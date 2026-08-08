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

const exists = async (p) => stat(p).then(() => true, () => false);

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

  // The estimate exists so someone can decide whether a conversion is worth starting. Reading
  // low is the one direction that makes it useless, so it is checked against every fixture
  // rather than against the one calibration that happened to expose the last shortfall.
  it('predicts the same rows the conversion writes, whatever the origin', async () => {
    // 0.4.9 made a continuous recording take its origin from the first record's timekeeping
    // TAL, and --info kept placing a requested window against zero — it reads annotations
    // only for discontinuous files, deliberately, because scanning every record to report a
    // header summary is what an earlier version was fixed for. The estimate and the
    // conversion therefore disagreed on any windowed run of a file starting mid-second.
    for (const name of ['fractional-start.edf', 'fractional-start-d.edf']) {
      for (const window of [[], ['--start', '1'], ['--end', '2'], ['--start', '1.5'],
        ['--start', '0.5', '--duration', '1']]) {
        const info = await cli([fixture(name), '--info', '--json', ...window]);
        assert.equal(info.code, 0);
        const predicted = JSON.parse(info.stdout).estimate.rows;

        const dir = await outDir();
        assert.equal((await cli([fixture(name), '--out', dir, '--quiet', ...window])).code, 0);
        const written = (await readFile(path.join(dir, 'signals.csv'), 'utf8'))
          .trimEnd().split('\n').length - 1;

        assert.equal(predicted, written, `${name} ${window.join(' ') || '(whole file)'}`);
      }
    }
  });

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

  it('refuses before writing when one output would sit inside another', async () => {
    // A recording named rec.edf beside a folder named rec is enough: the outputs are
    // <out>/rec and <out>/rec/inner, which are not equal, so the duplicate check let both
    // through. Each conversion claims its own directory with a non-recursive mkdir but
    // creates its parents recursively, so whichever started second either found the
    // directory the other had already made as a parent — and failed with "already exists" —
    // or did not. Under --jobs that came out differently run to run.
    const dir = await stage({ 'study/rec.edf': 'tiny.edf', 'study/rec/inner.edf': 'mixed-rates.edf' });

    for (const jobs of ['1', '2']) {
      const out = path.join(dir, `out-${jobs}`);
      const { code, stderr } = await cli([path.join(dir, 'study'), '--out', out, '--jobs', jobs]);
      assert.equal(code, 2, `--jobs ${jobs}`);
      assert.match(stderr, /cannot sit inside another/u);
      await assert.rejects(readdir(out), `--jobs ${jobs} wrote something before refusing`);
    }
  });

  it('refuses two recordings whose names differ only in case, where that matters', async () => {
    // On a filesystem that does not distinguish case — macOS by default, Windows always —
    // <out>/REC and <out>/rec are one directory. Compared exactly they are different, so
    // both went through, and with --force the second wrote into the first's directory: one
    // recording's signals.csv beside the other's signals_256hz.csv, under a single
    // metadata.json naming only one of them, reported as "Converted 2 of 2 recordings".
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;

    const dir = await stage({ 'a/REC.edf': 'tiny.edf', 'b/rec.edf': 'mixed-rates.edf' });
    const out = path.join(dir, 'out');
    const { code, stderr } = await cli([
      path.join(dir, 'a', 'REC.edf'), path.join(dir, 'b', 'rec.edf'), '--out', out, '--force',
    ]);
    assert.equal(code, 2);
    assert.match(stderr, /would both be converted into/u);
    await assert.rejects(readdir(out), 'nothing may be written before refusing');
  });

  it('finds a nested destination even with a sibling sorting between them', async () => {
    // The first version of this guard sorted resolved paths and compared neighbours, on the
    // reasoning that an ancestor and its descendant end up adjacent. The separator is not
    // the lowest character, so any sibling starting with one of the thirteen printable
    // characters below '/' lands between them: with rec.edf, rec!x.edf and rec/inner.edf,
    // '!' sorts between out/rec and out/rec/inner and the pair was never compared.
    const dir = await stage({
      'study/rec.edf': 'tiny.edf',
      'study/rec!x.edf': 'annotations.edf',
      'study/rec/inner.edf': 'mixed-rates.edf',
    });
    const { code, stderr } = await cli([path.join(dir, 'study'), '--out', path.join(dir, 'out')]);
    assert.equal(code, 2, stderr);
    assert.match(stderr, /cannot sit inside another/u);
  });

  it('converts a recording whose name begins with a dash, however many jobs', async () => {
    // The child received the recording as its first argument, so a path beginning with a
    // dash parsed as an option — which `path.join` produces from a folder given as `.`,
    // since `./-lead.edf` normalises to `-lead.edf`. Serial converted it, parallel did not.
    const dir = await stage({ 'study/ok.edf': 'annotations.edf' });
    await writeFile(path.join(dir, 'study', '-lead.edf'), await readFile(fixture('tiny.edf')));

    for (const jobs of ['1', '2']) {
      const { code, stderr } = await cli([
        path.join(dir, 'study'), '--out', path.join(dir, `out-${jobs}`), '--jobs', jobs,
      ]);
      assert.equal(code, 0, `--jobs ${jobs}: ${stderr}`);
      assert.match(stderr, /Converted 2 of 2 recordings/u, `--jobs ${jobs}`);
    }
  });

  it('prints a file name containing a replacement pattern as it is', async () => {
    // named() built its replacement as a string, so `$&` in a file name re-injected the text
    // it had just matched: bad$&name.edf reported itself as "baderror: name.edf".
    const dir = await stage({ 'study/good.edf': 'tiny.edf' });
    await writeFile(path.join(dir, 'study', 'bad$&name.edf'), 'not an edf');

    const { stderr } = await cli([
      path.join(dir, 'study'), '--out', path.join(dir, 'out'), '--jobs', '2',
    ]);
    assert.match(stderr, /bad\$&name\.edf: File is 10 bytes/u, `name was mangled: ${stderr}`);
  });

  it('allows outputs that merely share a parent', async () => {
    // Only nesting is refused. Siblings under one directory are the ordinary case.
    const dir = await stage({ 'study/a.edf': 'tiny.edf', 'study/b.edf': 'annotations.edf' });
    const { code } = await cli([path.join(dir, 'study'), '--out', path.join(dir, 'out'), '--quiet']);
    assert.equal(code, 0);
    assert.deepEqual((await readdir(path.join(dir, 'out'))).sort(), ['a', 'b']);
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
    /*
      Two names is a batch, so --out is a parent — even though the two names turn out to be
      one recording, converted once. Until 0.5.40 the deduplicated count decided this, so the
      same command wrote signals.csv directly into --out and printed an indented JSON document
      instead of JSON Lines. The shape of a run is what you asked for, which is what the
      comment above that count has said since 0.4.20, and what cli-reference says of exactly
      this command.
    */
    assert.deepEqual(await readdir(path.join(dir, 'one')), ['a']);
    assert.ok((await readdir(path.join(dir, 'one', 'a'))).includes('signals.csv'));

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

    // The two ways in are `link.edf`, which is a link, and `linkdir/actual.edf`, which is a
    // real file inside a linked folder. The name that is not a link wins, so the output
    // keeps the shape the folder has rather than flattening it under the link's name.
    const written = (await readdir(path.join(dir, 'csv'))).sort();
    assert.deepEqual(written, ['linkdir', 'plain'], `found ${written}`);
    const linked = await readFile(path.join(dir, 'csv', 'linkdir', 'actual', 'signals.csv'), 'utf8');
    assert.equal(linked.split('\n')[0], 'time_s,ch1,ch2', 'the link resolved to its target');
  });

  it('converts a recording reachable two ways only once', async () => {
    const dir = await stage({ 'data/one.edf': 'tiny.edf' });
    await symlink(path.join(dir, 'data', 'one.edf'), path.join(dir, 'data', 'alias.edf'));

    const { code, stderr } = await cli([
      path.join(dir, 'data'), '--out', path.join(dir, 'out'), '--quiet',
    ]);
    assert.equal(code, 0, stderr);
    // A folder was named, so --out is a parent whether it holds one recording or fifty, and
    // the survivor is named after the recording rather than the link pointing at it.
    assert.deepEqual(await readdir(path.join(dir, 'out')), ['one']);
    assert.ok((await readdir(path.join(dir, 'out', 'one'))).includes('signals.csv'));
  });

  it('picks the same name for a folder reached two ways, whatever the order', async () => {
    // 0.4.29 settled this for two names of one file and left the directory above it deciding
    // by accident: the walk was a stack popped from the back, so which of two names for one
    // folder was visited first came down to readdir order, and the loser was skipped as
    // already seen. `aaa-real/` beside `zzz-alias -> aaa-real` converted into
    // <out>/zzz-alias/ — the link's name, chosen by a hash order that differs between
    // filesystems. Both orderings of the names are checked, so passing cannot be luck.
    for (const [real, alias] of [['aaa-real', 'zzz-alias'], ['zzz-real', 'aaa-alias']]) {
      const dir = await stage({ [`study/${real}/rec.edf`]: 'tiny.edf' });
      await symlink(path.join(dir, 'study', real), path.join(dir, 'study', alias));

      const out = path.join(dir, 'csv');
      const { code, stderr } = await cli([path.join(dir, 'study'), '--out', out, '--quiet']);
      assert.equal(code, 0, stderr);
      assert.deepEqual(
        await readdir(out),
        [real],
        `the folder's own name must win over the link, not "${alias}"`,
      );
    }
  });

  it('keeps the batch shape when two names turn out to be one recording', async () => {
    /*
      The shape of a run — whether --out is a parent, whether --json is JSON Lines — is
      decided by what was named. It was decided by what survived deduplication, so naming a
      recording and a symbolic link to it made the run stop being a batch: the files landed
      in --out itself rather than in a directory under it, and --json printed one indented
      document. Two genuinely different recordings gave the other shape from the same flags.
    */
    const dir = await stage({ 'one.edf': 'tiny.edf' });
    await symlink(path.join(dir, 'one.edf'), path.join(dir, 'alias.edf'));

    for (const order of [['one.edf', 'alias.edf'], ['alias.edf', 'one.edf']]) {
      const out = path.join(dir, `out-${order[0]}`);
      const { code, stderr } = await cli([
        ...order.map((name) => path.join(dir, name)),
        '--out', out, '--quiet',
      ]);
      assert.equal(code, 0, stderr);
      assert.deepEqual(await readdir(out), ['one'], `given ${order.join(' ')}`);
    }

    // And --json stays JSON Lines, one compact object rather than an indented document.
    const { stdout } = await cli([
      path.join(dir, 'one.edf'), path.join(dir, 'alias.edf'), '--out', path.join(dir, 'j'), '--json',
    ]);
    const lines = stdout.trimEnd().split('\n');
    assert.equal(lines.length, 1, stdout);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  });

  it('picks the same name whether a recording is named directly or through its folder', async () => {
    /*
      The tie-break above settles two *paths* for one recording. This is one path with two
      *names*: a folder gives the recording its position inside the folder, `night-01/rec`,
      and naming the file directly gives it its bare `rec`. Whichever the loop met first won,
      so argument order decided the output directory's name — and, once a sibling
      `study/rec.edf` was in play, decided whether the run happened at all: the bare name
      collides with that sibling, so one order was refused with exit 2 while the other
      converted both.

      The nested name wins. It is what the folder promised, and it is the one that does not
      collide, since collapsing a recording to its bare name is what puts it on a sibling.
    */
    const dir = await stage({ 'study/night-01/rec.edf': 'tiny.edf' });
    const folder = path.join(dir, 'study');
    const file = path.join(folder, 'night-01', 'rec.edf');

    for (const [label, order] of [['folder first', [folder, file]], ['file first', [file, folder]]]) {
      const out = path.join(dir, `out-${label.replace(' ', '-')}`);
      const { code, stderr } = await cli([...order, '--out', out, '--quiet']);
      assert.equal(code, 0, stderr);
      assert.deepEqual(
        (await readdir(path.join(out, 'night-01'))).sort(),
        ['rec'],
        `${label} named it differently`,
      );
      assert.deepEqual((await readdir(out)).sort(), ['night-01'], `${label} converted it twice`);
    }

    // And with a sibling that wants the bare name, both orders convert both recordings.
    await writeFile(path.join(folder, 'rec.edf'), await readFile(fixture('annotations.edf')));
    for (const [label, order] of [['folder first', [folder, file]], ['file first', [file, folder]]]) {
      const out = path.join(dir, `both-${label.replace(' ', '-')}`);
      const { code, stderr } = await cli([...order, '--out', out, '--quiet']);
      assert.equal(code, 0, `${label}:\n${stderr}`);
      assert.deepEqual((await readdir(out)).sort(), ['night-01', 'rec'], label);
    }
  });

  it('picks the same name for a recording reached two ways, whatever the order', async () => {
    // The first arrival won, so the output directory was named by argument order:
    // `edf2csv data/one.edf data/alias.edf` wrote out/one and the same two swapped wrote
    // out/alias. A shell orders a glob however it likes, and inside a folder it was whatever
    // readdir returned — which differs between filesystems, so copying a study to another
    // machine could rename its output. Both tie-breaks are properties of the names.
    const dir = await stage({ 'data/one.edf': 'tiny.edf', 'data/other.edf': 'annotations.edf' });
    const alias = path.join(dir, 'data', 'alias.edf');
    await symlink(path.join(dir, 'data', 'one.edf'), alias);

    for (const order of [['one.edf', 'alias.edf'], ['alias.edf', 'one.edf']]) {
      const out = path.join(dir, `out-${order[0]}`);
      const { code, stderr } = await cli([
        ...order.map((name) => path.join(dir, 'data', name)),
        path.join(dir, 'data', 'other.edf'), '--out', out, '--quiet',
      ]);
      assert.equal(code, 0, stderr);
      assert.deepEqual(
        (await readdir(out)).sort(),
        ['one', 'other'],
        `named after the link instead of the recording, given ${order.join(' ')}`,
      );
    }

    // With no name of its own to prefer — two links and no recording among them — the path
    // that sorts first wins, which is still an answer that does not move.
    const both = await stage({ 'real.edf': 'tiny.edf', 'data/other.edf': 'annotations.edf' });
    for (const name of ['zzz.edf', 'aaa.edf']) {
      await symlink(path.join(both, 'real.edf'), path.join(both, 'data', name));
    }
    for (const order of [['zzz.edf', 'aaa.edf'], ['aaa.edf', 'zzz.edf']]) {
      const out = path.join(both, `out-${order[0]}`);
      const { stderr } = await cli([
        ...order.map((name) => path.join(both, 'data', name)),
        path.join(both, 'data', 'other.edf'), '--out', out, '--quiet',
      ]);
      assert.deepEqual((await readdir(out)).sort(), ['aaa', 'other'], `given ${order.join(' ')}: ${stderr}`);
    }
  });

  it('puts a recording in the same place however many siblings it has', async () => {
    // What --out means was decided by counting the recordings, so `edf2csv study --out csv`
    // wrote csv/signals.csv while the study held one night and csv/night-01/rec/signals.csv
    // once it held two: adding a recording moved the output of one that had not changed.
    // The same count made the destination turn on things nobody had touched — a night on an
    // unmounted drive, a sub-directory that could not be read — since losing an input was
    // enough to change where the survivors landed.
    const alone = await stage({ 'study/night-01/rec.edf': 'tiny.edf' });
    const beside = await stage({
      'study/night-01/rec.edf': 'tiny.edf',
      'study/night-02/rec.edf': 'tiny.edf',
    });

    for (const dir of [alone, beside]) {
      const { code, stderr } = await cli([
        path.join(dir, 'study'), '--out', path.join(dir, 'csv'), '--quiet',
      ]);
      assert.equal(code, 0, stderr);
    }

    const first = path.join('csv', 'night-01', 'rec', 'signals.csv');
    assert.deepEqual(
      await readFile(path.join(alone, first), 'utf8'),
      await readFile(path.join(beside, first), 'utf8'),
      'the same recording, in the same place, whether or not it has a neighbour',
    );

    // Naming the recording itself still means the output directory itself.
    const named = await cli([
      path.join(alone, 'study', 'night-01', 'rec.edf'),
      '--out', path.join(alone, 'direct'), '--quiet',
    ]);
    assert.equal(named.code, 0, named.stderr);
    assert.ok((await readdir(path.join(alone, 'direct'))).includes('signals.csv'));
  });

  it('reports a dangling link whatever it is called, and keeps the survivors in place', async () => {
    // A study kept as one folder per night, with one night linked to a drive that is not
    // mounted. The link carries no `.edf` name, so it was skipped in silence — and losing it
    // left a single recording, which used to move the survivor's output as well.
    const dir = await stage({ 'study/night-01/rec.edf': 'tiny.edf' });
    await symlink(path.join(dir, 'nowhere'), path.join(dir, 'study', 'night-02'));

    const { code, stderr } = await cli([
      path.join(dir, 'study'), '--out', path.join(dir, 'csv'), '--quiet',
    ]);
    assert.notEqual(code, 0, 'a recording that could not be reached is not a success');
    assert.match(stderr, /night-02: could not be read/u);
    assert.ok(
      (await readdir(path.join(dir, 'csv', 'night-01', 'rec'))).includes('signals.csv'),
      'the night that was mounted lands where it would have landed anyway',
    );
  });

  it('reports a folder it could not read instead of stepping over it', async () => {
    // Skipping it in silence meant a folder holding three recordings, one inside a
    // sub-directory without read permission, converted two and said "Converted 2 of 2
    // recordings" — a total that agreed with itself and with nothing else. That is the
    // failure 0.4.4 fixed for symbolic links, arriving by a different route.
    if (process.getuid?.() === 0) return; // root reads everything; nothing to test

    const dir = await stage({
      'study/open/a.edf': 'tiny.edf',
      'study/locked/b.edf': 'annotations.edf',
      'study/top.edf': 'mixed-rates.edf',
    });
    const locked = path.join(dir, 'study', 'locked');
    await chmod(locked, 0o000);
    try {
      const { code, stderr } = await cli([path.join(dir, 'study'), '--out', path.join(dir, 'out')]);
      assert.equal(code, 1, 'a folder that could not be read is not a clean run');
      assert.match(stderr, /locked: could not be read/u);
      // What could be read is still converted.
      assert.deepEqual((await readdir(path.join(dir, 'out'))).sort(), ['open', 'top']);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('refuses two names that a normalising filesystem would make one', async (t) => {
    if (process.platform !== 'darwin') {
      t.skip('only HFS+ and APFS fold normalisation; elsewhere these are two directories');
      return;
    }

    // The duplicate-destination guard case-folded but never normalised, so `café` written as
    // e + U+0301 and `café` written as U+00E9 stayed two JavaScript strings while being one
    // directory on APFS. Two recordings therefore both passed the check and both converted
    // into the same place: signals.csv from one beside signals_256hz.csv from the other,
    // under a single metadata.json naming one of them, "Converted 2 of 2 recordings", exit 0.
    // Different extensions are what let the two files coexist while their stems collide.
    const dir = await stage({});
    await mkdir(path.join(dir, 'study'), { recursive: true });
    await writeFile(path.join(dir, 'study', 'caf\u00e9.edf'), await readFile(fixture('tiny.edf')));
    await writeFile(path.join(dir, 'study', 'cafe\u0301.bdf'), await readFile(fixture('biosemi.bdf')));
    assert.equal((await readdir(path.join(dir, 'study'))).length, 2, 'the two files must coexist');

    for (const extra of [[], ['--force']]) {
      const out = path.join(dir, `csv${extra.length}`);
      const { code, stderr } = await cli([path.join(dir, 'study'), '--out', out, ...extra]);
      assert.equal(code, 2, `expected a refusal${extra.length ? ' even with --force' : ''}`);
      assert.match(stderr, /would both be converted into/u);
      assert.equal(await exists(out), false, 'and nothing may be written');
    }
  });

  it('decides what --out means from what was named, not from what a folder held', async () => {
    // 0.4.20 took this decision off the recording count; the flag it left behind answered
    // "did any input come from a directory" rather than "was a directory named", which is
    // the same thing only when the directory yielded something. So
    // `edf2csv study named.edf --out csv` wrote csv/named/ while the study held recordings
    // and csv/signals.csv once it held none: whether an unrelated folder happened to contain
    // anything decided where a different recording's output went.
    const dir = await stage({ 'study/night-01/rec.edf': 'tiny.edf', 'named.edf': 'tiny.edf' });
    await mkdir(path.join(dir, 'blank'), { recursive: true });

    const withRecordings = path.join(dir, 'a');
    const full = await cli([
      path.join(dir, 'study'), path.join(dir, 'named.edf'), '--out', withRecordings, '--quiet',
    ]);
    assert.equal(full.code, 0, full.stderr);

    const withNone = path.join(dir, 'b');
    const empty = await cli([
      path.join(dir, 'blank'), path.join(dir, 'named.edf'), '--out', withNone, '--quiet',
    ]);
    assert.equal(empty.code, 0, empty.stderr);

    // The named recording lands in the same place either way.
    for (const out of [withRecordings, withNone]) {
      assert.ok(
        (await readdir(path.join(out, 'named'))).includes('signals.csv'),
        `named.edf did not land in ${out}/named`,
      );
    }

    // And naming one recording on its own still means the output directory itself.
    const alone = path.join(dir, 'c');
    await cli([path.join(dir, 'named.edf'), '--out', alone, '--quiet']);
    assert.ok((await readdir(alone)).includes('signals.csv'));
  });

  it('passes a value beginning with a dash to its children unambiguously', async () => {
    // Child argv was built as two arguments per option, so a value beginning with a dash was
    // another option as far as the child's parser was concerned: `--out ./-nightly` reached
    // it as `--out` followed by `-nightly`, and the child died on "Option '--out' argument is
    // ambiguous" while the serial path converted the same command without complaint. A
    // leading dash is not exotic — path.join produces one from a folder given as `.`.
    const dir = await stage({ 'in/a.edf': 'tiny.edf', 'in/b.edf': 'tiny.edf' });
    const awkward = path.join(dir, '-nightly');

    const parallel = await cli([path.join(dir, 'in'), '--out', awkward, '--jobs', '2', '--quiet']);
    assert.equal(parallel.code, 0, `--jobs refused a destination serial accepts:\n${parallel.stderr}`);
    assert.deepEqual((await readdir(awkward)).sort(), ['a', 'b']);

    // And it produces exactly what the serial path does.
    const serial = path.join(dir, '-serial');
    await cli([path.join(dir, 'in'), '--out', serial, '--quiet']);
    for (const name of ['a', 'b']) {
      assert.equal(
        await readFile(path.join(serial, name, 'signals.csv'), 'utf8'),
        await readFile(path.join(awkward, name, 'signals.csv'), 'utf8'),
      );
    }
  });

  it('states a recording\'s length the way --info states it', async () => {
    // The message whose job is to tell you how long the recording actually is rendered it as
    // a bare number of seconds, while --info printed the humanised form for the same file in
    // the same session: "6m 40s" against "400s", and "7950s recording" on an overnight file,
    // leaving the reader to divide by 3600 to judge whether their --start was reasonable.
    // cli-reference.md has always documented it humanised, a form no input could produce.
    const info = await cli([fixture('long-stream.edf'), '--info']);
    const duration = /Duration\s+(\S+(?: \S+)*?)\s+\(/u.exec(info.stdout);
    assert.ok(duration, info.stdout);
    assert.equal(duration[1], '6m 40s');

    const past = await cli([fixture('long-stream.edf'), '--start', '10m', '--out', await outDir()]);
    assert.equal(past.code, 2, past.stderr);
    assert.match(past.stderr, /at or past the end of this 6m 40s recording/u);
    // The typed value still comes back exactly as it was written.
    assert.match(past.stderr, /--start "10m"/u);

    // A recording short enough that the two renderings coincide is unchanged, which is the
    // case the reference's other example uses.
    const short = await cli([fixture('tiny.edf'), '--start', '600s', '--out', await outDir()]);
    assert.match(short.stderr, /at or past the end of this 2s recording/u);
  });

  it('says where signals.csv went when there was nothing to put in it', async () => {
    // Selecting a channel that carries zero samples per record leaves no table to write, so
    // the run produces channels.csv and metadata.json and no signals.csv — while the
    // documentation says signals.csv is written unless --annotations-only was passed. The
    // NO_SAMPLES warning explained the channel; nothing explained the missing file.
    const dir = await outDir();
    const converted = await cli([
      fixture('single-rate-empty-channel.edf'), '--channels', 'unused', '--out', dir,
    ]);
    assert.equal(converted.code, 0, converted.stderr);
    assert.match(converted.stderr, /No signal file was written/u);
    assert.deepEqual((await readdir(dir)).sort(), ['channels.csv', 'metadata.json']);

    // And --info stops calling that channel "(not selected)" when it is exactly what was
    // selected — the table contradicted the warning printed below it.
    const info = await cli([
      fixture('single-rate-empty-channel.edf'), '--info', '--channels', 'unused',
    ]);
    const row = info.stdout.split('\n').find((l) => l.includes('unused'));
    assert.match(row, /\(no samples\)/u, row);

    // A channel that has samples and was not selected still says so — "(no samples)" is
    // about what the file gives the channel, and takes precedence because it is true whether
    // or not the channel was asked for.
    const real = info.stdout.split('\n').find((l) => l.includes('real'));
    assert.match(real, /\(not selected\)/u, real);
  });

  it('does not promise nothing for a run that writes a file', async () => {
    // The estimate describes the signal tables, so under --annotations-only there was
    // nothing to describe and the line read "Would write 0 rows, roughly 0 B." — for a
    // conversion that goes on to write annotations.csv with three events in it. --info
    // exists to say what a conversion will do, so asserting it will write nothing when it
    // will write a file is the one thing it must not do.
    const withEvents = await cli([fixture('annotations.edf'), '--info', '--annotations-only']);
    assert.equal(withEvents.code, 0, withEvents.stderr);
    assert.ok(!/Would write 0 rows/u.test(withEvents.stdout), withEvents.stdout);
    assert.match(withEvents.stdout, /Would write annotations\.csv and channels\.csv/u);
    // The event count needs the annotation channel read record by record, which is the scan
    // --info exists to avoid, so it says so rather than inventing a number.
    assert.match(withEvents.stdout, /cannot be told from the header/u);
    assert.ok(!withEvents.stdout.includes('signals.csv'), 'no signal file is named');

    const dir = await outDir();
    await cli([fixture('annotations.edf'), '--out', dir, '--annotations-only', '--quiet']);
    const events = (await readFile(path.join(dir, 'annotations.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(events.length - 1, 3, 'the run it described did write events');

    // A file with no annotation channel gets told that too, rather than the same sentence.
    const without = await cli([fixture('tiny.edf'), '--info', '--annotations-only']);
    assert.match(without.stdout, /no annotations\.csv either/u);

    // And an ordinary --info still reports rows and bytes.
    const ordinary = await cli([fixture('annotations.edf'), '--info']);
    assert.match(ordinary.stdout, /Would write 300 rows, roughly/u);
  });

  it('reports an unreadable timekeeping TAL it read, on a continuous recording', async () => {
    /*
      --info avoids scanning every record on a continuous file: it reads at most sixteen to
      find the origin. That read decodes the TAL and sees it fail — and the count was
      hard-coded to zero at the call site, so the failure was read and thrown away. The file
      raised ANNOTATION_DECODE_FAILED when converted and nothing under --info, while its
      byte-identical EDF+D twin, differing only in a reserved field that has nothing to do
      with the defect, raised it both ways.
    */
    // Matched on the code rather than the sentence: the continuous and discontinuous paths
    // word this differently, and the point is that both raise it at all.
    const codes = async (args) =>
      new Set(JSON.parse((await cli([...args, '--json'])).stdout).warnings.map((w) => w.code));

    for (const name of ['lost-timekeeping.edf', 'lost-timekeeping-d.edf']) {
      const fromInfo = await codes([fixture(name), '--info']);
      assert.ok(fromInfo.has('ANNOTATION_DECODE_FAILED'), `${name}: --info said nothing`);

      const fromRun = await codes([fixture(name), '--out', await outDir(), '--quiet']);
      assert.ok(fromRun.has('ANNOTATION_DECODE_FAILED'), `${name}: the conversion said nothing`);

      // And --strict agrees with itself across the two modes.
      assert.equal((await cli([fixture(name), '--info', '--strict'])).code, 1, name);
    }

    // A recording whose timekeeping is readable says nothing, either way.
    const quiet = await codes([fixture('annotations.edf'), '--info']);
    assert.ok(!quiet.has('ANNOTATION_DECODE_FAILED'), [...quiet].join());
  });

  it('does not promise nothing for a recording that has no signal channels', async () => {
    /*
      0.4.51 removed "Would write 0 rows, roughly 0 B." for `--annotations-only`. A recording
      that simply has no signal channels reaches the same state by a different route — no
      rate groups to describe — and got the same sentence, for a conversion that writes an
      annotations.csv with events in it beside channels.csv and metadata.json.
    */
    const { code, stdout } = await cli([fixture('annotations-only.edf'), '--info']);
    assert.equal(code, 0);
    assert.ok(!/Would write 0 rows/u.test(stdout), stdout);
    assert.match(stdout, /Would write annotations\.csv and channels\.csv/u);

    // And the conversion it described does write them.
    const dir = await outDir();
    await cli([fixture('annotations-only.edf'), '--out', dir, '--quiet']);
    assert.deepEqual(
      (await readdir(dir)).sort(),
      ['annotations.csv', 'channels.csv', 'metadata.json'],
    );
    const events = await readFile(path.join(dir, 'annotations.csv'), 'utf8');
    assert.ok(events.trimEnd().split('\n').length > 1, 'and it holds events');
  });

  it('names the annotation-only files as --gzip will actually write them', async () => {
    /*
      The two sentences above were string literals, and the gzip check below them reads the
      group file names — of which there are none under --annotations-only. So --info named
      annotations.csv for a run that went on to write annotations.csv.gz, and a script that
      opened the name it was given got ENOENT.
    */
    const { code, stdout } = await cli([
      fixture('annotations.edf'),
      '--info',
      '--annotations-only',
      '--gzip',
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /Would write annotations\.csv\.gz and channels\.csv\.gz/u);

    const dir = await outDir();
    await cli([fixture('annotations.edf'), '--out', dir, '--annotations-only', '--gzip', '--quiet']);
    assert.deepEqual(
      (await readdir(dir)).sort(),
      ['annotations.csv.gz', 'channels.csv.gz', 'metadata.json'],
      'the names --info gave are the names on disk',
    );

    const without = await cli([fixture('tiny.edf'), '--info', '--annotations-only', '--gzip']);
    assert.match(without.stdout, /no annotations\.csv\.gz either/u);
  });

  it('agrees with the conversion about where a recording starts', async () => {
    // --info reads one record's annotation bytes rather than scanning the file, which is
    // what keeps it a header read. It stopped at record 0, so the moment that record's
    // timekeeping entry was unreadable the two halves of the tool disagreed: the conversion
    // took the origin from record 1 and timed the file from 0.5s, while --info found nothing
    // at record 0 and reported a recording starting at zero.
    //
    // --start 3 is where that shows: --info refused it as past the end of a 3s recording
    // while the conversion wrote two rows for it.
    const window = ['--start', '3'];
    const info = await cli([fixture('lost-timekeeping.edf'), '--info', ...window]);
    assert.equal(info.code, 0, `--info refused a window the conversion accepts:\n${info.stderr}`);
    assert.match(info.stdout, /Would write 2 rows/u);

    const dir = await outDir();
    const converted = await cli([fixture('lost-timekeeping.edf'), '--out', dir, ...window, '--quiet']);
    assert.equal(converted.code, 0, converted.stderr);
    const rows = (await readFile(path.join(dir, 'signals.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(rows.length - 1, 2, 'and the estimate was right about how many');
    assert.match(rows[1], /^3\.000,/u, 'timed from the origin the other records establish');
  });

  it('treats a directory as an input rather than as a mistake', async () => {
    // The CLI reference described the pre-folder contract for a long time after folders
    // became inputs: "The input path must be a regular file that can be read. A directory,
    // a missing path or a special file is a file error (exit 1), not a usage error." Every
    // clause of that is now wrong for a directory, and the exit codes it gives are wrong
    // too — an empty folder is 2, not 1. This pins what the documentation now says.
    const dir = await stage({ 'study/rec.edf': 'tiny.edf' });

    const folder = await cli([path.join(dir, 'study'), '--out', path.join(dir, 'csv'), '--quiet']);
    assert.equal(folder.code, 0, `a folder of recordings converts: ${folder.stderr}`);

    await mkdir(path.join(dir, 'nothing'), { recursive: true });
    const empty = await cli([path.join(dir, 'nothing'), '--out', path.join(dir, 'x')]);
    assert.equal(empty.code, 2, 'a folder holding none is the command being wrong');

    const missing = await cli([path.join(dir, 'absent.edf'), '--out', path.join(dir, 'y')]);
    assert.equal(missing.code, 1, 'a named file that is not there is still a file error');

    // The library still refuses a directory, which is what the reference now says.
    const { EdfFile, EdfError } = await import('../dist/index.js');
    await assert.rejects(EdfFile.open(path.join(dir, 'study')), (error) => {
      assert.ok(error instanceof EdfError);
      assert.match(error.message, /is a directory, not an EDF file/u);
      return true;
    });
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

  it('shapes --json by what was named, not by what was found', async () => {
    // The batch flag was `inputs.length > 1`, so the shape of the output depended on the
    // contents of a folder: a study holding one night printed an indented document and the
    // same study holding two printed JSON Lines. A script written against one broke on the
    // other, on the day a recording was added rather than the day the script changed — and
    // an input going missing did it in reverse. Same count 0.4.20 took out of --out.
    const oneLine = (text) => text.trimEnd().split('\n');

    const alone = await stage({ 'study/night-01/rec.edf': 'tiny.edf' });
    const first = await cli([path.join(alone, 'study'), '--out', path.join(alone, 'csv'), '--json']);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(oneLine(first.stdout).length, 1, 'a folder is JSON Lines even with one in it');
    JSON.parse(first.stdout);

    const beside = await stage({
      'study/night-01/rec.edf': 'tiny.edf',
      'study/night-02/rec.edf': 'tiny.edf',
    });
    const second = await cli([path.join(beside, 'study'), '--out', path.join(beside, 'csv'), '--json']);
    assert.equal(second.code, 0, second.stderr);
    const lines = oneLine(second.stdout);
    assert.equal(lines.length, 2);
    for (const line of lines) JSON.parse(line);

    // Naming one recording still gives the indented document a single conversion prints.
    const named = await cli([
      path.join(alone, 'study', 'night-01', 'rec.edf'), '--out', path.join(alone, 'direct'), '--json',
    ]);
    assert.equal(named.code, 0, named.stderr);
    assert.ok(oneLine(named.stdout).length > 1, `expected an indented document, got ${named.stdout}`);
    JSON.parse(named.stdout);
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

  it('names a conversion that was killed, and the directory it left behind', async () => {
    // A process that dies by signal exits with a null code and says nothing on its way out.
    // The parent read that as an ordinary failure with empty output, so the run printed
    // "Converted 29 of 30 recordings; 1 failed." and stopped: not which recording, not why,
    // and not that its directory held a signals.csv cut off mid-row with no channels.csv
    // beside it. The out-of-memory killer, a scheduler's time limit and `kill` all arrive
    // this way, and half a CSV opens in pandas exactly like a whole one.
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-killed-'));
    temporaries.push(dir);
    const source = await readFile(fixture('long-stream.edf'));
    const names = [];
    for (let i = 0; i < 30; i++) {
      const name = path.join(dir, `r${String(i).padStart(2, '0')}.edf`);
      await writeFile(name, source);
      names.push(name);
    }

    const out = path.join(dir, 'out');
    const { spawn, execFile: raw } = await import('node:child_process');
    const run = spawn(process.execPath, [CLI, ...names, '--out', out, '--jobs', '2'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    run.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });

    // Only the children carry `<out>/rNN`: the parent's --out is `<out>` and its inputs are
    // `<dir>/rNN.edf`, so neither of its arguments contains that path.
    const childPid = async () =>
      new Promise((resolve) => {
        raw('pgrep', ['-f', `${out}/r`], (_error, stdout) =>
          resolve((stdout ?? '').trim().split('\n').filter(Boolean)[0]),
        );
      });

    let victim;
    for (let tries = 0; tries < 100 && victim === undefined; tries++) {
      victim = await childPid();
      if (victim === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(victim, 'no conversion was running to kill');
    process.kill(Number(victim), 'SIGKILL');

    const code = await new Promise((resolve) => run.on('close', resolve));
    assert.notEqual(code, 0, `a killed conversion is a failed run, stderr was:\n${stderr}`);
    assert.match(
      stderr,
      /error: .*r\d\d\.edf: stopped by SIGKILL before it finished\./u,
      `the killed recording must be named, stderr was:\n${stderr}`,
    );
    assert.match(
      stderr,
      /Incomplete, and should not be used: .*out\/r\d\d/u,
      'and so must the directory it left behind',
    );
  });

  it('rejects a job count that is not a whole number of one or more', async () => {
    // Checked in every mode, including the two where the value cannot be honoured anyway:
    // --stdout converts one recording however many jobs are asked for, but a request that
    // cannot be met is a usage error rather than something to accept in silence.
    for (const mode of [['--info'], ['--stdout']]) {
      for (const jobs of ['0', 'abc', '1.5', '']) {
        const { code, stderr } = await cli([fixture('tiny.edf'), '--jobs', jobs, ...mode]);
        assert.equal(code, 2, `--jobs ${JSON.stringify(jobs)} ${mode.join(' ')}`);
        assert.match(stderr, /--jobs must be a whole number/u);
      }
    }
  });

  it('counts a warning as a conversion, however many jobs there are', async () => {
    // An exit code cannot separate "converted, and raised warnings" from "did not convert",
    // and under --strict those were the same code. The parent read it as a failure, so a
    // parallel run of two recordings — one of which merely warned — reported
    // "Converted 1 of 2 recordings; 1 failed" for a run in which both converted.
    const dir = await stage({ 'study/clean.edf': 'tiny.edf', 'study/warns.edf': 'mixed-rates.edf' });

    for (const jobs of ['1', '2']) {
      const { code, stderr } = await cli([
        path.join(dir, 'study'), '--out', path.join(dir, `out-${jobs}`), '--strict', '--jobs', jobs,
      ]);
      assert.equal(code, 1, `--strict fails the run either way (--jobs ${jobs})`);
      assert.match(stderr, /Converted 2 of 2 recordings/u, `--jobs ${jobs} miscounted`);
      assert.ok(!stderr.includes('failed'), `--jobs ${jobs}: nothing failed`);
      // One verdict on the whole run, not one per child.
      assert.equal(stderr.match(/--strict:/gu)?.length, 1, `--jobs ${jobs}: one verdict`);
      assert.deepEqual((await readdir(path.join(dir, `out-${jobs}`))).sort(), ['clean', 'warns']);
    }
  });

  it('still counts a real failure as a failure in parallel', async () => {
    const dir = await stage({ 'study/good.edf': 'tiny.edf' });
    await writeFile(path.join(dir, 'study', 'bad.edf'), 'not an edf');
    const { code, stderr } = await cli([
      path.join(dir, 'study'), '--out', path.join(dir, 'out'), '--jobs', '2',
    ]);
    assert.equal(code, 1);
    assert.match(stderr, /Converted 1 of 2 recordings; 1 failed/u);
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

/** Run the CLI with stdout redirected to a regular file, which is what the audit checks. */
async function shellTo(args, destination) {
  const quoted = args.map((a) => `"${a}"`).join(' ');
  try {
    const { stderr } = await run('/bin/sh', [
      '-c',
      `"${process.execPath}" "${CLI}" ${quoted} > "${destination}"`,
    ]);
    return { code: 0, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stderr: String(error.stderr ?? '') };
  }
}

describe('what the summary says it did', () => {
  it('does not report a conversion to a reader that stopped reading', async () => {
    /*
      `edf2csv rec.edf --stdout | head -1` announced "Wrote 52,507 rows to stdout" for a
      102,400-row recording of which the reader took one line. That number is neither total:
      it is however many had been formatted before the closed pipe was noticed. What reached
      the reader cannot be known from this side. That it stopped early can.
    */
    const { stderr } = await run(
      '/bin/sh',
      ['-c', `"${process.execPath}" "${CLI}" "${fixture('long-stream.edf')}" --stdout | head -1`],
    );
    assert.match(stderr, /the reader closed the pipe after [\d,]+ of [\d,]+ rows/u);
    assert.match(stderr, /was not converted in full/u);
    assert.ok(!/^Wrote /mu.test(stderr), `still claims a conversion:\n${stderr}`);

    // A run nobody interrupted still reports its rows the way it always did.
    const whole = await cli([fixture('long-stream.edf'), '--stdout']);
    assert.equal(whole.code, 0);
    assert.match(whole.stderr, /Wrote 102,400 rows to stdout\./u);
  });

  it('does not call a conversion incomplete because the reader stopped reading', async () => {
    /*
      Whether the conversion stopped early and whether the reader did are different
      questions, and 0.5.12 answered the first with the second. A recording whose CSV outruns
      the pipe buffer but fits inside one flush is written in full and only then meets the
      closed pipe — every row formatted, every row handed over — and the summary said "The
      recording was not converted in full."

      The estimate's row count is exact, so the two cases can be told apart.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-mid-'));
    temporaries.push(dir);
    const recording = path.join(dir, 'mid.edf');
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    // 10,000 rows: past the 64 KiB pipe buffer, inside the flush threshold.
    writeEdf({
      path: recording,
      numRecords: 100,
      recordDuration: 1,
      signals: [
        {
          label: 'EEG',
          dimension: 'uV',
          physMin: -250,
          physMax: 250,
          digMin: -2048,
          digMax: 2047,
          samplesPerRecord: 100,
          gen: (record, sample) => ((record * 7 + sample) % 4095) - 2048,
        },
      ],
    });

    const { stderr } = await run('/bin/sh', [
      '-c',
      `"${process.execPath}" "${CLI}" "${recording}" --stdout | head -1`,
    ]);
    assert.match(stderr, /Wrote 10,000 rows to stdout, but the reader closed the pipe/u);
    assert.ok(!/was not converted in full/u.test(stderr), stderr);
  });

  it(`calls a compressed CSV's rows rows`, async () => {
    // `.csv.gz` does not end in `.csv`, so the unit was dropped from every line of a --gzip
    // summary and the numbers stood on their own with nothing saying what they counted.
    const dir = await outDir();
    const { stderr } = await cli([fixture('annotations.edf'), '--out', dir, '--gzip']);
    for (const name of ['signals.csv.gz', 'annotations.csv.gz', 'channels.csv.gz']) {
      assert.match(
        stderr,
        new RegExp(`${name.replaceAll('.', '\\.')}\\s+[\\d,]+\\s+rows`, 'u'),
        `${name} has no unit:\n${stderr}`,
      );
    }
  });
});

describe('--info over a folder', () => {
  it('names the recording each warning came from, as a conversion does', async () => {
    /*
      The table goes to stdout and the warnings to stderr, which is the point of the split.
      Over a folder that left several warnings in a row on stderr with nothing saying which
      recording raised any of them: two recordings, two warnings, and no way to pair them up
      short of running the tool again one file at a time. A batch conversion has named its
      recordings since 0.4.20.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-infodir-'));
    temporaries.push(dir);
    for (const [name, source] of [
      ['night-01.edf', 'mixed-rates.edf'],
      ['night-02.edf', 'truncated.edf'],
    ]) {
      await writeFile(path.join(dir, name), await readFile(fixture(source)));
    }
    const { code, stderr } = await cli([dir, '--info']);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /warning: .*night-01\.edf: Channels use 3 different sampling rates/u);
    assert.match(stderr, /warning: .*night-02\.edf: The header declares 10 data records/u);

    // One recording has nothing to be confused with, so it says what it always said.
    const single = await cli([fixture('mixed-rates.edf'), '--info']);
    assert.match(single.stderr, /^warning: Channels use 3 different sampling rates/mu);
  });
});

describe('--info and the destination guards', () => {
  it('describes the recordings instead of refusing over output it will not write', async () => {
    /*
      Both collision guards refused --info. A folder holding `rec.edf` beside
      `rec/inner.edf` gave exit 2 and "would be converted into yy/rec/inner, which is inside
      yy/rec", printing nothing about either recording; two recordings whose names collide
      got the overwrite refusal the same way. Both messages assert a conversion and an
      overwrite that --info does not perform, and the identical command without --out
      described both files happily.

      Which makes the refused command the useful one: --info --out is how you ask what a run
      would produce before committing to it, and a collision is exactly what you would want
      it to show you.
    */
    const nested = await mkdtemp(path.join(tmpdir(), 'edf2csv-nested-'));
    temporaries.push(nested);
    await mkdir(path.join(nested, 'study', 'rec'), { recursive: true });
    await writeFile(path.join(nested, 'study', 'rec.edf'), await readFile(fixture('tiny.edf')));
    await writeFile(
      path.join(nested, 'study', 'rec', 'inner.edf'),
      await readFile(fixture('annotations.edf')),
    );

    const info = await cli([path.join(nested, 'study'), '--info', '--out', path.join(nested, 'yy')]);
    assert.equal(info.code, 0, info.stderr);
    assert.equal((info.stdout.match(/^File /gmu) ?? []).length, 2, 'both recordings described');

    // The conversion it was warning about is still refused.
    const run = await cli([path.join(nested, 'study'), '--out', path.join(nested, 'yy2')]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /cannot sit inside another's/u);
  });

  it('describes recordings whose names would collide, rather than refusing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-collide-'));
    temporaries.push(dir);
    for (const [name, source] of [['n1', 'tiny.edf'], ['n2', 'annotations.edf']]) {
      await mkdir(path.join(dir, name), { recursive: true });
      await writeFile(path.join(dir, name, 'rec.edf'), await readFile(fixture(source)));
    }
    const both = [path.join(dir, 'n1', 'rec.edf'), path.join(dir, 'n2', 'rec.edf')];

    const info = await cli([...both, '--info', '--out', path.join(dir, 'xx')]);
    assert.equal(info.code, 0, info.stderr);
    assert.equal((info.stdout.match(/^File /gmu) ?? []).length, 2);

    const run = await cli([...both, '--out', path.join(dir, 'xx2')]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /would both be converted into/u);
  });
});

describe('a folder the process cannot read', () => {
  it('is a failure, not a usage error, and does not claim the folder is empty', async () => {
    /*
      "None here" and "could not look" are different answers. An unreadable folder gave the
      same exit 2 and the same "No EDF or BDF recordings found" as an empty one — directly
      under a line saying the folder could not be read. Exit 2 is this tool's code for "the
      command itself was wrong", so a script was being told to fix its arguments when what
      needed fixing was a permission.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-locked-'));
    temporaries.push(dir);
    const locked = path.join(dir, 'locked');
    await mkdir(locked);
    await writeFile(path.join(locked, 'night.edf'), await readFile(fixture('tiny.edf')));
    await chmod(locked, 0o000);
    try {
      const { code, stderr } = await cli([locked, '--out', path.join(dir, 'out')]);
      assert.equal(code, 1, `a permission is not a usage error:\n${stderr}`);
      assert.match(stderr, /could not be read/u);
      assert.ok(
        !/No EDF or BDF recordings found/u.test(stderr),
        'it did not look, so it cannot say there were none',
      );
      assert.match(stderr, /whether it holds recordings is unknown/u);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('counts an unreadable path in the closing line, not only in the exit code', async () => {
    /*
      A folder holding one recording beside a sub-directory without read permission printed
      "Converted 1 of 1 recordings." and exited 1: a line agreeing with itself and with
      nothing else. The unreadable paths were added to the failure count after the summary
      had already printed.

      This is the sentence the walk's own comment quotes as the thing it fixed. What was
      fixed then was the error line and the exit code; the summary went on saying everything
      worked.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-unread-'));
    temporaries.push(dir);
    const inside = path.join(dir, 'in');
    const locked = path.join(inside, 'locked');
    await mkdir(locked, { recursive: true });
    await writeFile(path.join(inside, 'night.edf'), await readFile(fixture('tiny.edf')));
    await writeFile(path.join(locked, 'other.edf'), await readFile(fixture('annotations.edf')));
    await chmod(locked, 0o000);
    try {
      const { code, stderr } = await cli([inside, '--out', path.join(dir, 'out')]);
      assert.equal(code, 1, stderr);
      assert.match(stderr, /Converted 1 of 1 recordings; 1 path could not be read\./u);
    } finally {
      await chmod(locked, 0o755);
    }

    // An ordinary batch says what it always said.
    const clean = path.join(dir, 'clean');
    await mkdir(clean, { recursive: true });
    await writeFile(path.join(clean, 'a.edf'), await readFile(fixture('tiny.edf')));
    await writeFile(path.join(clean, 'b.edf'), await readFile(fixture('annotations.edf')));
    const ok = await cli([clean, '--out', path.join(dir, 'clean-out')]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stderr, /Converted 2 of 2 recordings\./u);
  });

  it('still calls an empty folder empty, and that a usage error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-emptydir-'));
    temporaries.push(dir);
    const { code, stderr } = await cli([dir]);
    assert.equal(code, 2, stderr);
    assert.match(stderr, /No EDF or BDF recordings found/u);
  });
});

describe('what --stdout says about itself', () => {
  it('does not claim a restriction that --layout long removed', async () => {
    // 0.5.0 made --stdout work on a mixed-rate recording and left the help saying
    // "(single-rate recordings only)" — twenty lines above its own paragraph explaining
    // that --layout long is how a mixed-rate file streams.
    const { stdout } = await cli(['--help']);
    const works = await cli([fixture('mixed-rates.edf'), '--stdout', '--layout', 'long']);
    assert.equal(works.code, 0, works.stderr);
    assert.ok(
      !/single-rate recordings only/u.test(stdout),
      'the help forbids what the tool just did',
    );
  });

  it('refuses the flags it used to accept and drop', async () => {
    /*
      --out named a directory that was never created, so the run looked like it had written
      one. --checksum was worse: the hash is computed before the first record is read — a
      second full pass over the input — and the only file it is ever written to is
      metadata.json, which --stdout does not write. Refusing is what this tool already does
      for --stdout with --json and with --annotations-only.
    */
    const dir = await outDir();
    const out = await cli([fixture('tiny.edf'), '--stdout', '--out', dir]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /--stdout and --out cannot be combined/u);
    await assert.rejects(() => stat(dir), 'and no directory is left behind');

    const checksum = await cli([fixture('tiny.edf'), '--stdout', '--checksum']);
    assert.equal(checksum.code, 2);
    assert.match(checksum.stderr, /--stdout and --checksum cannot be combined/u);
  });

  it('refuses a recording with no signal table instead of streaming nothing', async () => {
    /*
      A recording holding only EDF+ annotations produces no rate groups. The wide layout
      said "--stdout needs exactly one table, but this recording produces 0, one for each
      sampling rate its channels use ()" — an empty parenthetical, advice to narrow to one
      of no rates, and advice to use --layout long. Which wrote zero bytes to stdout, not
      even a header row, exited 0, and warned that "the signal files hold their headers and
      no data": there were no files and there was no header.
    */
    for (const layout of [[], ['--layout', 'long']]) {
      const { code, stdout, stderr } = await cli([
        fixture('annotations-only.edf'),
        '--stdout',
        ...layout,
      ]);
      assert.equal(code, 2, stderr);
      assert.equal(stdout, '', 'nothing goes to stdout when there is nothing to write');
      assert.match(stderr, /no signal channels, only EDF\+ annotations/u);
      assert.ok(!/produces 0/u.test(stderr), stderr);
      assert.ok(!/use \(\)/u.test(stderr), `empty parenthetical:\n${stderr}`);
    }

    // Channels that exist but carry nothing get a different sentence, since the fix differs.
    const selected = await cli([
      fixture('single-rate-empty-channel.edf'),
      '--stdout',
      '--channels',
      'unused',
    ]);
    assert.equal(selected.code, 2);
    assert.match(selected.stderr, /nothing was selected that carries samples/u);

    // And a recording that does have a table still streams.
    const works = await cli([fixture('mixed-rates.edf'), '--stdout', '--layout', 'long']);
    assert.equal(works.code, 0, works.stderr);
    assert.equal(works.stdout.split('\n')[0], 'time_s,channel,value');
  });

  it('streams a recording named twice, which is still one recording', async () => {
    /*
      0.5.40 made the run's shape count the names rather than the recordings, which is right
      for --out and for --json. This guard read that count, and they are different questions:
      `edf2csv one.edf one.edf --stdout` is one recording, named twice, converted once, and
      perfectly streamable. It was refused with the message written for a folder — telling
      the reader to "name the recording itself" and quoting the name they had just given
      twice.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-twice-'));
    temporaries.push(dir);
    await writeFile(path.join(dir, 'one.edf'), await readFile(fixture('tiny.edf')));
    await writeFile(path.join(dir, 'two.edf'), await readFile(fixture('annotations.edf')));
    const one = path.join(dir, 'one.edf');
    await symlink(one, path.join(dir, 'alias.edf'));

    for (const args of [[one, one], [one, path.join(dir, 'alias.edf')]]) {
      const { code, stdout, stderr } = await cli([...args, '--stdout']);
      assert.equal(code, 0, stderr);
      assert.equal(stdout.split('\n')[0], 'time_s,ch1,ch2');
    }

    // Two recordings still cannot be one stream, and a folder is still a folder.
    const several = await cli([one, path.join(dir, 'two.edf'), '--stdout']);
    assert.equal(several.code, 2);
    assert.match(several.stderr, /cannot take 2 recordings/u);

    const alone = path.join(dir, 'alone');
    await mkdir(alone, { recursive: true });
    await writeFile(path.join(alone, 'night.edf'), await readFile(fixture('tiny.edf')));
    const folder = await cli([alone, '--stdout']);
    assert.equal(folder.code, 2);
    assert.match(folder.stderr, /a folder is converted as a batch/u);
  });

  it('counts a folder of one as a folder, not as one recording it cannot take', async () => {
    // "--stdout writes a single CSV, so it cannot take 1 recordings" — ungrammatical, and
    // wrong on its face, since one recording is exactly what it can take. What it cannot
    // take is a folder.
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-one-'));
    temporaries.push(dir);
    await writeFile(path.join(dir, 'night.edf'), await readFile(fixture('tiny.edf')));

    const { code, stderr } = await cli([dir, '--stdout']);
    assert.equal(code, 2);
    assert.ok(!/take 1 recordings/u.test(stderr), stderr);
    assert.match(stderr, /a folder is converted as a batch even when it holds one recording/u);
    assert.match(stderr, /night\.edf/u, 'and names the recording to run instead');
  });
});

describe('--layout long', () => {
  it('puts every rate in one table, in time order, with nothing invented', async () => {
    /*
      The wide layout has to split a mixed-rate recording across files: a 256 Hz channel and
      a 1 Hz channel share no rows, so one table holding both means either 255 empty cells
      in every 256 or inventing the samples to fill them. The long layout gives each sample
      its own time, so the same recording fits one table and every value in it is a value
      the file holds.
    */
    const wideDir = await outDir();
    const longDir = await outDir();
    assert.equal((await cli([fixture('mixed-rates.edf'), '--out', wideDir, '--quiet'])).code, 0);
    assert.equal(
      (await cli([fixture('mixed-rates.edf'), '--out', longDir, '--layout', 'long', '--quiet'])).code,
      0,
    );

    assert.deepEqual(
      (await readdir(longDir)).sort(),
      ['channels.csv', 'metadata.json', 'signals.csv'],
      'one signal file, whatever the rates',
    );

    const rows = (await readFile(path.join(longDir, 'signals.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(rows[0], 'time_s,channel,value');

    let previous = -Infinity;
    const byKey = new Map();
    for (const row of rows.slice(1)) {
      const [time, channel, value] = row.split(',');
      assert.ok(Number(time) >= previous, `time went backwards at ${row}`);
      previous = Number(time);
      byKey.set(`${Number(time).toFixed(8)}|${channel}`, value);
    }

    // Every cell of the wide conversion is present, with the same text.
    let cells = 0;
    for (const name of (await readdir(wideDir)).filter((n) => n.startsWith('signals'))) {
      const wide = (await readFile(path.join(wideDir, name), 'utf8')).trimEnd().split('\n');
      const columns = wide[0].split(',').slice(1);
      for (const row of wide.slice(1)) {
        const parts = row.split(',');
        for (const [index, column] of columns.entries()) {
          cells++;
          assert.equal(
            byKey.get(`${Number(parts[0]).toFixed(8)}|${column}`),
            parts[index + 1],
            `${column} at ${parts[0]}`,
          );
        }
      }
    }
    assert.equal(cells, rows.length - 1, 'and nothing beyond them');

    // channels.csv names the one file they all landed in.
    const channels = await readFile(path.join(longDir, 'channels.csv'), 'utf8');
    assert.ok(!channels.includes('signals_256hz.csv'), channels);
  });

  it('orders channels at one time as the file declares them, not by rate', async () => {
    /*
      Rate groups are sorted largest-rate-first, because that is how the wide layout names
      its files, and emitting a tie group by group let that leak into the rows. A recording
      declaring `slow, medium, fast` wrote `fast, medium, slow` at every instant where all
      three had a sample — while channels.csv listed file order and the documentation
      promised it. Most recordings declare their fastest channels first, which hides it.
    */
    const dir = await outDir();
    await cli([fixture('ascending-rates.edf'), '--out', dir, '--layout', 'long', '--quiet']);
    const rows = (await readFile(path.join(dir, 'signals.csv'), 'utf8')).trimEnd().split('\n');

    const atZero = rows.slice(1).filter((row) => row.startsWith('0.000,')).map((row) => row.split(',')[1]);
    assert.deepEqual(atZero, ['slow', 'medium', 'fast'], 'the order the header declares');

    // And the wide layout's columns are the same order, which is the point of matching it.
    const wide = await outDir();
    await cli([fixture('ascending-rates.edf'), '--out', wide, '--quiet']);
    const channels = (await readFile(path.join(wide, 'channels.csv'), 'utf8'))
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((row) => row.split(',')[0]);
    assert.deepEqual(channels, ['slow', 'medium', 'fast']);
  });

  it('holds that order when two rates land on one instant a ULP apart', async () => {
    /*
      0.5.9 made tied channels come out in file order and tested equality on the double. Two
      exact divisions of the same instant need not give the same double: a 0.3 s record with
      12 and 4 samples is 40 Hz and 13.333… Hz, and 9/40 is 0.22500000000000000555 while
      3/13.333… is 0.22499999999999997780. So at that one instant the rows fell out in
      numeric order — `slow` before `fast` — in a file that was otherwise right.

      Two rows are at one time exactly when they carry the same `time_s`, which is the only
      definition a reader of the CSV can apply.
    */
    const dir = await outDir();
    await cli([fixture('fractional-tie.edf'), '--out', dir, '--layout', 'long', '--quiet']);
    const rows = (await readFile(path.join(dir, 'signals.csv'), 'utf8')).trimEnd().split('\n');

    // Group by the time as written, which is what the reader sees.
    const byTime = new Map();
    for (const row of rows.slice(1)) {
      const [time, channel] = row.split(',');
      (byTime.get(time) ?? byTime.set(time, []).get(time)).push(channel);
    }
    const shared = [...byTime.entries()].filter(([, channels]) => channels.length > 1);
    assert.ok(shared.length >= 4, `expected several shared instants, found ${shared.length}`);
    for (const [time, channels] of shared) {
      assert.deepEqual(channels, ['fast', 'slow'], `at ${time}`);
    }

    // And the column never steps backwards, which is what deciding on the text preserves.
    const times = rows.slice(1).map((row) => Number(row.split(',')[0]));
    for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], `at row ${i}`);
  });

  it('says so when the one recording it cannot sort turns up', async () => {
    /*
      The sorted-rows promise rests on every sample of a record falling inside that record's
      span, so records in file order give times in order. A discontinuous recording is free
      to store its records in a different order than it timestamps them, and then the
      promise does not hold — the docs said it did, flatly, while the tool was already
      warning that it would not.

      What must stay true is the part that matters: every sample written, once, in file
      order, with the time the file gives it.
    */
    const dir = await outDir();
    const { code, stderr } = await cli([
      fixture('records-backwards.edf'),
      '--out',
      dir,
      '--layout',
      'long',
    ]);
    assert.equal(code, 0);
    assert.match(stderr, /2 data records start earlier than the record before it/u);
    assert.match(stderr, /will not increase monotonically/u);

    const rows = (await readFile(path.join(dir, 'signals.csv'), 'utf8')).trimEnd().split('\n');
    const times = rows.slice(1).map((row) => Number(row.split(',')[0]));
    assert.ok(
      times.some((time, index) => index > 0 && time < times[index - 1]),
      'this fixture exists because the times go backwards; if they do not it is testing nothing',
    );

    // Three records of five samples: every one present, none duplicated.
    assert.equal(times.length, 15);
    assert.deepEqual(
      rows.slice(1).map((row) => row.split(',').slice(0, 2).join(',')).slice(0, 3),
      ['10.000,fast', '10.000,slow', '10.250,fast'],
      'and they come out in file order, which is the only order there is',
    );
  });

  it('shares one time precision, because one column cannot mean three things', async () => {
    // 256 Hz needs eight places, 1 Hz needs three. Writing each rate at its own precision
    // would make the column's meaning depend on the row it is in.
    const dir = await outDir();
    await cli([fixture('mixed-rates.edf'), '--out', dir, '--layout', 'long', '--quiet']);
    const rows = (await readFile(path.join(dir, 'signals.csv'), 'utf8')).trimEnd().split('\n');
    const places = new Set(rows.slice(1).map((row) => row.split(',')[0].split('.')[1].length));
    assert.deepEqual([...places], [8], 'every row writes the finest precision any rate needs');
  });

  it('lets --stdout stream a mixed-rate recording, which wide cannot', async () => {
    const refused = await cli([fixture('mixed-rates.edf'), '--stdout']);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /--stdout needs exactly one table/u);
    assert.match(refused.stderr, /--layout long/u, 'and says what to do about it');

    const { code, stdout } = await cli([
      fixture('mixed-rates.edf'),
      '--stdout',
      '--layout',
      'long',
    ]);
    assert.equal(code, 0);
    assert.equal(stdout.split('\n')[0], 'time_s,channel,value');
  });

  it('does not credit itself with one copy of the stream per rate group', async () => {
    /*
      --stdout audits itself by comparing how far the file grew against how many bytes it
      handed over, because a filesystem filling up mid-write returns a short count rather
      than an error and stdout has nothing after it to trip over. The count was taken per
      rate group. The long layout gives every group the same writer, so a three-rate
      recording handed over 32,043 bytes, was credited with 96,129, and failed with a
      disk-full message about a file that was complete on disk.

      It only bites when stdout is a regular file, which is the one case the audit applies
      to — and is the command the --layout documentation gives.
    */
    // outDir() names a directory the conversion would create; --stdout creates nothing, so
    // the redirect needs a directory that already exists — its parent.
    const destination = path.join(path.dirname(await outDir()), 'signals.csv');
    const { code, stderr } = await shellTo(
      [fixture('mixed-rates.edf'), '--stdout', '--layout', 'long'],
      destination,
    );
    assert.equal(code, 0, stderr);
    assert.ok(!/did not reach the destination/u.test(stderr), stderr);
    assert.match(stderr, /Wrote 1,155 rows to stdout/u);

    const written = await readFile(destination, 'utf8');
    assert.equal(written.trimEnd().split('\n').length - 1, 1155, 'and every row is there');
  });

  it('counts the shared compressor once, not once per rate group', async () => {
    /*
      0.5.4 fixed this arithmetic in the uncompressed branch and left the compressed one,
      because there the count is a sum and here it is a subscription: one 'data' listener
      was attached per group to the one shared compressor, so every chunk was counted N
      times. A 40-rate recording claimed 622,240 bytes where 15,556 had been written, failed
      with a disk-full error over a perfectly good file, and printed Node's
      MaxListenersExceededWarning to stderr on the way past ten listeners.
    */
    const destination = path.join(path.dirname(await outDir()), 'signals.csv.gz');
    const { code, stderr } = await shellTo(
      [fixture('many-rates.edf'), '--stdout', '--layout', 'long', '--gzip'],
      destination,
    );
    assert.equal(code, 0, stderr);
    assert.ok(!/did not reach the destination/u.test(stderr), stderr);
    assert.ok(!/MaxListenersExceededWarning/u.test(stderr), `Node warned:\n${stderr}`);

    // And the stream is the file: same bytes as converting to a directory.
    const dir = await outDir();
    await cli([fixture('many-rates.edf'), '--out', dir, '--layout', 'long', '--gzip', '--quiet']);
    assert.deepEqual(
      gunzipSync(await readFile(destination)),
      gunzipSync(await readFile(path.join(dir, 'signals.csv.gz'))),
    );
  });

  it('predicts the long layout rather than the wide one', async () => {
    const dir = await outDir();
    const info = await cli([fixture('mixed-rates.edf'), '--info', '--json', '--layout', 'long']);
    const { estimate } = JSON.parse(info.stdout);
    await cli([fixture('mixed-rates.edf'), '--out', dir, '--layout', 'long', '--quiet']);

    const written = await readFile(path.join(dir, 'signals.csv'));
    const rows = written.toString('utf8').trimEnd().split('\n').length - 1;
    assert.equal(estimate.rows, rows, 'the row count is exact');
    assert.ok(estimate.bytes >= written.length, 'and the byte count never reads under');

    /*
      A long row is a sample; a wide row is a sample time. They come to the same number for
      this recording, because each of its rates carries exactly one channel — which is worth
      saying, since it is the case where the two layouts hold the same rows in a different
      shape. Where a rate carries several channels they diverge, so that is checked on a
      file that has one: quirky-labels.edf puts four channels at 4 Hz.
    */
    const wide = JSON.parse((await cli([fixture('mixed-rates.edf'), '--info', '--json'])).stdout);
    assert.equal(estimate.rows, wide.estimate.rows, 'one channel per rate, so the counts meet');

    const shared = fixture('quirky-labels.edf');
    const sharedWide = JSON.parse((await cli([shared, '--info', '--json'])).stdout);
    const sharedLong = JSON.parse(
      (await cli([shared, '--info', '--json', '--layout', 'long'])).stdout,
    );
    assert.equal(
      sharedLong.estimate.rows,
      sharedWide.estimate.rows * 4,
      'four channels at one rate is four long rows per sample time',
    );
  });

  it('refuses a layout it does not have', async () => {
    const { code, stderr } = await cli([fixture('tiny.edf'), '--layout', 'tall']);
    assert.equal(code, 2);
    assert.match(stderr, /--layout must be "wide" or "long", got "tall"/u);
  });
});

describe('--bom', () => {
  it('writes a mark on every CSV and on no JSON, leaving the text itself unchanged', async () => {
    /*
      The unit here is `µV`, written in the header as the single Latin-1 byte 0xB5, which is
      what real exporters do. UTF-8 makes it two bytes, and a spreadsheet reading the system
      code page shows `Âµ`. The mark is what tells it otherwise.
    */
    const plainDir = await outDir();
    const bomDir = await outDir();
    assert.equal((await cli([fixture('latin1-labels.edf'), '--out', plainDir, '--quiet'])).code, 0);
    assert.equal(
      (await cli([fixture('latin1-labels.edf'), '--out', bomDir, '--bom', '--quiet'])).code,
      0,
    );

    for (const name of ['signals.csv', 'channels.csv', 'annotations.csv']) {
      const marked = await readFile(path.join(bomDir, name));
      assert.deepEqual(
        [...marked.subarray(0, 3)],
        [0xef, 0xbb, 0xbf],
        `${name} must start with the mark`,
      );
      const plain = await readFile(path.join(plainDir, name));
      assert.equal(
        marked.subarray(3).toString('utf8'),
        plain.toString('utf8'),
        `${name} must be the same text, only preceded by the mark`,
      );
    }

    // JSON.parse rejects a leading U+FEFF, so metadata.json never gets one.
    const metadata = await readFile(path.join(bomDir, 'metadata.json'));
    assert.notEqual(metadata[0], 0xef, 'metadata.json must not carry a mark');
    assert.doesNotThrow(() => JSON.parse(metadata.toString('utf8')));

    const units = await readFile(path.join(bomDir, 'channels.csv'), 'utf8');
    assert.ok(units.includes('µV'), 'the unit survives as itself either way');
  });

  it('puts the mark inside the compressed stream, and counts it in the estimate', async () => {
    const dir = await outDir();
    assert.equal(
      (await cli([fixture('latin1-labels.edf'), '--out', dir, '--bom', '--gzip', '--quiet'])).code,
      0,
    );
    const expanded = gunzipSync(await readFile(path.join(dir, 'signals.csv.gz')));
    assert.deepEqual([...expanded.subarray(0, 3)], [0xef, 0xbb, 0xbf]);

    // The estimate promises never to read under what is written, so three bytes a file count.
    const plain = await cli([fixture('latin1-labels.edf'), '--info', '--json']);
    const marked = await cli([fixture('latin1-labels.edf'), '--info', '--json', '--bom']);
    assert.equal(
      JSON.parse(marked.stdout).estimate.bytes - JSON.parse(plain.stdout).estimate.bytes,
      3,
      'one signal file, three bytes',
    );
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

describe('write failures', () => {
  it('advises on what actually failed, not on disk space every time', async () => {
    // Every write failure carried the same hint — "Free up space or choose another
    // destination with --out" — which fits exactly one errno. A directory sitting where
    // signals.csv belongs came back telling the reader to free up disk space, and so did a
    // read-only volume and a permission denial. Wrong advice is worse than none: it sends
    // someone to check `df` on a disk that is fine while the real cause stays unexamined.
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-write-'));
    temporaries.push(dir);
    await writeFile(path.join(dir, 'a.edf'), await readFile(fixture('tiny.edf')));

    const blocked = path.join(dir, 'out');
    await mkdir(path.join(blocked, 'signals.csv'), { recursive: true });
    const isDirectory = await cli([path.join(dir, 'a.edf'), '--out', blocked, '--force']);
    assert.equal(isDirectory.code, 1, isDirectory.stderr);
    assert.match(isDirectory.stderr, /A directory is sitting where that file belongs/u);
    assert.ok(!/Free up space/u.test(isDirectory.stderr), 'the disk is not the problem here');

    const readonly = path.join(dir, 'ro');
    await mkdir(readonly, { recursive: true });
    await chmod(readonly, 0o500);
    try {
      const denied = await cli([path.join(dir, 'a.edf'), '--out', readonly, '--force']);
      assert.equal(denied.code, 1, denied.stderr);
      assert.match(denied.stderr, /You do not have permission to write there/u);
    } finally {
      await chmod(readonly, 0o700);
    }

    // The part that must not change: whatever the cause, the output is not to be used.
    assert.match(isDirectory.stderr, /incomplete and should not be used/u);
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
    // Since 0.5.12 the line says the reader stopped rather than claiming a conversion, and
    // this is still the number it reports: rows written before the close was noticed.
    const written = Number(stdout.match(/after ([\d,]+) of [\d,]+ rows/)[1].replaceAll(',', ''));
    assert.ok(written < 102_400, `stopped after ${written} of 102,400 rows`);
  });

  it('refuses a recording that would need more than one table', async () => {
    // Exit 2. Both --stdout refusals used to be 1, which means "the file or the destination
    // is the problem" — but the answer to both is to change the flags, as the hints say in
    // as many words, so a script reading the code went looking at the disk. --stdout --json
    // was already 2 for exactly this reason. Exit 2 has always covered checks that need the
    // header first: a --channels term matching nothing, a --start past the end.
    const { code, stderr } = await cli([fixture('mixed-rates.edf'), '--stdout']);
    assert.equal(code, 2, stderr);
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
    assert.equal(code, 2, stderr);
    assert.match(stderr, /no signal data/);

    // The distinction the two codes draw: a destination that genuinely cannot be written is
    // still the destination's problem, and stays exit 1.
    const parent = await outDir();
    await mkdir(parent, { recursive: true });
    const blocked = path.join(parent, 'file');
    await writeFile(blocked, 'not a directory');
    const unwritable = await cli([fixture('tiny.edf'), '--out', path.join(blocked, 'out')]);
    assert.equal(unwritable.code, 1, unwritable.stderr);
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
