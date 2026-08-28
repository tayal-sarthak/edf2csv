/**
 * Parsing for the time-range options.
 *
 * Researchers write offsets in whatever form is natural for the recording in front
 * of them: seconds for a short ECG strip, `30m` into a sleep study, `01:23:45` when
 * reading off a clock. All three are accepted; anything ambiguous is rejected with
 * a message that shows the forms that work.
 */

import { fixed, formatDuration } from '../format/number.js';
import { assertOptions } from './options.js';

export class TimeRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeRangeError';
  }
}

/**
 * Every spelling of a unit this accepts, and what one of it is worth in seconds.
 *
 * Exported so the spellings can be enumerated by a test rather than listed a second time:
 * twelve of these sixteen are named nowhere in the tool or its documentation, and none of
 * their values was checked by anything. `hrs: 360` would have converted `--start 2hrs` from
 * twelve minutes in and said nothing, which is the one kind of mistake a window may not make.
 */
export const UNIT_SECONDS: Record<string, number> = {
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

/** How the value reads in a refusal: numbers bare, everything else quoted so its type shows. */
function describeValue(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value);
}

/**
 * Parse a duration or offset into seconds.
 *
 * Accepted: `90`, `90s`, `5m`, `1h30m`, `1h 30m 15s`, `00:30:00`, `30:00`, `250ms`.
 *
 * `allowNegative` is for the two options that name a position rather than a length.
 *
 * A recording is timed from its first record's timekeeping annotation, and nothing obliges that
 * to sit at or after zero: a file whose records run from -100 s to -97 s is one this tool reads,
 * times from -100, and describes with
 *
 *     Timed from -100.000s  (first sample; --start and --end use this clock)
 *
 * That line says the number can be typed straight back in, and it could not be. Every offset
 * such a recording has came back as "not a time I understand", so its whole clock was
 * unreachable and no window of it could be converted at all — the one file shape where a
 * window is refused for naming a moment the recording actually contains.
 *
 * A length below zero is still a different thing, and `--duration` still refuses one.
 */
export function parseTimeSpec(input: string, optionName: string, allowNegative = false): number {
  /*
    Text, because this is the function the API page points other people's users at: "Use
    `parseTimeSpec` if you want to accept those forms from your own users."

    A value arriving from a JSON config or a form field is a number as often as a string, and
    `{ "start": 30 }` came back as `TypeError: input.trim is not a function` — a variable name
    from inside this file, thrown past a caller who had done exactly what the page told them
    to. Every other refusal here is a TimeRangeError quoting the value and the option. The
    number is not coerced, for the reason `channels: 'ECG'` is not iterated: a shape that
    happens to work for 30 also swallows NaN, and the CLI already writes `String(raw)`.
  */
  if (typeof input !== 'string') {
    throw new TimeRangeError(
      `${optionName} must be given as text, not ${describeValue(input)}. ` +
        `Seconds are written "30", and the other forms are "30s", "5m", "1h30m", "00:30:00".`,
    );
  }
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') {
    throw new TimeRangeError(`${optionName} is empty. Try a value like 30s, 5m, or 00:30:00.`);
  }

  /*
    The sign is read off the front and applied to the whole value, so `-1h30m` is an hour and a
    half before the origin rather than an hour before it and half an hour after.

    Nothing may sit between the sign and the number, and a leading `+` is still refused: every
    other number this tool takes is refused when written in a form nobody types, and `+5` is
    exactly what `--decimals` and `--jobs` reject one flag over.
  */
  const negative = trimmed.startsWith('-');
  const text = negative ? trimmed.slice(1) : trimmed;

  /*
    A leading plus, named as such.

    Refusing it is deliberate — see the paragraph above — but it came back as "is not a time I
    understand. Try 30s, 5m, 1h30m, 00:30:00, or a plain number of seconds", which is the
    message for input that could not be read at all. Every part of `+5s` was read: the number
    parsed, the unit was looked up and found. The one thing wrong with it is a character the
    reader put there on purpose, and they were sent to re-check their unit spellings with `5m`
    sitting in the list of suggestions, differing from what they typed by the sign they cannot
    see is the problem. 0.7.102 made this argument about a space; this is the same sentence
    about the other character that reaches it. `--decimals` and `--jobs` both quote the value
    back and say what is wrong with it.

    Every plus, not the first one, and the leftover space with it — the same rule the spaced
    refusal below applies to spaces, for the same reason: a hint whose command this function
    refuses is worse than no hint. `+1h+30m` was answered with `1h+30m`, which comes straight
    back as "is not a time I understand", and `+ 5s` with a value that opened on a space.
  */
  if (text.startsWith('+')) {
    throw new TimeRangeError(
      `${optionName} "${input}" begins with a plus. Write the number on its own: ` +
        `${input.trim().replaceAll('+', '').trim()}`,
    );
  }
  const signed = (seconds: number): number =>
    assertFinite(negative ? -seconds : seconds, optionName, input, allowNegative);

  // Bare number means seconds.
  if (/^\d+(?:\.\d+)?$/u.test(text)) return signed(Number(text));

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
    return signed(hours * 3600 + minutes * 60 + seconds);
  }

  // Unit form: 1h30m, 1h30m 15s, 250ms. A number sits directly against its unit; see below.
  UNIT_TOKEN.lastIndex = 0;
  let total = 0;
  let matched = 0;
  let consumed = 0;
  /** Whether any token had a space between its number and its unit. See the refusal below. */
  let spaced = false;
  let match: RegExpExecArray | null;
  // Which units have already been seen, so a repeat can be rejected rather than added.
  const seen = new Set<number>();
  while ((match = UNIT_TOKEN.exec(text)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2] ?? '';
    const scale = UNIT_SECONDS[unit];
    if (scale === undefined) {
      throw new TimeRangeError(
        `${optionName} "${input}" uses an unknown unit "${unit}". Use h, m, s or ms, ` +
          `or their long forms: hours, minutes, seconds.`,
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
    // Counted with the whitespace taken out, so the comparison below is against the same
    // string on both sides and a space inside a token reaches the refusal written for it
    // rather than the one about input that could not be read at all.
    consumed += match[0].replace(/\s+/gu, '').length;
    if (/\s/u.test(match[0])) spaced = true;
  }

  // Reject partially-understood input like "5x" or "1h banana".
  if (matched === 0 || consumed !== text.replace(/\s+/gu, '').length) {
    throw new TimeRangeError(
      `${optionName} "${input}" is not a time I understand. ` +
        `Try 30s, 5m, 1h30m, 00:30:00, or a plain number of seconds.`,
    );
  }

  /*
    A space between a number and its unit, named as such.

    `5 min` is refused on purpose — cli-reference sets the rule out, and it is what keeps
    `1 2h` from being read as anything — but it came back as "is not a time I understand. Try
    30s, 5m, 1h30m, 00:30:00, or a plain number of seconds", which is the message for input
    that could not be read at all. Every part of `5 min` was read: the number parsed, the unit
    was looked up in the table and found. The one thing wrong with it is a space, and the
    reader was sent to re-check their unit spellings instead — with `5m` sitting in the list of
    suggestions, differing from what they typed by a character they cannot see is the problem.

    Only reachable now that the count above ignores whitespace; before, the length check caught
    these first and there was nothing left to tell them apart by.
  */
  if (spaced) {
    throw new TimeRangeError(
      `${optionName} "${input}" puts a space between a number and its unit. ` +
        `Write them together: ${input.trim().replace(/(\d)\s+([a-z])/giu, '$1$2')}`,
    );
  }

  return signed(total);
}

function assertFinite(
  value: number,
  optionName: string,
  input: string,
  allowNegative: boolean,
): number {
  /*
    Overflow answers for itself, rather than borrowing the sentence about signs.

    One branch covered two rejections. `--start` with four hundred nines is a positive value
    that `Number` returns as `Infinity`, and the answer was `is not a valid non-negative
    time` — which names the one thing about it that is not the problem. Worse on the two
    options this is called with `allowNegative` for: `--start` and `--end` take a sign on
    purpose, since a recording timed from before zero has no other way to be addressed, so
    "non-negative" is not their rule at all and overflow is the only way they reach here.
  */
  if (!Number.isFinite(value)) {
    throw new TimeRangeError(
      `${optionName} "${input}" is further from zero than a number of seconds can hold.`,
    );
  }
  if (!allowNegative && value < 0) {
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
  /*
    A record with no place on the clock contributes no rows, which is what the conversion
    already does with one: its sample times are non-finite, so every one of them fails the
    range test and none is written. The arithmetic below reached `Infinity - Infinity` and
    answered `NaN`, which `--info` then printed — "Would write NaN rows, roughly NaN B." on a
    recording that goes on to write eight. Reachable from a header: a record duration of 1e308
    is five characters in an eight-character field, and the third record of one is past what a
    double can hold.
  */
  if (!Number.isFinite(options.recordStart)) return 0;
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
 * Whether two instants differ only by the arithmetic that produced them.
 *
 * A relative epsilon, because the gap between doubles grows with magnitude — the same shape
 * the long layout uses to decide two sample times are one instant. Well below any real sample
 * interval, and well above the rounding that two routes to one quantity produce: a recording's
 * length is `recordCount * recordDuration`, which for 6003 records of 0.1s is not the 600.3 it
 * prints as.
 */
function sameInstant(a: number, b: number): boolean {
  /*
    A relative tolerance has nothing to be relative to at infinity.

    `Math.abs(a - Infinity)` is Infinity, and so is the allowance beside it, so
    `Infinity <= Infinity` made every instant the same instant as an infinite one. A
    recording whose end overflows a double — three records of 1e308 seconds, which an
    8-character record-duration field can state and a timekeeping TAL can place — was
    therefore refused the window nobody asked for:

        $ edf2csv rec.edf --info
        error: --start 0s is at or past the end of this unknown recording.

    Exit 2 for a file, naming a flag the command did not carry, quoting a length that is
    `formatDuration`'s word for a number it will not print. `--info` is the one command that
    would have explained the file and it is the one that could not run.

    Finite or equal, which is the only reading that means anything: two infinities are the
    same non-instant, and a real offset is not one of them.
  */
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-12;
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
  /*
    The same check `buildPlan` makes, made here too, because this is exported on its own.

    `assertOptions` sits at the top of `buildPlan`, so `convert` was covered and the function
    underneath it was not — and this one has its own signature block on the API page.
    `resolveRange({ start: NaN, ... })` resolved: no error, no warning, and a range read back
    as `startSeconds: null, startRecord: null`, which is the "takes the whole recording
    without saying so" that comment names. `{ end: '2' }` was coerced by the arithmetic and
    accepted; `{ start: '30' }` reached the past-the-end error and printed it with the value
    missing — `--start s is at or past the end of this 3s recording`.
  */
  assertOptions({ start: options.start, duration: options.duration, end: options.end });

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

  /*
    At the end, allowing for the arithmetic that produced the end.

    `latest` is `recordCount * recordDuration`, and with a fractional duration that is not the
    number it prints as: 6003 records of 0.1s is 600.3000000000001, not 600.3. So `--start
    600.3` on a recording `--info` calls "10m 0.3s" was accepted by a hair, converted nothing,
    and exited 0 with a signals.csv holding its header — which is the empty conversion this
    error exists to prevent, and which the same command on a whole-second recording is refused
    for.

    A relative epsilon, the same shape the long layout uses to decide two sample times are one
    instant: well below any real interval, and well above the rounding that two different
    routes to the same quantity produce.
  */
  if (startSeconds >= latest || sameInstant(startSeconds, latest)) {
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
  /*
    Both ends of the window, clamped the same way.

    The end has been clamped to the recording since these fields existed — `--end 999h` on a
    two-hour file is documented as converting to the end, silently — and the start was left as
    typed. So a window asked for before the recording begins was recorded as one:

        edf2csv two-second.edf --out csv --start=-500
        metadata.json  "start_seconds": -500, "end_seconds": 2

    over a signals.csv whose first row is 0.000, with `records_converted` correctly `[0, 2]`.
    output-files calls the pair "the resolved time window", which the end is and the start was
    not, and a script taking `end_seconds - start_seconds` for the span converted got 502 for
    two seconds of data.

    `earliest` and not zero, because a recording is timed from its first record and need not
    begin there: negative-origin.edf runs from -100s, and -100 is where a start before the
    recording belongs. Nothing downstream moves — every sample sits at or after `earliest`, so
    the row filter and the record selection answer the same for either value, and the byte
    estimate takes a width from the smaller magnitude, which is the one the column actually
    holds.

    Not when the whole window sits before the recording, where there is no overlap to clamp
    to and raising the start past the end would describe the request backwards: `--start 0
    --duration 0.001` on a file beginning at 30s is an empty window, and EMPTY_WINDOW quotes
    the bounds — "(30.000s to 0.001s)" says nothing a reader can act on, where the bounds as
    asked for are what its hint is already explaining.
  */
  const clampedStart = clampedEnd <= earliest ? startSeconds : Math.max(startSeconds, earliest);
  const { startRecord, endRecord } = selectRecords(options, clampedStart, clampedEnd);

  return {
    startSeconds: clampedStart,
    endSeconds: clampedEnd,
    startRecord,
    endRecord,
    /*
      The same rounding, one field over.

      `latest` is `recordCount * recordDuration`, and 6003 records of 0.1s is
      600.3000000000001. So `--end 600.3` on a recording of exactly that length wrote every
      sample it has — byte-identical to a bare conversion — and metadata.json recorded
      `whole_recording: false` for it, while the bare run recorded true. One conversion, two
      answers, on the field a pipeline reads to decide whether it has the lot.
    */
    isWholeRecording:
      (startSeconds <= earliest || sameInstant(startSeconds, earliest)) &&
      (clampedEnd >= latest || sameInstant(clampedEnd, latest)),
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
    /*
      An empty range is `[0, 0]` here as it is below, rather than whatever the arithmetic
      produced. Each bound was clamped on one side only — the start up to zero, the end down
      to the record count — so a window lying entirely before the recording came back as
      `records_converted: [0, -1]` in metadata.json, over a `endRecord` documented as "one
      past the last data record touching the window". A script differencing the pair read
      minus one record converted, and `ConversionProgress.recordsTotal` reported the same.

      The discontinuous branch below has always answered `[0, 0]` for exactly this request,
      so the two halves of one function disagreed about how to say "none": the same window on
      `annotations.edf` and on `discontinuous.edf` gave `[0, -1]` and `[0, 0]`.
    */
    const first = Math.max(0, Math.floor(startSeconds / options.recordDuration));
    const last = Math.min(options.recordCount, Math.ceil(endSeconds / options.recordDuration));
    return first < last ? { startRecord: first, endRecord: last } : { startRecord: 0, endRecord: 0 };
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
  /*
    The same 1e21 cliff, in the bounds this message hands back.

    `--start "9e21"` was answered with "is at or past the end of this 3e+21s recording, which
    runs from 1e+21s to 4e+21s" — a sentence whose whole purpose is to say what window there
    is to ask for, ending in two tokens the parser refuses: `--start 1e+21s` is "uses an
    unknown unit \"e\"". `Number(...)` was here to drop the trailing zeros, and it also
    re-introduced the exponent form that `toFixed` had produced.
  */
  const text = fixed(seconds, 3);
  return `${text.includes('.') ? text.replace(/\.?0+$/u, '') : text}s`;
}
