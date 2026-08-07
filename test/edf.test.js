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
    // The file-level diagnostic describes the recording, and is what a caller reading a
    // header without planning a conversion gets. A conversion reports its own; see convert.test.js.
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

  it('hands out views of one reused buffer, which is what the API reference says', async () => {
    /*
      api.md calls this the one contract that fails silently if you get it wrong, so the
      shape of it is worth pinning rather than describing. It also used to describe it
      loosely — "kept[0], kept[1] and kept[2] are all identical" — and the obvious test for
      that, object identity, returns false, which would talk a reader out of believing a
      warning that is true.
    */
    const file = await load('long-stream.edf');
    const kept = [];
    const copies = [];
    // 400 records of 512 bytes in 4608-byte batches: 44 full ones and a 2048-byte tail,
    // which is the arrangement the reference describes and the one that misleads.
    for await (const batch of file.readRecords({ chunkBytes: 5000 })) {
      kept.push(batch.data);
      copies.push(new Uint8Array(batch.data));
    }
    assert.ok(kept.length >= 3, `expected several batches, got ${kept.length}`);

    // Distinct objects, one buffer. Both halves of that matter to a caller.
    assert.notEqual(kept[0], kept[1], 'each iteration hands out its own view');
    assert.ok(
      kept.every((view) => view.buffer === kept[0].buffer && view.byteOffset === 0),
      'and every one of them looks at the same memory from the same place',
    );

    // The last batch is short, so what an early view shows afterwards is a seam: the last
    // batch's bytes for as far as they go, the previous batch's beyond that.
    const last = kept.at(-1);
    assert.ok(last.length < kept[0].length, 'the final batch is a partial one');
    assert.deepEqual(
      [...kept[0].subarray(0, last.length)],
      [...copies.at(-1)],
      'the head of a stale view is the last batch',
    );
    assert.deepEqual(
      [...kept[0].subarray(last.length)],
      [...copies.at(-2).subarray(last.length)],
      'and its tail is still the one before',
    );

    // Which is exactly what copying avoids, and why the reference tells you to copy.
    assert.notDeepEqual([...kept[0]], [...copies[0]]);
    await file.close();
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

describe('record bounds', () => {
  // A fractional index went straight into `headerBytes + record * recordBytes`, so
  // reading from 1.5 began half a record in and decoded every sample from the wrong
  // offset — returning channel 2's values under channel 1's signal, with no error.
  it('rejects a fractional record index rather than reading from mid-record', async () => {
    const file = await load('tiny.edf');
    for (const options of [{ startRecord: 1.5 }, { endRecord: 0.5 }]) {
      await assert.rejects(
        async () => {
          for await (const _ of file.readRecords(options)) break;
        },
        /whole record index/u,
        `should reject ${JSON.stringify(options)}`,
      );
    }
  });

  it('still clamps whole-number bounds that fall outside the file', async () => {
    const file = await load('tiny.edf');
    const read = async (options) => {
      let n = 0;
      for await (const batch of file.readRecords(options)) n += batch.recordCount;
      return n;
    };
    assert.equal(await read({ startRecord: -5 }), file.recordCount);
    assert.equal(await read({ endRecord: 99999 }), file.recordCount);
    assert.equal(await read({ startRecord: 1, endRecord: 1 }), 0);
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
describe('the read budget', () => {
  it('sizes the buffer from the data rather than from the budget', async () => {
    // The budget is a ceiling on how much to read at once, and the buffer was however many
    // records would fit in it — whether or not the file had that many. An 848-byte fixture
    // read with a 512 MB budget allocated 536,870,880 bytes for its two records, and every
    // ordinary read of a small file reserved the full 8 MB default. Nothing was wrong with
    // the data; the memory just had nothing to do with it.
    const file = await EdfFile.open(fixture('tiny.edf'));
    try {
      for await (const batch of file.readRecords({ chunkBytes: 512 * 1024 * 1024 })) {
        assert.equal(
          batch.data.buffer.byteLength,
          file.recordCount * file.header.recordBytes,
          'the buffer is the size of what is being read',
        );
      }
    } finally {
      await file.close();
    }
  });

  it('reads a window without reserving room for the whole recording', async () => {
    const file = await EdfFile.open(fixture('long-stream.edf'));
    try {
      for await (const batch of file.readRecords({ startRecord: 10, endRecord: 12 })) {
        assert.equal(batch.data.buffer.byteLength, 2 * file.header.recordBytes);
        assert.equal(batch.recordCount, 2);
      }
    } finally {
      await file.close();
    }
  });
});
describe('what the header says against what it means', () => {
  it('keeps the declared header length beside the computed one', async () => {
    // api.md said "Every field is read straight from the 256-byte fixed header ... Nothing is
    // normalised except where noted", and headerBytes carried no note — while being the one
    // field that is computed rather than read. The computation is right: every record offset
    // comes from it, and believing a carelessly written length field would put every sample
    // at the wrong offset. What was missing is the field's own value, which is a fact about
    // the file and is what HEADER_BYTES_MISMATCH is comparing against.
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-hb-'));
    try {
      const bytes = Buffer.from(await readFile(fixture('tiny.edf')));
      Buffer.from('99      ', 'latin1').copy(bytes, 184);
      const patched = path.join(dir, 'short-header.edf');
      await writeFile(patched, bytes);

      const file = await EdfFile.open(patched);
      try {
        assert.equal(file.header.headerBytes, 768, 'two signals need 256 + 2 * 256');
        assert.equal(file.header.declaredHeaderBytes, 99, 'and the file says otherwise');
        assert.ok(file.diagnostics.some((d) => d.code === 'HEADER_BYTES_MISMATCH'));
      } finally {
        await file.close();
      }

      // A well-formed file has them equal, which is what makes the pair worth exposing.
      const ordinary = await EdfFile.open(fixture('tiny.edf'));
      assert.equal(ordinary.header.declaredHeaderBytes, ordinary.header.headerBytes);
      await ordinary.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


