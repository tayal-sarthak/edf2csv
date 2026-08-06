/**
 * Generates the EDF fixtures the test suite runs against.
 *
 * Each file targets a specific thing that real recordings do and naive readers get
 * wrong. Run with `npm run fixtures`; the output directory is gitignored because it
 * is fully reproducible from this file.
 */

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTal, writeEdf } from './edf-writer.mjs';

export const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'generated');

/** Digital value equals the global sample index, so expected output is trivial to state. */
const ramp = (perRecord) => (record, sample) => record * perRecord + sample;
const sine = (perRecord, hz) => (record, sample) =>
  Math.round(1000 * Math.sin(2 * Math.PI * hz * (record + sample / perRecord)));

const uv = { dimension: 'uV', physMin: -250, physMax: 250, digMin: -2048, digMax: 2047 };

export function generate() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const at = (name) => path.join(OUT_DIR, name);

  // Two channels, 10 Hz, two records. Small enough to assert every value by hand.
  writeEdf({
    path: at('tiny.edf'),
    numRecords: 2,
    recordDuration: 1,
    startDate: '05.06.09',
    startTime: '12.34.56',
    signals: [
      { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 10, gen: ramp(10) },
      { label: 'ch2', dimension: 'mV', physMin: -1, physMax: 1, digMin: -1000, digMax: 1000, samplesPerRecord: 10, gen: (r, i) => -(r * 10 + i) },
    ],
  });

  // Three sampling rates in one file — the case that must never be merged.
  writeEdf({
    path: at('mixed-rates.edf'),
    numRecords: 3,
    recordDuration: 1,
    signals: [
      { label: 'EEG Fpz-Cz', ...uv, samplesPerRecord: 256, gen: sine(256, 3) },
      { label: 'ECG', dimension: 'mV', physMin: -5, physMax: 5, digMin: -2048, digMax: 2047, samplesPerRecord: 128, gen: sine(128, 1) },
      { label: 'Temp rectal', dimension: 'degC', physMin: 34, physMax: 40, digMin: -2048, digMax: 2047, samplesPerRecord: 1, gen: (r) => 100 * r },
    ],
  });

  // EDF+C with annotations that have a duration, lack a duration, and sit mid-record.
  const annotations = [
    { onset: 0.5, duration: 1, text: 'Sleep stage W' },
    { onset: 1.25, duration: null, text: 'Lights off' },
    { onset: 2, duration: 0.5, text: 'Seizure onset' },
  ];
  writeEdf({
    path: at('annotations.edf'),
    reserved: 'EDF+C',
    patient: 'MCH-0234567 F 02-MAY-1951 Haagse_Harry',
    recording: 'Startdate 02-MAR-2002 PSG-1234/2002 NN Telemetry03',
    // EDF+ requires the header start date to agree with the recording field's Startdate.
    startDate: '02.03.02',
    startTime: '22.15.00',
    numRecords: 3,
    recordDuration: 1,
    signals: [
      { label: 'EEG Fpz-Cz', ...uv, samplesPerRecord: 100, gen: sine(100, 2) },
      { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768, digMax: 32767, samplesPerRecord: 30, annotations: true },
    ],
    // Each annotation is stored in the record its onset falls inside, after that
    // record's mandatory timekeeping TAL.
    talsForRecord: (record) =>
      buildTal(
        record,
        annotations.filter((a) => a.onset >= record && a.onset < record + 1),
      ),
  });

  // EDF+D: records sit at 0 s, 1 s and 10 s, leaving a nine-second gap.
  writeEdf({
    path: at('discontinuous.edf'),
    reserved: 'EDF+D',
    numRecords: 3,
    recordDuration: 1,
    signals: [
      { label: 'EEG Fpz-Cz', ...uv, samplesPerRecord: 10, gen: ramp(10) },
      { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768, digMax: 32767, samplesPerRecord: 20, annotations: true },
    ],
    talsForRecord: (record) => buildTal([0, 1, 10][record]),
  });

  // The two degenerate calibrations side by side, because they must NOT behave the same.
  //
  //   flat      digitalMin === digitalMax. The header gives one calibration point twice, so
  //             there is no mapping and no physical value: written as empty cells.
  //   flatphys  physicalMin === physicalMax over a valid digital range. The mapping exists and
  //             is simply flat, so every code legitimately means 5 uV: written as a number.
  //
  // Keeping both in one file means one converted CSV shows the distinction directly.
  writeEdf({
    path: at('degenerate-range.edf'),
    numRecords: 1,
    recordDuration: 1,
    signals: [
      { label: 'flat', dimension: 'uV', physMin: 0, physMax: 0, digMin: 0, digMax: 0, samplesPerRecord: 4, gen: () => 0 },
      { label: 'flatphys', dimension: 'uV', physMin: 5, physMax: 5, digMin: -100, digMax: 100, samplesPerRecord: 4, gen: ramp(4) },
      { label: 'ok', dimension: 'uV', physMin: -10, physMax: 10, digMin: -100, digMax: 100, samplesPerRecord: 4, gen: ramp(4) },
    ],
  });

  // One real rate alongside a channel carrying no samples.
  //
  // A 0-sample channel has a nominal rate of 0 Hz, but no file is written for it and it is
  // already reported as NO_SAMPLES. Counting that 0 Hz as a rate made this single-rate file
  // warn that it used "2 different sampling rates (4 Hz, 0 Hz)".
  writeEdf({
    path: at('single-rate-empty-channel.edf'),
    numRecords: 2,
    recordDuration: 1,
    signals: [
      { label: 'real', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 4, gen: (r, s) => r * 4 + s },
      { label: 'unused', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 0, gen: () => 0 },
    ],
  });

  // Events sitting on and past the end of the recorded span.
  //
  // EDF+ does not oblige an annotation's onset to fall inside the data. A marker for the
  // end of a recording sits at exactly `duration`, and the window for a whole-file
  // conversion is [0, duration) — so filtering by it dropped those events with no time
  // option given and no way to ask for them back.
  const edgeSignal = { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 4, gen: (r, s) => r * 4 + s };
  const edgeAnnotations = { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768, digMax: 32767, samplesPerRecord: 60, annotations: true };
  writeEdf({
    path: at('annotations-at-edges.edf'),
    reserved: 'EDF+C',
    numRecords: 3,
    recordDuration: 1,
    signals: [edgeSignal, edgeAnnotations],
    talsForRecord: (r) =>
      buildTal(
        r,
        r === 2
          ? [
              { onset: 2.5, duration: null, text: 'inside' },
              { onset: 3, duration: null, text: 'at the end' },
              { onset: 3.5, duration: null, text: 'past the end' },
            ]
          : [],
      ),
  });

  // A record whose timekeeping TAL cannot be decoded, followed by a real event.
  //
  // The timekeeping TAL is the one in first position. Treating the first TAL that happened
  // to PARSE as the timekeeping one let this record's start time become 1.5 — the onset of
  // an ordinary annotation — shifting every sample in the record by half a second.
  writeEdf({
    path: at('annotations-bad-timekeeping.edf'),
    reserved: 'EDF+D',
    numRecords: 2,
    recordDuration: 1,
    signals: [edgeSignal, edgeAnnotations],
    talsForRecord: (r) =>
      r === 1
        ? `XX\x14\x00+1.5\x14event\x14\x00` // first TAL lacks the mandatory signed onset
        : buildTal(r),
  });

  // A continuous recording whose first record starts half a second after the header time.
  //
  // EDF+ puts the header start time and every annotation onset on one origin, and the first
  // record's timekeeping TAL states the fraction of a second by which that record follows
  // it. Timing the samples from zero instead put the two on origins half a second apart: the
  // event at +0.75 landed on sample 3 rather than sample 1. Written twice, continuous and
  // discontinuous, because the pair must agree — they differ only in the reserved field.
  const fractionalStart = {
    startDate: '02.03.02',
    startTime: '22.15.00',
    patient: 'X X X X',
    recording: 'Startdate 02-MAR-2002 X X X',
    numRecords: 3,
    recordDuration: 1,
    signals: [
      { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 4, gen: (r, s) => r * 4 + s },
      { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768, digMax: 32767, samplesPerRecord: 60, annotations: true },
    ],
    talsForRecord: (r) =>
      buildTal([0.5, 1.5, 2.5][r], r === 0 ? [{ onset: 0.75, duration: null, text: 'event' }] : []),
  };
  writeEdf({ ...fractionalStart, path: at('fractional-start.edf'), reserved: 'EDF+C' });
  writeEdf({ ...fractionalStart, path: at('fractional-start-d.edf'), reserved: 'EDF+D' });

  // An EDF+D recording whose first record sits well after zero.
  //
  // --duration is measured from where the conversion starts, and the annotation filter
  // anchored it at 0 instead. Signals came from [30, 35) while annotations were filtered
  // against (-inf, 5) — disjoint windows, so every event inside the converted span was
  // dropped and annotations.csv came back holding only its header.
  writeEdf({
    path: at('late-start.edf'),
    reserved: 'EDF+D',
    startDate: '02.03.02',
    startTime: '22.15.00',
    patient: 'X X X X',
    recording: 'Startdate 02-MAR-2002 X X X',
    numRecords: 3,
    recordDuration: 1,
    signals: [
      { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 4, gen: (r, s) => r * 4 + s },
      { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768, digMax: 32767, samplesPerRecord: 60, annotations: true },
    ],
    talsForRecord: (r) =>
      buildTal([30, 31, 32][r], r === 0 ? [{ onset: 30.5, duration: null, text: 'inside the window' }] : []),
  });

  // Enough channels that any message listing them all becomes unreadable.
  //
  // The header decides how many channels a file has, so any message that enumerates them is
  // as long as the file says. At 40 rates the mixed-rate warning ran past 300 characters on
  // one line; a real file with 200 auxiliary channels produced 1,545.
  writeEdf({
    path: at('many-rates.edf'),
    numRecords: 1,
    recordDuration: 1,
    signals: Array.from({ length: 40 }, (_, i) => ({
      label: `ch${i + 1}`, dimension: 'uV', physMin: -100, physMax: 100,
      digMin: -1000, digMax: 1000, samplesPerRecord: i + 1, gen: (r, s) => (r + s) % 1000,
    })),
  });

  // Two rates that survive the exponent fallback but collide at six decimals.
  //
  // 4 and 5 samples in a 4,000,000-second record are 1e-6 Hz and 1.25e-6 Hz. Both are above
  // the threshold where a rate is shown in exponent form, and both round to "0.000001" — so
  // the warning said the file used "2 different sampling rates (0.000001 Hz, 0.000001 Hz)".
  writeEdf({
    path: at('rate-decimal-collision.edf'),
    numRecords: 2,
    recordDuration: 4000000,
    signals: [
      { label: 'slow', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 4, gen: (r, s) => r * 4 + s },
      { label: 'slower', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 5, gen: (r, s) => r * 5 + s },
    ],
  });

  // A bound that gains a digit when it is rounded for output.
  //
  // physicalMax is 999.9999 and the channel is written to two decimals, so the top code
  // renders as "1000.00" — seven characters where flooring the bound suggests six. The
  // estimate took its integer digits from the floor and came out under the real file. An
  // unsigned channel is where it shows: a signed one has a sign allowance on every cell,
  // and the positive half of the samples never spends it.
  //
  // Five records, not ten. The time column is budgeted from the exclusive end of the range,
  // so a recording ending at 10 s reserves room for "10" but never writes past "9.950" — a
  // spare character per row that cancelled the shortfall exactly and hid it. Ending at 5 s
  // spends the whole budget, so the missing character in the value column is visible.
  writeEdf({
    path: at('rounding-bound.edf'),
    numRecords: 5,
    recordDuration: 1,
    signals: [
      { label: 'unsigned', dimension: 'uV', physMin: 0, physMax: 999.9999, digMin: 0, digMax: 100, samplesPerRecord: 20, gen: () => 100 },
    ],
  });

  // Record starts past 1e21, where JavaScript stops writing numbers as digits.
  //
  // EDF's record-duration field is 8 characters and exponent form fits, so `1e21` is a
  // legal thing for a header to say. Three records is then enough to reach the point where
  // `String(n)` switches to exponent notation.
  writeEdf({
    path: at('exponent-time.edf'),
    numRecords: 3,
    recordDuration: 1e21,
    signals: [
      { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 4, gen: (r, s) => r * 4 + s },
    ],
  });

  // Output larger than a pipe buffer, so a reader hanging up mid-stream is reachable.
  //
  // The --stdout tests could not express the EPIPE case with the small fixtures: 434 bytes
  // of CSV fits in the pipe buffer, every write lands, and no hang-up ever happens. This
  // one converts to about 2 MB.
  writeEdf({
    path: at('long-stream.edf'),
    numRecords: 400,
    recordDuration: 1,
    signals: [
      { label: 'EEG', dimension: 'uV', physMin: -250, physMax: 250, digMin: -2048, digMax: 2047, samplesPerRecord: 256, gen: (r, s) => (r * 7 + s) % 2048 },
    ],
  });

  // Two rates that round to the same filename slug.
  //
  // A rate is samplesPerRecord / recordDuration, and every channel shares the record
  // duration, so two rates can be no closer than 1 / recordDuration. Past about eleven
  // days per record that gap falls under the slug's six decimal places and both channels
  // want the same "signals_0hz.csv". Absurd, legal, and it used to corrupt the output:
  // both groups wrote to one path and the rows interleaved under a single channel header.
  writeEdf({
    path: at('rate-slug-collision.edf'),
    numRecords: 2,
    recordDuration: 1e7,
    signals: [
      { label: 'slowA', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 1, gen: (r) => 100 * (r + 1) },
      { label: 'slowB', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 2, gen: (r, i) => -50 * (r + i + 1) },
    ],
  });

  // Header claims ten records; only four were written before the recording stopped.
  writeEdf({
    path: at('truncated.edf'),
    numRecords: 10,
    truncateRecords: 4,
    recordDuration: 1,
    signals: [
      { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 5, gen: ramp(5) },
    ],
  });

  // Record count of -1, which the spec allows for a recording still in progress.
  writeEdf({
    path: at('unknown-records.edf'),
    numRecords: 4,
    declaredRecords: -1,
    recordDuration: 1,
    signals: [
      { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 5, gen: ramp(5) },
    ],
  });

  // Fractional record duration: 25 samples per 0.1 s record is 250 Hz.
  writeEdf({
    path: at('fractional-recdur.edf'),
    numRecords: 20,
    recordDuration: 0.1,
    signals: [
      { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 25, gen: ramp(25) },
    ],
  });

  // Duplicate labels, an empty-ish label, and an inverted physical range — all seen
  // in CHB-MIT and similar public datasets.
  writeEdf({
    path: at('quirky-labels.edf'),
    numRecords: 1,
    recordDuration: 1,
    signals: [
      { label: 'T8-P8', dimension: 'uV', physMin: -800, physMax: 800, digMin: -2048, digMax: 2047, samplesPerRecord: 4, gen: ramp(4) },
      { label: 'T8-P8', dimension: 'uV', physMin: -800, physMax: 800, digMin: -2048, digMax: 2047, samplesPerRecord: 4, gen: (r, i) => -(r * 4 + i) },
      { label: '-', dimension: '', physMin: -1, physMax: 1, digMin: -1, digMax: 1, samplesPerRecord: 4, gen: () => 0 },
      { label: 'inverted', dimension: 'uV', physMin: 100, physMax: -100, digMin: -1000, digMax: 1000, samplesPerRecord: 4, gen: ramp(4) },
    ],
  });

  // Every annotation crammed into the first record, with onsets spread across the
  // recording. Nothing in the spec obliges a writer to store an event in the record
  // its onset falls in, and some tools really do this.
  writeEdf({
    path: at('annotations-front-loaded.edf'),
    reserved: 'EDF+C',
    numRecords: 10,
    recordDuration: 1,
    signals: [
      { label: 'sig', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000, digMax: 1000, samplesPerRecord: 4, gen: ramp(4) },
      { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768, digMax: 32767, samplesPerRecord: 40, annotations: true },
    ],
    talsForRecord: (record) =>
      record === 0
        ? buildTal(0, [
            { onset: 0.5, duration: null, text: 'early' },
            { onset: 5.5, duration: null, text: 'middle' },
            { onset: 8.5, duration: null, text: 'late' },
          ])
        : buildTal(record),
  });

  // BDF: BioSemi's 24-bit variant. Same layout, 3-byte samples, wider digital range.
  writeEdf({
    path: at('biosemi.bdf'),
    bdf: true,
    reserved: '24BIT',
    numRecords: 2,
    recordDuration: 1,
    signals: [
      { label: 'A1', dimension: 'uV', physMin: -262144, physMax: 262144, digMin: -8388608, digMax: 8388607, samplesPerRecord: 8, gen: ramp(8) },
      // Values only a 24-bit range can hold, to prove the wider samples survive.
      { label: 'A2', dimension: 'uV', physMin: -262144, physMax: 262144, digMin: -8388608, digMax: 8388607, samplesPerRecord: 8, gen: (r, i) => (r * 8 + i) * -1000000 },
    ],
  });

  // BDF+D: BioSemi's discontinuous variant, which spells its markers "BDF+D" and
  // "BDF Annotations" rather than the EDF+ equivalents.
  writeEdf({
    path: at('biosemi-plus.bdf'),
    bdf: true,
    reserved: 'BDF+D',
    numRecords: 3,
    recordDuration: 1,
    signals: [
      { label: 'A1', dimension: 'uV', physMin: -262144, physMax: 262144, digMin: -8388608, digMax: 8388607, samplesPerRecord: 4, gen: ramp(4) },
      { label: 'BDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -8388608, digMax: 8388607, samplesPerRecord: 16, annotations: true },
    ],
    talsForRecord: (record) =>
      buildTal([0, 1, 20][record], record === 1 ? [{ onset: 1.5, duration: 0.25, text: 'Blink' }] : []),
  });

  // A file whose only content is annotations.
  writeEdf({
    path: at('annotations-only.edf'),
    reserved: 'EDF+C',
    numRecords: 2,
    recordDuration: 1,
    signals: [
      { label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1, digMin: -32768, digMax: 32767, samplesPerRecord: 30, annotations: true },
    ],
    talsForRecord: (record) =>
      buildTal(record, record === 0 ? [{ onset: 0.25, duration: null, text: 'Start' }] : []),
  });

  return OUT_DIR;
}

generate();
