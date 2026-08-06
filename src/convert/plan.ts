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
import { formatRate, formatRates } from '../edf/header.js';
import { decimalsForSignal } from '../edf/scale.js';
import { listed } from '../format/list.js';
import { timeDecimals } from '../format/number.js';
import { buildColumnNames, renamedByCollision, selectChannels } from './channels.js';
import { assertOptions } from './options.js';
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
  /** The `--start` value exactly as typed, for error messages. */
  startText?: string | undefined;
  duration?: number | undefined;
  end?: number | undefined;
  /** The `--end` value exactly as typed, for error messages. */
  endText?: string | undefined;
  annotationsOnly?: boolean | undefined;
  /** Force a fixed number of decimals instead of deriving it per channel. */
  decimals?: number | undefined;
  /** Compress each CSV with gzip, giving every one of them a `.gz` name. */
  gzip?: boolean | undefined;
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
  // First, and before a directory is created or a stream opened, so a rejected option
  // leaves nothing behind. See assertOptions for what used to get through.
  assertOptions(options);

  const diagnostics: Diagnostic[] = [];
  const columnNames = buildColumnNames(input.signals);

  // A channel whose own label was taken by another channel's disambiguating suffix. The
  // duplicate-label warning is about the labels that collided; this is about the channel
  // that lost its name to them, which is the one whose column no longer matches the file.
  for (const signal of renamedByCollision(input.signals, columnNames)) {
    diagnostics.push({
      code: 'DUPLICATE_LABEL',
      severity: 'warning',
      message:
        `Signal ${signal.index} is labelled "${signal.label}", which is also the column name ` +
        `another channel's "_ch" suffix produces, so its column is "${columnNames.get(signal.index)}".`,
      hint: 'Column names are unique; look this channel up in channels.csv by its signal_index.',
    });
  }

  const range = resolveRange({
    start: options.start,
    startText: options.startText,
    duration: options.duration,
    end: options.end,
    endText: options.endText,
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
          `${listed(matched.map((s) => `#${s.index}`))}); all of them were selected.`,
        hint: `Use --channels "#${matched[0]?.index ?? 0}" to pick just one.`,
      });
    }
  }

  const groups = writeSignals
    ? groupByRate(chosen, columnNames, options.decimals, options.gzip === true)
    : [];
  const estimate = estimateOutput(
    groups,
    range,
    input.recordDuration,
    input.recordStarts,
  );

  /*
    The mixed-rate warning describes what this conversion does, not what the file holds.

    The header parser raises its own, which is right for `parseHeader` — but it sees every
    channel and knows nothing about `--channels`. Converting one channel out of a three-rate
    recording therefore announced "3 different sampling rates ... written to one file per
    rate" over a run that wrote one file, in the same output where `--info` had already
    marked the other two "(not selected)". Selecting two of the three was wrong the other
    way: still "3".

    Callers combining these with a file's own diagnostics drop that copy in favour of this
    one; see `withoutFileRateWarning`.
  */
  if (groups.length > 1) {
    diagnostics.push({
      code: 'MIXED_SAMPLING_RATES',
      severity: 'warning',
      message:
        `Channels use ${groups.length} different sampling rates ` +
        `(${listed(formatRates(groups.map((g) => g.rate)).map((r) => `${r} Hz`))}).`,
      hint: 'They are written to one file per rate so no channel is resampled.',
    });
  }

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
  gzip: boolean,
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

    Naming from the whole set of rates at once removes most of those collisions before the
    suffix has to. Rounding each rate on its own gave 1e-6 Hz and 1.25e-6 Hz the same slug,
    and the numbering below then produced signals_0_000001hz.csv and signals_0_000001hz_2.csv
    — two files that no longer overwrite each other, but of which only one is named for the
    rate it holds. The suffix stays as the backstop for anything this still cannot separate.
  */
  const suffix = gzip ? '.csv.gz' : '.csv';
  const slugs = formatRates(rates).map((text) => `${text.replace('.', '_')}hz`);
  const used = new Set<string>();
  const uniqueName = (index: number): string => {
    const base = `signals_${slugs[index]}`;
    let name = `${base}${suffix}`;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}${suffix}`;
    used.add(name);
    return name;
  };

  return rates.map((rate, index) => {
    const members = byRate.get(rate) ?? [];
    const first = members[0];
    return {
      rate,
      samplesPerRecord: first ? first.samplesPerRecord : 0,
      fileName: single ? `signals${suffix}` : uniqueName(index),
      timeDecimals: timeDecimals(rate),
      channels: members.map((signal) => ({
        signal,
        column: columnNames.get(signal.index) ?? `signal_${signal.index}`,
        decimals: forcedDecimals ?? decimalsForSignal(signal),
      })),
    };
  });
}

/**
 * A file's diagnostics with the header's mixed-rate warning removed.
 *
 * `buildPlan` raises that warning for the channels actually being converted, so keeping both
 * would either duplicate it or contradict it. The header parser's copy stays where it is, for
 * callers reading a header without planning a conversion.
 */
export function withoutFileRateWarning(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.code !== 'MIXED_SAMPLING_RATES');
}

/** `256hz`, `12_5hz` — safe in a filename on every platform. */
export function rateSlug(rate: number): string {
  return `${formatRate(rate).replace('.', '_')}hz`;
}

/** Characters a fixed-decimal number of this magnitude occupies, sign included. */
function widthOf(magnitude: number, decimals: number, signed = false): number {
  const size = Math.abs(magnitude);
  const sign = signed ? 1 : 0;
  const fraction = decimals > 0 ? 1 + decimals : 0;

  /*
    Cells are written with toFixed, which rounds. Taking the integer digits from the floor of
    the bound therefore under-counted whenever rounding carried into a new digit: a channel
    bounded at 9999.999 and written to zero decimals produces "10000", five characters where
    the floor of 9999.999 suggests four. Every cell on such a channel was a byte short, and
    `--info` reported 127 KB for a file that came out 131 KB.

    Measuring the bound as rendered removes that. toFixed switches to exponential notation
    past 1e21, so the arithmetic form still covers magnitudes beyond it.
  */
  if (!Number.isFinite(size)) return sign + 1 + fraction;
  if (size < 1e21) return sign + size.toFixed(Math.min(decimals, 100)).length;
  return sign + (Math.floor(Math.log10(size)) + 1) + fraction;
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

    /*
      Width per cell, from the channel's own calibration rather than a flat allowance.

      The old `decimals + 6` budgeted six characters for the sign, integer part and decimal
      point on every channel, whatever it actually held. That over-counted a millivolt
      channel spanning ±5 by four characters a cell and ran 30-55% high across the fixture
      set — on a number people use to decide whether a conversion is worth starting.

      The channel's declared physical range is what bounds a cell, so that bound is what is
      used. Most samples sit below it, so this still reads high, which is the direction a
      size estimate should err in.

      One case is outside the bound rather than under it: nothing obliges a recording to keep
      its samples inside the digital range it declares, and one that does not maps outside the
      physical range too. Such a file can convert larger than the estimate. Clamping the data
      to make the estimate true is not a trade worth making — the samples are what they are.
    */
    const timeWidth = widthOf(range.endSeconds, group.timeDecimals);
    const cellWidth = group.channels.reduce(
      (sum, c) =>
        sum +
        widthOf(
          Math.max(Math.abs(c.signal.physicalMin), Math.abs(c.signal.physicalMax)),
          c.decimals,
          c.signal.physicalMin < 0 || c.signal.physicalMax < 0,
        ),
      0,
    );
    // One comma per channel, plus the newline.
    bytes += groupRows * (timeWidth + cellWidth + group.channels.length + 1);
    // The header row: the column names, their commas and a newline.
    bytes += 'time_s'.length + group.channels.reduce((n, c) => n + c.column.length + 1, 0) + 1;
  }

  return { rows, bytes, exceedsSpreadsheetLimit: exceeds };
}
