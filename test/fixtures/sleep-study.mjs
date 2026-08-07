/**
 * The recording the website is written about.
 *
 * Every terminal block and CSV sample on the landing page is real output, captured from the
 * tool running against this file. That was a claim held in a comment: the recipe was written
 * out in prose, and whoever next changed a number was trusted to rebuild the recording and
 * check. The page drifted twice anyway — a row figure in 0.4.67, a timezone suffix in 0.4.68
 * — so the recipe lives here instead, where a test can run it.
 *
 * It is not a test fixture in the `generated/` sense: nothing asserts against its samples,
 * and at 19 MB it is built into a temporary directory and thrown away. What it is for is
 * making the page's output reproducible on demand.
 */

import { buildTal, writeEdf } from './edf-writer.mjs';

const UV = { dimension: 'uV', physMin: -250, physMax: 250, digMin: -2048, digMax: 2047 };

/** Events by the record they are stored in, which for these is the record they start in. */
const EVENTS = new Map([
  [0, [{ onset: 0, duration: 1800, text: 'Sleep stage W' }]],
  [1800, [{ onset: 1800, duration: 2700, text: 'Sleep stage N1' }]],
  [4500, [{ onset: 4500, duration: 7200, text: 'Sleep stage N2' }]],
  [11700, [{ onset: 11700, duration: 3600, text: 'Sleep stage N3' }]],
  [15300, [{ onset: 15300, duration: 5400, text: 'Sleep stage R' }]],
  [20700, [{ onset: 20700, duration: 8100, text: 'Sleep stage N2' }]],
  [28740, [{ onset: 28740, duration: 60, text: 'Sleep stage W' }]],
]);

/**
 * Eight hours of sleep recording: three EEG/EOG channels at 100 Hz, respiration at 10 Hz,
 * body temperature at 1 Hz, and an EDF+ annotation channel. Started 2 March 2002, 23:10.
 *
 * The generators are arithmetic rather than physiological. What the page shows of them is
 * the first few rows of each table, and what those rows demonstrate is the format — column
 * names, decimal places, one file per rate — not the shape of a sleep spindle.
 */
export function writeSleepStudy(path) {
  writeEdf({
    path,
    /*
      Sleep staging, as a sleep study carries it. The first half hour awake, then the night
      in stages, which is what the landing page's annotations.csv sample shows — and did not
      show truthfully until 0.4.77, when the recording had an annotation channel and no
      events at all in it.
    */
    talsForRecord: (record) => buildTal(record, EVENTS.get(record) ?? []),
    reserved: 'EDF+C',
    patient: 'X X X X',
    recording: 'Startdate 02-MAR-2002 X X X',
    startDate: '02.03.02',
    startTime: '23.10.00',
    numRecords: 28800,
    recordDuration: 1,
    signals: [
      { label: 'EEG Fpz-Cz', ...UV, samplesPerRecord: 100, gen: (r, s) => (r * 7 + s * 13) % 2048 },
      { label: 'EEG Pz-Oz', ...UV, samplesPerRecord: 100, gen: (r, s) => (r * 5 + s * 11) % 2048 },
      { label: 'EOG horizontal', ...UV, samplesPerRecord: 100, gen: (r, s) => (r * 3 + s * 7) % 2048 },
      {
        label: 'Resp oro-nasal',
        dimension: 'V',
        physMin: -1,
        physMax: 1,
        digMin: -2048,
        digMax: 2047,
        samplesPerRecord: 10,
        gen: (r, s) => (r + s) % 2048,
      },
      {
        label: 'Temp rectal',
        dimension: 'degC',
        physMin: 34,
        physMax: 40,
        digMin: -2048,
        digMax: 2047,
        samplesPerRecord: 1,
        gen: (r) => r % 2048,
      },
      {
        label: 'EDF Annotations',
        dimension: '',
        physMin: -1,
        physMax: 1,
        digMin: -32768,
        digMax: 32767,
        samplesPerRecord: 30,
        annotations: true,
      },
    ],
  });
  return path;
}
