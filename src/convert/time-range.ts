/**
 * Parsing for the time-range options.
 *
 * Researchers write offsets in whatever form is natural for the recording in front
 * of them: seconds for a short ECG strip, `30m` into a sleep study, `01:23:45` when
 * reading off a clock. All three are accepted; anything ambiguous is rejected with
 * a message that shows the forms that work.
 */

import { formatDuration } from '../format/number.js';

export class TimeRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeRangeError';
  }
}

const UNIT_SECONDS: Record<string, number> = {
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  ms: 0.001,
};

const CLOCK = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/u;
const UNIT_TOKEN = /(\d+(?:\.\d+)?)\s*([a-z]+)/giu;

/**
 * Parse a duration or offset into seconds.
 *
 * Accepted: `90`, `90s`, `5m`, `1h30m`, `1h 30m 15s`, `00:30:00`, `30:00`, `250ms`.
 */
export function parseTimeSpec(input: string, optionName: string): number {
  const text = input.trim().toLowerCase();
  if (text === '') {
    throw new TimeRangeError(`${optionName} is empty. Try a value like 30s, 5m, or 00:30:00.`);
  }

  // Bare number means seconds.
  if (/^\d+(?:\.\d+)?$/u.test(text)) return assertFinite(Number(text), optionName, input);

  // Clock form: hh:mm:ss or mm:ss.
  const clock = CLOCK.exec(text);
  if (clock) {
    const hours = clock[1] === undefined ? 0 : Number(clock[1]);
    const minutes = Number(clock[2]);
    const seconds = Number(clock[3]);
    if (minutes >= 60 || seconds >= 60) {
      throw new TimeRangeError(
        `${optionName} "${input}" has a minutes or seconds field of 60 or more.`,
      );
    }
    return assertFinite(hours * 3600 + minutes * 60 + seconds, optionName, input);
  }

  // Unit form: 1h30m, 5 min, 250ms.
  UNIT_TOKEN.lastIndex = 0;
  let total = 0;
  let matched = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  // Which units have already been seen, so a repeat can be rejected rather than added.
  const seen = new Set<number>();
  while ((match = UNIT_TOKEN.exec(text)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2] ?? '';
    const scale = UNIT_SECONDS[unit];
    if (scale === undefined) {
      throw new TimeRangeError(
        `${optionName} "${input}" uses an unknown unit "${unit}". Use h, m, s, or ms.`,
      );
    }

    // "1h1h" is a typo, not a request for two hours. Summing repeated units silently
    // turned a slip into a plausible window that was quietly the wrong length. Units are
    // keyed by their scale so the aliases collapse together: "1h30min20m" is caught too.
    if (seen.has(scale)) {
      throw new TimeRangeError(
        `${optionName} "${input}" gives the same unit twice. ` +
          `Combine each unit once, as in 1h30m.`,
      );
    }
    seen.add(scale);

    total += amount * scale;
    matched++;
    consumed += match[0].length;
  }

  // Reject partially-understood input like "5x" or "1h banana".
  if (matched === 0 || consumed !== text.replace(/\s+/gu, '').length) {
    throw new TimeRangeError(
      `${optionName} "${input}" is not a time I understand. ` +
        `Try 30s, 5m, 1h30m, 00:30:00, or a plain number of seconds.`,
    );
  }

  return assertFinite(total, optionName, input);
}

function assertFinite(value: number, optionName: string, input: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TimeRangeError(`${optionName} "${input}" is not a valid non-negative time.`);
  }
  return value;
}

export interface ResolvedRange {
  /** Inclusive start, in seconds from the beginning of the recording. */
  startSeconds: number;
  /** Exclusive end, in seconds. */
  endSeconds: number;
  /** First data record touching the window. */
  startRecord: number;
  /** One past the last data record touching the window. */
  endRecord: number;
  /** True when the window covers the whole recording. */
  isWholeRecording: boolean;
  /** Earliest record start, including EDF+D timing gaps. */
  recordingStartSeconds: number;
  /** End of the latest record, including EDF+D timing gaps. */
  recordingEndSeconds: number;
}

/**
 * Slack for comparisons at sample/window boundaries.
 *
 * A nanosecond is far below any real sampling interval — 20 kHz is 50 microseconds — so it
 * absorbs the arithmetic error in `recordStart + sample / rate` without reaching a
 * neighbouring sample.
 */
export const BOUNDARY_TOLERANCE = 1e-9;

/**
 * The slack to use for a channel sampled this often.
 *
 * Never as much as half a sample interval, because slack that reaches the next sample stops
 * being slack. A fixed nanosecond was applied whatever the rate, and the format does not
 * oblige the interval to be larger than it: EDF's record duration is an 8-character field
 * that accepts `1e-9`. A recording of two 1 ns records holding ten samples each wrote ten of
 * its twenty rows — the window ends at 2e-9, the comparison asked for `time < 2e-9 - 1e-9`,
 * and the entire second record failed it. Exit 0, no warning, half the samples gone.
 */
export function toleranceFor(rate: number): number {
  if (!(rate > 0) || !Number.isFinite(rate)) return BOUNDARY_TOLERANCE;
  return Math.min(BOUNDARY_TOLERANCE, 1 / rate / 2);
}

/** Match the exact half-open boundary rules used while writing signal rows. */
export function sampleTimeIsInRange(
  time: number,
  startSeconds: number,
  endSeconds: number,
  tolerance: number = BOUNDARY_TOLERANCE,
): boolean {
  return time >= startSeconds - tolerance && time < endSeconds - tolerance;
}

/** Count samples from one record that fall inside a half-open requested window. */
export function countSamplesInRange(options: {
  recordStart: number;
  rate: number;
  samplesPerRecord: number;
  startSeconds: number;
  endSeconds: number;
}): number {
  const slack = toleranceFor(options.rate);
  const lower = Math.ceil(
    (options.startSeconds - slack - options.recordStart) * options.rate,
  );
  const upper = Math.ceil(
    (options.endSeconds - slack - options.recordStart) * options.rate,
  );
  const first = Math.max(0, Math.min(options.samplesPerRecord, lower));
  const last = Math.max(0, Math.min(options.samplesPerRecord, upper));
  return Math.max(0, last - first);
}

/**
 * Turn a requested window into both an exact time span and the record range that
 * contains it. Records are the unit the file can be read in; the exact span is what
 * decides which samples inside those records are actually written.
 */
export function resolveRange(options: {
  start?: number | undefined;
  /** The `--start` value exactly as typed, quoted back in the past-the-end error. */
  startText?: string | undefined;
  duration?: number | undefined;
  end?: number | undefined;
  /** The `--end` value exactly as typed, quoted back in the window error. */
  endText?: string | undefined;
  recordDuration: number;
  recordCount: number;
  /**
   * True start time of each data record, for discontinuous files. When absent,
   * records are assumed to sit end to end.
   */
  recordStarts?: Float64Array | null | undefined;
}): ResolvedRange {
  // For a continuous file the recording spans recordCount * recordDuration. A
  // discontinuous one does not: a 10-second recording with a 95-second gap in the
  // middle still ends at 105 seconds. Deriving the span from the records' real
  // positions is what stops a requested window from being clipped back to the
  // amount of *data* in the file and silently discarding everything past it.
  const { earliest, latest } = span(options.recordStarts, options.recordCount, options.recordDuration);

  if (options.duration !== undefined && options.end !== undefined) {
    throw new TimeRangeError('Use either --duration or --end, not both.');
  }

  const startSeconds = options.start ?? earliest;

  let endSeconds: number;
  if (options.duration !== undefined) endSeconds = startSeconds + options.duration;
  else if (options.end !== undefined) endSeconds = options.end;
  else endSeconds = latest;

  if (startSeconds >= latest) {
    /*
      Quote what was typed. Reporting the parsed seconds meant `--start 4h` came back as
      "--start 14400s is at or past the end", which reads as a value the user never gave.

      In quotation marks, which the parse errors above have always used and this did not.
      Without them the value ran into the sentence: `--start "  5s  "` printed as
      `--start   5s   is at or past the end`, where the value appears to be `5s   is` and
      the surrounding spaces — the actual reason a shell-built argument went wrong — are
      invisible.
    */
    throw new TimeRangeError(
      /*
        The recording's length in the same words --info uses for it.

        `formatSeconds` renders a bare number of seconds, so this message and the Duration
        line disagreed about one file in one session: --info said "6m 40s" and the error said
        "400s". On an overnight recording it read "7950s recording", leaving the reader to
        divide by 3600 to find out whether their --start was reasonable — which is the one
        question this message exists to answer. cli-reference.md has always documented it
        humanised ("2h 12m 30s"), a form no input could produce.

        The typed value keeps `quoted`, since that is the user's own text and should come
        back exactly as they wrote it.
      */
      /*
        `latest` is where the recording ends on its own clock, which is its length only when
        it starts at zero. A file timed from its first record's timekeeping TAL need not: one
        whose records run 1000s to 1003s is three seconds long, and this called it "this
        16m 43s recording" — while --info two lines away said "Duration 3s". Where the
        recording sits is the useful thing to say in that case, and it is the number --start
        has to be given.
      */
      earliest === 0
        ? `--start ${quoted(options.startText, startSeconds)} is at or past the end of this ` +
          `${formatDuration(latest)} recording.`
        : `--start ${quoted(options.startText, startSeconds)} is at or past the end of this ` +
          `${formatDuration(latest - earliest)} recording, which runs from ` +
          `${formatSeconds(earliest)} to ${formatSeconds(latest)}.`,
    );
  }
  if (endSeconds <= startSeconds) {
    // Quote whatever the caller actually gave, for the same reason as the error above. The
    // end is only echoed when --end was passed: with --duration the end is computed here,
    // so there is no typed value to quote and the arithmetic result is the honest thing.
    const endShown =
      options.end !== undefined && options.endText !== undefined
        ? quoted(options.endText, endSeconds)
        : formatSeconds(endSeconds);
    const startShown = quoted(options.startText, startSeconds);
    throw new TimeRangeError(
      `The requested window ends at ${endShown}, which is not after its start at ${startShown}.`,
    );
  }

  const clampedEnd = Math.min(endSeconds, latest);
  const { startRecord, endRecord } = selectRecords(options, startSeconds, clampedEnd);

  return {
    startSeconds,
    endSeconds: clampedEnd,
    startRecord,
    endRecord,
    isWholeRecording: startSeconds <= earliest && clampedEnd >= latest,
    recordingStartSeconds: earliest,
    recordingEndSeconds: latest,
  };
}

function span(
  recordStarts: Float64Array | null | undefined,
  recordCount: number,
  recordDuration: number,
): { earliest: number; latest: number } {
  if (!recordStarts || recordStarts.length === 0) {
    return { earliest: 0, latest: recordCount * recordDuration };
  }
  let earliest = Infinity;
  let latest = -Infinity;
  for (const start of recordStarts) {
    if (start < earliest) earliest = start;
    if (start + recordDuration > latest) latest = start + recordDuration;
  }
  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) {
    return { earliest: 0, latest: recordCount * recordDuration };
  }
  return { earliest, latest };
}

/** Every record whose own time span overlaps the requested window. */
function selectRecords(
  options: { recordDuration: number; recordCount: number; recordStarts?: Float64Array | null | undefined },
  startSeconds: number,
  endSeconds: number,
): { startRecord: number; endRecord: number } {
  const starts = options.recordStarts;
  if (!starts || starts.length === 0) {
    return {
      startRecord: Math.max(0, Math.floor(startSeconds / options.recordDuration)),
      endRecord: Math.min(options.recordCount, Math.ceil(endSeconds / options.recordDuration)),
    };
  }

  let first = options.recordCount;
  let last = 0;
  for (let i = 0; i < starts.length; i++) {
    const begin = starts[i] ?? 0;
    if (begin + options.recordDuration > startSeconds && begin < endSeconds) {
      if (i < first) first = i;
      if (i + 1 > last) last = i + 1;
    }
  }
  return first < last ? { startRecord: first, endRecord: last } : { startRecord: 0, endRecord: 0 };
}

/**
 * The value as the caller typed it, in quotation marks, or the parsed seconds if they gave
 * none. The marks show where the value begins and ends, which matters most for the values
 * that went wrong because of what surrounds them.
 */
function quoted(text: string | undefined, seconds: number): string {
  return text === undefined ? formatSeconds(seconds) : `"${text}"`;
}

function formatSeconds(seconds: number): string {
  return `${Number(seconds.toFixed(3))}s`;
}
