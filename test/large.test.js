/**
 * Recordings big enough to reach the limits of the machinery underneath.
 *
 * These build multi-gigabyte files, which is why they are not in with the rest. The files
 * are sparse — the header is written and the data section is made by truncating outward — so
 * they cost a few kilobytes on disk while being exactly as large as they claim, and the
 * conversion reads them for real.
 *
 * Skipped on a machine without the memory to hold one record, since that is the whole
 * subject: a record is the unit the format is addressed in, and there is nothing smaller to
 * divide it into.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, truncate } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

const temporaries = [];
after(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

/** A recording of one record of `channels * samples * 2` bytes, sparse beyond the header. */
async function oneHugeRecord(channels, samplesPerRecord) {
  const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-large-'));
  temporaries.push(dir);
  const file = path.join(dir, 'huge.edf');

  const { writeEdf } = await import('./fixtures/edf-writer.mjs');
  writeEdf({
    path: file,
    numRecords: 1,
    recordDuration: 1,
    // The header only; the data section is made by the truncate below.
    truncateRecords: 0,
    signals: Array.from({ length: channels }, (unused, i) => ({
      label: `C${i}`,
      dimension: 'uV',
      physMin: -100, physMax: 100, digMin: -2048, digMax: 2047,
      samplesPerRecord,
      gen: () => 0,
    })),
  });
  await truncate(file, (await stat(file)).size + channels * samplesPerRecord * 2);
  return { file, out: path.join(dir, 'out'), recordBytes: channels * samplesPerRecord * 2 };
}

describe('a record with a great many samples in it', () => {
  it('holds to its buffer rather than to the record', async (t) => {
    if (totalmem() < 8 * 1024 ** 3) {
      t.skip('needs room to build two 32 MB recordings');
      return;
    }

    // The row buffer was drained once per record, so the rows of a single record piled up
    // with nothing emptying them: memory followed samples-per-record rather than the batch
    // size the writer exists to hold to. One record of 16,000,000 samples died with a heap
    // out of memory under a 256 MB cap, while the same 32 MB of samples split into 16,000
    // records converted to a 283 MB CSV without trouble. The format allows either layout.
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-onerecord-'));
    temporaries.push(dir);

    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const base = {
      label: 'A', dimension: 'uV', physMin: -100, physMax: 100, digMin: -2048, digMax: 2047,
      gen: (r, s) => ((r * 7 + s * 3) % 4000) - 2000,
    };
    const one = path.join(dir, 'one-record.edf');
    writeEdf({ path: one, numRecords: 1, recordDuration: 1, signals: [{ ...base, samplesPerRecord: 16_000_000 }] });

    // The cap is what makes this a test rather than a demonstration: without a limit the
    // machine's own memory would let the old code through.
    const out = path.join(dir, 'out');
    await run(
      process.execPath,
      ['--max-old-space-size=256', CLI, one, '--out', out, '--json', '--quiet'],
      { maxBuffer: 1 << 22 },
    );

    const rows = JSON.parse(
      (await run(process.execPath, [CLI, one, '--info', '--json'], { maxBuffer: 1 << 22 })).stdout,
    ).estimate.rows;
    assert.equal(rows, 16_000_000, 'the recording really does hold that many samples');
  });
});

describe('a record larger than one read', () => {
  it('converts instead of aborting the process', async (t) => {
    if (totalmem() < 8 * 1024 ** 3) {
      t.skip('needs room for a single 2.2 GB record');
      return;
    }

    // fs.read asserts on a length that does not fit in a signed 32-bit integer, and it
    // asserts in C++: "Assertion failed: args[3]->IsInt32()", forty frames of native stack,
    // SIGABRT, exit 134, nothing written. Not an exception — no catch block and no
    // uncaughtException handler runs, so a library consumer's process goes down too.
    //
    // A record is read in one call when it exceeds the chunk budget, there being nothing
    // smaller to divide it by. EDF's samples-per-record field is 8 characters, so eleven
    // channels at 99,999,999 samples make a record of 2,199,999,978 bytes.
    const { file, out, recordBytes } = await oneHugeRecord(11, 99_999_999);
    assert.ok(recordBytes > 2 ** 31 - 1, `${recordBytes} is not over the limit`);

    // A window, so the CSV stays small: the point is reading the record, not writing it.
    const { stdout } = await run(
      process.execPath,
      [CLI, file, '--out', out, '--duration', '0.000001', '--json', '--quiet'],
      { maxBuffer: 1 << 22 },
    );
    const summary = JSON.parse(stdout);
    assert.equal(summary.files.find((f) => f.name === 'signals.csv').rows, 100);
  });

  it('leaves a record just under the limit alone', async (t) => {
    if (totalmem() < 8 * 1024 ** 3) {
      t.skip('needs room for a single 2.1 GB record');
      return;
    }

    // The boundary is exactly the int32 limit, so this one always worked and must keep
    // working: a fix that refused large records rather than reading them would pass the test
    // above and fail here.
    const { file, out, recordBytes } = await oneHugeRecord(11, 97_000_000);
    assert.ok(recordBytes < 2 ** 31 - 1, `${recordBytes} is over the limit`);

    const { stdout } = await run(
      process.execPath,
      [CLI, file, '--out', out, '--duration', '0.000001', '--json', '--quiet'],
      { maxBuffer: 1 << 22 },
    );
    assert.equal(JSON.parse(stdout).files.find((f) => f.name === 'signals.csv').rows, 97);
  });
});
