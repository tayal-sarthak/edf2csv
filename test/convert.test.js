/** Conversion tests: planning, channel selection, time ranges, and written output. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  it('reads a comma decimal separator in every numeric field, the signal count included', async () => {
    // EdfFile.open worked out how much header to read with its own Number(), which tolerated
    // the NUL padding sloppy writers emit but not the comma decimal separator that
    // COMMA_DECIMAL exists to accept — and which the documentation lists this field among.
    // The signal headers were therefore never read, and the file died on a message that
    // refuted itself: "needs a 768-byte header, but the file is only 848 bytes".
    const file = await EdfFile.open(fixture('comma-decimal.edf'));
    assert.equal(file.header.signals.length, 2, 'the signal headers were read');
    assert.equal(file.header.recordDuration, 1);
    assert.ok(
      file.diagnostics.some((d) => d.code === 'COMMA_DECIMAL'),
      'the unusual separator is still reported',
    );
    await file.close();

    // And it converts to exactly what the same file with dots converts to.
    const commas = await outDir();
    const dots = await outDir();
    await convert(fixture('comma-decimal.edf'), { outputDir: commas, quiet: true });
    await convert(fixture('tiny.edf'), { outputDir: dots, quiet: true });
    assert.deepEqual(await readCsv(commas, 'signals.csv'), await readCsv(dots, 'signals.csv'));
  });

  it('names a channel whose label carries control characters', async () => {
    // --info has escaped these since it was written, because an ANSI escape in a header can
    // drive the reader's terminal. The CSV passes them through, which is right — losing what
    // the header says is not an improvement — but nothing said so, and `cat signals.csv` on
    // a channel labelled ESC[2J clears the terminal, while a script referencing that column
    // by name carries an invisible control character in it. NONPRINTABLE_LABEL has been
    // declared and documented as reserved since 0.1; this is it doing its job.
    const dir = await outDir();
    const result = await convert(fixture('control-labels.edf'), { outputDir: dir });

    const raised = result.diagnostics.filter((d) => d.code === 'NONPRINTABLE_LABEL');
    assert.equal(raised.length, 3, `expected one per affected signal: ${raised.length}`);
    assert.match(raised[0].message, /Signal 0's label or unit contains 2 control characters/u);
    assert.match(raised[0].message, /\\x1b/u, 'the bytes are named, escaped');
    assert.match(raised[1].message, /\\x07/u);
    // A tab is harmless to a terminal but makes a column name nobody can type reliably.
    assert.match(raised[2].message, /\\x09/u);
    assert.match(raised[0].hint, /--channels "#0"/u, 'the way to address it is given');

    // The label still reaches the CSV exactly as the header has it: this warns, it does not
    // rewrite. The fourth channel has nothing wrong with it and raises nothing.
    const header = (await readCsv(dir, 'signals.csv'))[0];
    assert.ok(header.includes(String.fromCharCode(27)), 'the escape is still in the column');
    assert.ok(header.includes('plain'));
  });

  it('leaves an ordinary label alone', async () => {
    for (const name of ['tiny.edf', 'mixed-rates.edf', 'quirky-labels.edf', 'annotations.edf']) {
      const file = await EdfFile.open(fixture(name));
      const noisy = file.diagnostics.filter((d) => d.code === 'NONPRINTABLE_LABEL');
      await file.close();
      assert.deepEqual(noisy, [], `${name} should not raise NONPRINTABLE_LABEL`);
    }
  });

  it('checks the suffix against the file, not only against the label it disambiguates', async () => {
    // `_ch<index>` is unique among the channels sharing a label, and nothing stopped it from
    // landing on a label some other channel already had. T8, T8, T8_ch0 — all three legal —
    // produced `time_s,T8_ch0,T8_ch1,T8_ch0`: two columns with one name, while the warning
    // beside it promised the suffix kept them distinguishable. channels.csv listed the same
    // name against two signal indices, so the join it exists for could not resolve it
    // either, and df["T8_ch0"] returns one of the two with nothing to say which.
    const file = await EdfFile.open(fixture('label-suffix-collision.edf'));
    const names = buildColumnNames(file.header.signals);
    await file.close();

    assert.equal(new Set(names.values()).size, names.size, `not unique: ${[...names.values()]}`);
    assert.equal(names.get(1), 'T8_ch1', 'a name nothing contests is left where it was');

    // The channel that lost its own label to another's suffix is named in a warning, since
    // its column is the one thing in the output that no longer matches the file.
    const dir = await outDir();
    const result = await convert(fixture('label-suffix-collision.edf'), { outputDir: dir });
    const notice = result.diagnostics.find((d) => /also the column name/u.test(d.message));
    assert.ok(notice, `the renamed channel must be reported: ${JSON.stringify(result.diagnostics)}`);
    assert.match(notice.message, /Signal 2 is labelled "T8_ch0"/u);

    // Every column resolves to exactly one channel, in signals.csv and in channels.csv both.
    const header = (await readCsv(dir, 'signals.csv'))[0].split(',');
    assert.equal(new Set(header).size, header.length, `duplicate columns: ${header}`);
    const columns = (await readCsv(dir, 'channels.csv')).slice(1).map((row) => row.split(',')[0]);
    assert.deepEqual(columns, header.slice(1), 'channels.csv describes the columns written');
    assert.equal(new Set(columns).size, columns.length);
  });
});

describe('an empty result', () => {
  it('says so when the window lands where there is no data', async () => {
    // A window can select nothing without being past the end of the recording: between the
    // last sample and the nominal end of the last record, or inside a gap. What came out was
    // a signals.csv holding its header and nothing else, exit 0, no warning, --strict
    // passing — which is exactly what a successful extraction of an empty range looks like.
    // Everywhere else a request that produces nothing says so.
    const continuous = await outDir();
    const past = await convert(fixture('tiny.edf'), { outputDir: continuous, start: 1.95 });
    assert.deepEqual(await readCsv(continuous, 'signals.csv'), ['time_s,ch1,ch2']);
    const first = past.diagnostics.find((d) => d.code === 'EMPTY_WINDOW');
    assert.ok(first, `no warning: ${JSON.stringify(past.diagnostics)}`);
    assert.match(first.message, /1\.950s to 2\.000s/u, 'the window is quoted back');

    // The same thing on a discontinuous file, where the window falls inside the gap between
    // the records at 1s and 10s.
    const gap = await outDir();
    const inside = await convert(fixture('discontinuous.edf'), {
      outputDir: gap, start: 2, end: 10,
    });
    assert.ok(inside.diagnostics.some((d) => d.code === 'EMPTY_WINDOW'));

    // And an ordinary conversion is left alone.
    const ordinary = await outDir();
    const whole = await convert(fixture('tiny.edf'), { outputDir: ordinary });
    assert.ok(!whole.diagnostics.some((d) => d.code === 'EMPTY_WINDOW'));
  });

  it('leaves the paths that write no signal files alone', async () => {
    // --annotations-only writes no signal table by design, and a file with no signal
    // channels has none to write; neither is an empty window and neither should say so.
    for (const [name, options] of [
      ['annotations.edf', { annotationsOnly: true }],
      ['annotations-only.edf', {}],
    ]) {
      const dir = await outDir();
      const result = await convert(fixture(name), { outputDir: dir, ...options });
      assert.ok(
        !result.diagnostics.some((d) => d.code === 'EMPTY_WINDOW'),
        `${name} raised EMPTY_WINDOW`,
      );
    }
  });
});

describe('what the library says about itself', () => {
  it('keeps the answer about the input changing after the file is closed', async () => {
    // convert() closes the file before it returns, and changedSinceOpen() returned false on
    // a closed handle — so result.file.changedSinceOpen() denied the very change the
    // INPUT_CHANGED diagnostic in the same result object had just reported. One object, two
    // answers. False is not something a closed descriptor can know.
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const { copyFileSync } = await import('node:fs');

    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-closed-'));
    temporaries.push(scratch);
    const signals = [{
      label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100,
      digMin: -1000, digMax: 1000, samplesPerRecord: 256, gen: (r, s) => (r + s) % 1000,
    }];
    const small = path.join(scratch, 'small.edf');
    const large = path.join(scratch, 'large.edf');
    const live = path.join(scratch, 'live.edf');
    writeEdf({ path: small, numRecords: 2000, recordDuration: 1, signals });
    writeEdf({ path: large, numRecords: 3000, recordDuration: 1, signals });
    copyFileSync(small, live);

    let swapped = false;
    const changed = await convert(live, {
      outputDir: await outDir(),
      quiet: true,
      onProgress: () => {
        if (swapped) return;
        swapped = true;
        copyFileSync(large, live);
      },
    });
    assert.ok(changed.diagnostics.some((d) => d.code === 'INPUT_CHANGED'));
    assert.equal(await changed.file.changedSinceOpen(), true, 'the result must agree with itself');

    const still = await convert(fixture('tiny.edf'), { outputDir: await outDir(), quiet: true });
    assert.equal(await still.file.changedSinceOpen(), false);
  });

  it('blames the caller when the caller\'s callback is what failed', async () => {
    // onProgress ran inside the same try that turns a stream failure into WRITE_FAILED, so a
    // callback that threw came back as `Writing to "out" failed: caller bug`, advising the
    // reader to check a destination that was working perfectly. The same misattribution the
    // write hints carried until 0.4.36, one layer up.
    const { ConversionError } = await import('../dist/index.js');
    const thrown = new Error('caller bug');

    await assert.rejects(
      convert(fixture('long-stream.edf'), {
        outputDir: await outDir(),
        quiet: true,
        onProgress: () => {
          throw thrown;
        },
      }),
      (error) => {
        assert.ok(error instanceof ConversionError, `got ${error}`);
        assert.equal(error.code, 'CALLBACK_FAILED', 'not a write failure');
        assert.match(error.message, /The onProgress callback threw: caller bug/u);
        assert.ok(!/Writing to/u.test(error.message), 'the destination is not the problem');
        assert.match(error.hint, /not the recording or the destination/u);
        // The stack that matters is the caller's, so it is kept rather than flattened.
        assert.equal(error.cause, thrown);
        return true;
      },
    );
  });
});

describe('option checking', () => {
  it('rejects a value the command line would reject, and writes nothing', async () => {
    // The CLI has always validated these; the library did not, so the same value behaved
    // differently depending on how it arrived. `decimals: NaN` resolved successfully having
    // written whole numbers into a column the caller asked for decimals in — no error, no
    // warning, output that looks deliberate. `decimals: -1` came back as a bare RangeError
    // from inside toFixed, naming nothing the caller had written. `start: NaN` created the
    // directory, wrote signals.csv, then failed with a message about the input being
    // unreadable: a partial conversion, blamed on the file.
    const { OptionError } = await import('../dist/index.js');
    const { existsSync } = await import('node:fs');

    const cases = [
      [{ decimals: NaN }, /decimals must be a whole number between 0 and 20, got NaN/u],
      [{ decimals: -1 }, /got -1/u],
      [{ decimals: 1.5 }, /got 1.5/u],
      [{ decimals: 21 }, /got 21/u],
      [{ start: NaN }, /start must be a number of seconds, got NaN/u],
      [{ start: -5 }, /got -5/u],
      [{ duration: Infinity }, /duration must be a number of seconds/u],
      [{ end: NaN }, /end must be a number of seconds/u],
      /*
        The command line has always rejected `--layout tall`. The library took it, wrote the
        wide layout, and handed back a plan whose `layout` said "tall" — so a caller with a
        typo got a conversion that was not the one they asked for, described by a plan that
        agreed with the typo.
      */
      [{ layout: 'tall' }, /layout must be "wide" or "long", got "tall"/u],
      [{ layout: '' }, /layout must be "wide" or "long", got ""/u],
      [{ layout: 'LONG' }, /got "LONG"/u],
    ];

    for (const [options, expected] of cases) {
      const dir = await outDir();
      await assert.rejects(
        convert(fixture('tiny.edf'), { outputDir: dir, quiet: true, ...options }),
        (error) => {
          assert.ok(error instanceof OptionError, `${JSON.stringify(options)} threw ${error}`);
          assert.match(error.message, expected);
          return true;
        },
      );
      // Checked before a directory is created, so a rejected option leaves nothing behind.
      assert.equal(existsSync(dir), false, `${JSON.stringify(options)} left ${dir} behind`);
    }
  });

  it('leaves the values it should accept alone', async () => {
    for (const options of [{ decimals: 0 }, { decimals: 20 }, { start: 0 }, { duration: 1 }]) {
      const dir = await outDir();
      await convert(fixture('tiny.edf'), { outputDir: dir, quiet: true, ...options });
      assert.ok((await readdir(dir)).includes('signals.csv'), JSON.stringify(options));
    }
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

  it('shares one offset cache across every table in a conversion', async () => {
    // The cap was per rate group, and a file may hold as many rate groups as it has
    // channels, so nothing bounded the total: twelve channels at twelve rates just under
    // the cap — a 25 MB file — took 1.66 GB and 36 s, where a 92 MB file at one rate takes
    // 283 MB; twenty-four of them never finished. Groups ask fastest-first, so the tables
    // with the most rows to write get the cache and the ones that miss out are the ones
    // that would have gained least.
    const { makeTimeFormatter, newOffsetBudget, fixed } = await import('../dist/format/number.js');

    assert.equal(newOffsetBudget().remaining, 1 << 20, 'one conversion, one budget');

    const budget = { remaining: 100 };
    const cached = makeTimeFormatter(80, 8, 3, budget);
    assert.equal(budget.remaining, 20, 'a group that caches spends what it cached');
    const uncached = makeTimeFormatter(80, 4, 3, budget);
    assert.equal(budget.remaining, 20, 'a group that cannot fit spends nothing');

    // Whether a group got the cache may not change a single cell.
    for (const sample of [0, 1, 37, 79]) {
      assert.equal(uncached(42, sample), fixed(42 + sample / 4, 3));
      assert.equal(cached(42, sample), fixed(42 + sample / 8, 3));
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

  it('calls a channel inverted when its gain is negative, not when one pair looks odd', async () => {
    // The gain is (physMax - physMin) / (digMax - digMin), so the sign of that fraction is
    // what inverts a channel. Reversing exactly one pair does it; reversing both leaves a
    // positive gain and a channel that is not inverted at all. The documentation described
    // the trigger as the physical pair on its own, which is neither what the code does nor
    // what the format means — and the code is the one that is right.
    const file = await EdfFile.open(fixture('reversed-bounds.edf'));
    const raised = file.diagnostics.filter((d) => d.code === 'INVERTED_PHYSICAL_RANGE');
    await file.close();

    assert.equal(raised.length, 2, `one per genuinely inverted channel: ${raised.length}`);
    assert.match(raised[0].message, /Signal 0 \("phys-only"\).*physical minimum 100 above/u);
    // The message names whichever pair is actually reversed.
    assert.match(raised[1].message, /Signal 1 \("dig-only"\).*digital minimum 1000 above/u);
    assert.ok(!raised.some((d) => /"both"/u.test(d.message)), 'both reversed is a positive gain');

    // And the values follow the gain. Only the channel whose digital bounds are the right
    // way round can be checked this way: the fixture writer clamps generated samples to the
    // declared digital range, and a reversed range clamps every one of them to the same
    // value — so those two columns are constant by construction of the fixture rather than
    // by anything the converter did.
    const dir = await outDir();
    await convert(fixture('reversed-bounds.edf'), { outputDir: dir, quiet: true });
    const rows = (await readCsv(dir, 'signals.csv')).slice(1).map((r) => r.split(',').map(Number));
    assert.equal(rows[0][1], 0, 'phys-only starts at its physical maximum');
    assert.ok(rows[rows.length - 1][1] < rows[0][1], 'and falls, because its gain is negative');
  });

  it('writes an exact time column at the rates a BioSemi records', async () => {
    // The search for a terminating decimal expansion stopped at nine places, and the comment
    // beside it claimed "every rate in common use clears this — 256 Hz needs 8 places, 512 Hz
    // needs 9". The next two powers of two do not: 1/1024 needs ten and 1/2048 needs eleven,
    // and those are what an ActiveTwo records at by default. Both fell through to the
    // rounding fallback, so `time_s * rate` came back at 8191.999... rather than a whole
    // number — exactly what this column exists to avoid.
    const { timeDecimals } = await import('../dist/format/number.js');
    for (const rate of [1024, 2048, 4096, 8192]) {
      const decimals = timeDecimals(rate);
      assert.equal(
        Number((1 / rate).toFixed(decimals)),
        1 / rate,
        `${rate} Hz rounds its sample interval at ${decimals} places`,
      );
    }

    // A rate whose expansion repeats still gets the capped fallback, rather than asking for
    // seventeen decimals of a number that never terminates.
    assert.ok(timeDecimals(3) <= 9, '3 Hz must not claim an exact expansion');
    assert.ok(timeDecimals(7) <= 9);

    // And end to end: every time_s in a 1024 Hz conversion lands on a whole sample.
    const dir = await outDir();
    await convert(fixture('biosemi-rate.edf'), { outputDir: dir, quiet: true });
    const rows = (await readCsv(dir, 'signals.csv')).slice(1);
    assert.equal(rows.length, 2048);
    for (const row of rows) {
      const time = Number(row.split(',')[0]);
      assert.equal(time * 1024, Math.round(time * 1024), `${time} is not a whole sample`);
    }
  });

  it('keeps the boundary slack under one sample interval', async () => {
    // The slack for deciding which samples fall inside the requested window was a flat
    // nanosecond, applied whatever the rate — and the format does not oblige the sample
    // interval to be larger than that. Two records of 1e-9 s holding ten samples each wrote
    // ten of their twenty rows: the window ends at 2e-9, the comparison asked for
    // `time < 2e-9 - 1e-9`, and the entire second record failed it. Exit 0, no warning.
    const dir = await outDir();
    const result = await convert(fixture('sub-nanosecond.edf'), { outputDir: dir });
    const rows = await readCsv(dir, 'signals.csv');
    assert.equal(rows.length - 1, 20, 'every sample must be written');

    // 1e10 Hz has a terminating expansion at ten places, which the search now reaches, so
    // this recording gets a column that separates every sample and needs no warning at all.
    const times = new Set(rows.slice(1).map((row) => row.split(',')[0]));
    assert.equal(times.size, 20, 'and each one is distinguishable');
    assert.ok(!result.diagnostics.some((d) => d.code === 'TIME_RESOLUTION'));
  });

  it('says so when the rate has no exact expansion to fall back on', async () => {
    // Three samples in 1e-15 s is 3e15 Hz, and 1/3e15 repeats forever, so there is no exact
    // expansion to find and even the fallback's fifteen places cannot separate consecutive
    // samples. Every sample is still written and in order; what stops being true is that
    // time_s identifies a row, and joining or plotting on it silently collapses them.
    const dir = await outDir();
    const result = await convert(fixture('repeating-fast.edf'), { outputDir: dir });
    const rows = await readCsv(dir, 'signals.csv');
    assert.equal(rows.length - 1, 6, 'every sample is written');

    const notice = result.diagnostics.find((d) => d.code === 'TIME_RESOLUTION');
    assert.ok(notice, `expected the warning: ${JSON.stringify(result.diagnostics)}`);
    assert.match(notice.hint, /Every sample is written, in order/u);
    const times = new Set(rows.slice(1).map((row) => row.split(',')[0]));
    assert.ok(times.size < 6, 'and the column really does repeat, which is why it is said');
  });

  it('reaches far enough to separate samples before giving up on them', async () => {
    // The fallback for a rate with no exact expansion is meant to use "enough places to keep
    // consecutive samples distinct", and stopped at nine — which at 3e10 Hz, where the
    // interval is 3.3e-11, rounded every sample in a record to one timestamp. A column that
    // cannot tell two samples apart is not keeping them distinct.
    const { timeDecimals } = await import('../dist/format/number.js');
    for (const rate of [333, 3e6, 3e10]) {
      const decimals = timeDecimals(rate);
      const interval = 1 / rate;
      assert.ok(
        interval >= 10 ** -decimals,
        `${rate} Hz gets ${decimals} places for an interval of ${interval}`,
      );
    }
    // And it stops at fifteen rather than growing without bound.
    assert.ok(timeDecimals(3e15) <= 15);
  });

  it('leaves rows on disk when the recording shrinks mid-conversion, and says so', async () => {
    /*
      warnings-and-errors.md filed this under "These stop the conversion. Nothing is written.
      All of them exit 1." Every other error in that section is raised while the header is
      read, before the output directory exists. This one is raised during the signal pass, so
      a signals.csv is already on disk holding every row up to that point — ending on a row
      boundary, opening exactly like a finished one.

      Truncating before the run proves nothing: the header read notices, warns, and converts
      the records that are there. The file has to shrink while it is being read, so this cuts
      it from inside onProgress, which fires once per batch.
    */
    const { truncate, stat } = await import('node:fs/promises');
    const { truncateSync } = await import('node:fs');
    const dir = await outDir();
    const recording = path.join(path.dirname(dir), 'shrinking.edf');
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    writeEdf({
      path: recording,
      // Big enough that the default 8 MB read chunk gives several batches, so onProgress
      // fires while there is still file left to read. At 2 MB it is one batch and one
      // callback, after everything has already been read, and nothing can be cut in time.
      numRecords: 40_000,
      recordDuration: 1,
      signals: [
        {
          label: 'sig',
          dimension: 'uV',
          physMin: -100,
          physMax: 100,
          digMin: -2048,
          digMax: 2047,
          samplesPerRecord: 256,
          gen: (record, sample) => ((record * 7 + sample) % 4000) - 2000,
        },
      ],
    });
    const whole = (await stat(recording)).size;

    let cut = false;
    await assert.rejects(
      () =>
        convert(recording, {
          outputDir: dir,
          onProgress: () => {
            if (cut) return;
            cut = true;
            // Synchronous, so the next read is already looking at a shorter file.
            truncateSync(recording, Math.floor(whole / 3));
          },
        }),
      (error) => {
        assert.match(error.message, /appears to have changed size while it was being read/u);
        assert.match(error.hint, /before it failed is incomplete and should not be used/u);
        return true;
      },
    );
    assert.ok(cut, 'the file was never truncated, so this tested nothing');

    // And the rows written before it failed really are on disk.
    const written = await readFile(path.join(dir, 'signals.csv'), 'utf8');
    const rows = written.trimEnd().split('\n').length - 1;
    assert.ok(rows > 0, 'no partial file, so there is nothing to warn anyone about');
    assert.ok(rows < 40_000 * 256, `${rows} rows is the whole recording`);
    assert.ok(written.endsWith('\n'), 'it ends on a row boundary, which is why it misleads');

    await truncate(recording, whole).catch(() => {});
  });

  it('writes enough decimals for a magnetometer to keep its codes apart', async () => {
    /*
      ±1e-16 T over a 16-bit converter steps by 3.05e-21 and needs 23 decimals. The clamp
      was 20, on the stated grounds that 20 was the most `toFixed` accepts — it accepts 100.
      So every value landed on a 1e-20 grid, roughly three digital codes to a printed value,
      69% of them unrecoverable, exit 0 and no warning. The channel type the comment named
      as the reason for the ceiling was the one the ceiling broke.
    */
    const dir = await outDir();
    const result = await convert(fixture('magnetometer.edf'), { outputDir: dir });
    const rows = await readCsv(dir, 'signals.csv');
    const cells = rows.slice(1).map((row) => row.split(',')[1]);
    assert.equal(new Set(cells).size, cells.length, 'every code must print as its own text');
    assert.ok(!result.diagnostics.some((d) => d.code === 'VALUE_RESOLUTION'));

    // And the FAQ's arithmetic gets the codes back, which is the claim being kept.
    const [signal] = result.plan.groups[0].channels;
    const gain =
      (signal.signal.physicalMax - signal.signal.physicalMin) /
      (signal.signal.digitalMax - signal.signal.digitalMin);
    const offset = signal.signal.physicalMax / gain - signal.signal.digitalMax;
    cells.forEach((cell, index) => {
      assert.equal(Math.round(Number(cell) / gain - offset), -32768 + index);
    });
  });

  it('does not report a precision the caller chose as a loss of precision', async () => {
    /*
      `--decimals` exists to set a coarser precision, so raising VALUE_RESOLUTION for it is
      reporting the flag back at the person who typed it. It fired on every channel of an
      ordinary EEG at `--decimals 2` — and since --strict turns any diagnostic into exit 1,
      `--decimals 2 --strict` could not succeed on any recording at all.
    */
    for (const decimals of [0, 2, 4]) {
      const result = await convert(fixture('mixed-rates.edf'), { outputDir: await outDir(), decimals });
      assert.ok(
        !result.diagnostics.some((d) => d.code === 'VALUE_RESOLUTION'),
        `--decimals ${decimals} raised it`,
      );
    }

    /*
      The ceiling case is a different thing and says so whatever --decimals says — including
      at 20, where 0.5.10's version went quiet and printed every one of that channel's codes
      as `0.00000000000000000000`. The question is not who chose the precision; it is whether
      any precision the tool can print would separate consecutive codes.
    */
    for (const options of [{}, { decimals: 20 }, { decimals: 2 }]) {
      const clamped = await convert(fixture('unprintable-step.bdf'), {
        outputDir: await outDir(),
        ...options,
      });
      assert.ok(
        clamped.diagnostics.some((d) => d.code === 'VALUE_RESOLUTION'),
        `silent at ${JSON.stringify(options)}`,
      );
    }
  });

  it('says so when the step is finer than any printable decimal', async () => {
    // A step below 1e-98 is past what `toFixed` will print, and an 8-character physical
    // bound can still express one: `1e-99` is five characters. Nothing that measures
    // anything produces this, which is the reason to warn rather than the reason not to.
    const result = await convert(fixture('unprintable-step.bdf'), { outputDir: await outDir() });
    const notice = result.diagnostics.find((d) => d.code === 'VALUE_RESOLUTION');
    assert.ok(notice, `expected the warning: ${JSON.stringify(result.diagnostics)}`);
    assert.match(notice.message, /gravimeter steps by less than any number of decimals/u);
    assert.match(notice.hint, /computed at full/u);
  });

  it('leaves an ordinary channel at the decimals it always had', async () => {
    const { decimalsForSignal } = await import('../dist/edf/scale.js');
    const signal = (physicalMin, physicalMax, digitalMin, digitalMax) => ({
      physicalMin,
      physicalMax,
      digitalMin,
      digitalMax,
    });
    // Raising the ceiling must not move a channel that never reached it.
    assert.equal(decimalsForSignal(signal(-250, 250, -2048, 2047)), 3);
    assert.equal(decimalsForSignal(signal(-5, 5, -2048, 2047)), 5);
    assert.equal(decimalsForSignal(signal(34, 40, -2048, 2047)), 5);
    assert.equal(decimalsForSignal(signal(-262144, 262144, -8388608, 8388607)), 4);
  });

  it('leaves an ordinary sampling rate alone', async () => {
    for (const name of ['tiny.edf', 'mixed-rates.edf', 'long-stream.edf', 'many-rates.edf']) {
      const result = await convert(fixture(name), { outputDir: await outDir(), quiet: true });
      assert.ok(
        !result.diagnostics.some((d) => d.code === 'TIME_RESOLUTION'),
        `${name} raised TIME_RESOLUTION`,
      );
    }
  });

  it('measures a record against what the file can express, not against equality', async () => {
    // 0.4.41 asked whether the declared start and the contiguous one were the same double.
    // They are not: a recording of 0.1s records sitting at 0.1, 0.2, 0.3 ... is contiguous
    // by construction, and 0.1 + 2 * 0.1 is 0.30000000000000004. Two of its eight records
    // were reported as contradicting continuity on a file with nothing wrong with it — and
    // under --strict that was a failed run.
    const fine = await convert(fixture('contiguous-fractional.edf'), { outputDir: await outDir() });
    assert.deepEqual(
      fine.diagnostics.filter((d) => /marked continuous/u.test(d.message)),
      [],
      'an ordinary contiguous recording must raise nothing',
    );

    // A record that really is somewhere else is still caught: 0.5s, 1.5s, then 10.5s.
    const lying = await convert(fixture('continuous-liar.edf'), { outputDir: await outDir() });
    const notice = lying.diagnostics.find((d) => /marked continuous/u.test(d.message));
    assert.ok(notice, `a nine-second jump must be reported: ${JSON.stringify(lying.diagnostics)}`);
    assert.match(notice.message, /1 of its 3 data records/u);
  });

  it('takes the origin from whichever record first states one', async () => {
    // Reading only recordStarts[0] meant a single unreadable timekeeping TAL threw the
    // origin away and timed the whole file from zero — while records 1 and 2, saying plainly
    // that they start at 1.5s and 2.5s, went unread. Every sample came out 0.5s earlier than
    // the file states, against annotation onsets that kept their true values: precisely the
    // mismatch 0.4.9 fixed, through the one hole left in it. Continuity is what makes it
    // recoverable — record i sits at origin + i * duration, so any readable record fixes it.
    const rowsFor = async (name) => {
      const dir = await outDir();
      const result = await convert(fixture(name), { outputDir: dir });
      return {
        signals: await readCsv(dir, 'signals.csv'),
        annotations: await readCsv(dir, 'annotations.csv'),
        diagnostics: result.diagnostics,
      };
    };

    const continuous = await rowsFor('lost-timekeeping.edf');
    const discontinuous = await rowsFor('lost-timekeeping-d.edf');

    assert.equal(continuous.signals[1], '0.500,0.000', 'the recording starts where it says');
    assert.deepEqual(
      continuous.signals,
      discontinuous.signals,
      'the two differ only in the reserved field, so they must agree on time',
    );

    // The events land on rows that exist, which is the point of sharing an origin.
    const times = new Set(continuous.signals.slice(1).map((row) => row.split(',')[0]));
    for (const onset of ['0.750', '1.750', '2.750']) {
      assert.ok(times.has(onset), `no sample row at ${onset}`);
    }
  });

  it('calls a lost timekeeping annotation what it is', async () => {
    // Timekeeping TALs were counted among the annotations, so a file with one unreadable
    // timekeeping TAL and three good events announced "1 annotation entry was unreadable and
    // could not be exported" — while exporting all three. Nothing was missing from
    // annotations.csv; what went missing was a record's position in time.
    const dir = await outDir();
    const result = await convert(fixture('lost-timekeeping.edf'), { outputDir: dir });

    assert.equal((await readCsv(dir, 'annotations.csv')).length - 1, 3, 'every event exported');
    assert.ok(
      !result.diagnostics.some((d) => /could not be exported/u.test(d.message)),
      `nothing failed to export: ${JSON.stringify(result.diagnostics)}`,
    );
    const notice = result.diagnostics.find((d) => /timekeeping annotation/u.test(d.message));
    assert.ok(notice, 'the lost timing must be reported');
    assert.match(notice.message, /1 data record carries a timekeeping annotation/u);
    assert.match(notice.hint, /No event was lost/u);

    // On the discontinuous twin the existing per-record warning is more specific, and
    // saying both would report one problem twice.
    const other = await convert(fixture('lost-timekeeping-d.edf'), { outputDir: await outDir() });
    const timekeeping = other.diagnostics.filter((d) => /timekeeping/u.test(d.message));
    assert.equal(timekeeping.length, 1, `one message, got ${timekeeping.length}`);
    assert.match(timekeeping[0].message, /carry no readable timekeeping annotation \(record 0\)/u);
  });

  it('says so when a recording claims an origin its own arithmetic cannot hold', async () => {
    // A double spaces its values further apart the larger they get: at 1e16 the gap is two
    // seconds, so `t + 1` is `t`. Honouring the first timekeeping TAL without checking that
    // gave two silent failures.
    //
    // At 1e16 the collapse is partial. "Does this record overlap the window" asks whether
    // `start + recordDuration > windowStart`, and that is false for every record that
    // rounded onto its neighbour: eight of twelve rows vanished, exit 0, no warning, and
    // the file looked exactly like one that had never held them.
    const partial = await outDir();
    const first = await convert(fixture('far-origin.edf'), { outputDir: partial });
    const rows = await readCsv(partial, 'signals.csv');
    assert.equal(rows.length - 1, 12, 'every row is written');

    // At 1e17 every record lands on one instant, so the recording measures zero seconds
    // long, and the window resolver blamed a flag nobody had passed:
    //   error: --start 100000000000000000s is at or past the end of this 1e17s recording.
    const collapsed = await outDir();
    const second = await convert(fixture('far-origin-collapsed.edf'), { outputDir: collapsed });
    assert.equal((await readCsv(collapsed, 'signals.csv')).length - 1, 12);

    for (const result of [first, second]) {
      const warning = result.diagnostics.find((d) => /too far out/u.test(d.message));
      assert.ok(warning, `the lost origin must be reported: ${JSON.stringify(result.diagnostics)}`);
      assert.equal(warning.severity, 'warning');
      assert.match(warning.hint, /written from zero instead/u);
    }

    // Timed from zero, so the column is usable and increases.
    const times = rows.slice(1).map((row) => Number(row.split(',')[0]));
    assert.deepEqual(times.slice(0, 3), [0, 0.25, 0.5]);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'time increases');
  });

  it('reads timekeeping from an annotation channel that has room for it', async () => {
    /*
      EDF+ puts the timekeeping TAL first in the first annotation channel, and that was read
      as `annotationSignals[0]` — the first one declared, whether or not it can hold a byte.
      A channel with zero samples per record leaves a zero-byte slot, so the timekeeping in
      the channel after it went unread: "3 of 3 data records carry no readable timekeeping
      annotation" about three that are perfectly readable, and the file timed from zero.
    */
    const dir = await outDir();
    const result = await convert(fixture('zero-first-annotation.edf'), { outputDir: dir });
    assert.ok(
      !result.diagnostics.some((d) => /no readable timekeeping/u.test(d.message)),
      `they are readable: ${JSON.stringify(result.diagnostics)}`,
    );

    // Records start at 0, 2 and 4, so the times are the file's rather than continuity's.
    const times = (await readCsv(dir, 'signals.csv')).slice(1).map((row) => Number(row.split(',')[0]));
    assert.deepEqual(times.slice(0, 3), [0, 0.25, 0.5]);
    assert.equal(times[4], 2, 'record 1 starts where its timekeeping TAL says, not at 1');

    // And the event in the second channel is still exported.
    const events = await readCsv(dir, 'annotations.csv');
    assert.equal(events.length - 1, 1);
    assert.match(events[1], /^2\.5,,Lights off,1$/u);
  });

  it('checks continuity from a first record at zero, like any other first record', async () => {
    /*
      The EDF+C branch derives an origin from the first record that states one, then compares
      every record against where continuity puts it. It returned early when that origin came
      out as exactly 0 — right about the times, since contiguous starts from zero are what
      timing from zero already produces, and wrong to skip the comparison on the way past.

      So records saying 0, 5, 10 on one-second records went unreported, while the same file
      shifted by a second, saying 1, 6, 11, was reported. The contradiction is in records 1
      and 2 either way.
    */
    // 0, 5, 10 contradicts in records 1 and 2; 0.5, 1.5, 10.5 is contiguous until record 2.
    const cases = [
      ['continuous-liar-from-zero.edf', 2],
      ['continuous-liar.edf', 1],
    ];
    for (const [name, contradicting] of cases) {
      const result = await convert(fixture(name), { outputDir: await outDir() });
      const notice = result.diagnostics.find((d) => /marked continuous \(EDF\+C\)/u.test(d.message));
      assert.ok(notice, `${name}: ${JSON.stringify(result.diagnostics)}`);
      assert.match(
        notice.message,
        new RegExp(`${contradicting} of its 3 data records`, 'u'),
        `${name}: ${notice.message}`,
      );
    }

    // A recording that really is contiguous stays quiet, whatever its records say they are.
    for (const name of ['tiny.edf', 'annotations.edf', 'contiguous-fractional.edf']) {
      const quiet = await convert(fixture(name), { outputDir: await outDir(), quiet: true });
      assert.ok(
        !quiet.diagnostics.some((d) => /marked continuous \(EDF\+C\)/u.test(d.message)),
        `${name} was called a liar`,
      );
    }
  });

  it('reports records that overlap, not only records that reverse', async () => {
    /*
      The check asked whether a record starts before the one before it. Starts of 0, 0.5 and
      1.0 on one-second records are strictly increasing, so it saw nothing — while record 0's
      samples run to 0.75 and record 1 begins at 0.5, so the column steps backwards anyway.
      What makes the time column non-monotonic is a record starting before the previous one
      *ends*, which is a different question and now the one that is asked.
    */
    const dir = await outDir();
    const result = await convert(fixture('records-overlapping.edf'), { outputDir: dir });
    const overlap = result.diagnostics.find((d) => /overlap in time/u.test(d.message));
    assert.ok(overlap, `expected the warning: ${JSON.stringify(result.diagnostics)}`);
    assert.match(overlap.message, /2 data records start before the record before them ends/u);
    assert.match(overlap.hint, /will not increase monotonically/u);

    // The times really do step backwards, which is why it is said.
    const times = (await readCsv(dir, 'signals.csv')).slice(1).map((row) => Number(row.split(',')[0]));
    assert.ok(
      times.some((time, index) => index > 0 && time < times[index - 1]),
      'this fixture exists because the column steps backwards; if it does not it tests nothing',
    );

    // A contiguous recording is not an overlapping one, however its record duration divides.
    for (const name of ['tiny.edf', 'contiguous-fractional.edf', 'discontinuous.edf']) {
      const quiet = await convert(fixture(name), { outputDir: await outDir(), quiet: true });
      assert.ok(
        !quiet.diagnostics.some((d) => /overlap in time/u.test(d.message)),
        `${name} was called overlapping`,
      );
    }
  });

  it('asks the same of an origin the same distance out on the other side of zero', async () => {
    /*
      The guard above took the signed maximum of the record starts and seeded it with 0, so
      an all-negative recording never got past the seed: the check ran on an origin of zero,
      which any interval can carry, and passed. The collapse happened regardless — the
      spacing of doubles grows with magnitude, not with value, so -1e16 defeats a 1-second
      interval exactly as +1e16 does.

      Twelve rows became four, exit 0, nothing said, while the byte-for-byte positive mirror
      wrote all twelve and explained itself. The silent one was the one losing data.
    */
    const dir = await outDir();
    const result = await convert(fixture('far-origin-negative.edf'), { outputDir: dir });
    const rows = await readCsv(dir, 'signals.csv');
    assert.equal(rows.length - 1, 12, 'every row is written');

    const warning = result.diagnostics.find((d) => /too far out/u.test(d.message));
    assert.ok(warning, `the lost origin must be reported: ${JSON.stringify(result.diagnostics)}`);
    assert.match(warning.message, /-100000000000000\d+s from its own start date/u);
    assert.match(warning.hint, /written from zero instead/u);

    const times = rows.slice(1).map((row) => Number(row.split(',')[0]));
    assert.deepEqual(times.slice(0, 3), [0, 0.25, 0.5]);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'time increases');
  });

  it('keeps an origin large enough to be represented', async () => {
    // The guard is on what the arithmetic can express, not on the number being big. At 1e15
    // the gap between doubles is an eighth of a second, so a 4 Hz recording's quarter-second
    // steps survive and the true origin is kept.
    const { deriveRecordStarts } = await import('../dist/convert/timing.js');
    const file = {
      header: { continuity: 'EDF+C', recordDuration: 1, signals: [{ isAnnotations: false, samplesPerRecord: 4 }] },
      recordCount: 3,
      annotationSignals: [{}],
    };
    const kept = deriveRecordStarts(file, { recordStarts: [1e15], malformed: 0 });
    assert.deepEqual([...kept.starts], [1e15, 1e15 + 1, 1e15 + 2]);
    assert.deepEqual(kept.diagnostics, []);

    const dropped = deriveRecordStarts(file, { recordStarts: [1e16], malformed: 0 });
    assert.equal(dropped.starts, null);
    assert.match(dropped.diagnostics[0].message, /too far out/u);
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

    // And it is the hash of the file, not of something that resembles it.
    const { createHash } = await import('node:crypto');
    const expected = createHash('sha256').update(await readFile(fixture('tiny.edf'))).digest('hex');
    assert.equal(withSum.source.sha256, expected);
    assert.equal(withSum.source.bytes, (await stat(fixture('tiny.edf'))).size);
  });

  it('describes the bytes it converted, not whatever is at that path afterwards', async () => {
    // The size, timestamp and checksum came from re-opening the path once the CSVs were
    // written, which describes whatever answers to that name by then. A recording still
    // being written grew from 2,000 records to 3,000 mid-conversion and metadata.json
    // recorded `data_records: 2000` — correct, that is what the CSV holds — beside the byte
    // count and SHA-256 of the 3,000-record file. Two halves of one provenance record
    // describing two different files, with nothing to say so.
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const { copyFileSync } = await import('node:fs');

    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-grow-'));
    temporaries.push(scratch);
    const signals = [{
      label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100,
      digMin: -1000, digMax: 1000, samplesPerRecord: 256, gen: (r, s) => (r + s) % 1000,
    }];
    const small = path.join(scratch, 'small.edf');
    const large = path.join(scratch, 'large.edf');
    const live = path.join(scratch, 'live.edf');
    // Big enough to need more than one read batch, so the swap lands mid-conversion.
    writeEdf({ path: small, numRecords: 2000, recordDuration: 1, signals });
    writeEdf({ path: large, numRecords: 3000, recordDuration: 1, signals });
    copyFileSync(small, live);

    let swapped = false;
    const out = await outDir();
    const result = await convert(live, {
      outputDir: out,
      quiet: true,
      checksum: true,
      onProgress: () => {
        if (swapped) return;
        swapped = true;
        copyFileSync(large, live);
      },
    });

    assert.ok(swapped, 'the input was never replaced, so this proves nothing');
    const written = JSON.parse(await readFile(path.join(out, 'metadata.json'), 'utf8'));
    assert.equal(result.file.recordCount, 2000, 'the conversion saw the smaller file');
    assert.equal(written.recording.data_records, 2000);
    assert.equal(
      written.source.bytes,
      (await stat(small)).size,
      'the byte count must describe the file that was converted',
    );

    // An in-place overwrite keeps the inode, so the bytes that were converted are gone —
    // there is nowhere left to hash them from. A plausible hash of the wrong bytes is worse
    // than none, so none is recorded and the run says why.
    assert.equal(written.source.sha256, null);
    const notice = result.diagnostics.find((d) => d.code === 'INPUT_CHANGED');
    assert.ok(notice, `the change must be reported: ${JSON.stringify(result.diagnostics)}`);
    assert.match(notice.hint, /No checksum was recorded/u);
  });
});
