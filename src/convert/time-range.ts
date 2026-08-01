/**
 * Parsing for the time-range options.
 *
 * Researchers write offsets in whatever form is natural for the recording in front
 * of them: seconds for a short ECG strip, `30m` into a sleep study, `01:23:45` when
 * reading off a clock. All three are accepted; anything ambiguous is rejected with
 * a message that shows the forms that work.
 */

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
  while ((match = UNIT_TOKEN.exec(text)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2] ?? '';
    const scale = UNIT_SECONDS[unit];
    if (scale === undefined) {
      throw new TimeRangeError(
        `${optionName} "${input}" uses an unknown unit "${unit}". Use h, m, s, or ms.`,
      );
    }
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
}

/**
 * Turn a requested window into both an exact time span and the record range that
 * contains it. Records are the unit the file can be read in; the exact span is what
 * decides which samples inside those records are actually written.
 */
export function resolveRange(options: {
  start?: number | undefined;
  duration?: number | undefined;
  end?: number | undefined;
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
    throw new TimeRangeError(
      `--start ${formatSeconds(startSeconds)} is at or past the end of this ` +
        `${formatSeconds(latest)} recording.`,
    );
  }
  if (endSeconds <= startSeconds) {
    throw new TimeRangeError(
      `The requested window ends at ${formatSeconds(endSeconds)}, which is not after its ` +
        `start at ${formatSeconds(startSeconds)}.`,
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
      startRecord: Math.floor(startSeconds / options.recordDuration),
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

function formatSeconds(seconds: number): string {
  return `${Number(seconds.toFixed(3))}s`;
}
