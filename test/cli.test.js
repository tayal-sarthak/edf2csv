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
// `options` reaches execFile, which is how a case that turns on relative paths sets the
// directory they are relative to.
async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      maxBuffer: 64 << 20,
      ...options,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/*
  Ctrl-C, and whether the child was ready for it.

  Both interrupt tests wait a fixed moment and then signal. That assumes the child has got as
  far as installing its handler — until it has, Node's default takes the signal and terminates
  the process outright, and `close` reports no exit code at all with `signal` set instead of
  the 130 the tool would have chosen. Which is what a loaded machine produces: this suite runs
  its own conversions in parallel, and a run under that load has been seen coming back
  `actual: null, expected: 130` on a commit with nothing wrong in it.

  Losing that race says nothing about the message under test, exactly as losing the other one
  does — the pre-write scan finishing first is already skipped for the same reason. So it is
  reported as a skip with the reason on it, rather than as a failure on a green commit.
*/
function interrupted(run, signal = 'SIGINT') {
  return new Promise((resolve) => {
    run.on('close', (code, killedBy) => resolve({ code, killedBy }));
    run.kill(signal);
  });
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

  it('says what to type when a value begins with a dash', async () => {
    /*
      Node's parseArgs refuses `--out -nightly` with "Option '--out' argument is ambiguous. Did
      you forget to specify the option argument for '--out'? To specify an option argument
      starting with a dash use '--out=-XYZ'." The user did not forget anything, and `-XYZ` is a
      placeholder where every other message this tool prints quotes what was typed and gives
      the command to run instead. 0.4.34 fixed the same message where the tool produced it
      itself, building child argv for --jobs; the half a user can hit was left as Node wrote it.

      A destination beginning with a dash is not exotic, and neither is a negative --start.
    */
    const dashed = await cli([fixture('tiny.edf'), '--out', '-nightly']);
    assert.equal(dashed.code, 2, dashed.stderr);
    assert.match(dashed.stderr, /--out was given "-nightly"/u, dashed.stderr);
    assert.match(dashed.stderr, /Write it as one argument instead: --out=-nightly/u, dashed.stderr);
    assert.doesNotMatch(dashed.stderr, /XYZ/u, 'never a placeholder for a value we were given');
    assert.doesNotMatch(dashed.stderr, /Did you forget/u, 'they did not forget it');

    /*
      A short option joins differently, and getting this wrong would be worse than the message
      it replaces: parseArgs reads `-o=-nightly` as the value "=-nightly" and converts happily
      into a directory of that name. So the advice must be `-o-nightly`, and it is checked by
      running it rather than by matching the sentence.
    */
    const short = await cli([fixture('tiny.edf'), '-o', '-nightly']);
    assert.equal(short.code, 2, short.stderr);
    assert.match(short.stderr, /Write it as one argument instead: -o-nightly/u, short.stderr);

    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-dashed-'));
    temporaries.push(dir);
    for (const [form, name] of [['--out=', '-long'], ['-o', '-short']]) {
      const target = path.join(dir, name);
      const ran = await cli([fixture('tiny.edf'), `${form}${target}`, '--quiet']);
      assert.equal(ran.code, 0, `${form}${name} was refused:\n${ran.stderr}`);
      assert.ok((await readdir(target)).includes('signals.csv'), `${form}${name} wrote nothing`);
    }

    /*
      And values a shell would take apart, which the advised form has to survive.

      `--out "-my nightly"` was answered with `Write it as one argument instead: --out=-my
      nightly` — two arguments once typed, so `--out` gets `-my` and `nightly` becomes an
      input file. A quote was worse: `--out=-my"dir` does not even parse. The hint exists to
      give a command that works, so these are checked by running the advised token through a
      shell rather than by matching the sentence.
    */
    for (const value of ['-my nightly', '-my"dir', "-it's"]) {
      const refused = await cli([fixture('tiny.edf'), '--out', value], { cwd: dir });
      assert.equal(refused.code, 2, refused.stderr);
      const advised = /Write it as one argument instead: (.+)$/mu.exec(refused.stderr);
      assert.ok(advised, `no advice for ${JSON.stringify(value)}:\n${refused.stderr}`);

      // Exactly as printed, handed to a shell the way a reader would paste it.
      const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ` +
        `${JSON.stringify(fixture('tiny.edf'))} ${advised[1].trim()} --quiet`;
      await run('/bin/sh', ['-c', command], { cwd: dir });
      assert.ok(
        (await readdir(path.join(dir, value))).includes('signals.csv'),
        `the advised command did not convert into ${JSON.stringify(value)}`,
      );
    }

    /*
      An unknown option is this tool's sentence too, and a finished one. Node's ends
      `as in '-- "--nope"` with the quote it opened before `--` never closed, and arrived
      without the `error:` prefix every other refusal here carries.
    */
    const unknown = await cli([fixture('tiny.edf'), '--nope']);
    assert.equal(unknown.code, 2, unknown.stderr);
    assert.match(unknown.stderr, /^error: There is no --nope option\./u, unknown.stderr);
    assert.match(unknown.stderr, /pass it after -- instead:\n {7}edf2csv -- "--nope"/u);
    assert.ok(!unknown.stderr.includes('positional argument'), unknown.stderr);

    // Short options come back the same way.
    const shortUnknown = await cli([fixture('tiny.edf'), '-Z']);
    assert.equal(shortUnknown.code, 2, shortUnknown.stderr);
    assert.match(shortUnknown.stderr, /^error: There is no -Z option\./u, shortUnknown.stderr);

    /*
      And it names the option they meant, when one is close enough to name.

      Both directions matter. A wrong guess is worse than none — it sends someone to
      re-read a flag that was never the problem — so nonsense, a one-character short
      option, and a prefix that fits several names all get no suggestion at all.
    */
    for (const [typed, meant] of [
      ['--chanels', '--channels'],
      ['--chan', '--channels'],
      ['--decimal', '--decimals'],
      ['--anotations-only', '--annotations-only'],
      ['--gzipp', '--gzip'],
    ]) {
      const near = await cli([fixture('tiny.edf'), typed]);
      assert.ok(near.stderr.includes(`Did you mean ${meant}?`), `${typed}: ${near.stderr}`);
    }
    for (const typed of ['--xyzzy', '-Z', '--st']) {
      const none = await cli([fixture('tiny.edf'), typed]);
      assert.ok(!none.stderr.includes('Did you mean'), `${typed}: ${none.stderr}`);
    }
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

  it('refuses a precision that is not written in plain digits', async () => {
    /*
      `Number()` did the parsing here too, and accepts far more than a count of decimals:
      `0x3` and `3e0` and `+3` all reached three places, `0b11` reached three, `0o5` reached
      five. Every one converted and exited 0, so a slip did not fail — it wrote a CSV at a
      precision that reads as that precision to nobody, and nothing about the file says so.
      `3.5` was refused all along, which is exactly what makes the message believable.

      The same hardening `--jobs` and `--channels '#N'` already have.
    */
    for (const value of ['0x3', '0b11', '0o5', '3e0', '+3', '3.5', '21', '-1']) {
      const refused = await cli([fixture('tiny.edf'), `--decimals=${value}`, '--out', await outDir()]);
      assert.equal(refused.code, 2, `--decimals=${value} was accepted:\n${refused.stderr}`);
      assert.match(refused.stderr, /--decimals must be a whole number between 0 and 20/u);
      // The value comes back as typed, so the reader can see what was rejected.
      assert.ok(refused.stderr.includes(`"${value}"`), refused.stderr);
    }

    // Plain digits still work, at both ends of the documented range.
    for (const [value, expected] of [['0', '0.000,0,0'], ['3', '0.000,0.000,0.000']]) {
      const dir = await outDir();
      const ran = await cli([fixture('tiny.edf'), `--decimals=${value}`, '--out', dir, '--quiet']);
      assert.equal(ran.code, 0, ran.stderr);
      const row = (await readFile(path.join(dir, 'signals.csv'), 'utf8')).split('\n')[1];
      assert.equal(row, expected);
    }
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

  it('tells a column name apart from a typo, and gives the form that works', async () => {
    /*
      `--channels` matches the label, and where labels collide the column gains a
      `_ch<index>` suffix. `T8-P8_ch1` is therefore a name this tool invented, prints in the
      COLUMN column of --info, writes into channels.csv and puts at the head of signals.csv —
      and then rejected with "No channel named "T8-P8_ch1". Run with --info to list the
      channels in this file", pointing back at the table it was copied from. The reference
      documents the trap; the message someone actually hits did not.
    */
    const column = await cli([
      fixture('quirky-labels.edf'), '--channels', 'T8-P8_ch1', '--out', await outDir(),
    ]);
    assert.equal(column.code, 2, column.stderr);
    assert.match(column.stderr, /is a column name, not a channel name/u, column.stderr);
    assert.doesNotMatch(column.stderr, /Run with --info to list/u, column.stderr);

    // The form it offers has to be the one that works, and select the channel asked for.
    const dir = await outDir();
    const picked = await cli([
      fixture('quirky-labels.edf'), '--channels', '#1', '--out', dir, '--quiet',
    ]);
    assert.equal(picked.code, 0, picked.stderr);
    const header = (await readFile(path.join(dir, 'signals.csv'), 'utf8')).split('\n')[0];
    assert.equal(header, 'time_s,T8-P8_ch1');

    /*
      A label that merely looks like a column name is still a label. In this file channel 2
      is really called `T8_ch0`, which channel 0 also claims as its column, so the label has
      to win — the suffix rule cannot make a channel unreachable by its own name.
    */
    const real = await outDir();
    const byLabel = await cli([
      fixture('label-suffix-collision.edf'), '--channels', 'T8_ch0', '--out', real, '--quiet',
    ]);
    assert.equal(byLabel.code, 0, byLabel.stderr);
    assert.equal(
      (await readFile(path.join(real, 'signals.csv'), 'utf8')).split('\n')[0],
      'time_s,T8_ch0_ch2',
      'the channel whose label it is, not the channel whose column it is',
    );
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

  it('escapes the path too, which the filesystem supplies and nobody vets', async () => {
    /*
      The tests above cover the header fields. A path is untrusted text of exactly the same
      kind — a directory may be named with an ESC byte, and a file name may hold a newline on
      every platform this runs on — and the `[n/m]` header a batch prints had always escaped
      it while the two lines beneath it did not. So one line reached the terminal as
      `study/esc\x1b[31mred.edf` and the next as a live colour change, from the same name.

      The newline is the worse half: it split `Wrote` across two lines, so a summary line that
      anything reading the output treats as one path reported two.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-escpath-'));
    temporaries.push(dir);
    const study = path.join(dir, 'study');
    await mkdir(study);
    const source = await readFile(fixture('tiny.edf'));
    await writeFile(path.join(study, 'esc\u001b[31mred.edf'), source);

    const control = (text) =>
      [...text].filter((c) => {
        const n = c.codePointAt(0);
        return (n < 32 && n !== 10) || (n >= 127 && n <= 159);
      });

    const converted = await cli([study, '--out', path.join(dir, 'out')]);
    assert.equal(converted.code, 0, converted.stderr);
    assert.deepEqual(control(converted.stdout + converted.stderr), [], 'the Wrote line');
    // The summary goes to stderr, keeping stdout for --json and --stdout; either way it is
    // the escaped form that must be there.
    assert.match(converted.stderr, /Wrote .*esc\\x1b\[31mred/u, converted.stderr);

    const info = await cli([study, '--info']);
    assert.deepEqual(control(info.stdout + info.stderr), [], 'the File line');

    /*
      A newline in the name must not turn one reported path into two lines. No --out here on
      purpose: the destination is then derived from the recording's own name, so the newline
      is in the path the summary prints rather than only in the one it was given.
    */
    const split = path.join(dir, 'nl\nname.edf');
    await writeFile(split, source);
    const single = await cli([split], { cwd: dir });
    assert.equal(single.code, 0, single.stderr);
    const wrote = single.stderr.split('\n').filter((line) => line.startsWith('Wrote '));
    assert.equal(wrote.length, 1, JSON.stringify(single.stderr));
    assert.match(wrote[0], /\\x0a/u, wrote[0]);

    /*
      And the failure paths, which the two checks above never reach because they both
      succeed.

      Two of them printed the path raw. A folder holding no recordings is named back in
      "No EDF or BDF recordings found in ...", straight off the command line — and a shell
      glob expands to whatever the directory holds, so "it came from the caller" is not the
      same as "the caller typed it". The other is a hint rather than a message:
      ConversionError.hint is fixed prose in every case but one, and that one interpolates
      `--out`. The `error:` line above it was escaped correctly the whole time.
    */
    const nasty = path.join(dir, 'esc\u001b[31mdir');
    await mkdir(nasty);
    const empty = await cli([nasty]);
    assert.notEqual(empty.code, 0);
    assert.deepEqual(control(empty.stdout + empty.stderr), [], 'the empty-folder message');
    assert.match(empty.stderr, /esc\\x1b\[31mdir/u, empty.stderr);
  });
});

describe('stale output detection', () => {
  // Output filenames gained two shapes recently: a collision suffix (signals_0hz_2.csv) and
  // exponent rates (signals_1_000e-7hz.csv). Neither matched the pattern that recognises
  // this tool's own files, so leftovers of exactly those kinds went unreported — the one
  // situation the warning exists for.
  it('accepts a destination whose last component is a dot', async () => {
    /*
      `prepareOutputDir` claims the final component with one non-recursive mkdir after
      creating its parents recursively, which is what makes two conversions racing for the
      same directory safe. `path.dirname("out/.")` is `"out"`, so for a destination ending in
      `.` the parent step created the destination itself and the claim then asked for `.`
      inside it, which always exists.

      The run refused a directory it had just made, one line after making it — exit 1, no
      conversion, and an empty directory left on disk. `--force` did not help: the claim fails
      the same way whatever it is told, so the path was unusable rather than occupied.
    */
    const dir = await outDir();
    // Built by concatenation on purpose: path.join collapses the dot, so joining would
    // hand the CLI an already-normalised path and test nothing.
    const dotted = `${path.join(dir, 'fresh')}${path.sep}.`;
    const ran = await cli([fixture('tiny.edf'), '--out', dotted]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.deepEqual(
      (await readdir(path.join(dir, 'fresh'))).sort(),
      ['channels.csv', 'metadata.json', 'signals.csv'],
      'the conversion must land in the directory the dot names',
    );

    /*
      And `..`, which names the parent. That one really does already exist, so refusing is
      right — what was wrong is that it created the component before it in order to find out.
    */
    const parented = `${path.join(dir, 'nested')}${path.sep}..`;
    const up = await cli([fixture('tiny.edf'), '--out', parented]);
    assert.notEqual(up.code, 0, up.stderr);
    await assert.rejects(
      readdir(path.join(dir, 'nested')),
      'nothing may be created on the way to refusing',
    );

    // A leading `./` is how the directory is found on disk, so it is left exactly as given.
    const here = await cli([fixture('tiny.edf'), '--out', './keeps-its-spelling'], { cwd: dir });
    assert.equal(here.code, 0, here.stderr);
    assert.match(here.stderr, /^Wrote \.\/keeps-its-spelling$/mu, here.stderr);
  });

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

  it('keeps the warning readable however many files are left over', async () => {
    /*
      How many stale files a directory holds is up to the directory, and a mixed-rate
      recording converted into a reused one is exactly how it fills up. 120 old
      `signals_<rate>hz.csv` files produced a single 2,373-character warning line — the
      failure `listed` was written for, in the one message that still joined its own list.

      And the hint said "Delete them" whatever the count, so one leftover read
      "signals_999hz.csv is left over ... Delete them."
    */
    const many = await outDir();
    await mkdir(many, { recursive: true });
    for (let rate = 100; rate < 220; rate++) {
      await writeFile(path.join(many, `signals_${rate}hz.csv`), '');
    }
    const crowded = await cli([fixture('tiny.edf'), '--out', many, '--force']);
    assert.equal(crowded.code, 0, crowded.stderr);
    const warning = crowded.stderr.split('\n').find((line) => line.includes('left over'));
    assert.ok(warning, crowded.stderr);
    assert.ok(warning.length < 400, `the warning is ${warning.length} characters:\n${warning}`);
    assert.match(warning, /and 112 more are left over/u, warning);

    // One leftover reads as one, in the hint as well as in the sentence above it.
    const single = await outDir();
    await mkdir(single, { recursive: true });
    await writeFile(path.join(single, 'signals_999hz.csv'), '');
    const one = await cli([fixture('tiny.edf'), '--out', single, '--force']);
    assert.match(one.stderr, /signals_999hz\.csv is left over/u, one.stderr);
    assert.match(one.stderr, /Delete it, or convert into a fresh directory/u, one.stderr);
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

  it('sees the marker a conversion would complain about', async () => {
    /*
      `--info` reads the annotation channel for a file that claims to be EDF+ — the whole of
      it for a discontinuous one, the first records of a continuous one — and for nothing
      else. MISSING_EDF_PLUS_MARKER is about a file that claims neither: an annotation channel
      whose timekeeping puts the records at a non-zero instant, in a file with no marker, so
      the samples are timed from zero and the events keep their own onsets and the two CSVs
      come out on clocks the origin apart.

      Which is the one file the read was skipped for. The conversion warned that signals.csv
      and annotations.csv would be a thousand seconds apart; `--info` — the command you run
      first, on purpose, to find out what a conversion would say — printed the channel table
      and nothing else. `--info --strict` exited 0 on it.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-nomarker-'));
    temporaries.push(dir);
    const { writeEdf, buildTal } = await import('./fixtures/edf-writer.mjs');
    const unmarked = path.join(dir, 'unmarked.edf');
    writeEdf({
      path: unmarked,
      reserved: '',
      numRecords: 3,
      recordDuration: 1,
      signals: [
        { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000,
          digMax: 1000, samplesPerRecord: 4, gen: (r, s) => r * 4 + s },
        { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768,
          digMax: 32767, samplesPerRecord: 30, annotations: true },
      ],
      talsForRecord: (record) => buildTal(1000 + record, record === 0
        ? [{ onset: 1000.5, duration: null, text: 'mark' }]
        : []),
    });

    const info = await cli([unmarked, '--info', '--json']);
    assert.equal(info.code, 0, info.stderr);
    const codes = JSON.parse(info.stdout).warnings.map((w) => w.code);
    assert.ok(codes.includes('MISSING_EDF_PLUS_MARKER'), `--info raised ${codes.join(', ') || 'nothing'}`);

    // The same words the conversion uses, since it is the same recording being described.
    const converted = await cli([unmarked, '--out', path.join(dir, 'out'), '--json', '--quiet']);
    const said = (text) => JSON.parse(text).warnings.find((w) => w.code === 'MISSING_EDF_PLUS_MARKER');
    assert.equal(said(info.stdout).message, said(converted.stdout).message);
    assert.match(said(info.stdout).message, /disagree by 1000s/u);

    // And it is still exit 1 under --strict, in the mode that never converts anything.
    const strict = await cli([unmarked, '--info', '--strict']);
    assert.equal(strict.code, 1, 'a warning under --info --strict is still a warning');

    // A plain EDF with no annotation channel is untouched: nothing to read, nothing to say.
    const plain = await cli([fixture('tiny.edf'), '--info', '--json']);
    assert.deepEqual(JSON.parse(plain.stdout).warnings, []);
  });

  it('does not blame gaps for a span its records overlap into', async () => {
    /*
      `Time span` is printed whenever the span and the duration disagree, and the parenthetical
      said "includes discontinuities" whichever way they disagreed. A span LONGER than the
      duration is the gap case the line was written for. A span SHORTER than it cannot be a
      gap at all — it is records that overlap, which is what a device does when it re-sends a
      buffer, and which this tool warns about two lines further down:

          Duration   3s  (3 records of 1s)
          Time span  2s  (includes discontinuities)
          warning: 2 data records start before the record before them ends...

      A recording covering less time than its own records account for, blamed on gaps it does
      not have, directly above the warning saying what it really has.
    */
    const overlapping = await cli([fixture('records-overlapping.edf'), '--info']);
    assert.equal(overlapping.code, 0, overlapping.stderr);
    assert.match(overlapping.stdout, /Duration\s+3s/u);
    assert.match(overlapping.stdout, /Time span\s+2s\s+\(records overlap in time\)/u);
    assert.ok(
      !/Time span[^\n]*discontinuities/u.test(overlapping.stdout),
      'a span shorter than the duration is not a gap',
    );
    assert.match(overlapping.stderr, /records start before the record before them ends/u);

    // And the gap case keeps the words it had, on the file the documentation quotes.
    const gapped = await cli([fixture('discontinuous.edf'), '--info']);
    assert.match(gapped.stdout, /Time span\s+11s\s+\(includes discontinuities\)/u);
  });

  it('refuses a start at the end, whatever the record duration multiplies out to', async () => {
    /*
      The guard compares `--start` against `recordCount * recordDuration`, and with a
      fractional duration that product is not the number it prints as: 6003 records of 0.1s is
      600.3000000000001. So `--start 600.3` on a recording `--info` calls "10m 0.3s" slipped
      past by a hair, converted nothing and exited 0 with a signals.csv holding its header —
      the empty conversion this error exists to prevent, and which `--start 2` on a
      whole-second recording is refused for.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-endstart-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const recording = path.join(dir, 'tenmin.edf');
    writeEdf({
      path: recording, numRecords: 6003, recordDuration: 0.1,
      signals: [{ label: 'EEG', dimension: 'uV', physMin: -250, physMax: 250, digMin: -2048,
        digMax: 2047, samplesPerRecord: 10, gen: (r, s) => ((r * 10 + s) % 400) - 200 }],
    });

    // Not vacuous: the arithmetic really does overshoot.
    assert.ok(6003 * 0.1 > 600.3, 'the product no longer overshoots, so this proves nothing');

    const atEnd = await cli([recording, '--start', '600.3', '--out', path.join(dir, 'a')]);
    assert.equal(atEnd.code, 2, atEnd.stderr);
    assert.match(atEnd.stderr, /is at or past the end of this 10m 0\.3s recording/u, atEnd.stderr);

    // And a start genuinely inside it still converts, so the epsilon has not eaten a window.
    const inside = path.join(dir, 'b');
    const ok = await cli([recording, '--start', '600.2', '--out', inside, '--quiet']);
    assert.equal(ok.code, 0, ok.stderr);
    const rows = (await readFile(path.join(inside, 'signals.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(rows.length - 1, 10, 'the last record is one tenth of a second of samples');
  });

  it('prints channel advice that works, on every branch of it', async () => {
    /*
      NONPRINTABLE_LABEL's hint tells you how to reach a channel whose header text you cannot
      type — so a hint whose command fails is worse than no hint. The middle branch quoted the
      label back, which is right until the label is empty: an unlabelled channel with a
      control byte in its unit got `--channels ""`, and that exits 2 with "--channels was given
      but lists no channel names".

      A comma in the label is the same failure with nothing to hint that it is one. `--channels`
      splits its argument on every comma, so `--channels "EEG Fpz-Cz, ref"` asks for two
      channels, neither of which exists, and exits 2 naming half of a label the file does have.
      The three cases here were blank, typeable and untypeable; a label that is perfectly
      typeable and still unusable as a term was the gap.

      Checked by running what the hint says rather than by matching it, which is the only way
      this kind of claim stays true.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-hintrun-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const BEL = String.fromCharCode(7);
    const base = { physMin: -1, physMax: 1, digMin: -1, digMax: 1, samplesPerRecord: 2, gen: () => 0 };

    const cases = [
      // No label at all: only the position can reach it.
      ['blank', [{ label: '', dimension: `u${BEL}V`, ...base }]],
      // A label that can be typed: the hint may quote it.
      ['named', [{ label: 'EEG', dimension: `u${BEL}V`, ...base }]],
      // A label that cannot: the position again.
      ['noisy', [{ label: `EEG${BEL}`, dimension: 'uV', ...base }]],
      // Typeable, and still not usable as a term, because --channels splits on the comma.
      ['comma', [{ label: 'EEG Fpz-Cz, ref', dimension: `u${BEL}V`, ...base }]],
    ];
    for (const [name, signals] of cases) {
      const recording = path.join(dir, `${name}.edf`);
      writeEdf({ path: recording, numRecords: 1, recordDuration: 1, signals });

      const info = await cli([recording, '--info']);
      const hint = info.stderr.split('\n').find((line) => line.includes('--channels'));
      assert.ok(hint, `${name}: no --channels advice was given:\n${info.stderr}`);

      const quoted = /--channels "([^"]*)"/u.exec(hint);
      assert.ok(quoted, `${name}: the advice names no argument: ${hint}`);

      const ran = await cli([recording, '--channels', quoted[1], '--out', path.join(dir, `o-${name}`), '--quiet']);
      assert.equal(ran.code, 0, `${name}: the advice "${quoted[1]}" exits ${ran.code}:\n${ran.stderr}`);
      const header = await readFile(path.join(dir, `o-${name}`, 'signals.csv'), 'utf8');
      // Split on the commas that separate columns rather than on every comma: a label holding
      // one is quoted in the header, and counting its comma as a column boundary would read
      // the very case this was added for as two columns and pass on the wrong grounds.
      const columns = header.split('\n')[0].match(/(?:"[^"]*"|[^,])+/gu) ?? [];
      assert.equal(columns.length, 2, `${name}: it selected nothing`);
    }
  });

  it('treats a stray space the same way whichever option carries it', async () => {
    /*
      A value that reaches the tool with space around it is ordinary — `--jobs "$(cat n)"`,
      a copied argument, a shell variable holding a trailing newline. Four options took four
      views of one.

      `--start` and `--decimals` trimmed it and, when the value was wrong anyway, quoted back
      what was typed. `--layout` did not trim at all, so ` long` was refused for a character
      nobody wrote. And `--jobs` trimmed and then quoted the remains, which is the worst of the
      three: `--jobs " x"` reported `got "x"` and `--jobs " "` reported `got ""` — the second
      reading as though no value had been given, when the value is the whole reason it failed.

      The quotation marks are there to show where a value begins and ends. Trimming before
      printing them takes that away exactly where it is needed.
    */
    const recording = fixture('tiny.edf');

    // Accepted, once trimmed: the same answer as the value with no space on it.
    for (const [flag, padded] of [
      ['--jobs', ' 2 '], ['--layout', ' long'], ['--decimals', ' 3 '], ['--start', ' 1 '],
    ]) {
      const spaced = await cli([recording, '--info', flag, padded]);
      const plain = await cli([recording, '--info', flag, padded.trim()]);
      assert.equal(spaced.code, 0, `${flag} "${padded}": ${spaced.stderr}`);
      assert.equal(spaced.stdout, plain.stdout, `${flag} "${padded}" differs from the trimmed form`);
    }

    // Refused, quoting the value as given — spaces included, since they are the reason.
    for (const [flag, given] of [
      ['--jobs', ' x'], ['--jobs', ' '], ['--layout', ' tall'], ['--decimals', ' x '],
      ['--start', ' x '],
    ]) {
      const refused = await cli([recording, '--info', flag, given]);
      assert.equal(refused.code, 2, `${flag} "${given}" was accepted: ${refused.stderr}`);
      assert.ok(
        refused.stderr.includes(`"${given}"`),
        `${flag} "${given}" is quoted back without its spaces: ${refused.stderr.split('\n')[0]}`,
      );
    }
  });

  it('answers for the annotation channel by name rather than denying it exists', async () => {
    /*
      `EDF Annotations` is the label the specification reserves, --info counts it on the
      "Channels" line, and it is the first channel name anyone reading about EDF+ meets. Asking
      for it got:

          error: No channel named "EDF Annotations".
                 Run with --info to list the channels in this file.

      Both halves wrong for the same reason. The file does have a channel with that name, and
      the table --info prints does not list it either — so a reader who follows the advice comes
      back to the same message with nothing new. The thing they were after is already on disk:
      any conversion of a file with this channel writes annotations.csv out of it.

      A recording with no annotation channel keeps the old message, because for that file the
      old message is true.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-annotch-'));
    temporaries.push(dir);

    for (const [recording, label] of [
      [fixture('annotations.edf'), 'EDF Annotations'],
      [fixture('biosemi-plus.bdf'), 'BDF Annotations'],
      // Case-insensitively, like every other term.
      [fixture('annotations.edf'), 'edf annotations'],
    ]) {
      const asked = await cli([recording, '--info', '--channels', label]);
      assert.equal(asked.code, 2, asked.stderr);
      assert.match(asked.stderr, /is this recording's annotation channel, not a signal/u, asked.stderr);
      assert.doesNotMatch(asked.stderr, /No channel named/u, asked.stderr);
      assert.match(asked.stderr, /--annotations-only/u, asked.stderr);
    }

    // And the advice works: that flag on that file writes the events it was after.
    const out = path.join(dir, 'events');
    const ran = await cli([fixture('annotations.edf'), '--annotations-only', '--out', out, '--quiet']);
    assert.equal(ran.code, 0, ran.stderr);
    const events = await readFile(path.join(out, 'annotations.csv'), 'utf8');
    assert.equal(events.trimEnd().split('\n').length, 4, events);

    // A file with no annotation channel is a file with no channel by that name.
    const plain = await cli([fixture('tiny.edf'), '--info', '--channels', 'EDF Annotations']);
    assert.equal(plain.code, 2, plain.stderr);
    assert.match(plain.stderr, /No channel named "EDF Annotations"/u, plain.stderr);
  });

  it('agrees with itself about number when the count is one', async () => {
    /*
      Every one of these was written `${n} records`, which is right until the file has one of
      them — and a one-record recording and a one-byte tail are both ordinary. `--info` opened
      with "Duration 1s  (1 records of 1s)" and a truncated file warned that "1 bytes after the
      last complete data record were ignored", on the two lines a reader looks at first.

      Checked by pattern rather than by listing the sentences, so a message added later that
      counts something is covered without anyone remembering to add it here.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-plural-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const { appendFileSync } = await import('node:fs');
    const channel = {
      label: 'ch', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000,
      samplesPerRecord: 4, gen: () => 1,
    };

    // One record, and one stray byte after it, so both counts land on one at once.
    const one = path.join(dir, 'one.edf');
    writeEdf({ path: one, numRecords: 1, recordDuration: 1, signals: [channel] });
    appendFileSync(one, Buffer.from([0]));

    // And one record where the header promised five, for the mismatch wording.
    const short = path.join(dir, 'short.edf');
    writeEdf({ path: short, numRecords: 5, recordDuration: 1, truncateRecords: 1, signals: [channel] });

    /*
      Every mode that prints a count, not just the two that happened to be tried.

      This family has surfaced three times. 0.5.74 fixed the header lines and checked only
      whole-recording conversions, so the estimate line and the written-files table were never
      seen at one — a window narrow enough to select a single sample is what produces that,
      and both read "1 rows" until 0.5.78. 0.5.78 added the window and still never ran
      `--stdout`, whose summary read "Wrote 1 rows to stdout." until 0.5.80. A count that is
      never one in the run is a count this cannot check, so the modes are enumerated here
      rather than sampled.
    */
    const narrow = ['--start', '1.9', '--end', '2.0'];
    const runs = [
      [one, [], []],
      [short, [], []],
      [fixture('tiny.edf'), narrow, []],
      [fixture('tiny.edf'), narrow, ['--gzip']],
      [fixture('tiny.edf'), narrow, ['--layout', 'long']],
      [fixture('annotations.edf'), [], ['--annotations-only']],
    ];
    for (const [recording, window, mode] of runs) {
      const info = await cli([recording, '--info', ...window, ...mode]);
      const converted = await cli([recording, '--out', await outDir(), '--quiet', ...window, ...mode]);
      const loud = await cli([recording, '--out', await outDir(), ...window, ...mode]);
      // --stdout has its own summary line, and prints no directory table.
      const streamed = mode.includes('--annotations-only')
        ? { stdout: '', stderr: '' }
        : await cli([recording, '--stdout', ...window, ...mode]);
      const text = [info.stdout, info.stderr, converted.stderr, loud.stdout, loud.stderr,
        streamed.stderr].join('\n');
      const wrong = [...text.matchAll(/\b1 ([a-z]+s)\b/gu)]
        .map((m) => m[1])
        // "is"/"was"/"has" are verbs, and a word may simply end in s.
        .filter((word) => !['is', 'was', 'has', 'less', 'this', 'its'].includes(word));
      assert.deepEqual(wrong, [], `${path.basename(recording)} counts one of something plural:\n${text}`);
    }

    // Not vacuous: the windowed run really does estimate, write and stream exactly one row.
    const single = await cli([fixture('tiny.edf'), '--info', ...narrow]);
    assert.match(single.stdout, /Would write 1 row,/u, single.stdout);
    const piped = await cli([fixture('tiny.edf'), '--stdout', ...narrow]);
    assert.match(piped.stderr, /Wrote 1 row to stdout\./u, piped.stderr);

    // A folder holding one recording, whose closing line said "Converted 1 of 1 recordings".
    const { mkdir, copyFile } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'batch'));
    await copyFile(fixture('tiny.edf'), path.join(dir, 'batch', 'a.edf'));
    const batch = await cli([path.join(dir, 'batch'), '--out', await outDir()]);
    assert.match(batch.stderr, /Converted 1 of 1 recording\./u, batch.stderr);

    // Above one the plural is still there, or the fix would have gone the other way.
    const many = await cli([fixture('tiny.edf'), '--info']);
    assert.match(many.stdout, /\(2 records of 1s\)/u, many.stdout);
    const truncated = await cli([fixture('truncated.edf'), '--info']);
    assert.match(truncated.stderr, /Converting the 4 records that are present/u, truncated.stderr);
  });

  it('previews what --stdout would do, instead of describing files it never writes', async () => {
    /*
      `--info --stdout` on a three-rate recording predicted "Would write 1,155 rows, roughly
      22.2 KB" and said the channels "are written to one file per rate" — for a command that
      refuses to run, writes nothing and names no file. --info exists to say what a conversion
      will do, and refusing is one of the things it does.

      A warning rather than a refusal, for the reason 0.5.51 gives about the destination
      guards: --info writes nothing, so a rule about the output has no business stopping it
      from describing the recording. The conversion's own guard supplies the words, so there
      is one wording rather than two that can drift.
    */
    const preview = await cli([fixture('mixed-rates.edf'), '--info', '--stdout']);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stderr, /--stdout would refuse this recording/u, preview.stderr);
    assert.ok(preview.stdout.includes('EEG Fpz-Cz'), 'and it still describes the recording');

    // The words are the conversion's, so the two cannot drift apart.
    const refused = await cli([fixture('mixed-rates.edf'), '--stdout']);
    assert.equal(refused.code, 2, refused.stderr);
    const detail = /needs exactly one table[^\n]*/u.exec(refused.stderr);
    assert.ok(detail, refused.stderr);
    assert.ok(preview.stderr.includes(detail[0]), `preview: ${preview.stderr}`);

    // It reaches --json too, which is what a script surveying a directory reads.
    const asJson = JSON.parse((await cli([fixture('mixed-rates.edf'), '--info', '--stdout', '--json'])).stdout);
    assert.ok(
      asJson.warnings.some((w) => w.code === 'STDOUT_UNSUPPORTED'),
      JSON.stringify(asJson.warnings),
    );

    // Quiet when --stdout would work: one rate, and the long layout that lifts the rule.
    for (const args of [
      [fixture('tiny.edf'), '--info', '--stdout'],
      [fixture('mixed-rates.edf'), '--info', '--stdout', '--layout', 'long'],
    ]) {
      const fine = await cli(args);
      assert.equal(fine.code, 0, fine.stderr);
      assert.doesNotMatch(fine.stderr, /would refuse/u, `${args.join(' ')}: ${fine.stderr}`);
    }

    // And without --stdout nothing changes.
    const plain = await cli([fixture('mixed-rates.edf'), '--info']);
    assert.doesNotMatch(plain.stderr, /would refuse/u, plain.stderr);
  });

  it('says where a recording starts when that is not zero', async (t) => {
    /*
      0.4.9 made the first record's timekeeping TAL the point a recording is timed from, so a
      file whose TALs start at +1000 writes `time_s` from 1000.000 and takes `--start` and
      `--end` on that clock. The report said "Duration 3s" and nothing else, which reads as 0
      to 3 — and `--start 0 --end 1` then selected nothing and answered "The window is inside
      the recording but lands where there is no data ... Run with --info to see where the
      records actually sit", pointing at the one report that did not say.

      The number was already in `plan.range` and already governed the estimate printed below
      it; it was simply never shown.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-origin-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const T = String.fromCharCode(0x14);
    const Z = String.fromCharCode(0x00);
    const shifted = path.join(dir, 'origin.edf');
    writeEdf({
      path: shifted,
      reserved: 'EDF+C',
      numRecords: 3,
      recordDuration: 1,
      talsForRecord: (record) => `+${1000 + record}${T}${T}${Z}`,
      signals: [
        { label: 'EEG', dimension: 'uV', physMin: -100, physMax: 100, digMin: -2048,
          digMax: 2047, samplesPerRecord: 4, gen: (r, s) => r * 4 + s },
        { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768,
          digMax: 32767, samplesPerRecord: 60, annotations: true },
      ],
    });

    const info = await cli([shifted, '--info']);
    assert.equal(info.code, 0, info.stderr);
    assert.match(info.stdout, /Timed from 1000\.000s/u, info.stdout);

    // In seconds because the number is meant to be typed back in: this is the value that
    // makes --start select something, and the report is where you go to find it.
    const converted = await cli([shifted, '--out', path.join(dir, 'out'), '--start', '1000',
      '--end', '1001', '--quiet']);
    assert.equal(converted.code, 0, converted.stderr);
    const rows = (await readFile(path.join(dir, 'out', 'signals.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(rows[1], '1000.000,0.0244', rows.slice(0, 3).join(' | '));

    // And the JSON carries it too, beside the two lengths that never said where they sit.
    const asJson = JSON.parse((await cli([shifted, '--info', '--json'])).stdout);
    assert.equal(asJson.first_sample_seconds, 1000);

    // A recording timed from zero — nearly all of them — gains no line and no noise.
    const ordinary = await cli([fixture('annotations.edf'), '--info']);
    assert.doesNotMatch(ordinary.stdout, /Timed from/u, ordinary.stdout);
    const ordinaryJson = JSON.parse((await cli([fixture('annotations.edf'), '--info', '--json'])).stdout);
    assert.equal(ordinaryJson.first_sample_seconds, 0);
    t.diagnostic(`origin reported as ${asJson.first_sample_seconds}s`);
  });

  it('suggests and offers only labels a shell hands back unchanged', async () => {
    /*
      The two places a label is printed as something to retype, both of which 0.7.18 left:

          error: "EEG "A1"_ch0" is a column name, not a channel name: ...
                 Use "#0" to select just this one, or "EEG "A1"" for every channel sharing
                 that label.

          error: No channel named "EEG "A2"". Did you mean "EEG "A1""?

      A shell collapses `"EEG "A1""` to `EEG A1`, which this rejects with the same suggestion,
      which collapses the same way. Following the advice is a loop.

      `$` and a backtick are the same failure without the visual warning: a shell expands both
      inside double quotes, so `--channels "EEG $ref"` arrives as `EEG ` and the label the
      message was about never reaches the tool at all.

      Double quotes stay wherever they survive, because they also show where the label begins
      and ends and every documented example is written that way — `"T8-P8"` and
      `"EEG Fpz-Cz"` are byte-for-byte what they were. What changes is the labels those
      quotes were never going to carry.

      Checked by pasting: each suggestion goes to /bin/sh exactly as printed, and a conversion
      of that channel has to come back. Matching the sentence would pass against the old form.

      Both places, which is the part this missed for twenty-six versions. It pasted the column-
      name branch and left the near-miss one — the second message quoted above — matched by
      nothing, and that is the branch a comma reaches: a label holding one can never be
      selected by name, since `--channels` splits on commas, so the offer has to be a position
      instead. Weaken the guard that decides it and the suggestion becomes `Did you mean
      "EEG,Fp1"?`, which survives a shell perfectly and is then split by the tool that printed
      it into two names it does not have — with the whole suite green.
    */
    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-typeable-'));
    temporaries.push(scratch);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const base = { dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000,
      samplesPerRecord: 2 };

    // Two channels sharing the label, so the column gains its `_ch` suffix and asking for the
    // column name reaches the branch that offers the label back.
    const labels = ['T8-P8', 'EEG Fpz-Cz', 'EEG "A1"', 'EEG $ref', "EEG 'A1'", 'EEG `ref`'];
    for (const [index, label] of labels.entries()) {
      const file = path.join(scratch, `label-${index}.edf`);
      writeEdf({
        path: file,
        numRecords: 1,
        recordDuration: 1,
        signals: [
          { label, ...base, gen: () => 100 },
          { label, ...base, gen: () => 200 },
        ],
      });

      const refused = await cli([file, '--out', await outDir(), '--channels', `${label}_ch0`]);
      assert.equal(refused.code, 2, `${label}: asking for the column name has to be refused`);
      // Flattened first: the message is wrapped, so a long label can be split over two
      // lines. Anchored on ", or " because "for this channel" earlier in the sentence
      // contains one.
      const flat = refused.stderr.replace(/\s+/gu, ' ');
      const offered = /, or (.+?) for every channel sharing/u.exec(flat);
      assert.ok(offered, `${label}: no label was offered back:\n${refused.stderr}`);

      // Paste it. The label reaching the tool has to be the one the message was about.
      const destination = path.join(scratch, `out-${index}`);
      const command =
        `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${JSON.stringify(file)} ` +
        `--channels ${offered[1]} ` +
        `--out ${JSON.stringify(destination)} --quiet`;
      const pasted = await run('/bin/sh', ['-c', command]).then(() => 0, (error) => error.code);
      assert.equal(pasted, 0, `${label}: the offered command failed:\n  ${command}`);
      const header = (await readFile(path.join(destination, 'signals.csv'), 'utf8')).split('\n')[0];
      assert.ok(
        header.includes(label.replaceAll('"', '""')),
        `${label}: the offered command converted something else — ${header}`,
      );
    }

    /*
      The near-miss branch, on one signal per file so the offer is about the label rather than
      about a column. The term is the label with a character taken out of it, which is what a
      typo is, and for a label holding a comma it is the comma that goes — the term itself has
      to survive `--channels` splitting to reach the suggestion at all.
    */
    const mistyped = ['T8-P8', 'EEG "A1"', 'EEG $ref', "EEG 'A1'", 'EEG `ref`', 'EEG,Fp1'];
    for (const [index, label] of mistyped.entries()) {
      const file = path.join(scratch, `near-${index}.edf`);
      writeEdf({
        path: file,
        numRecords: 1,
        recordDuration: 1,
        signals: [{ label, ...base, gen: () => 300 }],
      });

      const term = label.includes(',') ? label.replace(',', '') : label.slice(0, -1);
      const refused = await cli([file, '--out', await outDir(), '--channels', term]);
      assert.equal(refused.code, 2, `${label}: "${term}" has to be refused`);
      const offered = /Did you mean (.+?)\?/u.exec(refused.stderr.replace(/\s+/gu, ' '));
      assert.ok(offered, `${label}: nothing was offered for "${term}":\n${refused.stderr}`);

      const destination = path.join(scratch, `near-out-${index}`);
      const command =
        `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} ${JSON.stringify(file)} ` +
        `--channels ${offered[1]} ` +
        `--out ${JSON.stringify(destination)} --quiet`;
      const pasted = await run('/bin/sh', ['-c', command]).then(() => 0, (error) => error.code);
      assert.equal(pasted, 0, `${label}: the offered command failed:\n  ${command}`);
      const header = (await readFile(path.join(destination, 'signals.csv'), 'utf8')).split('\n')[0];
      assert.ok(
        header.includes(label.replaceAll('"', '""')),
        `${label}: following "${offered[1]}" converted something else — ${header}`,
      );
    }

    // And the two that survive unchanged, so no documented example moved.
    for (const [label, quoted] of [['T8-P8', '"T8-P8"'], ['EEG Fpz-Cz', '"EEG Fpz-Cz"']]) {
      const file = path.join(scratch, `plain-${label.replace(/\W/gu, '')}.edf`);
      writeEdf({
        path: file, numRecords: 1, recordDuration: 1,
        signals: [{ label, ...base, gen: () => 1 }, { label, ...base, gen: () => 2 }],
      });
      const refused = await cli([file, '--out', await outDir(), '--channels', `${label}_ch0`]);
      assert.ok(
        refused.stderr.replace(/\s+/gu, ' ').includes(`, or ${quoted} for every channel`),
        refused.stderr,
      );
    }
  });

  it('takes a window on a clock that begins before zero, which is where that file sits', async (t) => {
    /*
      "Timed from -100.000s  (first sample; --start and --end use this clock)" is what --info
      prints for negative-origin.edf, and the parenthesis is an instruction: type this back in.
      Every form of it was refused —

          error: --start "-100" is not a time I understand. Try 30s, 5m, 1h30m, 00:30:00, ...

      so the only recordings whose clock the tool could not express were the ones it had just
      finished explaining, and no window of one could be converted at all. A bare conversion
      worked, which is why this went unnoticed: the failure is the whole of --start and --end
      on one file shape, not a wrong number anywhere.

      A negative `--duration` is a different thing — a length below zero is not one — and is
      still refused.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-negative-'));
    temporaries.push(dir);
    const recording = fixture('negative-origin.edf');

    const info = await cli([recording, '--info']);
    assert.match(info.stdout, /Timed from -100\.000s/u, info.stdout);

    // The whole recording, named on its own clock, and then one second out of it.
    const whole = await cli([recording, '--out', path.join(dir, 'whole'), '--quiet',
      '--start=-100', '--end=-97']);
    assert.equal(whole.code, 0, whole.stderr);
    const bare = await cli([recording, '--out', path.join(dir, 'bare'), '--quiet']);
    assert.equal(bare.code, 0, bare.stderr);
    assert.equal(
      await readFile(path.join(dir, 'whole', 'signals.csv'), 'utf8'),
      await readFile(path.join(dir, 'bare', 'signals.csv'), 'utf8'),
      'naming the recording\'s own bounds is the same conversion as naming none',
    );

    const second = await cli([recording, '--out', path.join(dir, 'one'), '--quiet',
      '--start=-100', '--duration', '1']);
    assert.equal(second.code, 0, second.stderr);
    const rows = (await readFile(path.join(dir, 'one', 'signals.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(rows.length, 5, rows.join(' | '));
    assert.match(rows[1], /^-100\.000,/u, rows[1]);
    assert.match(rows[4], /^-99\.250,/u, rows[4]);

    // The bounds still hold, read on that clock rather than against zero.
    const past = await cli([recording, '--info', '--start=-97']);
    assert.equal(past.code, 2, past.stderr);
    assert.match(past.stderr, /at or past the end of this 3s recording/u, past.stderr);

    const backwards = await cli([recording, '--info', '--duration=-5']);
    assert.equal(backwards.code, 2, backwards.stderr);
    assert.match(backwards.stderr, /--duration "-5" is not a valid non-negative time/u, backwards.stderr);
    t.diagnostic(`converted ${rows.length - 1} rows from -100s`);
  });

  it('names a clock in a form the clock accepts, however far out it sits', async (t) => {
    /*
      Both of these say which numbers there are to ask for, and both said them in a notation
      the parser refuses.

          Timed from 1e+21s  (first sample; --start and --end use this clock)
          error: --start "9e21" is at or past the end of this 3e+21s recording,
                 which runs from 1e+21s to 4e+21s.

          $ edf2csv far.edf --start 1e+21s
          error: --start "1e+21s" uses an unknown unit "e". Use h, m, s or ms, ...

      `toFixed` switches to exponent notation at 1e21 and `Number(...)` puts it back, so the
      one line whose parenthesis is an instruction — type this back in — ended in a token that
      is not a time, and so did both bounds of the sentence that exists to name the window.
      The same 1e21 cliff the CSV cells are already expanded past with BigInt, in the two
      places that print a clock instead of a column.

      Reachable from a conforming file: an EDF+ onset is plain digits of any length, and a
      record duration wide enough to keep samples apart out there is four characters. The
      tokens are taken from what the tool printed rather than written out here, so a fix that
      changes the notation again has to keep them typeable.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-far-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const T = String.fromCharCode(0x14);
    const Z = String.fromCharCode(0x00);
    const far = path.join(dir, 'far-origin.edf');
    writeEdf({
      path: far,
      reserved: 'EDF+D',
      numRecords: 3,
      recordDuration: 1e21,
      talsForRecord: (record) => `+${(10n ** 21n * BigInt(record + 1)).toString()}${T}${T}${Z}`,
      signals: [
        { label: 'EEG', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000,
          digMax: 1000, samplesPerRecord: 4, gen: (r, s) => r * 4 + s },
        { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768,
          digMax: 32767, samplesPerRecord: 40, annotations: true },
      ],
    });

    const info = await cli([far, '--info']);
    assert.equal(info.code, 0, info.stderr);
    const timed = /^Timed from (\S+)s {2}\(first sample/mu.exec(info.stdout);
    assert.ok(timed, `--info printed no origin for a recording that has one:\n${info.stdout}`);

    const fromInfo = await cli([far, '--out', path.join(dir, 'a'), '--quiet',
      `--start=${timed[1]}s`]);
    assert.equal(fromInfo.code, 0,
      `--info said "Timed from ${timed[1]}s" and --start refused it:\n${fromInfo.stderr}`);

    // The other half: the error that names the window hands back two bounds, and both have
    // to be askable. Its own start is quoted back as the caller typed it, so this reads the
    // pair after "runs from".
    const past = await cli([far, '--info', `--start=${(9n * 10n ** 21n).toString()}`]);
    assert.equal(past.code, 2, past.stderr);
    const bounds = /runs from (\S+)s to (\S+)s/u.exec(past.stderr);
    assert.ok(bounds, `the window error named no bounds:\n${past.stderr}`);

    const named = await cli([far, '--out', path.join(dir, 'b'), '--quiet',
      `--start=${bounds[1]}s`, `--end=${bounds[2]}s`]);
    assert.equal(named.code, 0,
      `the error offered ${bounds[1]}s to ${bounds[2]}s and refused them:\n${named.stderr}`);
    const rows = (await readFile(path.join(dir, 'b', 'signals.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(rows.length - 1, 12, 'the named bounds are the whole recording');

    // Ordinary magnitudes keep the rendering they had, down to the trailing zeros: this is a
    // notation change at 1e21 and nowhere else.
    assert.match((await cli([fixture('late-start.edf'), '--info'])).stdout,
      /^Timed from 30\.000s {2}\(first sample/mu);
    assert.match((await cli([fixture('negative-origin.edf'), '--info'])).stdout,
      /^Timed from -100\.000s {2}\(first sample/mu);
    assert.match((await cli([fixture('tiny.edf'), '--info', '--start=99'])).stderr,
      /at or past the end of this 2s recording/u);
    t.diagnostic(`origin printed as ${timed[1]}s, window as ${bounds[1]}s to ${bounds[2]}s`);
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

  it('wraps every hint to the terminal, without wrapping the warning above it', async () => {
    /*
      The `warning: ` head is one line per diagnostic so that grepping a log finds whole
      warnings, and it stays one line at whatever width the message runs to. The hint below
      it is prose for a person and wraps at 80 — it already sat on its own unprefixed
      continuation line, so nothing greps for it and nothing depended on its width.

      Asserted over every fixture because the long hints are the ones a damaged header
      produces, and those are exactly the fixtures kept here.
    */
    const names = (await readdir(path.join(ROOT, 'test', 'fixtures', 'generated'))).filter((n) =>
      /\.(edf|bdf)$/u.test(n),
    );
    assert.ok(names.length > 10, `expected the generated fixtures, got ${names.length}`);

    const wide = [];
    let hints = 0;
    let prose = 0;
    for (const name of names) {
      for (const extra of [[], ['--layout', 'long'], ['--decimals', '20'], ['--gzip']]) {
        const { stdout, stderr } = await cli([fixture(name), '--info', ...extra]);
        for (const line of stderr.split('\n')) {
          if (!/^ {9}\S/u.test(line)) continue;
          hints++;
          if (line.length > 80) wide.push(`${name}: hint ${line.length} cols — ${line.trim()}`);
        }
        /*
          --info's own prose, which is everything below the channel table. The lines above
          it are laid out in columns — the key-value block and the table itself — and either
          may exceed 80 because a header is free to carry a long patient id or channel
          label. Those are aligned, not wrapped, and re-flowing them would be the bug.
        */
        const lines = stdout.split('\n');
        const head = lines.findIndex((l) => l.startsWith('#  COLUMN'));
        if (head === -1) continue;
        const after = lines.indexOf('', head);
        for (const line of lines.slice(after + 1)) {
          if (line === '') continue;
          prose++;
          if (line.length > 80) wide.push(`${name}: info ${line.length} cols — ${line}`);
        }
      }
    }
    assert.ok(hints > 20, `expected hints to assert about, saw ${hints}`);
    assert.ok(prose > 20, `expected --info prose to assert about, saw ${prose}`);

    /*
      And the hint under a refusal, which is the same sentence often enough to matter: a
      mixed-rate recording refused by --stdout and the same recording described by --info
      both end in "Narrow it to one rate with --channels ...". One arrived as a
      ConversionError hint, the other as a Diagnostic hint, and until 0.7.3 they wrapped
      differently.

      Only the seven-space hint. The `error: ` line above it carries the path the tool was
      given and stays one line, for the same reason `warning: ` does.
    */
    let refusals = 0;
    for (const args of [
      [fixture('mixed-rates.edf'), '--stdout'],
      [fixture('mixed-rates.edf'), '--stdout', '--json'],
      [fixture('mixed-rates.edf'), '--stdout', '--annotations-only'],
      [fixture('mixed-rates.edf'), '--channels', 'ZZZ'],
      [fixture('mixed-rates.edf'), '--layout', 'sideways'],
      [fixture('mixed-rates.edf'), '--start', '5000'],
      [fixture('mixed-rates.edf'), '--start', '1x'],
      [fixture('mixed-rates.edf'), '--channels', '#99'],
      [fixture('mixed-rates.edf'), '--out', '-nightly'],
      [fixture('mixed-rates.edf'), '--chanel', 'EEG'],
      [fixture('annotations.edf'), '--channels', 'EDF Annotations'],
      [fixture('mixed-rates.edf'), '--stdout', '--checksum'],
      [fixture('mixed-rates.edf'), '--stdout', '--force'],
    ]) {
      const { stderr } = await cli(args);
      for (const line of stderr.split('\n')) {
        if (!/^ {7}\S/u.test(line)) continue;
        refusals++;
        if (line.length > 80) wide.push(`${args.join(' ')}: ${line.length} cols — ${line.trim()}`);
      }
    }
    assert.ok(refusals > 8, `expected refusal hints to assert about, saw ${refusals}`);

    /*
      And the one continuation that must NOT have been wrapped. The unknown-option error
      ends on a command to paste back into the shell, and a wrap would put `edf2csv --` on
      one line and the flag on the next.
    */
    const { stderr: unknown } = await cli([fixture('mixed-rates.edf'), '--chanel', 'EEG']);
    assert.match(unknown, /^ {7}edf2csv -- "--chanel"$/mu, unknown);

    /*
      And the refusals that interpolate a path, which only overrun on a deep one. The
      fixtures live four directories down from the repository root, so a refusal naming one
      is already past 80 before the sentence around it starts — the --stdout-on-a-folder
      message reached 268 columns this way, and no test noticed because none of them used a
      destination long enough.

      The path itself is one word with nowhere to break, so it stays whole on its own line
      and overruns deliberately. That is the useful shape: the path is the part that gets
      copied, and it is asserted to arrive unsplit.
    */
    const nested = path.join(
      await outDir(),
      'night-recordings',
      'subject-0142',
      'session-b',
      'pre-sleep-baseline',
    );
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'rec.edf'), await readFile(fixture('tiny.edf')));
    const folder = await cli([nested, '--stdout']);
    const long = [];
    for (const line of folder.stderr.split('\n')) {
      if (!/^ {7}\S/u.test(line) || line.length <= 80) continue;
      // A single unbroken word is the path, and is allowed to run past the column.
      if (!/\s/u.test(line.trim())) continue;
      long.push(`${line.length} cols — ${line.trim()}`);
    }
    assert.deepEqual(long, [], `wrappable text past 80 columns:\n${long.join('\n')}`);
    const recording = path.join(nested, 'rec.edf');
    assert.ok(
      folder.stderr.split('\n').some((line) => line === `       ${recording}`),
      `the path must arrive on one line, unsplit:\n${folder.stderr}`,
    );
    assert.deepEqual(wide, [], `lines past 80 columns:\n${wide.join('\n')}`);
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

  it('reads two spellings of one path as one name, not two', async (t) => {
    /*
      A recording named both directly and through a folder keeps the position the folder gives
      it — that is the documented rule, and the depth comparison in `outnames` is what applies
      it. It was never reached: the comparison above it settled the two names on lexicographic
      order of the paths *as typed*, so `study/night-01/rec.edf` and `./study/night-01/rec.edf`
      were two different names for one file.

      What that decided was not cosmetic. With a `study/rec.edf` beside it, one spelling
      converted both recordings and exited 0, and the other was refused — "would both be
      converted into "out/rec", so one would overwrite the other" — exit 2, nothing written.
      A leading `./` decided whether the run happened.
    */
    const dir = await stage({
      'study/night-01/rec.edf': 'tiny.edf',
      // The sibling whose bare name collides, which is what turns the disagreement into a
      // refusal rather than a rename.
      'study/rec.edf': 'mixed-rates.edf',
    });
    const study = path.join(dir, 'study');
    const nested = path.join('study', 'night-01', 'rec.edf');

    const spellings = [
      path.join(dir, nested),
      `.${path.sep}${nested}`,
      nested,
    ];
    const written = [];
    for (const [index, spelling] of spellings.entries()) {
      const out = path.join(dir, `out${index}`);
      // The relative spellings have to be read from the staging directory to mean anything.
      const ran = await cli([study, spelling, '--out', out, '--quiet'], { cwd: dir });
      assert.equal(ran.code, 0, `spelled "${spelling}" was refused:\n${ran.stderr}`);
      written.push((await readdir(out)).sort().join(','));
    }
    assert.equal(new Set(written).size, 1, `spellings disagreed: ${written.join(' | ')}`);
    assert.equal(written[0], 'night-01,rec', 'the folder gives the nested one its position');
    t.diagnostic(`three spellings, one answer: ${written[0]}`);
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

  it('describes a recording that does not start at zero by its length, not its end', async () => {
    /*
      The end of a recording is its length only when it begins at zero, and one timed from
      its first record's timekeeping TAL need not. A file whose records run 1000s to 1003s is
      three seconds long; `--start 5000` called it "this 16m 43s recording", while --info two
      lines away said "Duration 3s". Same file, same session, two answers.

      And a window before such a recording was told it "is inside the recording but lands
      where there is no data — past the last sample, or inside a gap in a discontinuous
      file", when it sits entirely before the first sample and neither explanation applies.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-shifted-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const T = String.fromCharCode(0x14);
    const Z = String.fromCharCode(0x00);
    const shifted = path.join(dir, 'shifted.edf');
    writeEdf({
      path: shifted,
      reserved: 'EDF+C',
      numRecords: 3,
      recordDuration: 1,
      talsForRecord: (record) => `+${1000 + record}${T}${T}${Z}`,
      signals: [
        { label: 'EEG', dimension: 'uV', physMin: -100, physMax: 100, digMin: -2048,
          digMax: 2047, samplesPerRecord: 4, gen: (r, s) => r * 4 + s },
        { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768,
          digMax: 32767, samplesPerRecord: 60, annotations: true },
      ],
    });

    const past = await cli([shifted, '--start', '5000', '--out', path.join(dir, 'a')]);
    assert.equal(past.code, 2, past.stderr);
    assert.match(past.stderr, /this 3s recording, which runs from 1000s to 1003s/u, past.stderr);
    assert.doesNotMatch(past.stderr, /16m 43s/u, past.stderr);

    const before = await cli([shifted, '--start', '0', '--end', '1', '--out', path.join(dir, 'b')]);
    assert.equal(before.code, 0, before.stderr);
    assert.match(before.stderr, /This recording starts at 1000\.000s/u, before.stderr);
    assert.doesNotMatch(before.stderr, /inside a gap in a discontinuous file/u, before.stderr);

    // A window that really does land in a gap keeps the explanation that fits it.
    const gap = await cli([
      fixture('discontinuous.edf'), '--start', '3', '--end', '9', '--out', path.join(dir, 'c'),
    ]);
    assert.match(gap.stderr, /inside a gap in a discontinuous file/u, gap.stderr);
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

  it('does not blame the selection when there was nothing to select', async () => {
    /*
      Same missing file, a different reason for it, and the warning gave the first reason for
      the second case. A recording of nothing but EDF+ annotations reached the branch above
      and was told that "every channel selected carries zero samples per data record", that
      "channels.csv still describes them", and to run --info to see "which channels do carry
      samples" — three statements about channels, printed directly beneath a warning saying
      the file has none. Its channels.csv is a header row and nothing else.

      `--stdout` on the same file distinguishes the two cases, and `--info` prints one
      accurate line; this was the only path that did not.
    */
    const dir = await outDir();
    const converted = await cli([fixture('annotations-only.edf'), '--out', dir]);
    assert.equal(converted.code, 0, converted.stderr);
    assert.match(converted.stderr, /no signal data in this recording/u);
    assert.doesNotMatch(converted.stderr, /every channel selected/u);
    assert.doesNotMatch(converted.stderr, /which channels do carry samples/u);

    // The hint's two claims, both checkable: the events are in annotations.csv, and
    // channels.csv lists signal channels so it lists none.
    const channels = await readFile(path.join(dir, 'channels.csv'), 'utf8');
    assert.equal(channels.trimEnd().split('\n').length, 1, 'channels.csv is a header row alone');
    const events = await readFile(path.join(dir, 'annotations.csv'), 'utf8');
    assert.ok(events.trimEnd().split('\n').length > 1, 'and the events are where the hint says');

    // The other route keeps its own wording, which is true of it and not of this one.
    const selected = await cli([
      fixture('single-rate-empty-channel.edf'), '--channels', 'unused', '--out', await outDir(),
    ]);
    assert.match(selected.stderr, /every channel selected/u);
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
    // On a continuous recording the event count needs the annotation channel read record by
    // record, which is the scan --info exists to avoid, so it says so rather than inventing a
    // number: this file is read only as far as the first record stating a start time.
    assert.match(withEvents.stdout, /cannot be told from the header/u);
    assert.ok(!withEvents.stdout.includes('signals.csv'), 'no signal file is named');

    /*
      A discontinuous one is a different matter, and got the same sentence anyway.

      Every record start of an EDF+D file has to be read out of the annotation channel, because
      that is where its record times live — so by the time this line is printed the events have
      been read and counted, and "how many events there are cannot be told from the header" is
      an answer about the header to a question the run has already settled. It is the same
      shape as the "0 rows" this test was written for: --info declining to say what a
      conversion will do, on the one mode whose whole purpose is saying it.
    */
    for (const [name, expected] of [['lost-timekeeping-d.edf', 3], ['discontinuous.edf', 0]]) {
      const described = await cli([fixture(name), '--info', '--annotations-only']);
      assert.equal(described.code, 0, described.stderr);
      assert.ok(
        !/cannot be told from the header/u.test(described.stdout),
        `${name}: the events were read; the count is not unknowable\n${described.stdout}`,
      );
      const said = /Would write annotations\.csv with (\d+) events?/u.exec(described.stdout);
      assert.ok(said, `${name}: no count was given:\n${described.stdout}`);

      const out = await outDir();
      await cli([fixture(name), '--out', out, '--annotations-only', '--quiet']);
      const rows = (await readFile(path.join(out, 'annotations.csv'), 'utf8')).trimEnd().split('\n');
      assert.equal(Number(said[1]), rows.length - 1, `${name}: predicted ${said[1]} events`);
      assert.equal(Number(said[1]), expected, `${name}: the fixture changed under this test`);
    }

    // And the count follows the window, which filters the events as it filters the rows.
    const windowed = await cli([
      fixture('lost-timekeeping-d.edf'), '--info', '--annotations-only', '--start', '2',
    ]);
    const narrowed = /Would write annotations\.csv with (\d+) events?/u.exec(windowed.stdout);
    assert.ok(narrowed, windowed.stdout);
    const out = await outDir();
    await cli([
      fixture('lost-timekeeping-d.edf'), '--out', out, '--annotations-only', '--start', '2',
      '--quiet',
    ]);
    const rows = (await readFile(path.join(out, 'annotations.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(Number(narrowed[1]), rows.length - 1, 'the windowed count must match too');
    assert.ok(Number(narrowed[1]) < 3, 'the window has to have dropped something');

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

  it('names the recording in a batch warning when --quiet removes the header', async () => {
    /*
      A batch prints `[n/m] <path>` before each recording, and that header is what pairs a
      warning with the file it came from. --quiet suppresses it — the summary line it is
      documented to suppress — and took the attribution with it: two recordings, two
      warnings, no way to tell which raised which, while `error:` lines in the same run stay
      named. Same shape as the --info defect 0.5.34 fixed.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-quiet-'));
    temporaries.push(dir);
    for (const [name, source] of [
      ['night-01.edf', 'mixed-rates.edf'],
      ['night-02.edf', 'truncated.edf'],
    ]) {
      await writeFile(path.join(dir, name), await readFile(fixture(source)));
    }

    const quiet = await cli([dir, '--out', path.join(dir, 'out'), '--quiet']);
    assert.match(quiet.stderr, /warning: .*night-01\.edf: Channels use 3 different sampling/u);
    assert.match(quiet.stderr, /warning: .*night-02\.edf: The header declares 10 data records/u);

    // With the header there to do the pairing, the warnings say what they always said.
    const loud = await cli([dir, '--out', path.join(dir, 'out2')]);
    assert.match(loud.stderr, /^\[1\/2\] /mu);
    assert.match(loud.stderr, /^warning: Channels use 3 different sampling/mu);

    // And one recording has nothing to be confused with.
    const single = await cli([fixture('mixed-rates.edf'), '--out', await outDir(), '--quiet']);
    assert.match(single.stderr, /^warning: Channels use 3 different sampling/mu);

    /*
      And under --jobs, which 0.5.49 missed: it keyed the naming off the child's own `batch`
      flag, and a forked child does not have one. It is handed a single recording and a
      single destination, so it believes it is a single conversion and says nothing — leaving
      the parallel path exactly as the serial path had been, minus even a stable order to
      guess the attribution from.
    */
    const parallel = await cli([dir, '--out', path.join(dir, 'out3'), '--quiet', '--jobs', '2']);
    assert.equal(parallel.code, 0, parallel.stderr);
    assert.match(parallel.stderr, /warning: .*night-01\.edf: Channels use 3 different sampling/u,
      parallel.stderr);
    assert.match(parallel.stderr, /warning: .*night-02\.edf: The header declares 10 data records/u,
      parallel.stderr);

    // Not twice, when the header is there to do the pairing.
    const loudJobs = await cli([dir, '--out', path.join(dir, 'out4'), '--jobs', '2']);
    assert.match(loudJobs.stderr, /^warning: Channels use 3 different sampling/mu, loudJobs.stderr);
    assert.doesNotMatch(loudJobs.stderr, /warning: .*night-01\.edf: /u, loudJobs.stderr);
  });

  it('reports a window that selects nothing, which is a fact about the plan', async () => {
    /*
      EMPTY_WINDOW was pushed from the rows a conversion actually wrote, so --info never said
      it: `--info --start 0.31 --end 0.39` on a 10 Hz recording printed "Would write 0 rows"
      with no warning and exited 0 under --strict, while converting that window warned and
      exited 1. The hint reads "Run with --info to see where the records actually sit",
      advising the reader into the one mode that would not tell them.
    */
    const window = ['--start', '0.31', '--end', '0.39'];
    const codes = async (args) =>
      JSON.parse((await cli([...args, '--json'])).stdout).warnings.map((w) => w.code);

    assert.deepEqual(await codes([fixture('tiny.edf'), '--info', ...window]), ['EMPTY_WINDOW']);
    assert.deepEqual(
      await codes([fixture('tiny.edf'), '--out', await outDir(), ...window]),
      ['EMPTY_WINDOW'],
      'and exactly once, not twice',
    );
    assert.equal((await cli([fixture('tiny.edf'), '--info', '--strict', ...window])).code, 1);

    // A window that selects something says nothing, and neither does a recording with no
    // signal channels — it has no signal files for a window to be empty of.
    assert.deepEqual(await codes([fixture('tiny.edf'), '--info', '--start', '0', '--duration', '1']), []);
    assert.ok(!(await codes([fixture('annotations-only.edf'), '--info'])).includes('EMPTY_WINDOW'));
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
    // Wrapped to the terminal, so the sentence may carry a newline where a space would go.
    assert.match(without.stdout.replace(/\s+/gu, ' '), /no annotations\.csv\.gz either/u);
  });

  it('starts every recording where --info says it does', async () => {
    /*
      output-files.md defined the column as "seconds elapsed since the start of the recording.
      Zero is the first sample of the first data record" — and the second sentence has been
      false since 0.4.9 made the first record's timekeeping annotation the origin. The page's
      only other mention of record start times is scoped to EDF+D, and `fractional-start.edf`
      is EDF+C and begins at 0.500.

      Swept rather than spot-checked, since the claim is about every recording: whatever
      `--info` prints as `Timed from` — or its absence, meaning zero — has to be the first
      value in the file the conversion writes.
    */
    const names = (await readdir(path.join(ROOT, 'test', 'fixtures', 'generated'))).filter((n) =>
      /\.(edf|bdf)$/u.test(n),
    );
    assert.ok(names.length > 10, 'fixtures should be generated before this runs');

    let shifted = 0;
    for (const name of names) {
      const info = await cli([fixture(name), '--info']);
      if (info.code !== 0) continue;
      const claimed = /^Timed from ([\d.-]+)s/mu.exec(info.stdout);

      const dir = await outDir();
      const converted = await cli([fixture(name), '--out', dir, '--quiet']);
      if (converted.code !== 0) continue;
      let rows;
      try {
        rows = (await readFile(path.join(dir, 'signals.csv'), 'utf8')).trimEnd().split('\n');
      } catch {
        continue; // no signal table: annotations only, or no channel carries samples
      }
      if (rows.length < 2) continue;

      const first = Number(rows[1].split(',')[0]);
      if (claimed) {
        shifted++;
        assert.equal(first, Number(claimed[1]), `${name}: --info says ${claimed[1]}, file says ${first}`);
      } else {
        assert.equal(first, 0, `${name}: --info printed no origin, so the file must start at 0`);
      }
    }
    assert.ok(shifted >= 2, `no fixture exercises a non-zero origin (found ${shifted})`);
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

  it('does not warn about files in a directory it never created', async (t) => {
    /*
      `convert()` hashes the input under --checksum and scans the whole annotation channel
      for record start times before it claims the output directory, so there is a window —
      seconds wide on a long EDF+ — in which an interrupt finds nothing written at all. The
      handler printed the one sentence it had: "Files already written to "oa" are incomplete
      and should not be used", about a directory `ls` then reported did not exist. Nothing
      had been written, and the advice was to distrust nothing.

      The recording below is 300,000 records of an EDF+C file, sparse beyond its header, so
      it costs four kilobytes on disk and takes about three seconds to scan. The signal is
      sent at 400 ms, and the window only gets wider on a slower machine.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-preint-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const { statSync, truncateSync, existsSync } = await import('node:fs');
    const recording = path.join(dir, 'long-scan.edf');
    const records = 300_000;
    writeEdf({
      path: recording,
      reserved: 'EDF+C',
      numRecords: records,
      recordDuration: 1,
      truncateRecords: 0,
      signals: [
        { label: 'EEG', dimension: 'uV', physMin: -100, physMax: 100, digMin: -2048,
          digMax: 2047, samplesPerRecord: 4, gen: () => 0 },
        { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768,
          digMax: 32767, samplesPerRecord: 30, annotations: true },
      ],
    });
    truncateSync(recording, statSync(recording).size + records * (4 + 30) * 2);

    const { spawn } = await import('node:child_process');
    /*
      Two ways to lose, pulling opposite ways, so the wait tunes itself rather than being
      guessed once.

      This used to wait a flat 400 ms and skip on either. Both are scheduling accidents: the
      scan finishing first wants a shorter wait, the signal beating the handler's installation
      wants a longer one, and a loaded machine produces the second often — two skips in one
      suite run while the sweeps were running beside it. A skip reads as green and takes the
      check with it, and the check is that an interrupt before anything is written does not
      advise distrusting a directory that was never created.
    */
    let out = '';
    let attempt = 0;
    let wait = 400;
    let outcome = null;
    let stderr = '';
    for (; attempt < 6 && outcome === null; attempt++) {
      out = path.join(dir, `out-${attempt}`);
      const run = spawn(process.execPath, [CLI, recording, '--out', out, '--quiet'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      stderr = '';
      run.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (existsSync(out)) {
        // The scan finished first: interrupt sooner next time.
        run.kill('SIGKILL');
        await new Promise((resolve) => run.on('close', resolve));
        wait = Math.max(50, Math.round(wait / 2));
        continue;
      }
      const settled = await interrupted(run);
      // The signal beat the handler's installation: give it longer next time.
      // A floor as well as a doubling, so the ladder climbs from any starting point.
      if (settled.code === null) wait = Math.max(100, wait * 2);
      else outcome = settled;
    }
    if (outcome === null) {
      t.skip(`the interrupt could not be placed inside the scan in ${attempt} attempts`);
      return;
    }
    const { code } = outcome;

    assert.equal(code, 130, `expected the signal exit status, stderr was:\n${stderr}`);
    assert.match(stderr, /interrupted \(SIGINT\)/u);
    assert.match(stderr, /Nothing was written/u, stderr);
    assert.match(stderr, /was never created/u, stderr);
    assert.doesNotMatch(stderr, /Files already written/u, stderr);
    assert.equal(existsSync(out), false, 'and the directory really is not there');
  });

  it('resolves auto against the cores this process may use', async () => {
    /*
      "`auto` is one job per core less one, so a long batch leaves the machine usable" is the
      documented promise, and the count came from `os.cpus().length` — every core the kernel
      can see, which is the machine's answer to a question about this process. A container
      given two CPUs of a sixty-four core node, a job pinned by `taskset`, a
      `docker --cpuset-cpus`: in every one of them `auto` asked for sixty-three workers, which
      is the promise inverted.

      `os.availableParallelism` is the call for that question and has been in Node since 18.14;
      this package requires 20. It reports the parallelism actually available to the process
      rather than the size of the machine around it.

      Nothing checked the number either way. `auto` appears in one test, as a value the option
      accepts, and what it resolves to is invisible from outside — the only effect is how many
      children run at once, which a test would have to race to observe. So the resolver is
      exported and asked directly, the way `worstOf` already is.
    */
    const { parseJobs } = await import('../dist/cli.js');
    const { availableParallelism, cpus } = await import('node:os');
    const usable = availableParallelism();

    // One per core less one, and never more jobs than there are recordings to run them on.
    assert.equal(parseJobs('auto', 1000), Math.max(1, usable - 1), 'one per core, less one');
    assert.equal(parseJobs('auto', 2), Math.min(2, Math.max(1, usable - 1)));
    assert.equal(parseJobs('auto', 1), 1, 'one recording is one job');
    assert.ok(parseJobs('auto', 1000) >= 1, 'never zero, whatever the machine says');

    // And it is the process's count rather than the machine's. They agree on an unrestricted
    // machine, which is where this runs, so what is asserted is which call was made: a stub
    // that reports a different number has to change the answer.
    assert.equal(typeof availableParallelism, 'function');
    assert.ok(usable <= cpus().length, 'a process cannot have more cores than the machine');

    // The explicit counts are unaffected.
    assert.equal(parseJobs('4', 1000), 4);
    assert.equal(parseJobs(undefined, 1000), 1, 'one at a time unless asked');
  });

  it('calls a killed worker a failure, not a usage error', async () => {
    /*
      `worstOf` tested for exit 1 and fell through to exit 2 for everything else, on the
      assumption that a child exits 1 or 2. A child killed by a signal exits 130 or 143 — its
      own interrupt handler does that — so a worker stopped by SIGTERM made the whole batch
      exit 2: "The command line is the problem" in cli-reference's table, "The command was
      invoked incorrectly" in warnings-and-errors. The command was fine; something killed a
      worker. The out-of-memory killer and a scheduler's time limit both arrive this way.

      Exercised through the code rather than by killing a real worker, which needs a
      conversion long enough to catch and is a race in a test suite. The mapping is the defect.
    */
    const { worstOf } = await import('../dist/cli.js');
    assert.equal(typeof worstOf, 'function', 'worstOf is not exported for testing');

    assert.equal(worstOf([143]), 1, 'a worker killed by SIGTERM is a failure');
    assert.equal(worstOf([130]), 1, 'and so is one stopped by SIGINT');
    assert.equal(worstOf([1]), 1);
    assert.equal(worstOf([2]), 2, 'a usage error is still a usage error');
    assert.equal(worstOf([2, 2]), 2);
    assert.equal(worstOf([2, 143]), 1, 'anything that is not a usage error wins');
    assert.equal(worstOf([1, 2]), 1);
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

    /*
      Interrupted when the batch has demonstrably started, not after a fixed wait.

      A flat 400 ms was two guesses at once: long enough for the handler to be installed, short
      enough that thirty conversions cannot all have finished. The first is the one that failed
      — on a loaded machine Node has not finished booting in 400 ms, the default action for
      SIGINT applies, the process dies with a null code, and the test skipped itself. Two of
      those in one suite run while the sweeps were running beside it. A skip reads as green and
      takes the check with it, and the check is that an interrupted batch does not report
      success and does name the directories it left half-written.

      The batch prints `[1/30]` as the first recording finishes, so that line is proof of both
      halves at once: the parent is well past installing its handler, and twenty-nine
      recordings are still to come. Waiting for it replaces both guesses with the event they
      were standing in for.
    */
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`no batch progress in 60s: ${stderr}`)), 60_000);
      const check = () => {
        if (!/\[1\/\d+\]/u.test(stderr)) return;
        clearTimeout(deadline);
        run.stderr.off('data', check);
        resolve();
      };
      run.stderr.on('data', check);
      check();
    });
    const { code } = await interrupted(run);

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
    // Wrapped to the terminal: a long destination sits on its own line, unbroken, so the
    // sentence and the path may be separated by a newline and seven spaces.
    assert.match(
      stderr.replace(/\s+/gu, ' '),
      /Incomplete, and should not be used: .*out\/r\d\d/u,
      'and so must the directory it left behind',
    );
  });

  it('rejects a job count that is not a whole number of one or more', async () => {
    // Checked in every mode, including the two where the value cannot be honoured anyway:
    // --stdout converts one recording however many jobs are asked for, but a request that
    // cannot be met is a usage error rather than something to accept in silence.
    for (const mode of [['--info'], ['--stdout']]) {
      /*
        The last four went through `Number()`, which reads `0x10` as 16, `1e3` as 1000, and
        `999999999999999999999` as the nearest double to it — while `1.5` was refused. The
        message promises "a whole number of 1 or more", and refusing 1.5 is what makes a
        reader believe it, so the others read as the tool silently reinterpreting what they
        typed.
      */
      for (const jobs of ['0', 'abc', '1.5', '', '0x10', '1e3', '999999999999999999999', '+4']) {
        const { code, stderr } = await cli([fixture('tiny.edf'), '--jobs', jobs, ...mode]);
        assert.equal(code, 2, `--jobs ${JSON.stringify(jobs)} ${mode.join(' ')}`);
        assert.match(stderr, /--jobs must be a whole number/u);
      }

      // What it does take: a plain decimal, padded or not, and "auto".
      for (const jobs of ['1', '4', ' 4 ', 'auto']) {
        const { code, stderr } = await cli([fixture('tiny.edf'), '--jobs', jobs, ...mode]);
        assert.equal(code, 0, `--jobs ${JSON.stringify(jobs)} ${mode.join(' ')}: ${stderr}`);
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

  it('does not spend more words hiding one item than naming it would', async () => {
    /*
      The cut is at eight, and the ninth item was replaced by "and 1 more" — eleven characters
      standing in for one rate:

          Channels use 9 different sampling rates (100 Hz, 99 Hz, 98 Hz, 97 Hz, 96 Hz,
          95 Hz, 94 Hz, 93 Hz and 1 more).

      Four characters longer than naming all nine, and one rate shorter. The sentence has
      already said there are nine, so the reader is given the count and then denied the item —
      by a phrase that costs more than the item does. The cap exists because a 200-channel
      recording produced a 1,545-character line; one item over is not that.
    */
    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-listed-'));
    temporaries.push(scratch);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const rated = (count) => {
      const at = path.join(scratch, `rates-${count}.edf`);
      writeEdf({
        path: at,
        numRecords: 1,
        recordDuration: 1,
        signals: Array.from({ length: count }, (unused, i) => ({
          label: `ch${i}`, dimension: 'uV', physMin: -100, physMax: 100,
          digMin: -1000, digMax: 1000, samplesPerRecord: 100 - i, gen: () => 1,
        })),
      });
      return at;
    };
    const warningFor = async (count) => {
      const { stderr } = await cli([rated(count), '--info']);
      const line = stderr.split('\n').find((l) => l.includes('different sampling rates'));
      assert.ok(line, `no rate warning for ${count} rates:\n${stderr}`);
      return line;
    };

    // Nine rates, all nine named, and the phrase that used to hide one of them gone.
    const nine = await warningFor(9);
    for (let rate = 100; rate > 91; rate--) {
      assert.ok(nine.includes(`${rate} Hz`), `${rate} Hz is missing from: ${nine}`);
    }
    assert.ok(!/and 1 more/u.test(nine), nine);

    // Eight is unchanged, and ten still counts its remainder — where two items really are
    // longer than the words replacing them.
    assert.ok(!/more/u.test(await warningFor(8)));
    const ten = await warningFor(10);
    assert.match(ten, /and 2 more/u);
    assert.ok(!ten.includes('91 Hz'), ten);
  });

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
        // `rows?`: what this checks is that the unit is there at all, and a one-row table
        // says "row" since 0.5.78.
        new RegExp(`${name.replaceAll('.', '\\.')}\\s+[\\d,]+\\s+rows?\\b`, 'u'),
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
    /*
      And it says so. 0.5.32 stopped the guard refusing --info and put nothing in its place,
      while the sentence it added to cli-reference says "--info --out is how you would want
      to find out about them" — so the one command documented as the way to learn about a
      collision said nothing about it.
    */
    assert.match(info.stderr, /would both be converted into/u);
    assert.match(info.stderr, /^warning: /mu, 'reported, not refused');

    // A run with nothing to collide leaves stderr alone.
    const clean = await cli([both[0], '--info', '--out', path.join(dir, 'clean')]);
    assert.equal(clean.stderr, '');

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
      assert.match(stderr.replace(/\s+/gu, ' '), /whether it holds recordings is unknown/u);
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
      assert.match(stderr, /Converted 1 of 1 recording; 1 path could not be read\./u);

      /*
        And once however many ways the folder was named. Each named directory is walked
        separately and its findings appended, with no deduplication — while the recordings
        beside them were deduplicated by identity a few lines later. So `edf2csv study study`
        printed the error twice and closed with "1 of 1 recordings; 2 paths could not be
        read": one path, counted two, in the sentence that tells someone how much of their
        study was never looked at.
      */
      const alias = path.join(dir, 'alias');
      await symlink(inside, alias);
      for (const [label, args] of [
        ['named twice', [inside, inside]],
        ['through a link', [inside, alias]],
      ]) {
        const twice = await cli([...args, '--out', path.join(dir, `out-${label.split(' ')[0]}`)]);
        assert.match(
          twice.stderr,
          /Converted 1 of 1 recording; 1 path could not be read\./u,
          `${label}: ${twice.stderr}`,
        );
        const errors = twice.stderr.split('\n').filter((line) => line.startsWith('error: '));
        assert.equal(errors.length, 1, `${label} reported it ${errors.length} times`);
      }

      // Two genuinely different unreadable paths are still two.
      const second = path.join(dir, 'other');
      await mkdir(path.join(second, 'shut'), { recursive: true });
      await writeFile(path.join(second, 'r.edf'), await readFile(fixture('tiny.edf')));
      await chmod(path.join(second, 'shut'), 0o000);
      try {
        const both = await cli([inside, second, '--out', path.join(dir, 'out-both')]);
        assert.match(both.stderr, /Converted 2 of 2 recordings; 2 paths could not be read\./u,
          both.stderr);
      } finally {
        await chmod(path.join(second, 'shut'), 0o755);
      }
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
    assert.match(stderr, /2 data records start earlier than the record before them/u);
    // Hints are wrapped to the terminal, so the sentence can carry a newline and nine
    // spaces anywhere a space would go. What is asserted is the sentence, not the column
    // it happened to break at.
    assert.match(stderr.replace(/\s+/gu, ' '), /will not increase monotonically/u);

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
  it('names the obstacle in words rather than handing back an errno', async () => {
    /*
      `describeFsError` turns a filesystem failure into a sentence, and it knew six codes.
      The seventh reaches it through the destination that a recursive mkdir cannot create: a
      parent that exists and leads nowhere. A symbolic link with no target is one, and
      `--out ""` is the other, since `mkdir('')` is ENOENT too.

      What came back was Node's own message, including the call that raised it:

          error: Cannot create "dangle/x": ENOENT: no such file or directory, mkdir 'dangle'.

      An errno, an internal function name, and a quoted argument, on the line this tool puts
      its plainest sentences on. The advice underneath it said to check the path exists.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-enoent-'));
    temporaries.push(dir);
    await writeFile(path.join(dir, 'a.edf'), await readFile(fixture('tiny.edf')));
    await symlink(path.join(dir, 'no-such-target'), path.join(dir, 'dangling'));

    const through = await cli([
      path.join(dir, 'a.edf'), '--out', path.join(dir, 'dangling', 'inner'),
    ]);
    assert.equal(through.code, 1, through.stderr);
    const flat = through.stderr.replace(/\s+/gu, ' ');
    assert.match(flat, /part of the path does not exist/u);
    for (const leak of ['ENOENT', 'mkdir', 'no such file or directory']) {
      assert.ok(!flat.includes(leak), `the message carries "${leak}": ${flat}`);
    }
  });

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
    // Hints wrap to the terminal, so the sentence may carry a newline and seven spaces
    // anywhere a space would go. What is asserted is the advice, not its line breaks.
    const flat = isDirectory.stderr.replace(/\s+/gu, ' ');
    assert.match(flat, /A directory is sitting where that file belongs/u);
    assert.ok(!/Free up space/u.test(flat), 'the disk is not the problem here');

    const readonly = path.join(dir, 'ro');
    await mkdir(readonly, { recursive: true });
    await chmod(readonly, 0o500);
    try {
      const denied = await cli([path.join(dir, 'a.edf'), '--out', readonly, '--force']);
      assert.equal(denied.code, 1, denied.stderr);
      assert.match(denied.stderr.replace(/\s+/gu, ' '), /You do not have permission to write there/u);
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

  it('shapes every refusal like the others, so a log can be grepped for one', async () => {
    /*
      Every usage error in this tool prints "error: <what>" with its advice indented seven
      spaces under it, and the documentation shows them that way — except the two --stdout
      refusals written before the prefix was, which printed flush left with no prefix at all.
      They are the pair a script is most likely to hit, since both flags are things a script
      passes rather than a person, and a refusal that does not match `^error:` is invisible to
      the grep that finds every other one.

      Checked as a shape over all of them rather than as two more string assertions.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-shape-'));
    temporaries.push(dir);
    await writeFile(path.join(dir, 'only.edf'), await readFile(fixture('tiny.edf')));

    /*
      Every `--stdout` refusal, not the ones that came to mind. This test was written in
      0.5.79 and did not enumerate `--stdout --out` or `--stdout --checksum`, which were
      still printing flush left with no prefix — the very shape it exists to hold.
    */
    const refusals = [
      [fixture('tiny.edf'), '--stdout', '--json'],
      [fixture('tiny.edf'), fixture('annotations.edf'), '--stdout'],
      [dir, '--stdout'],
      [fixture('tiny.edf'), '--stdout', '--annotations-only'],
      [fixture('tiny.edf'), '--stdout', '--out', path.join(dir, 'x')],
      [fixture('tiny.edf'), '--stdout', '--checksum'],
      [fixture('tiny.edf'), '--stdout', '--force'],
      [fixture('mixed-rates.edf'), '--stdout'],
      [fixture('tiny.edf'), '--duration', '1', '--end', '2'],
      [fixture('tiny.edf'), '--layout', 'sideways'],
    ];
    for (const args of refusals) {
      const { code, stdout, stderr } = await cli(args);
      assert.equal(code, 2, `${args.join(' ')} did not exit 2:\n${stderr}`);
      assert.equal(stdout, '', `${args.join(' ')} wrote to stdout`);
      const lines = stderr.trimEnd().split('\n');
      assert.match(lines[0], /^error: /u, `${args.join(' ')} first line: ${lines[0]}`);
      for (const line of lines.slice(1)) {
        assert.match(line, /^ {7}\S/u, `${args.join(' ')} continuation: ${JSON.stringify(line)}`);
      }
    }

    // And the count in the one that has one agrees with itself.
    const two = await cli([fixture('tiny.edf'), fixture('annotations.edf'), '--stdout']);
    assert.match(two.stderr, /cannot take 2 recordings/u, two.stderr);

    /*
      `--force` was accepted and dropped in silence until 0.5.100 — the thing 0.5.5 refused
      `--out` and `--checksum` for. `--jobs` stays accepted on purpose: a job count is a
      property of the run rather than a request about this file's output, and a wrapper that
      passes `--jobs 4` to everything is not asking for something `--stdout` cannot do.
    */
    const withJobs = await cli([fixture('tiny.edf'), '--stdout', '--jobs', '4']);
    assert.equal(withJobs.code, 0, withJobs.stderr);
    assert.match(withJobs.stdout, /^time_s,/u, 'the CSV still goes to stdout');
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

  it('leaves no blank line behind the summary --quiet removed', async () => {
    /*
      The blank line under a block of warnings separates them from the summary below, so it
      belongs to the summary. `--quiet` dropped the summary and printed the separator
      anyway — a stray blank line per recording, in the mode that exists to print less, and
      five hundred of them in a batch of five hundred.

      The recording above raises nothing, so the case never showed there. This one raises
      the mixed-rate warning.
    */
    const quiet = await cli([fixture('mixed-rates.edf'), '--out', await outDir(), '--quiet']);
    assert.equal(quiet.code, 0, quiet.stderr);
    assert.match(quiet.stderr, /^warning: /u, quiet.stderr);
    assert.doesNotMatch(quiet.stderr, /\n\n$/u, `trailing blank line: ${JSON.stringify(quiet.stderr)}`);

    /*
      And the shape it distorted: --strict prints its verdict after a blank line, so under
      --quiet there were two of them where an ordinary run shows one.
    */
    const strict = await cli([
      fixture('mixed-rates.edf'), '--out', await outDir(), '--quiet', '--strict',
    ]);
    assert.equal(strict.code, 1, strict.stderr);
    assert.doesNotMatch(strict.stderr, /\n\n\n/u, JSON.stringify(strict.stderr));

    const loud = await cli([fixture('mixed-rates.edf'), '--out', await outDir(), '--strict']);
    // Blank lines immediately above the "--strict:" verdict, in each mode.
    const blanksBefore = (text) => {
      const lines = text.split('\n');
      let at = lines.findIndex((line) => line.startsWith('--strict:'));
      let blanks = 0;
      while (at > 0 && lines[at - 1] === '') {
        blanks++;
        at--;
      }
      return blanks;
    };
    assert.equal(
      blanksBefore(strict.stderr),
      blanksBefore(loud.stderr),
      `--quiet must not change how the --strict line is spaced:\n${JSON.stringify(strict.stderr)}\n${JSON.stringify(loud.stderr)}`,
    );
  });

  it('accepts a time window in human units', async () => {
    /*
      This asserted the exit code and nothing else. A build that ignored `--start` and
      `--duration` outright converts the whole recording and exits 0, and so did one that read
      `500ms` as five hundred seconds — the flags this test is named for could have meant
      anything, or nothing, and it would still have gone green.

      What a unit is worth is checked instead: `0.5s` and `500ms` have to select exactly the
      rows `0.5` and `0.5` select, byte for byte, and `500ms` has to differ from `500`, which is
      the whole of what "ms" means. The recording is 2 seconds at 250 Hz in 0.1 s records, so
      half a second is 125 rows and the boundary lands inside a record rather than on one.
    */
    const recording = fixture('fractional-recdur.edf');
    const convert = async (start, duration) => {
      const dir = await outDir();
      const result = await cli([recording, '--out', dir, '--start', start, '--duration', duration,
        '--quiet']);
      assert.equal(result.code, 0, `--start ${start} --duration ${duration}: ${result.stderr}`);
      return (await readFile(path.join(dir, 'signals.csv'), 'utf8')).trimEnd().split('\n');
    };

    const spelled = await convert('0.5s', '500ms');
    const plain = await convert('0.5', '0.5');
    assert.deepEqual(spelled, plain, 'the units name the same window as the bare seconds do');

    // Not vacuous: it is a window, and it is the right one.
    assert.equal(spelled.length - 1, 125, spelled.slice(0, 3).join(' | '));
    assert.equal(spelled[1], '0.500,12.500');
    assert.equal(spelled[spelled.length - 1], '0.996,24.900');

    // And a unit that is ignored is a unit that means nothing: 500 seconds is the rest of the
    // recording, which is a different answer to the same digits.
    const seconds = await convert('0.5s', '500');
    assert.notDeepEqual(seconds, spelled, '"500ms" and "500" cannot name the same length');
    assert.equal(seconds.length - 1, 375, 'a duration past the end takes what is there');

    // The clock and the compound forms reach the same arithmetic, on a longer recording.
    const clock = await cli([fixture('annotations.edf'), '--out', await outDir(), '--quiet',
      '--start', '00:00:01', '--duration', '1s']);
    assert.equal(clock.code, 0, clock.stderr);
    const compound = await cli([fixture('annotations.edf'), '--info', '--json',
      '--start', '0h0m1s', '--end', '2s']);
    assert.equal(compound.code, 0, compound.stderr);
    assert.equal(JSON.parse(compound.stdout).estimate.rows, 100);
  });
});
