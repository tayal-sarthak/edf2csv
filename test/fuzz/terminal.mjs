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
function underTty(args, shrink, interrupt = false) {
  const script = `
import os, pty, select, subprocess, sys, signal, time
args = sys.argv[1:]
shrink = os.environ.get('SHRINK') or ''
interrupt = os.environ.get('INTERRUPT') == '1'
whole = os.path.getsize(shrink) if shrink else 0
master, slave = pty.openpty()
p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
buf = bytearray()
shrunk = not (shrink or interrupt)
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
        if interrupt:
            # Ctrl-C arrives while the meter is on the screen, which is the whole case.
            time.sleep(0.05)
            p.send_signal(signal.SIGINT)
        else:
            os.truncate(shrink, whole // 3)
        shrunk = True
p.wait()
sys.stdout.write(bytes(buf).decode('latin1'))
sys.stderr.write(str(p.returncode))
`;
  const run = spawnSync('python3', ['-c', script, process.execPath, ...args], {
    encoding: 'latin1',
    env: { ...process.env, SHRINK: shrink ?? '', INTERRUPT: interrupt ? '1' : '' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = run.stdout ?? '';
  /*
    What the meter actually said, which nothing has ever looked at.

    Every check here is about what happens around the meter — that it is taken down before an
    error, that nothing but text reaches the screen. The numbers in it were checked by neither:
    `100` in the source could read `101` and this sweep, the only thing in the project that can
    see a progress meter at all, would go on passing.
  */
  // The ellipsis is three UTF-8 bytes that make the round trip through python's stdout and
  // back as six latin1 characters, so the gap between the word and the number is wider than
  // it reads: allow up to a dozen non-digits rather than counting them.
  const drawn = [...output.matchAll(/converting\D{0,12}?(\d+)%/gu)].map((m) => Number(m[1]));
  return { output, code: Number(run.stderr), drawn };
}

const work = mkdtempSync(path.join(tmpdir(), 'edf2csv-tty-'));
const problems = [];
/** Conditions this machine would not arrange. Said out loud, and not a failure. */
const notes = [];
let checked = 0;

try {
  const { writeEdf } = await import('../fixtures/edf-writer.mjs');
  /*
    Big enough to need more than one read batch, so it can change under the reader — and, for
    the one that is cut, big enough that the meter draws long before the end.

    1,700 records of ten 256-sample channels is 8.7 MB against an 8 MB read budget, which is
    two batches. The meter is drawn from inside the read loop and throttled to one draw every
    hundred milliseconds, so on that file it has only ever printed two numbers: 96% and 100%.
    Every run of this sweep since it was written has produced those and nothing else.

    Which left the cut with four per cent of the file to land in. 0.7.45 replaced a fixed sleep
    with "wait for the first bytes the meter puts on the screen", on the reasoning that those
    bytes prove the reader is inside the file — true, and on this recording they arrive when it
    is all but read, so the run it is meant to interrupt kept finishing and reporting that it
    had proved nothing. 5,000 records is 25 MB, four batches, and a first draw at 32%.
  */
  const write = (name, records) => {
    const at = path.join(work, name);
    writeEdf({
      path: at,
      numRecords: records,
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
  const shrinking = write('shrinking.edf', 5000);
  // The rest never need a meter, so they keep the smaller file and the sweep keeps its speed.
  const steady = write('steady.edf', 1700);
  // Its own copy for the interrupt, since `shrinking` is a third of its size by then and a
  // run that short can finish before the signal lands.
  const stopping = write('stopping.edf', 5000);

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
      // `\x1b`, not the byte itself: see the repository-wide check in docs.test.js.
      if (!/\r\x1b\[K$/u.test(before) && before !== '') {
        problems.push(
          `"error: " does not start its line — preceded by ${JSON.stringify(before)}`,
        );
      }
    }
  }

  /*
    An interrupt, which is the one message that always arrives while the meter is up.

    This sweep exists because 0.7.9 printed `converting… 96%error: …` and `grep '^error:'`
    came back empty. It checked `error: ` and nothing else — and the tool prints a third
    prefix, `interrupted (SIGINT): `, which a failing conversion has to be arranged to
    produce but which Ctrl-C produces by definition, at the moment the meter is on the screen
    because that is what the person was looking at when they pressed it. The one message
    guaranteed to meet the meter was the one nothing here met.

    Sent once the first meter bytes arrive, the same trigger the shrink above uses.
    Interrupting is arranged rather than raced, so there is no attempt loop and no note.
  */
  const stopped = underTty([CLI, stopping, '--out', path.join(work, 'stopped'), '--channels', 'ch0'], null, true);
  checked++;
  if (stopped.code !== 130) {
    problems.push(`an interrupt at a terminal exited ${stopped.code}, expected 130`);
  } else {
    const at = stopped.output.indexOf('interrupted (');
    if (at === -1) {
      problems.push('an interrupted run said nothing about being interrupted');
    } else {
      const before = stopped.output.slice(stopped.output.lastIndexOf('\n', at) + 1, at);
      if (!/\r\x1b\[K$/u.test(before) && before !== '') {
        problems.push(
          `"interrupted (" does not start its line — preceded by ${JSON.stringify(before)}`,
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

  /*
    And the numbers the meter itself printed, over every run that drew one.

    A percentage is a percentage: a whole number from 0 to 100 that does not go backwards
    inside a run. Nothing asserted either, so `100` in the source could read `101` and this
    sweep — the only thing in the project that can see a progress meter at all — would go on
    passing. Every other check here is about what happens *around* the meter: that it is taken
    down before an error, that nothing but text reaches the screen.

    Not "and ends at 100": the meter is throttled to one draw every hundred milliseconds, so
    the last one before the summary is dropped whenever it lands too soon after the one before.
    On the shorter recordings here that is every time.
  */
  const drew = [failed, gz, ok].filter((run) => run.drawn.length > 0);
  for (const run of drew) {
    const shown = run.drawn;
    const wrong = shown.filter((p) => !Number.isInteger(p) || p < 0 || p > 100);
    if (wrong.length > 0) problems.push(`the meter drew ${wrong.join(', ')}, which is not a percentage`);
    if (shown.some((p, at) => at > 0 && p < shown[at - 1])) {
      problems.push(`the meter went backwards: ${shown.join(', ')}`);
    }
  }
  if (drew.length === 0) notes.push('no run drew a progress meter, so its numbers were not checked');
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
