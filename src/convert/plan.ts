/**
 * Turning a request into a concrete conversion plan.
 *
 * The plan is where the tool's central promise is enforced: channels recorded at
 * different sampling rates are never merged into one table. A single wide CSV can
 * only hold mixed rates by inventing samples for the slow channels — MNE, for
 * instance, expands three genuine 1 Hz temperature readings into 768 interpolated
 * values without warning. Instead each distinct rate gets its own file, so every
 * number in every output file is a number that was actually recorded.
 */

import type { Diagnostic } from '../edf/errors.js';
import type { EdfSignal } from '../edf/header.js';
import { formatRate } from '../edf/header.js';
import { decimalsForSignal } from '../edf/scale.js';
import { timeDecimals } from '../format/number.js';
import { buildColumnNames, selectChannels } from './channels.js';
import { countSamplesInRange, resolveRange } from './time-range.js';
import type { ResolvedRange } from './time-range.js';

export interface PlannedChannel {
  signal: EdfSignal;
  column: string;
  decimals: number;
}

export interface RateGroup {
  /** Sampling rate in Hz shared by every channel in this group. */
  rate: number;
  samplesPerRecord: number;
  fileName: string;
  timeDecimals: number;
  channels: PlannedChannel[];
}

export interface PlanInput {
  signals: readonly EdfSignal[];
  recordDuration: number;
  recordCount: number;
  hasAnnotationChannel: boolean;
  /**
   * True start time of each data record, supplied for discontinuous files. The
   * requested time window is resolved against these rather than against
   * `recordCount * recordDuration`, which for a file with gaps is the amount of
   * data rather than the span of time it covers.
   */
  recordStarts?: Float64Array | null | undefined;
}

export interface PlanOptions {
  channels?: readonly string[] | undefined;
  start?: number | undefined;
  duration?: number | undefined;
  end?: number | undefined;
  annotationsOnly?: boolean | undefined;
  /** Force a fixed number of decimals instead of deriving it per channel. */
  decimals?: number | undefined;
}

export interface ConversionPlan {
  groups: RateGroup[];
  range: ResolvedRange;
  columnNames: Map<number, string>;
  writeSignals: boolean;
  diagnostics: Diagnostic[];
  estimate: OutputEstimate;
}

export interface OutputEstimate {
  /** Total data rows across every signal file. */
  rows: number;
  /** Approximate size of the signal CSVs on disk. */
  bytes: number;
  /** True when any single file would exceed Excel's row limit. */
  exceedsSpreadsheetLimit: boolean;
}

/** Excel and most spreadsheet tools stop at 1,048,576 rows including the header. */
export const SPREADSHEET_ROW_LIMIT = 1_048_576;

export function buildPlan(input: PlanInput, options: PlanOptions = {}): ConversionPlan {
  const diagnostics: Diagnostic[] = [];
  const columnNames = buildColumnNames(input.signals);

  const range = resolveRange({
    start: options.start,
    duration: options.duration,
    end: options.end,
    recordDuration: input.recordDuration,
    recordCount: input.recordCount,
    recordStarts: input.recordStarts,
  });

  const writeSignals = options.annotationsOnly !== true;

  let chosen: EdfSignal[] = input.signals.filter((s) => !s.isAnnotations);

  /*
    Channel names are checked even under --annotations-only, where the selection is not
    otherwise used.

    Skipping the check meant `--channels TYPO --annotations-only` exited 0 in silence while
    the same typo without the flag was a usage error, and `--channels ""` stayed an error
    in both — so a mistyped name was the one form of bad input the tool accepted quietly.
    Everywhere else a term matching nothing is reported rather than ignored; a flag that
    happens not to apply is a poor reason to make an exception.
  */
  if (options.channels && options.channels.length > 0) {
    const selection = selectChannels(input.signals, options.channels);
    if (writeSignals) chosen = selection.signals;
    for (const { term, matched } of selection.ambiguous) {
      diagnostics.push({
        code: 'DUPLICATE_LABEL',
        severity: 'warning',
        message:
          `"${term}" matches ${matched.length} channels (positions ` +
          `${matched.map((s) => `#${s.index}`).join(', ')}); all of them were selected.`,
        hint: `Use --channels "#${matched[0]?.index ?? 0}" to pick just one.`,
      });
    }
  }

  const groups = writeSignals ? groupByRate(chosen, columnNames, options.decimals) : [];
  const estimate = estimateOutput(
    groups,
    range,
    input.recordDuration,
    input.recordStarts,
  );

  if (estimate.exceedsSpreadsheetLimit) {
    diagnostics.push({
      code: 'LARGE_OUTPUT',
      severity: 'warning',
      message:
        `At least one output file will have more than ${SPREADSHEET_ROW_LIMIT.toLocaleString('en-US')} ` +
        `rows, which is more than Excel or Numbers can open.`,
      hint: 'Use --start and --duration to convert a section, or read the file with pandas or R.',
    });
  }

  return { groups, range, columnNames, writeSignals, diagnostics, estimate };
}

/**
 * Partition channels by sampling rate, largest first.
 *
 * The common case — every channel at one rate — collapses to a single group and a
 * single `signals.csv`, so the honest behaviour costs nothing when there is nothing
 * to be honest about.
 */
function groupByRate(
  signals: readonly EdfSignal[],
  columnNames: Map<number, string>,
  forcedDecimals: number | undefined,
): RateGroup[] {
  const byRate = new Map<number, EdfSignal[]>();
  for (const signal of signals) {
    // A channel with no samples has no sampling rate to group by, and would
    // otherwise produce an empty "0hz" file. The header parser already warned.
    if (signal.samplesPerRecord === 0) continue;
    const bucket = byRate.get(signal.samplingRate);
    if (bucket) bucket.push(signal);
    else byRate.set(signal.samplingRate, [signal]);
  }

  const rates = [...byRate.keys()].sort((a, b) => b - a);
  const single = rates.length === 1;

  /*
    Two distinct rates can produce the same slug, because the slug rounds to six decimal
    places. Rates come from samplesPerRecord / recordDuration and every channel shares the
    record duration, so the closest two rates can be is 1 / recordDuration — which drops
    below 1e-6 once a record is longer than about eleven days. Absurd, but the header
    permits it, and the failure was silent and destructive: both groups opened a write
    stream on the same path, so the file ended up holding interleaved rows from both
    channels under a header naming only one of them.

    Distinct rates therefore get distinct files, always. The suffix is only ever reached by
    a collision, so ordinary recordings keep the names they have always had.
  */
  const used = new Set<string>();
  const uniqueName = (rate: number): string => {
    const base = `signals_${rateSlug(rate)}`;
    let name = `${base}.csv`;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}.csv`;
    used.add(name);
    return name;
  };

  return rates.map((rate) => {
    const members = byRate.get(rate) ?? [];
    const first = members[0];
    return {
      rate,
      samplesPerRecord: first ? first.samplesPerRecord : 0,
      fileName: single ? 'signals.csv' : uniqueName(rate),
      timeDecimals: timeDecimals(rate),
      channels: members.map((signal) => ({
        signal,
        column: columnNames.get(signal.index) ?? `signal_${signal.index}`,
        decimals: forcedDecimals ?? decimalsForSignal(signal),
      })),
    };
  });
}

/** `256hz`, `12_5hz` — safe in a filename on every platform. */
export function rateSlug(rate: number): string {
  return `${formatRate(rate).replace('.', '_')}hz`;
}

function estimateOutput(
  groups: readonly RateGroup[],
  range: ResolvedRange,
  recordDuration: number,
  recordStarts: Float64Array | null | undefined,
): OutputEstimate {
  let rows = 0;
  let bytes = 0;
  let exceeds = false;

  for (const group of groups) {
    let groupRows = 0;
    for (let record = range.startRecord; record < range.endRecord; record++) {
      const recordStart = recordStarts
        ? (recordStarts[record] ?? record * recordDuration)
        : record * recordDuration;
      groupRows += countSamplesInRange({
        recordStart,
        rate: group.rate,
        samplesPerRecord: group.samplesPerRecord,
        startSeconds: range.startSeconds,
        endSeconds: range.endSeconds,
      });
    }
    rows += groupRows;
    if (groupRows + 1 > SPREADSHEET_ROW_LIMIT) exceeds = true;

    // A cell is roughly the sign, a few integer digits, the point and its decimals.
    const timeWidth = group.timeDecimals + 6;
    const cellWidth = group.channels.reduce((sum, c) => sum + c.decimals + 6, 0);
    bytes += groupRows * (timeWidth + cellWidth + 1);
  }

  return { rows, bytes, exceedsSpreadsheetLimit: exceeds };
}
