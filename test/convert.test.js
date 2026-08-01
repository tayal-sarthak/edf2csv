/** Conversion tests: planning, channel selection, time ranges, and written output. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ChannelSelectionError,
  ConversionError,
  EdfFile,
  TimeRangeError,
  buildColumnNames,
  buildPlan,
  convert,
  parseTimeSpec,
  selectChannels,
} from '../dist/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'generated');
const fixture = (name) => path.join(FIXTURES, name);

const temporaries = [];
async function outDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-test-'));
  temporaries.push(dir);
  return path.join(dir, 'out');
}
after(async () => {
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

const readCsv = async (dir, name) =>
  (await readFile(path.join(dir, name), 'utf8')).trimEnd().split('\n');

async function planFor(name, options = {}) {
  const file = await EdfFile.open(fixture(name));
  try {
    return buildPlan(
      {
        signals: file.header.signals,
        recordDuration: file.header.recordDuration,
        recordCount: file.recordCount,
        hasAnnotationChannel: file.annotationSignals.length > 0,
      },
      options,
    );
  } finally {
    await file.close();
  }
}

describe('time specifications', () => {
  it('accepts the forms a researcher would actually type', () => {
    assert.equal(parseTimeSpec('90', '--start'), 90);
    assert.equal(parseTimeSpec('90s', '--start'), 90);
    assert.equal(parseTimeSpec('5m', '--start'), 300);
    assert.equal(parseTimeSpec('1h', '--start'), 3600);
    assert.equal(parseTimeSpec('1h30m', '--start'), 5400);
    assert.equal(parseTimeSpec('1h 30m 15s', '--start'), 5415);
    assert.equal(parseTimeSpec('00:30:00', '--start'), 1800);
    assert.equal(parseTimeSpec('30:00', '--start'), 1800);
    assert.equal(parseTimeSpec('250ms', '--start'), 0.25);
  });

  it('rejects input it only partly understands instead of guessing', () => {
    for (const bad of ['5x', '1h banana', '', 'abc', '00:99:00']) {
      assert.throws(() => parseTimeSpec(bad, '--start'), TimeRangeError, `should reject ${bad}`);
    }
  });
});

describe('column naming', () => {
  it('keeps EDF labels verbatim, spaces included', async () => {
    const file = await EdfFile.open(fixture('mixed-rates.edf'));
    const names = buildColumnNames(file.header.signals);
    assert.equal(names.get(0), 'EEG Fpz-Cz');
    await file.close();
  });

  it('disambiguates duplicate labels by signal position', async () => {
    const file = await EdfFile.open(fixture('quirky-labels.edf'));
    const names = buildColumnNames(file.header.signals);
    assert.equal(names.get(0), 'T8-P8_ch0');
    assert.equal(names.get(1), 'T8-P8_ch1');
    assert.equal(names.get(2), '-', 'a unique label is left alone even if it is odd');
    await file.close();
  });
});

describe('channel selection', () => {
  it('matches labels case-insensitively', async () => {
    const file = await EdfFile.open(fixture('mixed-rates.edf'));
    const { signals } = selectChannels(file.header.signals, ['ecg']);
    assert.deepEqual(signals.map((s) => s.label), ['ECG']);
    await file.close();
  });

  it('selects a specific channel by position when labels collide', async () => {
    const file = await EdfFile.open(fixture('quirky-labels.edf'));
    const { signals } = selectChannels(file.header.signals, ['#1']);
    assert.deepEqual(signals.map((s) => s.index), [1]);
    await file.close();
  });

  it('selects every channel sharing a requested label, and says so', async () => {
    const file = await EdfFile.open(fixture('quirky-labels.edf'));
    const { signals, ambiguous } = selectChannels(file.header.signals, ['T8-P8']);
    assert.deepEqual(signals.map((s) => s.index), [0, 1]);
    assert.equal(ambiguous.length, 1);
    await file.close();
  });

  it('fails loudly on a typo rather than quietly dropping the channel', async () => {
    const file = await EdfFile.open(fixture('mixed-rates.edf'));
    assert.throws(
      () => selectChannels(file.header.signals, ['ECQ']),
      (error) => {
        assert.ok(error instanceof ChannelSelectionError);
        assert.match(error.message, /Did you mean "ECG"/);
        return true;
      },
    );
    await file.close();
  });
});

describe('planning', () => {
  it('puts every channel in one file when they share a sampling rate', async () => {
    const plan = await planFor('tiny.edf');
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].fileName, 'signals.csv');
  });

  it('splits channels by sampling rate rather than resampling them', async () => {
    const plan = await planFor('mixed-rates.edf');
    assert.deepEqual(
      plan.groups.map((g) => [g.fileName, g.rate, g.channels.length]),
      [
        ['signals_256hz.csv', 256, 1],
        ['signals_128hz.csv', 128, 1],
        ['signals_1hz.csv', 1, 1],
      ],
    );
  });

  it('warns when a file would be too large for a spreadsheet', async () => {
    const plan = await planFor('tiny.edf');
    assert.equal(plan.estimate.exceedsSpreadsheetLimit, false);
    assert.ok(plan.estimate.rows > 0);
  });
});

describe('converting', () => {
  it('writes the expected files and exact values', async () => {
    const dir = await outDir();
    const result = await convert(fixture('tiny.edf'), { outputDir: dir });

    assert.deepEqual(result.files.map((f) => f.name).sort(), ['channels.csv', 'signals.csv']);

    const rows = await readCsv(dir, 'signals.csv');
    assert.equal(rows[0], 'time_s,ch1,ch2');
    assert.equal(rows[1], '0.000,0.000,0.00000');
    assert.equal(rows[2], '0.100,0.100,-0.00100');
    assert.equal(rows.length, 21, '20 samples plus a header');
  });

  it('records provenance in metadata.json', async () => {
    const dir = await outDir();
    await convert(fixture('tiny.edf'), { outputDir: dir });
    const metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.tool.name, 'edf2csv');
    assert.equal(metadata.recording.data_records, 2);
    assert.equal(metadata.recording.start_datetime, '2009-06-05T12:34:56.000Z');
    assert.equal(metadata.conversion.whole_recording, true);
  });

  it('gives each sampling rate its own file with only its real samples', async () => {
    const dir = await outDir();
    const result = await convert(fixture('mixed-rates.edf'), { outputDir: dir });
    const rows = Object.fromEntries(result.files.map((f) => [f.name, f.rows]));

    // Three seconds of recording: 768 samples at 256 Hz, 384 at 128 Hz, and 3 at 1 Hz.
    // The slow channel keeps its three genuine readings instead of being stretched.
    assert.equal(rows['signals_256hz.csv'], 768);
    assert.equal(rows['signals_128hz.csv'], 384);
    assert.equal(rows['signals_1hz.csv'], 3);

    const slow = await readCsv(dir, 'signals_1hz.csv');
    assert.equal(slow[0], 'time_s,Temp rectal');
    assert.equal(slow.length, 4);
  });

  it('keeps the gap visible in a discontinuous recording', async () => {
    const dir = await outDir();
    await convert(fixture('discontinuous.edf'), { outputDir: dir });
    const rows = await readCsv(dir, 'signals.csv');

    assert.equal(rows.length, 31, 'all three records are converted, none dropped');
    const times = rows.slice(1).map((r) => Number(r.split(',')[0]));
    assert.equal(times[19], 1.9);
    assert.equal(times[20], 10, 'the nine-second gap survives as a jump in time_s');
  });

  it('honours a time window measured against a discontinuous file"s real span', async () => {
    // discontinuous.edf holds 3 records positioned at 0s, 1s and 10s. Its span is
    // 11 seconds even though it contains only 3 seconds of data, so a window that
    // reaches past 3s must still pick up the record sitting at 10s.
    const dir = await outDir();
    await convert(fixture('discontinuous.edf'), { outputDir: dir, start: 1, end: 200 });
    const rows = await readCsv(dir, 'signals.csv');
    const times = rows.slice(1).map((r) => Number(r.split(',')[0]));

    assert.equal(rows.length, 21, 'records at 1s and 10s, 10 samples each');
    assert.equal(times.at(-1), 10.9, 'the record at 10s must not be clipped away');
  });

  it('can start a window inside a gap, past where the data would end if contiguous', async () => {
    const dir = await outDir();
    // Naively the file is "3 seconds long", so --start 5 would look out of range.
    await convert(fixture('discontinuous.edf'), { outputDir: dir, start: 5 });
    const rows = await readCsv(dir, 'signals.csv');
    assert.equal(rows.length, 11, 'just the record at 10s');
    assert.equal(Number(rows[1].split(',')[0]), 10);
  });

  it('exports annotations with onset, duration and text', async () => {
    const dir = await outDir();
    await convert(fixture('annotations.edf'), { outputDir: dir });
    const rows = await readCsv(dir, 'annotations.csv');
    assert.equal(rows[0], 'onset_s,duration_s,description,record_index');
    assert.equal(rows[1], '0.5,1,Sleep stage W,0');
    assert.equal(rows[2], '1.25,,Lights off,1', 'a missing duration stays empty, not zero');
  });

  it('converts only the requested channels', async () => {
    const dir = await outDir();
    await convert(fixture('mixed-rates.edf'), { outputDir: dir, channels: ['ECG'] });
    const rows = await readCsv(dir, 'signals.csv');
    assert.equal(rows[0], 'time_s,ECG');

    const channels = await readCsv(dir, 'channels.csv');
    const converted = channels.slice(1).map((r) => r.split(',').at(-1));
    assert.deepEqual(converted, ['no', 'yes', 'no'], 'unselected channels are still described');
  });

  it('converts only the requested time window', async () => {
    const dir = await outDir();
    await convert(fixture('tiny.edf'), { outputDir: dir, start: 0.5, duration: 0.5 });
    const rows = await readCsv(dir, 'signals.csv');
    assert.equal(rows.length, 6, 'five samples between 0.5s and 1.0s');
    assert.equal(rows[1].split(',')[0], '0.500');
    assert.equal(rows.at(-1).split(',')[0], '0.900');
  });

  it('writes annotations alone when asked', async () => {
    const dir = await outDir();
    const result = await convert(fixture('annotations.edf'), { outputDir: dir, annotationsOnly: true });
    const names = result.files.map((f) => f.name);
    assert.ok(!names.includes('signals.csv'));
    assert.equal(result.annotationCount, 3);
  });

  it('refuses to overwrite an existing directory unless told to', async () => {
    const dir = await outDir();
    await convert(fixture('tiny.edf'), { outputDir: dir });
    await assert.rejects(
      () => convert(fixture('tiny.edf'), { outputDir: dir }),
      (error) => {
        assert.ok(error instanceof ConversionError);
        assert.equal(error.code, 'OUTPUT_EXISTS');
        return true;
      },
    );
    await convert(fixture('tiny.edf'), { outputDir: dir, force: true });
  });

  it('points out leftovers from a previous conversion into the same directory', async () => {
    const dir = await outDir();
    // A mixed-rate run leaves signals_*hz.csv; a single-rate run writes signals.csv and
    // would otherwise leave the old files sitting there looking equally current.
    await convert(fixture('mixed-rates.edf'), { outputDir: dir });
    const second = await convert(fixture('tiny.edf'), { outputDir: dir, force: true });

    const stale = second.diagnostics.find((d) => d.code === 'STALE_OUTPUT');
    assert.ok(stale, 'the leftover rate-group files must be reported');
    assert.match(stale.message, /signals_256hz\.csv/);
    assert.ok(!stale.message.includes('metadata.json'), 'metadata.json is rewritten every run');
  });

  it('says nothing about leftovers when a rerun replaces everything', async () => {
    const dir = await outDir();
    await convert(fixture('tiny.edf'), { outputDir: dir });
    const second = await convert(fixture('tiny.edf'), { outputDir: dir, force: true });
    assert.ok(!second.diagnostics.some((d) => d.code === 'STALE_OUTPUT'));
  });

  it('converts a truncated recording and reports what it found', async () => {
    const dir = await outDir();
    const result = await convert(fixture('truncated.edf'), { outputDir: dir });
    assert.equal(result.files.find((f) => f.name === 'signals.csv').rows, 20);
    assert.ok(result.diagnostics.some((d) => d.code === 'RECORD_COUNT_MISMATCH'));
  });

  it('records a checksum only when asked for one', async () => {
    const plain = await outDir();
    await convert(fixture('tiny.edf'), { outputDir: plain });
    const withoutSum = JSON.parse(await readFile(path.join(plain, 'metadata.json'), 'utf8'));
    assert.equal(withoutSum.source.sha256, null);

    const hashed = await outDir();
    await convert(fixture('tiny.edf'), { outputDir: hashed, checksum: true });
    const withSum = JSON.parse(await readFile(path.join(hashed, 'metadata.json'), 'utf8'));
    assert.match(withSum.source.sha256, /^[0-9a-f]{64}$/);
  });
});
