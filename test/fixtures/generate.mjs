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
