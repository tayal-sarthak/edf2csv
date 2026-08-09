/**
 * `--stdout` must not report success for bytes that never arrived.
 *
 * These need a destination that fills up, which means a filesystem of a known small size.
 * macOS can make one with `hdiutil`; on anything else the tests skip rather than pretend.
 * They are in their own file because that setup is slow and unlike everything else here.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const fixture = (name) => path.join(ROOT, 'test', 'fixtures', 'generated', name);

/*
  Named for this process, and mounted where macOS says it mounted it.

  Both used to be constants — /tmp/edf2csv-audit.dmg and /Volumes/edf2csvaudit — and each
  run began by detaching that volume and deleting that image, whoever they belonged to. Two
  runs at once therefore destroyed each other rather than queueing: three concurrent copies
  of this file fail 10 of 12 tests, with the second run pulling the disk out from under the
  first mid-write. `node --test` runs test files in parallel, a re-run started before the
  last one finished is ordinary, and CI machines run more than one job. A test that is
  destructive to whatever else is on the machine is worse than a slow one.

  The mount point is read from hdiutil rather than assumed, too: macOS renames a volume
  whose name is already taken — `edf2csvaudit 1` — so assuming the path meant a colliding
  run would silently write into the *other* run's volume.
*/
const IMAGE = `/tmp/edf2csv-audit-${process.pid}.dmg`;
const VOLUME_NAME = `edf2csvaudit${process.pid}`;

async function volumeAvailable() {
  if (process.platform !== 'darwin') return false;
  try {
    await run('hdiutil', ['info']);
    return true;
  } catch {
    return false;
  }
}

/** The mount point hdiutil reports, which is not always the one the name asks for. */
function mountPointOf(attachOutput) {
  const mounted = attachOutput
    .split('\n')
    .map((line) => line.split('\t').pop()?.trim())
    .filter((mount) => mount?.startsWith('/Volumes/'));
  const point = mounted.at(-1);
  assert.ok(point, `hdiutil attach reported no mount point:\n${attachOutput}`);
  return point;
}

async function withSmallVolume(body, size = '2m') {
  await rm(IMAGE, { force: true });
  await run('hdiutil', [
    'create', '-size', size, '-fs', 'HFS+', '-volname', VOLUME_NAME, '-quiet', IMAGE,
  ]);
  const { stdout } = await run('hdiutil', ['attach', IMAGE, '-nobrowse']);
  const volume = mountPointOf(stdout);
  try {
    return await body(volume);
  } finally {
    await run('hdiutil', ['detach', volume, '-quiet']).catch(() => {});
    await rm(IMAGE, { force: true });
  }
}

/** Run the CLI with stdout redirected to a file on the small volume, via a shell. */
async function toFile(args, destination) {
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

describe('--out onto a destination that fills up', () => {
  after(async () => {
    await rm(IMAGE, { force: true });
  });

  it('reports the write failure instead of dying on an unhandled event', async (t) => {
    if (!(await volumeAvailable())) {
      t.skip('needs hdiutil, which only macOS has');
      return;
    }

    /*
      The shortfall has to land in the *final* flush, which is what makes this different from
      the ordinary out-of-space case: an fs.WriteStream whose write failed emits 'error' again
      during its own auto-destroy, after end()'s callback has settled. 0.5.36 released the
      writer's 'error' listener at that callback, so the second emit reached Node as an
      unhandled event — a raw stack trace, the process down, convert() never rejecting, and
      none of the WRITE_FAILED message the tool is built to print.

      A conversion that overshoots by a lot fails in a mid-stream flush instead and prints
      correctly, which is why every existing test here missed it. Leaving a little under the
      whole output free is what puts the failure in the last one.
    */
    await withSmallVolume(async (volume) => {
      const whole = (
        await run(process.execPath, [CLI, fixture('long-stream.edf'), '--stdout'], {
          maxBuffer: 1 << 24,
        })
      ).stdout.length;
      const free = Number(
        (await run('/bin/sh', ['-c', `df -k "${volume}" | tail -1 | awk '{print $4}'`])).stdout,
      );
      const leave = Math.floor(whole / 1024) - 100;
      await run('dd', [
        'if=/dev/zero',
        `of=${path.join(volume, 'filler')}`,
        'bs=1024',
        `count=${free - leave}`,
      ]);

      let stderr = '';
      let code = 0;
      try {
        await run(process.execPath, [
          CLI,
          fixture('long-stream.edf'),
          '--out',
          path.join(volume, 'out'),
        ]);
      } catch (error) {
        code = error.code ?? 1;
        stderr = String(error.stderr ?? '');
      }

      assert.equal(code, 1, `expected a reported failure, got ${code}:\n${stderr}`);
      assert.ok(
        !/Unhandled 'error' event/u.test(stderr),
        `died on an unhandled event rather than reporting:\n${stderr}`,
      );
      assert.match(stderr, /failed: ENOSPC/u);
      assert.match(stderr, /The files written so far are incomplete/u);
    }, '8m');
  });
});

describe('--stdout onto a destination that fills up', () => {
  // withSmallVolume detaches its own volume in a finally; this is only for the image, in
  // case the process died between creating it and attaching it.
  after(async () => {
    await rm(IMAGE, { force: true });
  });

  it('reports the shortfall instead of claiming every row was written', async (t) => {
    if (!(await volumeAvailable())) {
      t.skip('needs hdiutil, which only macOS has');
      return;
    }

    // POSIX write() returns a short count rather than an error when the disk fills partway
    // through a single call, and only the NEXT write raises ENOSPC. --out always has a next
    // write — channels.csv and metadata.json come after — so it always finds out. --stdout
    // has nothing after it, and when fd 1 is a regular file Node's stdout is a
    // SyncWriteStream whose _write discards the count writeSync returns. So nothing was
    // raised at all: 94,977 of 102,400 rows on disk, the file ending mid-row, stderr saying
    // "Wrote 102,400 rows to stdout." and the process exiting 0.
    await withSmallVolume(async (VOLUME) => {
      const destination = path.join(VOLUME, 'sig.csv');
      const result = await toFile([fixture('long-stream.edf'), '--stdout'], destination);

      assert.notEqual(result.code, 0, `expected a failure, stderr was:\n${result.stderr}`);
      assert.match(result.stderr, /did not reach the destination/u);
      assert.ok(
        !/Wrote [\d,]+ rows to stdout/u.test(result.stderr),
        'a run that lost rows must not also announce the full count',
      );

      // The truncation itself is not preventable — the bytes were already gone. What must
      // not happen is calling it a success.
      const landed = (await stat(destination)).size;
      const whole = (await run(process.execPath, [CLI, fixture('long-stream.edf'), '--stdout'], {
        maxBuffer: 1 << 24,
      })).stdout.length;
      assert.ok(landed < whole, `nothing was lost, so this proves nothing: ${landed} of ${whole}`);
    });
  });

  it('does not tell a --stdout user about files, or about --out', async (t) => {
    if (!(await volumeAvailable())) {
      t.skip('needs hdiutil, which only macOS has');
      return;
    }

    // Filling the volume first means an ENOSPC is actually raised, which is the path the
    // hint text comes from. Both halves of that hint were written for --out: "the files
    // written so far" named files that do not exist on this path, and "choose another
    // destination with --out" is advice for a different command — the destination is
    // whatever the shell redirected the stream to.
    await withSmallVolume(async (VOLUME) => {
      await run('dd', ['if=/dev/zero', `of=${path.join(VOLUME, 'filler')}`, 'bs=1024', 'count=1560']);
      const result = await toFile([fixture('long-stream.edf'), '--stdout'], path.join(VOLUME, 's.csv'));

      assert.notEqual(result.code, 0, result.stderr);
      assert.match(result.stderr, /What reached stdout before it failed is incomplete/u);
      assert.ok(!/files written so far/u.test(result.stderr), 'no files were written');
      assert.ok(!/with --out/u.test(result.stderr), '--out is the flag they chose not to pass');
    });
  });

  it('leaves a destination with room alone', async (t) => {
    if (!(await volumeAvailable())) {
      t.skip('needs hdiutil, which only macOS has');
      return;
    }

    // The same volume, and an output that fits: this must succeed with every row present.
    // A check that fires on a healthy conversion is worse than no check.
    await withSmallVolume(async (VOLUME) => {
      const destination = path.join(VOLUME, 'small.csv');
      const result = await toFile([fixture('tiny.edf'), '--stdout'], destination);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, /Wrote 20 rows to stdout/u);

      const written = await readFile(destination, 'utf8');
      assert.equal(written.trimEnd().split('\n').length, 21, 'header plus twenty rows');
      assert.ok(written.endsWith('\n'), 'and it ends on a row boundary');
    });
  });

  it('checks the compressed stream too, where the byte counts differ', async (t) => {
    if (!(await volumeAvailable())) {
      t.skip('needs hdiutil, which only macOS has');
      return;
    }

    // Under --gzip the writer feeds the compressor, so its byte count is the CSV before
    // compression and says nothing about what reached the descriptor. The compressed output
    // of this recording fits on the volume, so this must succeed — and it is the case that
    // catches counting the wrong number, which would report a shortfall of about 1.6 MB.
    await withSmallVolume(async (VOLUME) => {
      const destination = path.join(VOLUME, 'sig.csv.gz');
      const result = await toFile([fixture('long-stream.edf'), '--stdout', '--gzip'], destination);
      assert.equal(result.code, 0, result.stderr);

      const { stdout } = await run('/bin/sh', ['-c', `gunzip -c "${destination}" | wc -l`]);
      assert.equal(Number(stdout.trim()), 102_401, 'header plus every data row');
    });
  });

  it('does not report a compressed stream as written when it did not fit', async (t) => {
    if (!(await volumeAvailable())) {
      t.skip('needs hdiutil, which only macOS has');
      return;
    }

    /*
      The compressed output is 470,022 bytes and this leaves about 456 KB free, so the last
      chunks have nowhere to go.

      `compressed()` returned an already-resolved `settled` for the stdout path, so the
      conversion declared itself finished while the compressor still held the tail. The run
      printed the ENOSPC and then "Wrote 102,400 rows to stdout." on the next line, and
      exited 0 — over a file 11,270 bytes short whose gzip member has no trailer and will not
      decompress. Through `--out`, on the same volume with the same space, the identical
      failure exits 1. The byte audit could not see it either: it stats the descriptor as
      soon as the writers are done, which here is before the compressor has flushed.
    */
    await withSmallVolume(async (VOLUME) => {
      await run('/bin/sh', [
        '-c', `dd if=/dev/zero of="${path.join(VOLUME, 'filler')}" bs=1024 count=1415 2>/dev/null`,
      ]);
      const destination = path.join(VOLUME, 'short.csv.gz');
      const result = await toFile([fixture('long-stream.edf'), '--stdout', '--gzip'], destination);

      assert.notEqual(result.code, 0, `a truncated stream reported success:\n${result.stderr}`);
      assert.match(result.stderr, /no space left on device|did not reach the destination/u, result.stderr);
      assert.doesNotMatch(result.stderr, /Wrote [\d,]+ rows to stdout/u,
        `a failed run announced its rows:\n${result.stderr}`);
    });
  });

  it('checks its own stdout under --info, which wrote and looked at nothing', async (t) => {
    if (!(await volumeAvailable())) {
      t.skip('needs hdiutil, which only macOS has');
      return;
    }

    /*
      A conversion audits what reached stdout. `--info` wrote its description with
      `process.stdout.write` and looked at nothing, so `edf2csv rec.edf --info > desc.txt`
      into a filesystem with no room produced a zero-byte file and exited 0 — success
      reported over nothing at all. A description is small, but not always: a 900-channel
      recording's is 58 KB, and no destination is guaranteed to have it.
    */
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    await withSmallVolume(async (VOLUME) => {
      const recording = path.join(VOLUME, 'wide.edf');
      // Distinct rates so the channel table is long: the description has to exceed the room
      // left, or the write would simply fit.
      writeEdf({
        path: recording, numRecords: 1, recordDuration: 1,
        signals: Array.from({ length: 900 }, (unused, i) => ({
          label: `C${i}`, dimension: 'uV', physMin: -100, physMax: 100, digMin: -32768,
          digMax: 32767, samplesPerRecord: i + 1, gen: () => 0,
        })),
      });
      /*
        Twenty kilobytes left, not zero. Filling the volume completely means the shell cannot
        create the redirect target at all, and the tool never runs — the first attempt at this
        test failed that way. What is wanted is a write that starts and cannot finish, so the
        description has to be larger than the room: 900 channels is about 58 KB of table.
      */
      const { stdout: free } = await run('/bin/sh', ['-c', `df -k "${VOLUME}" | tail -1 | awk '{print $4}'`]);
      const leave = Math.max(1, Number(free.trim()) - 20);
      await run('/bin/sh', ['-c', `dd if=/dev/zero of="${path.join(VOLUME, 'filler')}" bs=1024 count=${leave} 2>/dev/null || true`]);

      const destination = path.join(VOLUME, 'desc.txt');
      const result = await toFile([recording, '--info'], destination);
      assert.notEqual(result.code, 0, `a description that never arrived reported success:\n${result.stderr}`);
      assert.match(result.stderr, /no space left on device|did not reach the destination/u, result.stderr);
    }, '4m');
  });

  it('still treats a reader that hangs up as the ordinary thing it is', async (t) => {
    if (!(await volumeAvailable())) {
      t.skip('needs hdiutil, which only macOS has');
      return;
    }

    /*
      Waiting for the compressor is what makes the case above reportable, and it must not
      turn `--stdout --gzip | head` into a failure: a reader closing the pipe is documented
      as not one, and the answer to it is "Stopped: the reader closed the pipe after N of M
      rows had been written", exit 0. Waiting surfaced that EPIPE as an error until it was
      filtered — the same error the writer already records as a hang-up.

      No volume needed, but it belongs beside the case it guards.
    */
    const { stderr, code } = await run('/bin/sh', [
      '-c', `"${process.execPath}" "${CLI}" "${fixture('long-stream.edf')}" --stdout --gzip | head -c 100 > /dev/null`,
    ]).then((r) => ({ ...r, code: 0 })).catch((e) => ({ stderr: e.stderr ?? '', code: e.code ?? 1 }));

    assert.equal(code, 0, stderr);
    assert.match(stderr, /Stopped: the reader closed the pipe after/u, stderr);
    assert.doesNotMatch(stderr, /^error:/mu, `a hang-up was reported as a failure:\n${stderr}`);
  });
});
