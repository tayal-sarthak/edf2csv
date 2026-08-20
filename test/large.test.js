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
      t.skip('needs room to build a 32 MB recording and write the 283 MB CSV it becomes');
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
    const converted = await run(
      process.execPath,
      ['--max-old-space-size=256', CLI, one, '--out', out, '--json', '--quiet'],
      { maxBuffer: 1 << 22 },
    );

    const rows = JSON.parse(
      (await run(process.execPath, [CLI, one, '--info', '--json'], { maxBuffer: 1 << 22 })).stdout,
    ).estimate.rows;
    assert.equal(rows, 16_000_000, 'the recording really does hold that many samples');

    /*
      And what the conversion did with them, which nothing here asked.

      The only assertion used to be the one above — a second `--info` on the same file, which
      describes the fixture and not the run. Everything the test is named for rested on `run`
      throwing, so deleting the conversion outright left it passing in under a second. A
      conversion that exits 0 having written a header and no rows passed it too.
    */
    const written = JSON.parse(converted.stdout);
    const signals = written.files.find((file) => file.name === 'signals.csv');
    assert.ok(signals, `no signals.csv was written: ${converted.stdout}`);
    assert.equal(signals.rows, rows, 'every sample of the one record has to reach the file');
    const onDisk = await stat(path.join(out, 'signals.csv'));
    // Sixteen million rows of `time_s,A`, so a couple of hundred megabytes. The bound is
    // loose on purpose: what it refuses is a file that holds a header and little else.
    assert.ok(
      onDisk.size > 100 * 1024 ** 2,
      `signals.csv is ${onDisk.size} bytes for ${rows} rows`,
    );
  });
});

describe('a recording with a great many channels', () => {
  /*
    A dense montage at one rate — the other half of the fan-out the previous suite covers.

    Every channel is handed its own formatted-value cache, sized to the digital range it
    declares. 0.2.5 capped that range at 16 bits, which bounds one channel at 512 KB and
    bounds nothing at all about a file's channel count. The full 16-bit range is what an
    ordinary EEG amplifier writes, so 256 of them reserved 134 MB of pointers before a row
    was written.

    The file below is 229 KB. Channel count, not file size, is what makes it expensive.
  */
  const CHANNELS = 256;
  const RECORDS = 20;
  const PER_RECORD = 16;

  const denseMontage = async (dir) => {
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const recording = path.join(dir, 'dense.edf');
    writeEdf({
      path: recording,
      numRecords: RECORDS,
      recordDuration: 1,
      signals: Array.from({ length: CHANNELS }, (unused, index) => ({
        label: `EEG ${index}`,
        dimension: 'uV',
        physMin: -250,
        physMax: 250,
        // The whole 16-bit range, which is both legal and usual, and the worst case for a
        // per-channel cache: every channel claims the maximum a channel may claim.
        digMin: -32768,
        digMax: 32767,
        samplesPerRecord: PER_RECORD,
        // Identical in every channel, so the columns can be compared against each other.
        gen: (record, sample) => ((record * 31 + sample * 7) % 65536) - 32768,
      })),
    });
    return recording;
  };

  it('sizes its value caches for the conversion, not for each channel', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-dense-'));
    temporaries.push(dir);
    const recording = await denseMontage(dir);

    /*
      96 MB, the same cap as the many-rates test above, and portable for the same reason it
      is not: this one is a fixed reservation rather than a garbage-collector question. The
      caches alone were 134 MB, so no machine's collector could have fitted them under this
      cap; they are 16 MB now, so none has to try. The old code exited 134 with a native V8
      stack and an empty output directory.
    */
    const out = path.join(dir, 'out');
    await run(
      process.execPath,
      ['--max-old-space-size=96', CLI, recording, '--out', out, '--quiet'],
      { maxBuffer: 1 << 22 },
    );

    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(path.join(out, 'signals.csv'), 'utf8')).trimEnd().split('\n');
    assert.equal(lines.length - 1, RECORDS * PER_RECORD, 'every row was written');
    assert.equal(lines[0].split(',').length, CHANNELS + 1, 'and every channel has a column');
  });

  it('formats a channel that missed the cache exactly as one that kept it', async () => {
    /*
      What the budget gives up is speed, not agreement. A channel past the budget formats
      each value directly instead of looking it up, and the two paths call the same scaler
      and the same `fixed` — so the columns have to come out identical, which is the only
      reason it is safe to hand the cache to some channels and not others.

      Every channel here is fed the same digital samples and declares the same scale, so
      the first column and the last must match cell for cell. They only exercise different
      code if the budget has run out by the time the last one asks, which 256 channels of
      the full 16-bit range guarantees.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-dense-agree-'));
    temporaries.push(dir);
    const recording = await denseMontage(dir);

    const out = path.join(dir, 'out');
    await run(process.execPath, [CLI, recording, '--out', out, '--quiet'], { maxBuffer: 1 << 22 });

    const { readFile } = await import('node:fs/promises');
    const rows = (await readFile(path.join(out, 'signals.csv'), 'utf8')).trimEnd().split('\n');
    const cells = rows.slice(1).map((row) => row.split(','));
    const cached = cells.map((row) => row[1]);
    const direct = cells.map((row) => row[CHANNELS]);
    assert.deepEqual(direct, cached, 'the uncached channel reads the same as the cached one');
    // Not vacuous: the samples have to actually vary, or two empty columns would agree.
    assert.ok(new Set(cached).size > 1, 'and the values are not all the same');
  });
});

describe('a recording that mixes many sampling rates', () => {
  /*
    200 rates, not 40.

    0.5.6 shared the line-buffer budget across the groups and left a 64 KiB floor under each,
    and left `createWriteStream` at its own 64 KiB default — which is per stream. At 40 groups
    that is 5 MB and invisible; at 200 it is 25 MB, and an 855 KB recording still died at a
    48 MB cap. Both are shared now, so the count that has to be exercised is the larger one.
  */
  const GROUPS = 200;
  const RECORDS = 400;

  it('holds one buffer for the conversion rather than one per table', async () => {
    /*
      Every rate group opened its own writer at the 1 MiB flush threshold, so pending output
      was group count × 1 MiB before anything drained. Forty rates therefore needed forty
      megabytes of buffer for a 6.5 MB recording, and the run died with a raw V8 heap
      out-of-memory — exit 134, a native stack, nothing written — under a 96 MB cap, while
      the site advertises 48 MB. The recording is small; the fan-out is not, and an EDF
      header can declare thousands of channels.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-manyrates-'));
    temporaries.push(dir);

    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const signals = Array.from({ length: GROUPS }, (unused, index) => ({
      label: `ch${index}`,
      dimension: 'uV',
      physMin: -250,
      physMax: 250,
      digMin: -2048,
      digMax: 2047,
      // A distinct samplesPerRecord per channel is a distinct rate, which is a distinct table.
      samplesPerRecord: GROUPS - index,
      gen: (record, sample) => ((record * 7 + sample * 13) % 4000) - 2000,
    }));
    const recording = path.join(dir, 'many.edf');
    writeEdf({ path: recording, numRecords: RECORDS, recordDuration: 1, signals });

    /*
      A comparison at one heap size, not an absolute figure, and a generous size at that.

      How much heap this needs is not portable. The fixed code converts 200 tables under 48 MB
      on macOS with Node 24 and does not on Linux with Node 22; the pre-fix code dies at 64 on
      the first and needs far more on the second. Picking the cap that separates them on the
      machine in front of me turned CI red for a garbage-collector difference, which is worse
      than no test.

      So: 96 MB, and both counts. 40 tables is the size the 0.5.6 fix was measured at and has
      always fitted; 200 is the size that did not, and the point is that the second now costs
      no more than the first. The exact separating cap is in the 0.5.20 changelog entry, where
      a measurement belongs, rather than asserted here where it would only be true on one
      machine.
    */
    const out = path.join(dir, 'out');
    const few = path.join(dir, 'few.edf');
    writeEdf({
      path: few,
      numRecords: RECORDS,
      recordDuration: 1,
      signals: signals.slice(0, 40).map((signal, index) => ({ ...signal, samplesPerRecord: 40 - index })),
    });
    await run(
      process.execPath,
      ['--max-old-space-size=96', CLI, few, '--out', path.join(dir, 'few-out'), '--quiet'],
      { maxBuffer: 1 << 22 },
    );
    await run(
      process.execPath,
      ['--max-old-space-size=96', CLI, recording, '--out', out, '--quiet'],
      { maxBuffer: 1 << 22 },
    );

    // Forty tables plus channels.csv and metadata.json, and every row of every one.
    const { readdir, readFile } = await import('node:fs/promises');
    const names = (await readdir(out)).filter((name) => name.startsWith('signals'));
    assert.equal(names.length, GROUPS, 'one table per rate');
    let rows = 0;
    for (const name of names) {
      rows += (await readFile(path.join(out, name), 'utf8')).trimEnd().split('\n').length - 1;
    }
    // Each channel writes samplesPerRecord × 4000 samples; the rates run 40 down to 1.
    const expected =
      RECORDS * Array.from({ length: GROUPS }, (u, i) => GROUPS - i).reduce((a, b) => a + b);
    assert.equal(rows, expected, 'and nothing was dropped to fit');
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
