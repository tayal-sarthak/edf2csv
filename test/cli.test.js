/** End-to-end tests of the executable: exit codes, stream discipline, and messages. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const fixture = (name) => path.join(ROOT, 'test', 'fixtures', 'generated', name);

const temporaries = [];
async function outDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-cli-'));
  temporaries.push(dir);
  return path.join(dir, 'out');
}
after(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

/** Run the CLI and capture stdout, stderr and the exit code without throwing. */
async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { maxBuffer: 64 << 20 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

describe('published type surface', () => {
  // The package declares no dependencies, so a TypeScript consumer has no @types/node
  // unless they install it themselves. If a Node-only type (Buffer, NodeJS.*, anything
  // imported from node:*) reaches a .d.ts on the public entry graph, every one of those
  // consumers gets "Cannot find name 'Buffer'" and the programmatic API stops
  // typechecking. That regression is invisible from inside this repo, where @types/node
  // is always present as a devDependency, so it is pinned here instead.
  it('exposes no Node-only types from the public entry point', async () => {
    const dist = path.join(ROOT, 'dist');
    const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');

    const seen = new Set();
    const offenders = [];
    const queue = ['index.d.ts'];

    while (queue.length > 0) {
      const relative = queue.shift();
      if (seen.has(relative)) continue;
      seen.add(relative);

      let source;
      try {
        source = await readFile(path.join(dist, relative), 'utf8');
      } catch {
        continue;
      }
      const code = strip(source);

      if (/\bBuffer\b/u.test(code)) offenders.push(`${relative}: Buffer`);
      if (/\bNodeJS\./u.test(code)) offenders.push(`${relative}: NodeJS.*`);
      const nodeImport = /from\s+['"](node:[^'"]+)['"]/u.exec(code);
      if (nodeImport) offenders.push(`${relative}: imports ${nodeImport[1]}`);

      for (const match of code.matchAll(/from\s+['"](\.[^'"]+)['"]/gu)) {
        const target = match[1].replace(/\.js$/u, '.d.ts');
        queue.push(path.normalize(path.join(path.dirname(relative), target)));
      }
    }

    assert.ok(seen.size > 5, `expected to walk the declaration graph, only saw ${seen.size} files`);
    assert.deepEqual(offenders, [], `Node-only types reachable from index.d.ts:\n${offenders.join('\n')}`);
  });

  it('declares no runtime dependencies', async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  });
});

describe('help and version', () => {
  it('prints usage to stdout and exits cleanly', async () => {
    const { code, stdout } = await cli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Usage/);
    assert.match(stdout, /--annotations-only/);
  });

  it('prints the version', async () => {
    const { code, stdout } = await cli(['--version']);
    assert.equal(code, 0);
    const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(stdout.trim(), packageJson.version);
  });
});

describe('invocation through a symlink', () => {
  // npm installs a bin as node_modules/.bin/edf2csv -> ../edf2csv/dist/cli.js, and that
  // symlink is what `npx edf2csv` executes. If the entry-point check compares the symlink
  // path against the module's own resolved URL, main() never runs and the command exits 0
  // having done nothing at all.
  it('runs when invoked through a symlink, as npx does', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-bin-'));
    temporaries.push(dir);
    const link = path.join(dir, 'edf2csv');
    await symlink(CLI, link);

    const { stdout } = await run(process.execPath, [link, '--version']);
    assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/, 'the symlinked entry point must actually run');
  });
});

describe('argument errors exit 2', () => {
  it('rejects an unknown option', async () => {
    const { code, stderr } = await cli(['--nope', fixture('tiny.edf')]);
    assert.equal(code, 2);
    assert.match(stderr, /--help/);
  });

  it('requires an input file', async () => {
    const { code } = await cli([]);
    assert.equal(code, 2);
  });

  it('rejects more than one input file', async () => {
    const { code, stderr } = await cli([fixture('tiny.edf'), fixture('mixed-rates.edf')]);
    assert.equal(code, 2);
    assert.match(stderr, /one at a time/);
  });

  it('rejects an unparseable time', async () => {
    const { code, stderr } = await cli([fixture('tiny.edf'), '--start', 'banana']);
    assert.equal(code, 2);
    assert.match(stderr, /not a time I understand/);
  });

  it('rejects an empty --decimals rather than reading it as zero', async () => {
    // Number('') is 0, which would silently round every value to a whole number.
    const { code, stderr } = await cli([fixture('tiny.edf'), '--decimals', '']);
    assert.equal(code, 2);
    assert.match(stderr, /--decimals needs a number/);
  });

  it('rejects an unknown channel and suggests a real one', async () => {
    const { code, stderr } = await cli([fixture('mixed-rates.edf'), '--channels', 'ECQ']);
    assert.equal(code, 2);
    assert.match(stderr, /Did you mean "ECG"/);
  });
});

describe('file errors exit 1', () => {
  it('reports a missing input', async () => {
    const { code, stderr } = await cli([fixture('nope.edf')]);
    assert.equal(code, 1);
    assert.match(stderr, /no such file/);
  });

  it('refuses to overwrite without --force, then accepts it', async () => {
    const dir = await outDir();
    assert.equal((await cli([fixture('tiny.edf'), '--out', dir, '--quiet'])).code, 0);

    const second = await cli([fixture('tiny.edf'), '--out', dir, '--quiet']);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /already exists/);
    assert.match(second.stderr, /--force/);

    assert.equal((await cli([fixture('tiny.edf'), '--out', dir, '--quiet', '--force'])).code, 0);
  });
});

describe('terminal safety', () => {
  // EDF identification fields and labels are free text copied out of the file and printed
  // straight to stdout by --info. A header carrying ANSI escapes could drive the reader's
  // terminal — \x1b[2J clears the screen — so control bytes are shown as escapes instead.
  it('never writes raw control bytes to stdout', async () => {
    const { code, stdout } = await cli([fixture('quirky-labels.edf'), '--info']);
    assert.equal(code, 0);
    const offending = [...stdout].filter((c) => {
      const n = c.codePointAt(0);
      return (n < 32 && n !== 10) || (n >= 127 && n <= 159);
    });
    assert.deepEqual(offending, [], 'control bytes must be escaped before reaching the terminal');
  });
});

describe('stale output detection', () => {
  // Output filenames gained two shapes recently: a collision suffix (signals_0hz_2.csv) and
  // exponent rates (signals_1_000e-7hz.csv). Neither matched the pattern that recognises
  // this tool's own files, so leftovers of exactly those kinds went unreported — the one
  // situation the warning exists for.
  it('recognises every filename shape it can produce, and ignores files it cannot', async () => {
    const dir = await outDir();
    await mkdir(dir, { recursive: true });

    const leftovers = ['signals_256hz.csv', 'signals_0hz_2.csv', 'signals_1_000e-7hz.csv'];
    const notOurs = ['signals_notes.csv', 'my_signals.csv'];
    for (const name of [...leftovers, ...notOurs]) {
      await writeFile(path.join(dir, name), '');
    }

    const { code, stderr } = await cli([fixture('tiny.edf'), '--out', dir, '--force']);
    assert.equal(code, 0);

    for (const name of leftovers) {
      assert.match(stderr, new RegExp(name.replace(/[.]/gu, '\\.')), `${name} should be reported`);
    }
    for (const name of notOurs) {
      assert.ok(!stderr.includes(name), `${name} is the user's file and must be left alone`);
    }
  });
});

describe('concurrent runs', () => {
  // Asking whether the directory exists and then creating it left a window where two
  // conversions both saw "not there". Both proceeded, both opened write streams on the
  // same signals.csv, and both exited 0 having written one file between them.
  it('lets exactly one of several simultaneous runs claim an output directory', async () => {
    const dir = await outDir();
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => cli([fixture('mixed-rates.edf'), '--out', dir, '--quiet'])),
    );

    const winners = runs.filter((r) => r.code === 0);
    assert.equal(winners.length, 1, `exactly one run may succeed, ${winners.length} did`);

    for (const loser of runs.filter((r) => r.code !== 0)) {
      assert.equal(loser.code, 1);
      assert.match(loser.stderr, /already exists/);
    }

    // The surviving output must be one complete conversion, not a blend of eight.
    const rows = (await readFile(path.join(dir, 'signals_256hz.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(rows.length, 769, '768 data rows plus a header');
    assert.ok(rows.every((r) => r.split(',').length === 2), 'every row has the same column count');
  });
});

describe('write failures', () => {
  it('reports an unwritable destination instead of dumping a stack trace', async () => {
    const dir = await outDir();
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o500); // readable and listable, but not writable
    try {
      const { code, stderr } = await cli([fixture('tiny.edf'), '--out', dir, '--force']);
      assert.equal(code, 1);
      assert.match(stderr, /failed/);
      assert.ok(!stderr.includes('at async'), 'must not leak a Node stack trace');
      assert.match(stderr, /incomplete/, 'the user must be told the output is unusable');
    } finally {
      await chmod(dir, 0o700);
    }
  });
});

describe('--info', () => {
  it('describes the recording on stdout without converting', async () => {
    const { code, stdout } = await cli([fixture('mixed-rates.edf'), '--info']);
    assert.equal(code, 0);
    assert.match(stdout, /EEG Fpz-Cz/);
    assert.match(stdout, /256 Hz/);
    assert.match(stdout, /Would write/);
  });

  it('sends warnings to stderr so stdout stays parseable', async () => {
    const { stdout, stderr } = await cli([fixture('mixed-rates.edf'), '--info']);
    assert.match(stderr, /different sampling rates/);
    assert.ok(!stdout.includes('warning:'), 'warnings must not contaminate stdout');
  });

  it('uses real EDF+D timing when resolving windows and estimates', async () => {
    const { code, stdout } = await cli([
      fixture('discontinuous.edf'),
      '--info',
      '--start',
      '5s',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /Time span\s+11s/);
    assert.match(stdout, /Would write 10 rows/);
  });

  it('shows the actual annotations-only output plan', async () => {
    const { code, stdout } = await cli([
      fixture('annotations.edf'),
      '--info',
      '--annotations-only',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /Would write 0 rows/);
    assert.ok(!stdout.includes('signals.csv'));
  });
});

describe('documented flags', () => {
  // The README keeps its own, friendlier option list rather than repeating --help
  // verbatim, so the two drift silently: --strict and the reworded --json both shipped
  // while the README still listed the old set. Descriptions may differ; the set of flags
  // may not.
  it('lists every flag the CLI accepts', async () => {
    const { stdout: help } = await cli(['--help']);
    const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');

    const flags = [...help.matchAll(/^\s+(?:-\w, )?(--[a-z-]+)/gmu)].map((m) => m[1]);
    assert.ok(flags.length > 10, `expected to find the flags in --help, got ${flags}`);

    const missing = flags.filter((flag) => !readme.includes(flag));
    assert.deepEqual(missing, [], `README's option list is missing: ${missing.join(', ')}`);
  });
});

describe('--strict', () => {
  it('leaves a clean recording alone and fails one that warned', async () => {
    const clean = await cli([fixture('tiny.edf'), '--out', await outDir(), '--quiet', '--strict']);
    assert.equal(clean.code, 0, 'nothing to warn about, so nothing to fail');

    const dir = await outDir();
    const warned = await cli([fixture('mixed-rates.edf'), '--out', dir, '--quiet', '--strict']);
    assert.equal(warned.code, 1);
    assert.match(warned.stderr, /--strict/);

    // The conversion is still complete; the exit code is the signal, not a rollback.
    const rows = (await readFile(path.join(dir, 'signals_1hz.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(rows.length, 4, 'header plus the three real samples');
  });

  it('screens a file with --info without converting it', async () => {
    assert.equal((await cli([fixture('tiny.edf'), '--info', '--strict'])).code, 0);
    assert.equal((await cli([fixture('mixed-rates.edf'), '--info', '--strict'])).code, 1);
  });
});

describe('--info --json', () => {
  it('describes the recording as JSON with warnings inside and stderr empty', async () => {
    const { code, stdout, stderr } = await cli([fixture('mixed-rates.edf'), '--info', '--json']);
    assert.equal(code, 0);
    assert.equal(stderr, '', 'warnings belong in the document, not beside it');

    const info = JSON.parse(stdout);
    assert.equal(info.channels.length, 3);
    assert.deepEqual(info.channels.map((c) => c.sampling_rate_hz), [256, 128, 1]);
    assert.ok(info.estimate.rows > 0);
    assert.ok(info.warnings.some((w) => w.code === 'MIXED_SAMPLING_RATES'));
    assert.equal(info.data_records, 3);
  });
});

describe('conversion', () => {
  it('keeps the human summary off stdout', async () => {
    const dir = await outDir();
    const { code, stdout, stderr } = await cli([fixture('tiny.edf'), '--out', dir]);
    assert.equal(code, 0);
    assert.equal(stdout, '', 'nothing but requested data belongs on stdout');
    assert.match(stderr, /Wrote/);
  });

  it('prints a machine-readable summary with --json', async () => {
    const dir = await outDir();
    const { code, stdout } = await cli([fixture('mixed-rates.edf'), '--out', dir, '--json']);
    assert.equal(code, 0);

    const summary = JSON.parse(stdout);
    assert.equal(summary.output_dir, dir);
    assert.equal(summary.records, 3);
    assert.ok(summary.files.some((f) => f.name === 'signals_1hz.csv' && f.rows === 3));
    assert.ok(summary.warnings.some((w) => w.code === 'MIXED_SAMPLING_RATES'));
  });

  it('stays silent apart from warnings with --quiet', async () => {
    const dir = await outDir();
    const { code, stdout, stderr } = await cli([fixture('tiny.edf'), '--out', dir, '--quiet']);
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  });

  it('accepts a time window in human units', async () => {
    const dir = await outDir();
    const { code } = await cli([fixture('fractional-recdur.edf'), '--out', dir, '--start', '0.5s', '--duration', '500ms', '--json']);
    assert.equal(code, 0);
  });
});
