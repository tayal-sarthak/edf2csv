/** Conversion tests: planning, channel selection, time ranges, and written output. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('prefers a real label over positional syntax when a channel is named "#1"', async () => {
    // A label may literally start with '#'. Treating it only as a position would
    // make that channel impossible to select by name.
    const file = await EdfFile.open(fixture('quirky-labels.edf'));
    const renamed = file.header.signals.map((s, i) => (i === 2 ? { ...s, label: '#1' } : s));
    const { signals } = selectChannels(renamed, ['#1']);
    assert.deepEqual(signals.map((s) => s.index), [2], 'the labelled channel wins, not position 1');
    await file.close();
  });

  it('suggests each candidate label only once', async () => {
    const file = await EdfFile.open(fixture('quirky-labels.edf'));
    try {
      selectChannels(file.header.signals, ['T8-P9']);
      assert.fail('should have thrown');
    } catch (error) {
      const hits = error.message.match(/"T8-P8"/g) ?? [];
      assert.equal(hits.length, 1, 'the duplicated label must not be suggested twice');
    }
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

describe('formatting a duration', () => {
  it('never prints a component that cannot exist', async () => {
    const { formatDuration } = await import('../dist/format/number.js');
    // Past 2^53 the decomposition stops being arithmetic: `total - h*3600 - m*60` cannot be
    // exact, and the error lands in the seconds field. A record duration of 1e300 printed
    // "8.333333333333333e+296h 48m -2880s" — minus forty-eight seconds.
    for (const seconds of [0, 1, 59.5, 3599.9996, 3600, 86400, 1e6, 1e9, 1e15, 9e15, 1e20, 3e300]) {
      const text = formatDuration(seconds);
      assert.ok(!/-\d/u.test(text), `${seconds} produced a negative component: ${text}`);
      const minutes = /(\d+)m /u.exec(text);
      if (minutes) assert.ok(Number(minutes[1]) < 60, `${seconds} -> ${text}`);
      const secondsField = /(\d+(?:\.\d+)?)s$/u.exec(text);
      if (secondsField && /[hm] /u.test(text)) {
        assert.ok(Number(secondsField[1]) < 60, `${seconds} -> ${text}`);
      }
    }
  });

  it('says so rather than inventing a number it does not have', async () => {
    const { formatDuration } = await import('../dist/format/number.js');
    // These rendered as "NaNs" and "Infinitys".
    for (const seconds of [Number.NaN, Infinity, -Infinity]) {
      assert.equal(formatDuration(seconds), 'unknown');
    }
  });

  it('is unchanged for durations a recording actually has', async () => {
    const { formatDuration } = await import('../dist/format/number.js');
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(59.5), '59.5s');
    assert.equal(formatDuration(3600), '1h 00m 0s');
    assert.equal(formatDuration(86400), '24h 00m 0s');
    // Rounded before splitting, so this never becomes "59m 60s".
    assert.equal(formatDuration(3599.9996), '1h 00m 0s');
  });
});

describe('the time column', () => {
  // Value cells are cached — a channel has only so many distinct readings — but the time
  // column rises monotonically, so no two rows share a string and toFixed ran once per row.
  // It was a third of the time on a ten-million-row conversion. What repeats is the offset
  // within a record, and reusing that only works if it produces the identical string.
  it('formats exactly as formatting the sum would', async () => {
    const { fixed, makeTimeFormatter, timeDecimals } = await import('../dist/format/number.js');
    const rates = [1, 2, 3, 4, 5, 7, 10, 25, 30, 50, 64, 100, 125, 128, 250, 256, 500, 512,
      1000, 1024, 2048, 0.5, 0.1, 12.5, 2.5, 1 / 3, 1e-6, 3.7, 999];

    let compared = 0;
    for (const rate of rates) {
      const decimals = timeDecimals(rate);
      const perRecord = Math.max(1, Math.min(600, Math.round(rate) || 1));
      const format = makeTimeFormatter(perRecord, rate, decimals);
      // Up to 1e8 seconds — three years of continuous recording, past anything real.
      for (const start of [0, 1, 2, 59, 60, 3599, 3600, 86400, 1e6, 1e7, 1e8]) {
        for (let sample = 0; sample < perRecord; sample++) {
          compared++;
          assert.equal(
            format(start, sample),
            fixed(start + sample / rate, decimals),
            `rate ${rate}, start ${start}, sample ${sample}`,
          );
        }
      }
    }
    assert.ok(compared > 40_000, `expected a broad sweep, only compared ${compared}`);
  });

  it('is the more accurate of the two once a double runs out of digits', async () => {
    // Past roughly 1e9 seconds the two answers separate, because `start + sample / rate`
    // no longer fits the fraction into a double. 317 years into a recording, sample 2 of a
    // 999 Hz record sits at 2/999 = 0.002002002..., which is 0.002002 at six places:
    //
    //   formatting the sum   10000000000.002003   the sum lost the digit
    //   this formatter       10000000000.002002   correct
    //
    // Nothing real reaches that magnitude, and where the two differ this one is right, so
    // there is no case in which the change costs accuracy.
    const { fixed, makeTimeFormatter } = await import('../dist/format/number.js');
    const format = makeTimeFormatter(999, 999, 6);
    assert.equal(format(1e10, 2), '10000000000.002002');
    assert.equal(fixed(1e10 + 2 / 999, 6), '10000000000.002003');
  });

  it('declines the cases its decomposition cannot express', async () => {
    const { fixed, makeTimeFormatter } = await import('../dist/format/number.js');
    const format = makeTimeFormatter(4, 4, 3);

    // A negative record start: appending a fraction to a negative whole part moves the time
    // the wrong way. -5 s plus half a second is -4.5, but "-5" and ".500" concatenate to
    // -5.500. An EDF+ timekeeping TAL may carry a negative onset, so this has to fall back.
    assert.equal(format(-5, 2), fixed(-5 + 0.5, 3));
    assert.equal(format(-5, 2), '-4.500');

    // A record that does not start on a whole second mixes the two fractions.
    assert.equal(format(0.25, 2), fixed(0.75, 3));
    assert.equal(format(0.25, 2), '0.750');

    // A sample beyond the record's declared length has no cached offset.
    assert.equal(format(1, 99), fixed(1 + 99 / 4, 3));

    // Past 1e21 `${n}` writes exponent notation, and the cached fraction was glued onto the
    // end of it: "1e+21.000". `fixed` has guarded values against that cliff since 0.3.x; the
    // time column lost the guard when 0.4.1 stopped calling it once per row.
    for (const start of [1e21, 2.5e21, 1e30]) {
      assert.equal(format(start, 1), fixed(start + 1 / 4, 3));
      assert.ok(!/e/iu.test(format(start, 1)), `exponent notation in ${format(start, 1)}`);
    }
  });

  it('writes a time column no parser has to guess at, however late the record', async () => {
    // EDF's record-duration field is 8 characters and accepts exponent form, so a header
    // saying 1e21 is legal and three records reach the cliff. Every cell in the column has
    // to be a number, not just the ones a well-behaved recording produces.
    const { convert } = await import('../dist/index.js');
    const out = await outDir();
    await convert(fixture('exponent-time.edf'), { outputDir: out, quiet: true });

    const rows = (await readFile(path.join(out, 'signals.csv'), 'utf8')).trim().split('\n');
    assert.equal(rows[0], 'time_s,ch1');
    for (const row of rows.slice(1)) {
      const time = row.split(',')[0];
      assert.ok(!/e/iu.test(time), `exponent notation in the time column: ${time}`);
      assert.ok(Number.isFinite(Number(time)), `unparseable time cell: ${time}`);
    }
    // The column still rises, and the last record starts two record durations in.
    assert.match(rows[rows.length - 1], /^2750000000000000000000\.000,/u);
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

  it('empties an undefined mapping but keeps a defined-but-flat one', async () => {
    // The distinction this pins is the whole risk of writing empty cells at all.
    //
    //   flat      digitalMin === digitalMax, so no mapping exists and no physical value
    //             can be computed -> empty. Writing the physical minimum here would
    //             produce a column indistinguishable from a real flat recording.
    //   flatphys  physicalMin === physicalMax over a valid digital range. The mapping is
    //             defined and merely flat, so 5 uV is a genuine reading -> still written.
    //   ok        an ordinary channel, which must be untouched by either neighbour.
    const dir = await outDir();
    await convert(fixture('degenerate-range.edf'), { outputDir: dir });

    const rows = await readCsv(dir, 'signals.csv');
    assert.equal(rows[0], 'time_s,flat,flatphys,ok');

    const body = rows.slice(1);
    assert.ok(body.length > 0, 'rows were written');
    for (const row of body) {
      const cells = row.split(',');
      assert.equal(cells.length, 4, 'an empty cell is still a cell');
      const [, flat, flatphys, ok] = cells;
      assert.equal(flat, '', `undefined mapping must be empty, got "${flat}"`);
      assert.equal(flatphys, '5.000', 'a flat but defined mapping keeps its value');
      assert.match(ok, /^-?\d+\.\d+$/u, 'an ordinary channel is unaffected');
    }
  });

  it('gives distinct rates distinct files even when their slugs collide', async () => {
    // Both rates render as "0hz". Sharing the filename meant two write streams on one
    // path: the rows interleaved and the header named only one of the two channels.
    const dir = await outDir();
    const result = await convert(fixture('rate-slug-collision.edf'), { outputDir: dir });

    const signalFiles = result.files.map((f) => f.name).filter((n) => n.startsWith('signals'));
    assert.equal(new Set(signalFiles).size, 2, `each rate needs its own file, got ${signalFiles}`);

    // Every channel must appear in exactly one file, with only its own samples.
    const seen = new Map();
    for (const name of signalFiles) {
      const rows = await readCsv(dir, name);
      const columns = rows[0].split(',').slice(1);
      assert.equal(columns.length, 1, `${name} should hold one channel, got ${columns}`);
      seen.set(columns[0], rows.length - 1);
      for (const row of rows.slice(1)) {
        assert.equal(row.split(',').length, 2, `${name} has a row with the wrong column count`);
      }
    }

    // slowA is 1 sample per record over 2 records; slowB is 2 per record over 2.
    assert.deepEqual([...seen.entries()].sort(), [['slowA', 2], ['slowB', 4]]);
  });

  it('reports the rates it converted, not the ones in the file', async () => {
    // The header parser sees every channel and knows nothing about --channels, so its
    // mixed-rate warning described the recording rather than the run: selecting one channel
    // out of a three-rate file announced "3 different sampling rates ... written to one file
    // per rate" over a conversion that wrote one file.
    const dir = await outDir();
    const one = await convert(fixture('mixed-rates.edf'), { outputDir: dir, channels: ['ECG'] });
    assert.equal(one.files.filter((f) => f.name.startsWith('signals')).length, 1);
    assert.ok(
      !one.diagnostics.some((d) => d.code === 'MIXED_SAMPLING_RATES'),
      'nothing was split, so nothing should say it was',
    );

    const two = await convert(fixture('mixed-rates.edf'), {
      outputDir: await outDir(),
      channels: ['EEG Fpz-Cz', 'ECG'],
    });
    const warning = two.diagnostics.find((d) => d.code === 'MIXED_SAMPLING_RATES');
    assert.ok(warning, 'two rates were written, so the split is worth reporting');
    assert.match(warning.message, /2 different sampling rates \(256 Hz, 128 Hz\)/u);

    const all = await convert(fixture('mixed-rates.edf'), { outputDir: await outDir() });
    const unfiltered = all.diagnostics.find((d) => d.code === 'MIXED_SAMPLING_RATES');
    assert.match(unfiltered.message, /3 different sampling rates/u, 'unchanged with no selection');
  });

  it('names each rate file for the rate it actually holds', async () => {
    // 1e-6 Hz and 1.25e-6 Hz both round to "0.000001" at six decimals, so both wanted the
    // name signals_0_000001hz.csv. The numbered fallback kept them apart, but it did it by
    // calling one of them signals_0_000001hz_2.csv — leaving the plain name on the file
    // holding 1.25e-6 Hz, which is the one rate that name rules out.
    const dir = await outDir();
    const result = await convert(fixture('rate-decimal-collision.edf'), { outputDir: dir });

    const named = new Map();
    for (const file of result.files.filter((f) => f.name.startsWith('signals'))) {
      const rows = await readCsv(dir, file.name);
      named.set(rows[0].split(',')[1], file.name);
    }
    assert.deepEqual(
      [...named.entries()].sort(),
      [['slow', 'signals_0_000001hz.csv'], ['slower', 'signals_0_00000125hz.csv']],
      'no numbered suffix, and each name states its own rate',
    );
  });

  it('blames the input when it is the input that failed', async () => {
    // Reading and writing both fail through one catch, and both were reported as writing.
    // A recording that shrinks mid-conversion — still being written by the acquisition
    // software, say — raised the reader's own precise error, which was then filed under
    // `Writing to "<dir>" failed` and given the hint about freeing disk space, sending the
    // reader to look at the one part of the system that was working.
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const { truncateSync } = await import('node:fs');

    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-shrink-'));
    temporaries.push(scratch);
    const source = path.join(scratch, 'shrinking.edf');

    // Records are read in batches sized by a byte budget, so the file has to be big enough
    // to need more than one — otherwise it is all read before anything can change under it.
    // Ten channels make the input large while converting only one keeps the CSV small.
    writeEdf({
      path: source,
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

    // Cut the file at a known point rather than racing a timer: onProgress fires after each
    // batch, so truncating in the first callback is reliably before the next read.
    let cut = false;
    const converting = convert(source, {
      outputDir: await outDir(),
      channels: ['ch0'],
      onProgress: () => {
        if (cut) return;
        cut = true;
        truncateSync(source, 4096);
      },
    });

    await assert.rejects(converting, (error) => {
      assert.ok(error instanceof ConversionError, `expected a ConversionError, got ${error}`);
      assert.equal(error.code, 'INPUT_UNREADABLE', 'a read failure is not a write failure');
      assert.match(error.message, /changed size while it was being read/u);
      assert.match(error.hint, /not still being written to/u, "the reader's own advice is kept");
      assert.ok(!/Free up space/u.test(error.hint), 'disk space is not the problem here');
      assert.match(error.hint, /incomplete and should not be used/u);
      return true;
    });
  });

  it('times a continuous recording from its first record, not from zero', async () => {
    // EDF+ says the first record's timekeeping TAL states the fraction of a second by which
    // it follows the header's start time, and annotation onsets share that origin. Timing
    // the samples from zero put the two half a second apart: the event at +0.75 landed on
    // sample 3 of a 4 Hz record rather than sample 1. The pair of fixtures differ only in
    // the reserved field, so whatever the answer is, it must be the same for both.
    const rowsFor = async (name) => {
      const dir = await outDir();
      await convert(fixture(name), { outputDir: dir });
      return {
        signals: await readCsv(dir, 'signals.csv'),
        annotations: await readCsv(dir, 'annotations.csv'),
      };
    };

    const continuous = await rowsFor('fractional-start.edf');
    const discontinuous = await rowsFor('fractional-start-d.edf');

    assert.deepEqual(
      continuous.signals,
      discontinuous.signals,
      'a continuous and a discontinuous copy of the same recording must agree on time',
    );
    assert.deepEqual(continuous.annotations, discontinuous.annotations);

    // The first sample sits where the TAL says, and the event lands on the row it belongs to.
    assert.equal(continuous.signals[1], '0.500,0.000');
    assert.equal(continuous.annotations[1], '0.75,,event,0');
    assert.ok(
      continuous.signals.includes('0.750,0.100'),
      'the event onset must coincide with a real sample row',
    );
  });

  it('measures --duration from where the recording starts, not from zero', async () => {
    // The signal window and the annotation window read the same absent --start two ways:
    // resolveRange took the earliest record, the annotation filter took 0. On a recording
    // whose first record sits at 30 s the two do not overlap at all, so every event inside
    // the converted span was dropped and annotations.csv came back with only its header.
    const dir = await outDir();
    await convert(fixture('late-start.edf'), { outputDir: dir, duration: 5 });

    const signals = await readCsv(dir, 'signals.csv');
    assert.match(signals[1], /^30\.000,/u, 'the samples start where the recording does');

    const rows = await readCsv(dir, 'annotations.csv');
    assert.equal(rows.length, 2, `expected the event inside the window, got ${rows}`);
    assert.match(rows[1], /^30\.5,,inside the window/u);
  });

  it('keeps annotations on and past the end of the data when no window was asked for', async () => {
    // Filtering to [0, duration) on a whole-file conversion dropped the events at 3.0 and
    // 3.5 of a three-second recording, and no flag could bring them back.
    const dir = await outDir();
    await convert(fixture('annotations-at-edges.edf'), { outputDir: dir });

    const rows = await readCsv(dir, 'annotations.csv');
    assert.deepEqual(
      rows.slice(1).map((r) => r.split(',')[0]),
      ['2.5', '3', '3.5'],
    );
  });

  it('keeps edge annotations when the request is unbounded, however it is spelled', async () => {
    // Filtering by the *resolved* window meant an unbounded request still lost events:
    // --end 999h clamps to the recording, and --start 0 takes its end from it, so both
    // filtered to [0, 3) and dropped the markers at 3.0 and 3.5 that a bare run keeps.
    // Asking for more of a recording returned less of it.
    for (const options of [{}, { end: 999 * 3600 }, { start: 0 }]) {
      const dir = await outDir();
      await convert(fixture('annotations-at-edges.edf'), { outputDir: dir, ...options });
      assert.deepEqual(
        (await readCsv(dir, 'annotations.csv')).slice(1).map((r) => r.split(',')[0]),
        ['2.5', '3', '3.5'],
        `unbounded request ${JSON.stringify(options)} should keep every event`,
      );
    }
  });

  it('still filters annotations when a window is requested', async () => {
    const dir = await outDir();
    await convert(fixture('annotations-at-edges.edf'), { outputDir: dir, start: 0, end: 3 });

    const rows = await readCsv(dir, 'annotations.csv');
    assert.deepEqual(rows.slice(1).map((r) => r.split(',')[0]), ['2.5'], 'half-open window');
  });

  it('does not let an ordinary annotation become a record start time', async () => {
    // Record 1's timekeeping TAL is undecodable. The next TAL is a genuine event at 1.5s;
    // treating it as the record start shifted every sample in that record by half a second.
    const dir = await outDir();
    await convert(fixture('annotations-bad-timekeeping.edf'), { outputDir: dir });

    const times = (await readCsv(dir, 'signals.csv')).slice(1).map((r) => r.split(',')[0]);
    assert.equal(times[4], '1.000', `record 1 must fall back to contiguous timing, got ${times[4]}`);

    // The event is still exported as an event rather than consumed as timing.
    const events = await readCsv(dir, 'annotations.csv');
    assert.deepEqual(events.slice(1).map((r) => r.split(',')[0]), ['1.5']);
  });

  it('does not call a single-rate file mixed because of an empty channel', async () => {
    const dir = await outDir();
    const result = await convert(fixture('single-rate-empty-channel.edf'), { outputDir: dir });

    const codes = result.diagnostics.map((d) => d.code);
    assert.ok(!codes.includes('MIXED_SAMPLING_RATES'), `unexpected mixed-rate warning: ${codes}`);
    assert.ok(codes.includes('NO_SAMPLES'), 'the empty channel is still reported');
    assert.deepEqual(
      result.files.map((f) => f.name).filter((n) => n.startsWith('signals')),
      ['signals.csv'],
      'one rate means one unsuffixed file',
    );
  });

  it('reports exactly what it wrote, for every fixture and mode', async () => {
    /*
      One invariant covering a whole class of bug: what the run says it produced must match
      what is on disk. Individual pieces of this have gone wrong before — two rate groups
      claiming one filename, annotations counted but not written — and each was found only
      because someone looked at that specific file. Checking the agreement directly means
      the next such disagreement fails here instead.
    */
    const fixtures = (await readdir(FIXTURES)).filter((n) => /\.(edf|bdf)$/u.test(n));
    assert.ok(fixtures.length > 10, 'fixtures should be generated before this runs');

    for (const name of fixtures) {
      for (const [mode, options] of [
        ['plain', {}],
        ['window', { start: 0, end: 1 }],
        ['annotationsOnly', { annotationsOnly: true }],
      ]) {
        const dir = await outDir();
        let result;
        try {
          result = await convert(path.join(FIXTURES, name), { outputDir: dir, ...options });
        } catch {
          continue; // a fixture that legitimately refuses this mode
        }
        const where = `${name} [${mode}]`;
        const metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8'));

        for (const written of result.files) {
          const rows = await readCsv(dir, written.name);
          assert.equal(rows.length - 1, written.rows, `${where}: ${written.name} row count`);
        }

        for (const group of metadata.conversion.rate_groups ?? []) {
          const header = (await readCsv(dir, group.file))[0].split(',').slice(1);
          assert.deepEqual(header, group.channels, `${where}: ${group.file} columns vs rate_groups`);
          assert.equal(group.decimals.length, group.channels.length, `${where}: decimals length`);
        }

        const annotations = result.files.find((f) => f.name === 'annotations.csv');
        if (annotations) {
          assert.equal(
            metadata.conversion.annotations_written,
            annotations.rows,
            `${where}: annotations_written vs annotations.csv`,
          );
        }
      }
    }
  });

  it('records provenance in metadata.json', async () => {
    const dir = await outDir();
    await convert(fixture('tiny.edf'), { outputDir: dir });
    const metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.tool.name, 'edf2csv');
    assert.equal(metadata.recording.data_records, 2);
    assert.equal(metadata.recording.start_datetime_local, '2009-06-05T12:34:56');
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
    const result = await convert(fixture('discontinuous.edf'), { outputDir: dir });
    const rows = await readCsv(dir, 'signals.csv');

    assert.equal(rows.length, 31, 'all three records are converted, none dropped');
    assert.equal(result.plan.estimate.rows, 30, 'timing gaps must not be counted as samples');
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

  it('finds annotations inside the window even when stored in a record outside it', async () => {
    // All three annotations live in record 0, but their onsets are 0.5s, 5.5s and 8.5s.
    // Reading only the window's own records would miss the one that belongs in it.
    const dir = await outDir();
    const result = await convert(fixture('annotations-front-loaded.edf'), {
      outputDir: dir,
      start: 5,
      duration: 2,
    });

    const rows = await readCsv(dir, 'annotations.csv');
    assert.equal(rows.length, 2, 'header plus the one annotation inside 5s-7s');
    assert.match(rows[1], /middle/);
    assert.equal(result.annotationCount, 1, 'the count must match what was written');
  });

  it('reports the number of annotations it actually wrote', async () => {
    const dir = await outDir();
    const result = await convert(fixture('annotations-front-loaded.edf'), { outputDir: dir });
    const metadata = JSON.parse(await readFile(path.join(dir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.conversion.annotations_written, 3);
    assert.equal(result.annotationCount, 3);
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

  it('never overwrites the input when its name collides with a generated file', async () => {
    const dir = await outDir();
    await mkdir(dir, { recursive: true });
    const input = path.join(dir, 'metadata.json');
    await copyFile(fixture('tiny.edf'), input);
    const before = await readFile(input);

    await assert.rejects(
      () => convert(input, { outputDir: dir, force: true }),
      (error) => {
        assert.ok(error instanceof ConversionError);
        assert.equal(error.code, 'INPUT_OUTPUT_COLLISION');
        return true;
      },
    );

    assert.deepEqual(await readFile(input), before, 'the source recording must remain untouched');
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
