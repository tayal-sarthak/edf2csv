/**
 * What the output looks like on an actual terminal.
 *
 *     npm run terminal
 *
 * The progress meter is the one part of this tool that only exists on a TTY: it is off
 * whenever `process.stderr.isTTY` is false, which is every test in the suite, because a
 * captured stderr is a pipe. So the meter has never been exercised by anything, and the
 * defect that prompted this went unseen — a conversion that failed part way left the meter
 * on the line and the error was appended to it:
 *
 *     converting… 96%error: Expected 317440 bytes of data at record 1638 but only 0 ...
 *
 * `grep '^error:'` over that run finds nothing, which is the property every release since
 * 0.7.1 has been protecting.
 *
 * Not part of `npm test`, for the same reason `crossvalidate` is not: it needs a pseudo
 * terminal, which Node cannot allocate on its own, and the CI matrix includes Windows. It
 * borrows python3's `pty` module — already a dependency of `npm run crossvalidate` — and
 * exits 0 with a note if that is unavailable rather than failing a machine that simply does
 * not have it.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'dist/cli.js');

function havePython() {
  try {
    execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!havePython()) {
  process.stdout.write('python3 with the pty module is not available; nothing checked.\n');
  process.exit(0);
}

/**
 * Run the CLI under a pseudo terminal, shrinking `shrink` under it once it is reading.
 *
 * The truncation used to be a thread that slept fifty milliseconds and cut. Fifty
 * milliseconds is not a synchronisation primitive: it is longer than this conversion needs
 * on a fast machine and shorter than Node takes to boot on a loaded one, and the second is
 * the case that hurts. Cutting the file before the reader opens it leaves a short recording
 * whose header overstates its records — which this tool reads happily, exactly as the
 * "trusts the file over the header" test says it must — so the conversion exits 0, the check
 * has nothing to look at, and the sweep fails the build over a scheduling accident. It also
 * reported the opposite of what happened: "did not shrink in time", about a file that shrank
 * too early.
 *
 * The first bytes a conversion puts on a terminal are the meter, which is drawn from inside
 * the read loop. Waiting for them and cutting then is the event the sleep was standing in for.
 */
function underTty(args, shrink) {
  const script = `
import os, pty, select, subprocess, sys
args = sys.argv[1:]
shrink = os.environ.get('SHRINK') or ''
whole = os.path.getsize(shrink) if shrink else 0
master, slave = pty.openpty()
p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
buf = bytearray()
shrunk = not shrink
while True:
    r, _, _ = select.select([master], [], [], 20)
    if not r:
        break
    try:
        d = os.read(master, 4096)
    except OSError:
        break
    if not d:
        break
    buf.extend(d)
    if not shrunk:
        os.truncate(shrink, whole // 3)
        shrunk = True
p.wait()
sys.stdout.write(bytes(buf).decode('latin1'))
sys.stderr.write(str(p.returncode))
`;
  const run = spawnSync('python3', ['-c', script, process.execPath, ...args], {
    encoding: 'latin1',
    env: { ...process.env, SHRINK: shrink ?? '' },
    maxBuffer: 64 * 1024 * 1024,
  });
  return { output: run.stdout ?? '', code: Number(run.stderr) };
}

const work = mkdtempSync(path.join(tmpdir(), 'edf2csv-tty-'));
const problems = [];
/** Conditions this machine would not arrange. Said out loud, and not a failure. */
const notes = [];
let checked = 0;

try {
  const { writeEdf } = await import('../fixtures/edf-writer.mjs');
  // Big enough to need more than one read batch, so it can change under the reader.
  const write = (name) => {
    const at = path.join(work, name);
    writeEdf({
      path: at,
      numRecords: 1700,
      recordDuration: 1,
      signals: Array.from({ length: 10 }, (unused, channel) => ({
        label: `ch${channel}`,
        dimension: 'uV',
        physMin: -100,
        physMax: 100,
        digMin: -1000,
        digMax: 1000,
        samplesPerRecord: 256,
        gen: (record, sample) => (record + sample) % 1000,
      })),
    });
    return at;
  };
  // Two recordings: the first is truncated under the reader on purpose, so the checks that
  // need a whole file get their own.
  const shrinking = write('shrinking.edf');
  const steady = write('steady.edf');

  /*
    A conversion that fails while the meter is up. Every `error: ` and `warning: ` this tool
    prints has to begin a line — that is what makes a batch's stderr greppable — and the
    meter leaves the cursor mid-line, so the failure path has to take it down first.
  */
  const shrinkArgs = [CLI, shrinking, '--out', path.join(work, 'out'), '--channels', 'ch0'];
  let failed = underTty(shrinkArgs, shrinking);
  // A conversion that outran the cut anyway is a run with nothing in it, not a failure —
  // put the file back and ask again before giving up on it.
  for (let attempt = 0; failed.code === 0 && attempt < 3; attempt++) {
    copyFileSync(steady, shrinking);
    rmSync(path.join(work, 'out'), { recursive: true, force: true });
    failed = underTty(shrinkArgs, shrinking);
  }
  checked++;
  if (failed.code === 0) {
    /*
      The same answer this file already gives a machine with no pty module: say what was not
      checked and leave the exit code alone. A sweep that fails because it could not arrange
      its own conditions reports on the machine it ran on, not on the code.
    */
    notes.push('the recording could not be shrunk under the reader; that run proved nothing');
  } else {
    const lines = failed.output.split(/\r?\n/u);
    // The meter and the error may share a physical line, separated by \r and the erase.
    const errorLine = lines.find((line) => line.includes('error: '));
    if (errorLine === undefined) {
      problems.push('no error line at all');
    } else {
      const at = errorLine.indexOf('error: ');
      const before = errorLine.slice(0, at);
      // Whatever precedes it must end in a carriage return and an erase, not in the meter.
      if (!/\r\[K$/u.test(before) && before !== '') {
        problems.push(
          `"error: " does not start its line — preceded by ${JSON.stringify(before)}`,
        );
      }
    }
  }

  /*
    Compressed bytes at a terminal, which is the other thing only a terminal can be wrong
    about. `--stdout --gzip` is documented, and documented redirected; without the redirect
    it put a deflate stream on the screen.
  */
  const gz = underTty([CLI, steady, '--stdout', '--gzip', '--channels', 'ch0']);
  checked++;
  if (gz.code !== 2) {
    problems.push(`--stdout --gzip at a terminal exited ${gz.code}, expected 2`);
  } else if (!gz.output.includes('compressed bytes straight to the terminal')) {
    problems.push(`--stdout --gzip was refused without saying why: ${JSON.stringify(gz.output.slice(0, 120))}`);
  }
  // Every byte it printed has to be text; the point is that none of it drives the terminal.
  const control = [...gz.output].filter((c) => {
    const n = c.codePointAt(0);
    return (n < 32 && n !== 10 && n !== 13) || (n >= 127 && n <= 159);
  });
  if (control.length > 0) problems.push(`the refusal itself carried ${control.length} control bytes`);

  /*
    And the command that refusal offers, which is the only line in the tool that has to be
    pasted rather than read. It said:

        edf2csv <recording> --stdout --gzip > signals.csv.gz

    `<recording>` is a redirect. A shell looks for a file called `recording`, does not find
    one, and the command never runs — or finds one and hands edf2csv a stream it does not
    read. The recording is right there in the invocation being refused, and exactly one of
    them reaches this line.

    Checked by running it: the printed line goes to /bin/sh with `edf2csv` replaced by this
    Node and this CLI, and a gzip stream has to land where it says it will. The awkward name
    is the case that decides whether quoting was thought about at all.
  */
  const spaced = path.join(work, 'a steady one.edf');
  copyFileSync(steady, spaced);
  for (const [recording, what] of [[steady, 'an ordinary name'], [spaced, 'a name with a space']]) {
    const refusal = underTty([CLI, recording, '--stdout', '--gzip', '--channels', 'ch0']);
    checked++;
    const offered = refusal.output
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.startsWith('edf2csv '));
    if (offered === undefined) {
      problems.push(`${what}: the refusal offered no command to run`);
      continue;
    }
    if (offered.includes('<recording>')) {
      problems.push(`${what}: the command is a placeholder a shell reads as a redirect: ${offered}`);
      continue;
    }
    const target = path.join(work, `pasted-${recording === steady ? 'plain' : 'spaced'}.gz`);
    const command = offered.replace(
      /^edf2csv /u,
      `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} `,
    ).replace(/> signals\.csv\.gz$/u, `> ${JSON.stringify(target)}`);
    const pasted = spawnSync('/bin/sh', ['-c', command], { encoding: 'latin1' });
    if (pasted.status !== 0) {
      problems.push(`${what}: the offered command exited ${pasted.status}: ${command}`);
    } else if (!existsSync(target)) {
      problems.push(`${what}: the offered command wrote nothing to its destination`);
    } else {
      const head = readFileSync(target);
      // 1f 8b is the gzip magic; anything else means the redirect landed somewhere odd.
      if (head[0] !== 0x1f || head[1] !== 0x8b) {
        problems.push(`${what}: what the offered command wrote is not a gzip stream`);
      }
    }
  }

  // And the ordinary success, where the meter must also leave no residue behind the summary.
  const ok = underTty([CLI, steady, '--out', path.join(work, 'ok'), '--channels', 'ch0']);
  checked++;
  if (ok.code !== 0) {
    problems.push(`a clean conversion under a tty exited ${ok.code}`);
  } else {
    // Same shape as the error above: the meter is erased first, so the summary follows the
    // erase rather than the meter's text.
    const wrote = ok.output
      .split(/\r|\n/u)
      .find((line) => line.replace(/^\u001b\[K/u, '').startsWith('Wrote '));
    if (wrote === undefined) {
      problems.push(`the summary did not start its own line: ${JSON.stringify(ok.output.slice(-160))}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.stdout.write(`\n${checked} runs under a pseudo terminal.\n`);
for (const note of notes) process.stdout.write(`  ${note}\n`);
if (problems.length === 0) {
  process.stdout.write(
    'Every prefix began its own line, the meter was taken down first, and nothing but\n' +
      'text reached the screen.\n',
  );
} else {
  for (const problem of problems) process.stdout.write(`  ${problem}\n`);
  process.exitCode = 1;
}
