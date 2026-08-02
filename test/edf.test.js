/** Parser-level tests: headers, scaling, annotations, and the diagnostics each raises. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EdfError,
  EdfFile,
  decimalsForSignal,
  makeScaler,
} from '../dist/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'generated');
const fixture = (name) => path.join(FIXTURES, name);

const open = [];
const temporaries = [];
async function load(name) {
  const file = await EdfFile.open(fixture(name));
  open.push(file);
  return file;
}
after(async () => {
  for (const file of open) await file.close();
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

const codes = (file) => file.diagnostics.map((d) => d.code);

describe('header parsing', () => {
  it('reads the fixed header of a plain EDF file', async () => {
    const file = await load('tiny.edf');
    assert.equal(file.header.version, '0');
    assert.equal(file.header.signalCount, 2);
    assert.equal(file.header.recordDuration, 1);
    assert.equal(file.recordCount, 2);
    assert.equal(file.header.isEdfPlus, false);
    assert.equal(file.header.continuity, null);
    assert.equal(file.durationSeconds, 2);
  });

  it('pins the two-digit year to 1985-2084 as the spec requires', async () => {
    const file = await load('tiny.edf');
    // "05.06.09" is 2009, not 1909 — anything below 85 belongs to the 2000s.
    assert.equal(file.header.startDateTime.toISOString(), '2009-06-05T12:34:56.000Z');
  });

  it('derives per-channel sampling rates, including from fractional record durations', async () => {
    const file = await load('fractional-recdur.edf');
    assert.equal(file.header.recordDuration, 0.1);
    assert.equal(file.dataSignals[0].samplingRate, 250);
  });

  it('reads labels, units and calibration for every signal', async () => {
    const file = await load('mixed-rates.edf');
    assert.deepEqual(
      file.dataSignals.map((s) => [s.label, s.physicalDimension, s.samplingRate]),
      [
        ['EEG Fpz-Cz', 'uV', 256],
        ['ECG', 'mV', 128],
        ['Temp rectal', 'degC', 1],
      ],
    );
  });

  it('separates annotation channels from signal channels', async () => {
    const file = await load('annotations.edf');
    assert.equal(file.header.continuity, 'EDF+C');
    assert.equal(file.dataSignals.length, 1);
    assert.equal(file.annotationSignals.length, 1);
    assert.equal(file.annotationSignals[0].label, 'EDF Annotations');
  });
});

describe('diagnostics', () => {
  it('warns about differing sampling rates', async () => {
    const file = await load('mixed-rates.edf');
    assert.ok(codes(file).includes('MIXED_SAMPLING_RATES'));
  });

  it('warns that an EDF+D recording is discontinuous', async () => {
    const file = await load('discontinuous.edf');
    assert.equal(file.header.continuity, 'EDF+D');
    assert.ok(codes(file).includes('DISCONTINUOUS'));
  });

  it('trusts the file over the header when the record count disagrees', async () => {
    const file = await load('truncated.edf');
    assert.equal(file.header.declaredRecordCount, 10);
    assert.equal(file.recordCount, 4, 'only four records were actually written');
    assert.ok(codes(file).includes('RECORD_COUNT_MISMATCH'));
  });

  it('accepts a record count of -1, which the spec permits', async () => {
    const file = await load('unknown-records.edf');
    assert.equal(file.header.declaredRecordCount, -1);
    assert.equal(file.recordCount, 4);
    assert.ok(codes(file).includes('RECORD_COUNT_UNKNOWN'));
  });

  it('flags duplicate labels and inverted physical ranges', async () => {
    const file = await load('quirky-labels.edf');
    assert.ok(codes(file).includes('DUPLICATE_LABEL'));
    assert.ok(codes(file).includes('INVERTED_PHYSICAL_RANGE'));
  });

  it('flags a digital range that cannot be scaled', async () => {
    const file = await load('degenerate-range.edf');
    assert.ok(codes(file).includes('DEGENERATE_DIGITAL_RANGE'));
  });
});

describe('errors', () => {
  it('reports a missing file without leaking a raw errno', async () => {
    await assert.rejects(() => EdfFile.open(fixture('does-not-exist.edf')), (error) => {
      assert.ok(error instanceof EdfError);
      assert.equal(error.code, 'UNREADABLE');
      assert.match(error.message, /no such file/);
      return true;
    });
  });

  it('refuses a file that is not EDF at all', async () => {
    await assert.rejects(
      () => EdfFile.open(fileURLToPath(import.meta.url)),
      (error) => error instanceof EdfError,
    );
  });
});

describe('digital to physical conversion', () => {
  it('maps the calibration points exactly', async () => {
    const file = await load('tiny.edf');
    const signal = file.dataSignals[0]; // -100..100 uV over -1000..1000
    const scale = makeScaler(signal);
    assert.equal(scale(-1000), -100);
    assert.equal(scale(1000), 100);
    assert.equal(scale(0), 0);
    assert.equal(scale(1), 0.1);
  });

  it('is correctly rounded where the naive formula loses bits', async () => {
    // A +/-800 uV channel over a 12-bit range: the exact value for digital 0 is
    // 800/4095. Computing it as (d - digMin) * gain + physMin cancels away the low
    // bits and yields ...467 instead.
    const file = await load('quirky-labels.edf');
    const scale = makeScaler(file.dataSignals[0]);
    assert.equal(scale(0), 0.19536019536019536);
  });

  it('yields NaN when the digital range is degenerate, rather than inventing a value', async () => {
    // The header gives one calibration point twice, so there is no mapping and no
    // physical value to report. Returning the physical minimum would fill the column
    // with numbers that look like a flat recording to whoever opens the CSV next.
    const file = await load('degenerate-range.edf');
    const scale = makeScaler(file.dataSignals[0]);
    assert.ok(Number.isNaN(scale(0)));
    assert.ok(Number.isNaN(scale(123)));
  });

  it('still scales the channel beside a degenerate one', async () => {
    const file = await load('degenerate-range.edf');
    const ok = file.dataSignals.find((s) => s.label === 'ok');
    const scale = makeScaler(ok);
    assert.ok(Number.isFinite(scale(0)), 'a valid channel must be unaffected');
  });

  it('honours an inverted physical range rather than silently correcting it', async () => {
    const file = await load('quirky-labels.edf');
    const inverted = file.dataSignals.find((s) => s.label === 'inverted');
    const scale = makeScaler(inverted);
    assert.equal(scale(-1000), 100);
    assert.equal(scale(1000), -100);
  });

  it('chooses enough decimals to keep adjacent digital codes distinct', async () => {
    const file = await load('tiny.edf');
    const [uv, mv] = file.dataSignals;
    assert.equal(decimalsForSignal(uv), 3); // step 0.1
    assert.equal(decimalsForSignal(mv), 5); // step 0.001
  });
});

describe('reading samples', () => {
  it('returns the digital values that were written', async () => {
    const file = await load('tiny.edf');
    const signal = file.dataSignals[0];
    const batches = [];
    for await (const batch of file.readRecords()) {
      for (let r = 0; r < batch.recordCount; r++) {
        for (let i = 0; i < signal.samplesPerRecord; i++) {
          batches.push(file.sampleAt(batch, r, signal, i));
        }
      }
    }
    // The fixture writes digital value === global sample index.
    assert.deepEqual(batches, Array.from({ length: 20 }, (_, i) => i));
  });

  it('produces the same samples no matter how small the read chunks are', async () => {
    const file = await load('mixed-rates.edf');
    const signal = file.dataSignals[0];
    const readAll = async (chunkBytes) => {
      const out = [];
      for await (const batch of file.readRecords({ chunkBytes })) {
        for (let r = 0; r < batch.recordCount; r++) {
          for (let i = 0; i < signal.samplesPerRecord; i++) out.push(file.sampleAt(batch, r, signal, i));
        }
      }
      return out;
    };
    assert.deepEqual(await readAll(1), await readAll(1 << 20));
  });
});

describe('BDF (BioSemi 24-bit)', () => {
  it('recognises the format from its version bytes', async () => {
    const file = await load('biosemi.bdf');
    assert.equal(file.header.isBdf, true);
    assert.equal(file.header.bytesPerSample, 3);
    assert.equal(file.header.signalCount, 2);
  });

  it('sizes data records by three bytes per sample', async () => {
    const file = await load('biosemi.bdf');
    // 2 signals * 8 samples * 3 bytes
    assert.equal(file.header.recordBytes, 48);
    assert.equal(file.recordCount, 2);
  });

  it('decodes 24-bit samples, including values no 16-bit field could hold', async () => {
    const file = await load('biosemi.bdf');
    const signal = file.dataSignals[1];
    const batch = (await file.readRecords().next()).value;
    const digital = [0, 1, 2, 3].map((i) => file.sampleAt(batch, 0, signal, i));
    assert.deepEqual(digital, [0, -1000000, -2000000, -3000000]);
    assert.ok(digital[3] < -32768, 'a 16-bit reader could not represent this sample');
  });

  it('understands BDF+ markers, which are spelled differently from EDF+', async () => {
    const file = await load('biosemi-plus.bdf');
    // The reserved field says "BDF+D" and the channel is "BDF Annotations".
    assert.equal(file.header.isBdf, true);
    assert.equal(file.header.isEdfPlus, true);
    assert.equal(file.header.continuity, 'EDF+D', 'normalised to a single continuity marker');
    assert.equal(file.annotationSignals.length, 1);
    assert.equal(file.dataSignals.length, 1);
  });

  it('recovers gaps and annotations from a discontinuous BDF+ file', async () => {
    const file = await load('biosemi-plus.bdf');
    const { annotations, recordStarts } = await file.readAnnotations();
    assert.deepEqual([...recordStarts], [0, 1, 20]);
    assert.deepEqual(annotations.map((a) => [a.onset, a.duration, a.text]), [[1.5, 0.25, 'Blink']]);
  });

  it('sign-extends negative 24-bit samples correctly', async () => {
    const file = await load('biosemi.bdf');
    const scale = makeScaler(file.dataSignals[1]);
    // -1000000 digital over a -8388608..8388607 range mapped to -262144..262144 uV
    assert.ok(scale(-1000000) < 0, 'must stay negative, not wrap to a huge positive');
    assert.ok(Math.abs(scale(-1000000) - -31249.9862) < 1e-3);
  });
});

describe('EDF+ annotations', () => {
  it('decodes onset, duration and text', async () => {
    const file = await load('annotations.edf');
    const { annotations } = await file.readAnnotations();
    assert.deepEqual(
      annotations.map((a) => [a.onset, a.duration, a.text]),
      [
        [0.5, 1, 'Sleep stage W'],
        [1.25, null, 'Lights off'],
        [2, 0.5, 'Seizure onset'],
      ],
    );
  });

  it('leaves duration null when the annotation did not specify one', async () => {
    const file = await load('annotations.edf');
    const { annotations } = await file.readAnnotations();
    const lightsOff = annotations.find((a) => a.text === 'Lights off');
    assert.equal(lightsOff.duration, null, 'a missing duration is not the same as zero');
  });

  it('recovers the true start time of every record in a discontinuous file', async () => {
    const file = await load('discontinuous.edf');
    const { recordStarts } = await file.readAnnotations();
    // The nine-second gap between the second and third record must survive.
    assert.deepEqual([...recordStarts], [0, 1, 10]);
  });

  it('does not mistake a timekeeping TAL for an annotation', async () => {
    const file = await load('discontinuous.edf');
    const { annotations } = await file.readAnnotations();
    assert.equal(annotations.length, 0);
  });

  it('reads a file whose only content is annotations', async () => {
    const file = await load('annotations-only.edf');
    assert.equal(file.dataSignals.length, 0);
    const { annotations } = await file.readAnnotations();
    assert.deepEqual(annotations.map((a) => a.text), ['Start']);
    assert.ok(codes(file).includes('NO_SIGNAL_CHANNELS'));
  });

  it('fails instead of returning partial annotations after a short read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-short-read-'));
    temporaries.push(dir);
    const copy = path.join(dir, 'annotations.edf');
    await copyFile(fixture('annotations.edf'), copy);
    const file = await EdfFile.open(copy);
    open.push(file);

    await truncate(copy, file.fileSize - 1);
    await assert.rejects(
      () => file.readAnnotations(),
      (error) => error instanceof EdfError && /changed size/.test(error.message),
    );
  });
});
