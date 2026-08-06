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

const IMAGE = '/tmp/edf2csv-audit.dmg';
const VOLUME = '/Volumes/edf2csvaudit';

async function volumeAvailable() {
  if (process.platform !== 'darwin') return false;
  try {
    await run('hdiutil', ['info']);
    return true;
  } catch {
    return false;
  }
}

async function withSmallVolume(body) {
  await run('hdiutil', ['detach', VOLUME, '-quiet']).catch(() => {});
  await rm(IMAGE, { force: true });
  await run('hdiutil', ['create', '-size', '2m', '-fs', 'HFS+', '-volname', 'edf2csvaudit', '-quiet', IMAGE]);
  await run('hdiutil', ['attach', IMAGE, '-nobrowse', '-quiet']);
  try {
    return await body();
  } finally {
    await run('hdiutil', ['detach', VOLUME, '-quiet']).catch(() => {});
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

describe('--stdout onto a destination that fills up', () => {
  after(async () => {
    await run('hdiutil', ['detach', VOLUME, '-quiet']).catch(() => {});
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
    await withSmallVolume(async () => {
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

  it('leaves a destination with room alone', async (t) => {
    if (!(await volumeAvailable())) {
      t.skip('needs hdiutil, which only macOS has');
      return;
    }

    // The same volume, and an output that fits: this must succeed with every row present.
    // A check that fires on a healthy conversion is worse than no check.
    await withSmallVolume(async () => {
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
    await withSmallVolume(async () => {
      const destination = path.join(VOLUME, 'sig.csv.gz');
      const result = await toFile([fixture('long-stream.edf'), '--stdout', '--gzip'], destination);
      assert.equal(result.code, 0, result.stderr);

      const { stdout } = await run('/bin/sh', ['-c', `gunzip -c "${destination}" | wc -l`]);
      assert.equal(Number(stdout.trim()), 102_401, 'header plus every data row');
    });
  });
});
