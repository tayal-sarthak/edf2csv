/** End-to-end tests of the executable: exit codes, stream discipline, and messages. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

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


  it('quotes the time it was given, so the value has visible edges', async () => {
    // The parse errors have always quoted the value; the range errors did not, and the
    // value ran into the sentence. `--start "  5s  "` printed as `--start   5s   is at or
    // past the end`, where the value looks like `5s   is` and the surrounding spaces —
    // the actual reason a shell-built argument went wrong — cannot be seen at all.
    const spaced = await cli([fixture('tiny.edf'), '--start', '  5s  ', '--info']);
    assert.equal(spaced.code, 2);
    assert.match(spaced.stderr, /--start " {2}5s {2}" is at or past the end/u);

    // The typed form is echoed, not the seconds it parsed to.
    const hours = await cli([fixture('tiny.edf'), '--start', '4h', '--info']);
    assert.match(hours.stderr, /--start "4h" is at or past/u);
    assert.ok(!hours.stderr.includes('14400'), 'never a value the user did not type');

    // With no --start there is nothing typed to quote, so the parsed value is shown plainly.
    const noStart = await cli([fixture('tiny.edf'), '--end', '0', '--info']);
    assert.equal(noStart.code, 2);
    assert.match(noStart.stderr, /ends at "0", which is not after its start at 0s/u);
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

  it('refuses a position that is not written in plain digits', async () => {
    // Number() did the parsing and accepts far more than a position: #0x2 reached channel 2
    // through hex, #0b1 channel 1, and a bare # was Number('') === 0. Each one selected a
    // channel and exited 0, so a slip converted the wrong channel instead of failing.
    for (const term of ['#', '#0x2', '#0b1', '#1e0', '# 2', '#2.0', '#+1']) {
      const { code, stderr } = await cli([fixture('mixed-rates.edf'), '--stdout', '--channels', term]);
      assert.equal(code, 2, `${term} must be a usage error`);
      assert.match(stderr, /is not a channel position/u, `${term} needs the position message`);
    }
    // A well-formed position that does not exist keeps its own, more specific message.
    const missing = await cli([fixture('mixed-rates.edf'), '--stdout', '--channels', '#99']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /No channel at position #99/u);

    // And the valid forms still work.
    const ok = await cli([fixture('mixed-rates.edf'), '--stdout', '--channels', '#2']);
    assert.equal(ok.code, 0);
    assert.match(ok.stdout, /^time_s,Temp rectal/u);
  });

  it('prints a multi-line message as lines, not as an escape', async () => {
    // Control bytes out of a header are escaped before reaching the terminal, and that
    // escaping was applied to whole messages — including the newline in our own two-line
    // ones, which arrived as the literal text "\x0a" in the middle of a sentence.
    const { stderr } = await cli([fixture('mixed-rates.edf'), '--channels', 'ECQ']);
    assert.ok(!stderr.includes('\\x0a'), `newline came through escaped: ${stderr}`);
    const lines = stderr.trimEnd().split('\n');
    assert.match(lines[0], /^error: No channel named "ECQ"/u);
    assert.match(lines[1], /^ {7}Run with --info/u, 'the second line lines up under the first');
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
  it('never writes raw control bytes to stderr either', async () => {
    // A fatal header error quotes the label that caused it, and an unparseable date is
    // echoed raw — both are free text out of the file, and both reached the terminal.
    const { stderr } = await cli([fixture('quirky-labels.edf'), '--info']);
    const offending = [...stderr].filter((c) => {
      const n = c.codePointAt(0);
      return (n < 32 && n !== 10) || (n >= 127 && n <= 159);
    });
    assert.deepEqual(offending, []);
  });

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

  // The estimate exists so someone can decide whether a conversion is worth starting. Reading
  // low is the one direction that makes it useless, so it is checked against every fixture
  // rather than against the one calibration that happened to expose the last shortfall.
  it('never reports a size the conversion then exceeds', async () => {
    const names = (await readdir(path.join(ROOT, 'test', 'fixtures', 'generated')))
      .filter((n) => /\.(edf|bdf)$/u.test(n))
      // Deliberately damaged headers; they have nothing to estimate.
      .filter((n) => !['truncated.edf', 'unknown-records.edf'].includes(n));
    assert.ok(names.length > 10, `expected the generated fixtures, got ${names.length}`);

    const short = [];
    for (const name of names) {
      const { code, stdout } = await cli([fixture(name), '--info', '--json']);
      if (code !== 0) continue;
      const dir = await outDir();
      const { code: convert } = await cli([fixture(name), '--out', dir]);
      if (convert !== 0) continue;

      let actual = 0;
      for (const file of await readdir(dir)) {
        if (file.startsWith('signals')) actual += (await stat(path.join(dir, file))).size;
      }
      const estimate = JSON.parse(stdout).estimate.bytes;
      if (estimate < actual) short.push(`${name}: said ${estimate}, wrote ${actual}`);
    }
    assert.deepEqual(short, [], `the estimate under-reported:\n  ${short.join('\n  ')}`);
  });
});

describe('converting several recordings at once', () => {
  /** Copy fixtures into a fresh directory under the given names. */
  async function stage(files) {
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-batch-'));
    temporaries.push(dir);
    for (const [name, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), await readFile(fixture(source)));
    }
    return dir;
  }

  it('gives each recording its own directory under --out', async () => {
    const dir = await stage({
      'night-01.edf': 'tiny.edf',
      'night-02.edf': 'annotations.edf',
      'night-03.edf': 'mixed-rates.edf',
    });
    const { code } = await cli([
      path.join(dir, 'night-01.edf'),
      path.join(dir, 'night-02.edf'),
      path.join(dir, 'night-03.edf'),
      '--out', path.join(dir, 'converted'),
      '--quiet',
    ]);
    assert.equal(code, 0);
    assert.deepEqual(
      (await readdir(path.join(dir, 'converted'))).sort(),
      ['night-01', 'night-02', 'night-03'],
      'one directory per recording, named after it',
    );
    // Each holds its own data rather than the last one to be written.
    const first = await readFile(path.join(dir, 'converted', 'night-01', 'signals.csv'), 'utf8');
    assert.equal(first.split('\n')[0], 'time_s,ch1,ch2');
    const third = await readdir(path.join(dir, 'converted', 'night-03'));
    assert.ok(third.includes('signals_256hz.csv'), 'the mixed-rate file still splits by rate');
  });

  it('converts each beside itself when no --out is given', async () => {
    const dir = await stage({ 'a.edf': 'tiny.edf', 'b.edf': 'tiny.edf' });
    const { code } = await cli([path.join(dir, 'a.edf'), path.join(dir, 'b.edf'), '--quiet']);
    assert.equal(code, 0);
    const entries = (await readdir(dir)).sort();
    assert.deepEqual(entries, ['a.edf', 'a_csv', 'b.edf', 'b_csv'], 'the shell loop it replaces');
  });

  it('keeps going past a recording it cannot read, and says so', async () => {
    const dir = await stage({ 'a.edf': 'tiny.edf', 'c.edf': 'annotations.edf' });
    await writeFile(path.join(dir, 'b.edf'), 'not an edf at all');

    const { code, stderr } = await cli([
      path.join(dir, 'a.edf'), path.join(dir, 'b.edf'), path.join(dir, 'c.edf'),
      '--out', path.join(dir, 'out'),
    ]);
    assert.equal(code, 1, 'the run failed even though most of it succeeded');
    assert.match(stderr, /b\.edf: File is 17 bytes/u, 'the failure names its recording');
    assert.match(stderr, /Converted 2 of 3 recordings; 1 failed/u);
    assert.deepEqual(
      (await readdir(path.join(dir, 'out'))).sort(),
      ['a', 'c'],
      'the readable recordings were still converted',
    );
  });

  it('refuses before writing when two recordings would share a directory', async () => {
    // Same file name in different folders is how recordings are usually organised, and both
    // resolve to <out>/rec. Converting them in turn would leave one under the other's name.
    const dir = await stage({ 'n1/rec.edf': 'tiny.edf', 'n2/rec.edf': 'mixed-rates.edf' });
    const { code, stderr } = await cli([
      path.join(dir, 'n1', 'rec.edf'),
      path.join(dir, 'n2', 'rec.edf'),
      '--out', path.join(dir, 'clash'),
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /would both be converted into/u);
    await assert.rejects(readdir(path.join(dir, 'clash')), 'nothing may be written first');
  });

  it('refuses a batch on --stdout, which holds one table', async () => {
    // Two different recordings: naming the same one twice is one recording, not a batch.
    const { code, stderr } = await cli([
      fixture('tiny.edf'), fixture('annotations.edf'), '--stdout',
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /cannot take 2 recordings/u);
  });

  it('treats a recording named twice as one recording', async () => {
    // The folder walk already collapsed a recording reached two ways, and the explicit
    // list did not: it refused the whole run over the collision. A shell produces the
    // second by accident — `edf2csv *.edf recording.edf` — and there is nothing ambiguous
    // about it.
    const dir = await stage({ 'a.edf': 'tiny.edf', 'b.edf': 'annotations.edf' });
    const twice = await cli([
      path.join(dir, 'a.edf'), path.join(dir, 'a.edf'),
      '--out', path.join(dir, 'one'), '--quiet',
    ]);
    assert.equal(twice.code, 0, twice.stderr);
    // One recording, so --out is the output directory itself rather than a parent.
    assert.ok((await readdir(path.join(dir, 'one'))).includes('signals.csv'));

    // A glob overlapping an explicit name is two recordings, not three.
    const overlap = await cli([
      path.join(dir, 'a.edf'), path.join(dir, 'b.edf'), path.join(dir, 'a.edf'),
      '--out', path.join(dir, 'two'),
    ]);
    assert.equal(overlap.code, 0, overlap.stderr);
    assert.match(overlap.stderr, /Converted 2 of 2 recordings/u);
    assert.deepEqual((await readdir(path.join(dir, 'two'))).sort(), ['a', 'b']);

    // Two DIFFERENT recordings that would land in the same directory are still refused.
    const clash = await stage({ 'n1/rec.edf': 'tiny.edf', 'n2/rec.edf': 'mixed-rates.edf' });
    const refused = await cli([
      path.join(clash, 'n1', 'rec.edf'), path.join(clash, 'n2', 'rec.edf'),
      '--out', path.join(clash, 'out'),
    ]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /would both be converted into/u);
  });

  it('emits one JSON object per line for a batch, and the usual document for one', async () => {
    // Concatenated pretty-printed objects parse for a streaming reader but not line by
    // line, and a batch is exactly where a record per line is wanted.
    const dir = await stage({ 'a.edf': 'tiny.edf', 'b.edf': 'annotations.edf' });
    const many = await cli([
      path.join(dir, 'a.edf'), path.join(dir, 'b.edf'),
      '--out', path.join(dir, 'out'), '--json',
    ]);
    assert.equal(many.code, 0);
    const lines = many.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 2, 'one line per recording');
    for (const line of lines) JSON.parse(line);

    const info = await cli([path.join(dir, 'a.edf'), path.join(dir, 'b.edf'), '--info', '--json']);
    assert.equal(info.stdout.trimEnd().split('\n').length, 2);

    // A single recording still prints the indented document it always has.
    const one = await cli([fixture('tiny.edf'), '--info', '--json']);
    assert.ok(one.stdout.split('\n').length > 10, 'single-file output stays pretty-printed');
    JSON.parse(one.stdout);
  });

  it('expands a folder to the recordings inside it, keeping their layout', async () => {
    // Recordings arrive organised into folders, and a shell has no tidy way to reach them —
    // which is why the recipes carried a `find` incantation. Passing the folder is the
    // obvious thing to try, and it used to fail with "is a directory, not an EDF file".
    const dir = await stage({
      'study/night-1/rec.edf': 'tiny.edf',
      'study/night-2/rec.edf': 'annotations.edf',
      'study/top.bdf': 'biosemi.bdf',
    });
    await writeFile(path.join(dir, 'study', 'notes.txt'), 'not a recording');

    // Not --quiet: the closing count is what proves notes.txt was left out of the list.
    const { code, stderr } = await cli([path.join(dir, 'study'), '--out', path.join(dir, 'csv')]);
    assert.equal(code, 0);
    assert.match(stderr, /Converted 3 of 3 recordings/u, 'notes.txt is not a recording');

    // The layout is kept, which is also what keeps two recordings named rec.edf apart:
    // flattening to <out>/rec would have made them collide and refused the whole run.
    for (const expected of ['night-1/rec', 'night-2/rec', 'top']) {
      const written = await readdir(path.join(dir, 'csv', ...expected.split('/')));
      assert.ok(written.includes('signals.csv'), `${expected} should hold a conversion`);
    }
    // The two same-named recordings kept their own data.
    const one = await readFile(path.join(dir, 'csv', 'night-1', 'rec', 'signals.csv'), 'utf8');
    const two = await readFile(path.join(dir, 'csv', 'night-2', 'rec', 'signals.csv'), 'utf8');
    assert.equal(one.split('\n')[0], 'time_s,ch1,ch2');
    assert.equal(two.split('\n')[0], 'time_s,EEG Fpz-Cz');
  });

  it('follows symbolic links, and survives a cycle of them', async () => {
    // A recursive readdir reports a symlink as a symlink and never as a file, so a linked
    // recording was skipped without a word — and "converted 3 of 3" then described the
    // three it had noticed rather than what the folder held. Linking recordings into a
    // working directory is ordinary, and naming the same link directly always worked,
    // which made the omission harder to notice rather than easier.
    const dir = await stage({ 'real/actual.edf': 'tiny.edf', 'study/plain.edf': 'annotations.edf' });
    await mkdir(path.join(dir, 'study', 'sub'), { recursive: true });
    await symlink(path.join(dir, 'real', 'actual.edf'), path.join(dir, 'study', 'link.edf'));
    await symlink(path.join(dir, 'real'), path.join(dir, 'study', 'linkdir'));
    // A cycle: study/sub/loop points back at study.
    await symlink(path.join(dir, 'study'), path.join(dir, 'study', 'sub', 'loop'));

    const { code, stderr } = await cli([path.join(dir, 'study'), '--out', path.join(dir, 'csv')]);
    assert.equal(code, 0, stderr);
    // link.edf and linkdir/actual.edf are the same file reached two ways, so it converts
    // once: plain.edf and the linked recording.
    assert.match(stderr, /Converted 2 of 2 recordings/u);

    const written = (await readdir(path.join(dir, 'csv'))).sort();
    assert.deepEqual(written, ['link', 'plain'], `found ${written}`);
    const linked = await readFile(path.join(dir, 'csv', 'link', 'signals.csv'), 'utf8');
    assert.equal(linked.split('\n')[0], 'time_s,ch1,ch2', 'the link resolved to its target');
  });

  it('converts a recording reachable two ways only once', async () => {
    const dir = await stage({ 'data/one.edf': 'tiny.edf' });
    await symlink(path.join(dir, 'data', 'one.edf'), path.join(dir, 'data', 'alias.edf'));

    const { code, stderr } = await cli([
      path.join(dir, 'data'), '--out', path.join(dir, 'out'), '--quiet',
    ]);
    assert.equal(code, 0, stderr);
    // One recording, so this is a single conversion and --out is the directory itself.
    assert.ok((await readdir(path.join(dir, 'out'))).includes('signals.csv'));
  });

  it('says so when a folder holds no recordings', async () => {
    const dir = await stage({ 'keep.edf': 'tiny.edf' });
    await mkdir(path.join(dir, 'empty'), { recursive: true });
    const { code, stderr } = await cli([path.join(dir, 'empty'), '--out', path.join(dir, 'x')]);
    assert.equal(code, 2);
    assert.match(stderr, /No EDF or BDF recordings found/u);
  });

  it('still reports a named file that does not exist', async () => {
    // Expansion must not quietly drop a path just because it is not a directory.
    const { code, stderr } = await cli([fixture('nope.edf'), '--quiet']);
    assert.equal(code, 1);
    assert.match(stderr, /no such file/u);
  });

  it('produces the same files whether or not conversions run at once', async () => {
    // Converting is CPU-bound, so --jobs runs each recording in its own process. Whatever
    // that changes about ordering and buffering, it must not change a single byte written.
    const dir = await stage({
      'a.edf': 'tiny.edf',
      'b.edf': 'annotations.edf',
      'c.edf': 'mixed-rates.edf',
      'd.edf': 'discontinuous.edf',
    });
    const names = ['a.edf', 'b.edf', 'c.edf', 'd.edf'].map((n) => path.join(dir, n));

    assert.equal((await cli([...names, '--out', path.join(dir, 'one'), '--quiet'])).code, 0);
    assert.equal(
      (await cli([...names, '--out', path.join(dir, 'many'), '--quiet', '--jobs', '4'])).code,
      0,
    );

    for (const recording of ['a', 'b', 'c', 'd']) {
      const serial = path.join(dir, 'one', recording);
      const parallel = path.join(dir, 'many', recording);
      const files = (await readdir(serial)).filter((f) => f !== 'metadata.json').sort();
      assert.deepEqual(files, (await readdir(parallel)).filter((f) => f !== 'metadata.json').sort());
      for (const file of files) {
        assert.deepEqual(
          await readFile(path.join(parallel, file)),
          await readFile(path.join(serial, file)),
          `${recording}/${file} differs between a serial and a parallel run`,
        );
      }
    }
  });

  it('names the recording in a failure even when a child produced it', async () => {
    // A child converts one recording, so it prefixes nothing the way a batch does. The
    // name has to survive anyway: the [n/m] header is not necessarily alongside in a log.
    const dir = await stage({ 'good.edf': 'tiny.edf' });
    await writeFile(path.join(dir, 'bad.edf'), 'not an edf');

    for (const jobs of ['1', '2']) {
      const { code, stderr } = await cli([
        path.join(dir, 'good.edf'), path.join(dir, 'bad.edf'),
        '--out', path.join(dir, `out-${jobs}`), '--jobs', jobs, '--quiet',
      ]);
      assert.equal(code, 1, `--jobs ${jobs}`);
      assert.match(stderr, /error: .*bad\.edf: File is 10 bytes/u, `--jobs ${jobs} must name it`);
    }
  });

  it('keeps one JSON object per line when conversions run at once', async () => {
    // Each child sees a single recording and prints the indented document a single
    // conversion prints; the batch has to put it back on one line.
    const dir = await stage({ 'a.edf': 'tiny.edf', 'b.edf': 'annotations.edf' });
    const { code, stdout } = await cli([
      path.join(dir, 'a.edf'), path.join(dir, 'b.edf'),
      '--out', path.join(dir, 'out'), '--json', '--jobs', '2',
    ]);
    assert.equal(code, 0);
    const lines = stdout.trimEnd().split('\n');
    assert.equal(lines.length, 2, `expected a line per recording, got ${stdout}`);
    for (const line of lines) JSON.parse(line);
  });

  it('stops its children when interrupted, and says the output is incomplete', async () => {
    // Ctrl-C in a terminal reaches every process in the group, so children stop anyway. A
    // signal sent to this process alone does not, which is how a batch runs from a script,
    // and interrupting one left conversions writing into a directory believed abandoned —
    // with a successful "Done in 1.6s" as the last thing on screen.
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-int-'));
    temporaries.push(dir);
    const source = await readFile(fixture('long-stream.edf'));
    const names = [];
    // Enough that 400 ms cannot finish them, few enough not to starve the rest of
    // the suite of process slots while it runs.
    for (let i = 0; i < 30; i++) {
      const name = path.join(dir, `r${String(i).padStart(2, '0')}.edf`);
      await writeFile(name, source);
      names.push(name);
    }

    const { spawn } = await import('node:child_process');
    const run = spawn(process.execPath, [CLI, ...names, '--out', path.join(dir, 'out'), '--jobs', '2'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    run.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });

    // Long enough that conversions are certainly in flight, short enough that they
    // cannot all have finished.
    await new Promise((resolve) => setTimeout(resolve, 400));
    run.kill('SIGINT');
    const code = await new Promise((resolve) => run.on('close', resolve));

    assert.equal(code, 130, `expected the signal exit status, stderr was:\n${stderr}`);
    assert.match(stderr, /interrupted \(SIGINT\)/u);
    assert.match(stderr, /should not be used/u, 'the half-written directories must be named');

    // Nothing may outlive the parent: give the kill a moment, then look for survivors.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { execFile: raw } = await import('node:child_process');
    const survivors = await new Promise((resolve) => {
      raw('pgrep', ['-f', `${CLI} .*${path.basename(dir)}`], (_error, stdout) =>
        resolve((stdout ?? '').trim()),
      );
    });
    assert.equal(survivors, '', `conversions outlived the interrupted parent: ${survivors}`);
  });

  it('rejects a job count that is not a whole number of one or more', async () => {
    for (const jobs of ['0', 'abc', '1.5', '']) {
      const { code, stderr } = await cli([fixture('tiny.edf'), '--jobs', jobs, '--info']);
      assert.equal(code, 2, `--jobs ${JSON.stringify(jobs)}`);
      assert.match(stderr, /--jobs must be a whole number/u);
    }
  });

  it('reports warnings from every recording under --strict', async () => {
    const dir = await stage({ 'clean.edf': 'tiny.edf', 'mixed.edf': 'mixed-rates.edf' });
    const { code, stderr } = await cli([
      path.join(dir, 'clean.edf'), path.join(dir, 'mixed.edf'),
      '--out', path.join(dir, 'out'), '--strict', '--quiet',
    ]);
    assert.equal(code, 1, 'a warning anywhere in the batch fails the run');
    assert.match(stderr, /--strict: 1 warning/u);
  });
});

describe('messages that enumerate what the file contains', () => {
  // How many channels a recording has is the file's decision, so every message that lists
  // them is as long as the file says. A 200-channel recording produced a 1,545-character
  // warning on one line — nothing was wrong with the conversion, but the sentence that
  // mattered was buried. Four messages did this, two of them added in 0.3.3 and 0.3.6.
  const oneLine = (text) => text.trimEnd().split('\n')[0];

  it('caps every list rather than letting the header set the length', async () => {
    const many = fixture('many-rates.edf');

    const info = await cli([many, '--info']);
    const warning = info.stderr.split('\n').find((l) => l.includes('different sampling rates'));
    assert.ok(warning.length < 200, `mixed-rate warning is ${warning.length} chars: ${warning}`);
    assert.match(warning, /and 32 more/u, 'the remainder is counted, not dropped in silence');
    assert.match(warning, /40 different sampling rates/u, 'the true total is still stated');

    const stream = await cli([many, '--stdout']);
    assert.ok(oneLine(stream.stderr).length < 250, `--stdout refusal: ${oneLine(stream.stderr)}`);

    const missing = await cli([many, '--channels', '#999']);
    assert.ok(oneLine(missing.stderr).length < 200, `position list: ${oneLine(missing.stderr)}`);
    assert.match(missing.stderr, /and 32 more/u);

    const malformed = await cli([many, '--channels', '#0x2']);
    assert.ok(malformed.stderr.split('\n')[1].length < 200, 'the position hint is capped too');
  });

  it('leaves an ordinary recording listed in full', async () => {
    // The list is the useful part when it fits: these rates are what --channels chooses between.
    const { stderr } = await cli([fixture('mixed-rates.edf'), '--info']);
    assert.match(stderr, /3 different sampling rates \(256 Hz, 128 Hz, 1 Hz\)/u);
    assert.ok(!stderr.includes('more)'), 'nothing is summarised when everything fits');
  });
});

describe('--gzip', () => {
  it('writes .csv.gz whose contents match an uncompressed run exactly', async () => {
    const plainDir = await outDir();
    const zipDir = await outDir();
    assert.equal((await cli([fixture('annotations.edf'), '--out', plainDir, '--quiet'])).code, 0);
    assert.equal((await cli([fixture('annotations.edf'), '--out', zipDir, '--gzip', '--quiet'])).code, 0);

    const names = (await readdir(zipDir)).sort();
    assert.deepEqual(
      names,
      ['annotations.csv.gz', 'channels.csv.gz', 'metadata.json', 'signals.csv.gz'],
      'every CSV is compressed; metadata.json stays readable',
    );

    for (const csv of ['signals.csv', 'annotations.csv']) {
      const expanded = gunzipSync(await readFile(path.join(zipDir, `${csv}.gz`))).toString('utf8');
      const plain = await readFile(path.join(plainDir, csv), 'utf8');
      assert.equal(expanded, plain, `${csv}.gz must decompress to the uncompressed output`);
    }

    // channels.csv is the one file that legitimately differs: it names the outputs.
    const channels = gunzipSync(await readFile(path.join(zipDir, 'channels.csv.gz'))).toString('utf8');
    assert.match(channels, /signals\.csv\.gz/u, 'channels.csv must name the file that was written');
  });

  it('reports the compressed names, and the estimate as a pre-compression size', async () => {
    const { code, stdout } = await cli([fixture('tiny.edf'), '--info', '--gzip']);
    assert.equal(code, 0);
    assert.match(stdout, /signals\.csv\.gz/u, '--info must predict the name it would write');
    assert.match(stdout, /before compression/u);

    const plain = await cli([fixture('tiny.edf'), '--info']);
    assert.ok(!plain.stdout.includes('before compression'), 'only qualified when compressing');
  });

  it('compresses the stream under --stdout', async () => {
    // execFile decodes stdout as text by default, which would corrupt the gzip bytes.
    const { stdout } = await run(process.execPath, [CLI, fixture('tiny.edf'), '--stdout', '--gzip'], {
      encoding: 'buffer',
    });
    assert.equal(stdout[0], 0x1f, 'gzip magic byte 1');
    assert.equal(stdout[1], 0x8b, 'gzip magic byte 2');
    const text = gunzipSync(stdout).toString('utf8');
    assert.equal(text.split('\n')[0], 'time_s,ch1,ch2');
  });

  it('reports an unwritable destination the same way an uncompressed run does', async () => {
    // The compressor sits between the writer and the file, so a failure below it arrives
    // on a promise the writer does not own. With nothing attached to that promise Node
    // treated the rejection as unhandled and killed the process: converting into a blocked
    // path printed a raw EISDIR stack trace rather than the message and exit 1 that the
    // same path produces without --gzip.
    const dir = await outDir();
    await mkdir(path.join(dir, 'signals.csv.gz'), { recursive: true });

    const { code, stderr } = await cli([fixture('tiny.edf'), '--out', dir, '--gzip', '--force', '--quiet']);
    assert.equal(code, 1, 'a write failure is exit 1, not a crash');
    assert.match(stderr, /Writing to .* failed/u);
    assert.ok(!stderr.includes('triggerUncaughtException'), 'no raw stack trace');
  });

  it('leaves stdout usable after compressing to it', async () => {
    // pipe() ends its destination when the source ends. Letting the compressor end stdout
    // would close it for the rest of the process, which is exactly what the writer already
    // refuses to do for the uncompressed case.
    const script = `
      import { convert } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'dist', 'index.js')).href)};
      await convert(${JSON.stringify(fixture('tiny.edf'))}, { toStdout: true, gzip: true });
      process.stderr.write(String(process.stdout.writableEnded));
    `;
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-gz-'));
    temporaries.push(dir);
    const file = path.join(dir, 'run.mjs');
    await writeFile(file, script, 'utf8');

    const { stderr } = await run(process.execPath, [file], { encoding: 'buffer' });
    assert.equal(stderr.toString(), 'false', 'stdout must still be open when the conversion returns');
  });

  it('reports a write failure on stdout instead of crashing', async () => {
    // EPIPE is swallowed because a reader closing early is not a failure. Everything else
    // used to be rethrown, and the throw landed on a nextTick outside whatever try/catch
    // the conversion was inside — so `--stdout` onto a full disk died with a raw stack
    // trace and lost the warning that the CSV it had already written was truncated. The
    // same failure through --out printed the ordinary message all along.
    //
    // A read-only descriptor handed over as stdout fails with EBADF, which is a real write
    // failure and not EPIPE, and needs no full filesystem to arrange.
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-badfd-'));
    temporaries.push(dir);
    const readOnly = path.join(dir, 'target');
    await writeFile(readOnly, '');

    const { open } = await import('node:fs/promises');
    const handle = await open(readOnly, 'r');
    const { spawn } = await import('node:child_process');
    try {
      const child = spawn(process.execPath, [CLI, fixture('long-stream.edf'), '--stdout'], {
        stdio: ['ignore', handle.fd, 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      const code = await new Promise((resolve) => child.on('close', resolve));

      assert.equal(code, 1, `expected a reported failure, stderr was:\n${stderr}`);
      assert.match(stderr, /Writing to stdout failed/u);
      assert.ok(!/throw error|node:internal/u.test(stderr), `an error escaped:\n${stderr}`);
    } finally {
      await handle.close();
    }
  });

  it('exits cleanly when a reader hangs up on a compressed stream', async () => {
    // 0.2.30 made `--stdout | head` exit 0; 0.3.1 said compression would behave identically.
    // It did not: the EPIPE forwarded from stdout destroys the compressor, and end() on a
    // destroyed stream fails with ERR_STREAM_DESTROYED — not EPIPE, so it escaped the
    // hang-up guard and came back as "Writing to stdout failed".
    const { execFile: raw } = await import('node:child_process');
    const shell = promisify(raw);
    const { stdout } = await shell(
      '/bin/bash',
      ['-c', `"${process.execPath}" "${CLI}" "${fixture('long-stream.edf')}" --stdout --gzip 2>/dev/null | head -c 100 >/dev/null; echo "exit=${'$'}{PIPESTATUS[0]}"`],
      { maxBuffer: 1 << 20 },
    );
    assert.match(stdout, /exit=0/u, 'a reader hanging up is not a failure, compressed or not');
  });

  it('refuses to overwrite the input with a compressed sidecar', async () => {
    // The rate files come from the plan and carry .csv.gz; the sidecars were spelled out
    // uncompressed, so a compressed run checked two names it would never write and missed
    // the two it would. A recording sitting at <outdir>/channels.csv.gz was overwritten by
    // its own conversion, with --force, and the run reported success.
    for (const name of ['channels.csv.gz', 'annotations.csv.gz']) {
      const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-clash-'));
      temporaries.push(dir);
      const target = path.join(dir, name);
      await writeFile(target, await readFile(fixture('annotations.edf')));

      const { code, stderr } = await cli([target, '--out', dir, '--gzip', '--force']);
      assert.equal(code, 1, `${name} must be refused`);
      assert.match(stderr, /is the same file as the input recording/u);
      assert.deepEqual(
        await readFile(target),
        await readFile(fixture('annotations.edf')),
        `${name} was overwritten by its own conversion`,
      );
    }
  });

  it('does not call a compressed run stale on the next uncompressed one', async () => {
    // Leftovers are matched by name. If the pattern did not know about .gz, a rerun
    // without the flag would leave the old .csv.gz files sitting there unreported.
    const dir = await outDir();
    assert.equal((await cli([fixture('tiny.edf'), '--out', dir, '--gzip', '--quiet'])).code, 0);
    const { code, stderr } = await cli([fixture('tiny.edf'), '--out', dir, '--force', '--quiet']);
    assert.equal(code, 0);
    assert.match(stderr, /signals\.csv\.gz/u, 'the superseded compressed file must be reported');
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

describe('--stdout', () => {
  it('streams the single table to stdout and writes nothing to disk', async () => {
    const { code, stdout, stderr } = await cli([fixture('tiny.edf'), '--stdout']);
    assert.equal(code, 0);
    const rows = stdout.trimEnd().split('\n');
    assert.equal(rows[0], 'time_s,ch1,ch2');
    assert.equal(rows.length, 21, 'header plus 20 samples');
    assert.match(stderr, /20 rows to stdout/, 'the note belongs on stderr, not in the CSV');
  });

  it('exits cleanly when the reader hangs up mid-stream', async () => {
    // `edf2csv big.edf --stdout | head -1` closes the pipe while the conversion is still
    // writing. Treating that as a write failure gave exit 1 plus advice about files that
    // do not exist and disk space that is not the problem.
    const { execFile: raw } = await import('node:child_process');
    const shell = promisify(raw);
    const { stdout } = await shell(
      '/bin/bash',
      ['-c', `"${process.execPath}" "${CLI}" "${fixture('mixed-rates.edf')}" --stdout --channels ECG 2>/dev/null | head -1; echo "exit=\${PIPESTATUS[0]}"`],
      { maxBuffer: 1 << 20 },
    );
    assert.match(stdout, /exit=0/, 'a reader hanging up is not a failure');
    assert.match(stdout, /^time_s,ECG/u, 'the header still made it through');
  });

  it('stops converting once the reader is gone', async () => {
    // Exiting cleanly is only half of it. The first version of that fix returned early from
    // flush() without clearing the buffer, so every later row was appended and never drained:
    // a 165 MB conversion piped to `head -1` grew a 1.3 GB working set and died out of heap.
    //
    // This needs a recording whose CSV exceeds the pipe buffer. mixed-rates.edf converts to
    // 434 bytes — every write lands, no hang-up ever happens, and the bug is unreachable.
    const { execFile: raw } = await import('node:child_process');
    const shell = promisify(raw);
    const { stdout } = await shell(
      '/bin/bash',
      // stderr goes out on fd 3 — the outer stdout — so that the CSV keeps the pipe that
      // head closes. Sending the CSV to /dev/null instead would never block and never hang up.
      ['-c', `{ "${process.execPath}" "${CLI}" "${fixture('long-stream.edf')}" --stdout 2>&3 | head -1 >/dev/null; } 3>&1`],
      { maxBuffer: 1 << 20 },
    );
    const written = Number(stdout.match(/Wrote ([\d,]+) rows/)[1].replaceAll(',', ''));
    assert.ok(written < 102_400, `stopped after ${written} of 102,400 rows`);
  });

  it('refuses a recording that would need more than one table', async () => {
    const { code, stderr } = await cli([fixture('mixed-rates.edf'), '--stdout']);
    assert.equal(code, 1);
    assert.match(stderr, /exactly one table/);
    assert.match(stderr, /--channels/, 'the message should say how to narrow it');
    // Naming the rates is what makes the advice actionable: these are what to narrow to.
    assert.match(stderr, /256 Hz, 128 Hz, 1 Hz/u, 'the rates on offer must be listed');
  });

  it('accepts the same recording once narrowed to one rate', async () => {
    const { code, stdout } = await cli([
      fixture('mixed-rates.edf'), '--stdout', '--channels', 'Temp rectal',
    ]);
    assert.equal(code, 0);
    assert.deepEqual(stdout.trimEnd().split('\n').length, 4, 'header plus the three real samples');
  });

  it('refuses --json, since both would claim stdout', async () => {
    // Together they wrote the CSV and then the summary object onto one stream, giving a
    // document that parses as neither — and silently, since each half looked right alone.
    const { code, stdout, stderr } = await cli([fixture('tiny.edf'), '--stdout', '--json']);
    assert.equal(code, 2, 'a conflicting request is a usage error');
    assert.equal(stdout, '');
    assert.match(stderr, /both write to stdout/);
  });

  it('refuses --annotations-only, which has no signal data to stream', async () => {
    const { code, stderr } = await cli([fixture('annotations.edf'), '--stdout', '--annotations-only']);
    assert.equal(code, 1);
    assert.match(stderr, /no signal data/);
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
