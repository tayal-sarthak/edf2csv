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

/** Run the CLI under a pseudo terminal, shrinking `shrink` under it after a moment. */
function underTty(args, shrink) {
  const script = `
import os, pty, select, subprocess, sys, threading, time
args = sys.argv[1:]
shrink = os.environ.get('SHRINK') or ''
whole = os.path.getsize(shrink) if shrink else 0
master, slave = pty.openpty()
p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
if shrink:
    threading.Thread(
        target=lambda: (time.sleep(0.05), os.truncate(shrink, whole // 3)), daemon=True
    ).start()
buf = bytearray()
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
  const failed = underTty(
    [CLI, shrinking, '--out', path.join(work, 'out'), '--channels', 'ch0'],
    shrinking,
  );
  checked++;
  if (failed.code === 0) {
    problems.push('the recording did not shrink in time; nothing was proven');
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
if (problems.length === 0) {
  process.stdout.write(
    'Every prefix began its own line, the meter was taken down first, and nothing but\n' +
      'text reached the screen.\n',
  );
} else {
  for (const problem of problems) process.stdout.write(`  ${problem}\n`);
  process.exitCode = 1;
}
