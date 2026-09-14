/**
 * Checking the options a caller passed, before anything is written.
 *
 * The command line has always validated these — `--decimals 1.5` is a usage error and always
 * has been — and the library did not, so the same value behaved differently depending on how
 * it arrived. `convert(file, { decimals: NaN })` resolved successfully having written whole
 * numbers into a column the caller had asked for decimals in, which is the worst of the
 * three: no error, no warning, and output that looks like a deliberate choice. `decimals: -1`
 * reached `toFixed` and came back as a bare RangeError from deep inside the formatter, naming
 * nothing the caller had written. `start: NaN` created the output directory, wrote
 * signals.csv, and then failed with a message about the input being unreadable — a partial
 * conversion, blamed on the file.
 *
 * These run at the top of `buildPlan`, which every path goes through before a directory is
 * created or a stream is opened, so a rejected option leaves nothing behind.
 */

import { counted, grouped } from '../format/list.js';

/** A problem with the options a caller passed, as opposed to a problem with the file. */
export class OptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionError';
  }
}

/**
 * The largest `--decimals` accepts, and what both documentation pages state.
 *
 * Not a limit of `toFixed`, whatever this comment used to say. `toFixed` takes 0 to 100 and
 * throws a RangeError at 101 — which is exactly the belief `MAX_DERIVED_DECIMALS` in
 * edf/scale.ts exists to correct, having once clamped the *derived* precision to 20 on the
 * same wrong grounds and rounded a magnetometer channel needing 23 places onto a grid three
 * digital codes wide, losing 69% of its samples in silence.
 *
 * Twenty is a bound on a number a person types by hand, not on what the format can express.
 * The derived precision, which nobody types, runs to 100 and says so.
 */
export const MAX_DECIMALS = 20;

export function assertOptions(options: {
  decimals?: number | undefined;
  start?: number | undefined;
  duration?: number | undefined;
  end?: number | undefined;
  layout?: string | undefined;
  channels?: readonly string[] | undefined;
  outputDir?: string | undefined;
  annotationsOnly?: boolean | undefined;
  gzip?: boolean | undefined;
  bom?: boolean | undefined;
  force?: boolean | undefined;
  checksum?: boolean | undefined;
  toStdout?: boolean | undefined;
  onProgress?: unknown;
  startText?: unknown;
  durationText?: unknown;
  endText?: unknown;
}): void {
  /*
    The bag itself, before anything is read out of it.

    Every check below reads `options.decimals` and its neighbours, and both functions that run
    this declare the parameter with a default of `{}` — which covers `undefined` and nothing
    else. So a value that is not an object had its properties read off it, came back
    `undefined`, and meant what `undefined` means here: that option was not given.

        convert('rec.edf', 'out')      // converts to rec_csv, and reports success
        buildPlan(input, 42)           // the whole recording, wide, three decimals
        convert('rec.edf', null)       // TypeError: Cannot read properties of null

    `convert(file, 'out')` is the one that costs something. The second parameter is an option
    bag and the string looks like a destination, which is a mistake worth making — and the
    rows went to `<recording>_csv` beside the input, a directory the caller had not named,
    with `result.outputDir` reporting where they really went to nobody who was reading it.
    That is the sentence `outputDir: null` has at the top of this file, arrived at through the
    argument in front of it.

    `resolveRange` was given this check on its own bag in 0.8.75 and `readRecords` on its in
    0.9.2. These are the last two exported functions that take one.
  */
  // An array is an object and carries none of these properties, so it went the same way as a
  // string with none of the same visibility — `convert(file, ['a.edf', 'b.edf'])` is the
  // second-argument twin of the mistake `assertInputPath` was written for.
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new OptionError(
      `options must be an object of options, got ${describeValue(options)}. The destination ` +
        `goes in it as outputDir; omit it for the defaults.`,
    );
  }
  /*
    The three options that exist only to be quoted back, quoted back unexamined.

    `startText`, `durationText` and `endText` carry the value exactly as the caller's user
    typed it, so a refusal names that rather than its parsed form — "--start \"4h\"" rather
    than "--start 14400s". Nothing asked whether they were text, and they reach the sentence
    as they are:

        convert(file, { start: 99, startText: {} })
        TimeRangeError: --start "[object Object]" is at or past the end of this 3s recording.

        convert(file, { start: 1, end: 0.5, endText: [] })
        TimeRangeError: The requested window ends at "", which is not after its start at 1s.

    `[object Object]` is the string `assertInputPath`'s own docstring names as the reason that
    function exists, and the empty quotation is the hole `describeValue` was written to stop —
    both in the one place whose entire purpose is to show the reader what they typed.
  */
  for (const name of ['startText', 'durationText', 'endText'] as const) {
    const value = options[name];
    if (value !== undefined && typeof value !== 'string') {
      throw new OptionError(
        `${name} must be the value as it was typed, got ${describeValue(value)}. It is quoted ` +
          `back in the window errors so they name what was given rather than its parsed form.`,
      );
    }
  }
  const { decimals } = options;
  if (decimals !== undefined) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
      throw new OptionError(
        `decimals must be a whole number between 0 and ${MAX_DECIMALS}, got ${describeValue(decimals)}.`,
      );
    }
  }

  /*
    `start` and `end` are positions on the recording's own clock, `duration` is a length.

    All three were held above zero, which is right for a length and wrong for a position: a
    recording timed from its first record's timekeeping annotation may sit before zero, and
    -100 is then where its first sample is. So a caller could read `plan.range` back as
    `recordingStartSeconds: -100` and not be allowed to ask for it — the same wall
    `parseTimeSpec` put in front of the command line until 0.5.120.

    Non-finite is still refused for all three, since NaN reaches a comparison as false and
    would take the whole recording without saying so.
  */
  for (const name of ['start', 'duration', 'end'] as const) {
    const value = options[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new OptionError(`${name} must be a number of seconds, got ${describeValue(value)}.`);
    }
    /*
      A length below zero is refused for what it is, rather than for not being a number.

      `duration: -1` came back as "duration must be a number of seconds, got -1", which is
      not the reason and not true: -1 is a number of seconds, and this same call accepts it
      for `start` and for `end`, where a recording timed from before zero makes it an
      ordinary position. What is wrong is that a duration is a length, and no length is
      negative — which is what the command line says for the same value, and what the API
      reference has always said this check enforces.
    */
    if (name === 'duration' && value < 0) {
      throw new OptionError(`duration is a length of time, so it cannot be ${describeValue(value)}.`);
    }
  }

  /*
    Two words, and a caller who writes a third means something the tool cannot do.

    The command line has always rejected `--layout tall`. The library took it, put it in
    `plan.layout` for the caller to read back, and wrote the wide layout — so a programmatic
    caller with a typo got a conversion that was not the one they asked for, described by a
    plan that agreed with the typo. Every other option that has a shape is checked here; this
    one was added in 0.5.0 and never joined them.
  */
  const { layout } = options;
  if (layout !== undefined && layout !== 'wide' && layout !== 'long') {
    throw new OptionError(`layout must be "wide" or "long", got ${describeValue(layout)}.`);
  }

  /*
    A selection that names nothing is not the absence of a selection.

    `buildPlan` asks `options.channels.length > 0` before selecting, so an empty array fell
    through to the branch that means "no channels option was given" — and `convert(file, {
    channels: [] })` wrote every channel in the recording, resolved, and said nothing. That is
    the one shape of this the command line has always refused, in as many words: "Returning
    undefined here would mean 'no --channels given' and convert everything, which is the
    opposite of what someone passing an empty list is asking for."

    A list of blanks is the same request written differently — it is what `''.split(',')`
    produces, which is how a caller building the array from user input arrives here — and it
    reached `selectChannels` and came back "No channels were selected", a sentence about the
    file rather than about the call. Both are the option being wrong, so both are refused
    here, before a directory exists.
  */
  /*
    An empty destination, refused here rather than by the filesystem.

    `convert(file, { outputDir: '' })` went the whole way to `mkdir('')` and came back a
    `ConversionError`: "Cannot create \"\": part of the path does not exist. Check the path
    exists and that you have permission to write there." Advice about a path and a permission
    for a value that is neither, and a failure class that means the conversion went wrong
    where the option did.

    The command line refused this at 0.6.x, with the reasoning that `--out "$DEST"` and `DEST`
    unset is how it gets written by accident — and left the library, which a caller building
    the path in code reaches the same way. Not trimmed, for the reason given there: a
    directory whose name is a space is a strange thing to ask for, but it is a thing the
    filesystem has and a path is not a keyword.
  */
  /*
    And its shape, which was the one option with a value and no check on it.

    The empty string was refused and nothing else was, so `outputDir` failed two ways that the
    paragraph above describes for the flags. A value of the wrong type reached `path.join` and
    came back as a Node error about an argument this caller never passed:

        convert('rec.edf', { outputDir: 42 })
        TypeError: The "path" argument must be of type string. Received type number (42)

    And `null` — which is what `JSON.parse` of a config file gives for a field left unset, the
    same door `1` and `'true'` come through — was not an error at all. It is not `undefined`,
    so it never meant "use the default", but every read of it is `?? default` or a truthiness
    test, so that is what it did: the rows went to `<recording>_csv` beside the input, a
    directory the caller had not named, and the run reported success.
  */
  const { outputDir } = options;
  if (outputDir !== undefined && typeof outputDir !== 'string') {
    throw new OptionError(`outputDir must be a path, got ${describeValue(outputDir)}.`);
  }
  if (outputDir === '') {
    throw new OptionError('outputDir is empty. Give a directory, for example "./converted".');
  }

  /*
    The six flags, every one of which is read as `=== true` where it is read.

    Which means a value that is not a boolean is not merely tolerated: it is taken as the
    opposite of what it says. `convert(file, { annotationsOnly: 'true' })` wrote every signal
    the caller had asked to leave out; `{ gzip: 1 }` wrote plain CSVs under names ending
    `.csv`, so a caller who then opened `signals.csv.gz` found nothing there. No error, no
    warning, and output that looks like a deliberate choice — which is the sentence at the
    top of this file, describing the case it was written for.

    `1` and `'true'` are how a flag arrives from `JSON.parse` of a config file, from a query
    string, or from a CLI wrapper that did not coerce; none of them is a caller being
    careless in a way TypeScript would catch, since the callers this reaches are the ones not
    using it. The layout check above states the rule these were missing from: "Every other
    option that has a shape is checked here."
  */
  for (const name of ['annotationsOnly', 'gzip', 'bom', 'force', 'checksum', 'toStdout'] as const) {
    const value = options[name];
    if (value !== undefined && typeof value !== 'boolean') {
      throw new OptionError(`${name} must be true or false, got ${describeValue(value)}.`);
    }
  }

  /*
    The one option that is called rather than read, and the only one that was not checked.

    `convert` invokes it as `options.onProgress?.(...)` once a record has been written, so a
    value that is not a function passes every check here, opens the destination, writes rows
    into it and then fails from inside the loop:

        convert('rec.edf', { outputDir: 'out', onProgress: 'every record' })
        ConversionError: The onProgress callback threw: options.onProgress is not a function

    A callback that threw is what that sentence reports, and no callback was given; the text
    after the colon names an expression inside this package. Worse is what it leaves: `out`
    exists with a half-written signals.csv in it, which is the case the paragraph at the top
    of this file describes — "`start: NaN` created the output directory, wrote signals.csv,
    and then failed with a message about the input being unreadable — a partial conversion,
    blamed on the file". Checked here, the same call writes nothing and says which argument
    is wrong.
  */
  const { onProgress } = options;
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new OptionError(`onProgress must be a function, got ${describeValue(onProgress)}.`);
  }

  const { channels } = options;
  if (channels !== undefined) {
    /*
      A list of strings, checked as one. `selectChannels` calls `.trim()` on every term, so a
      caller who passed the string `'ECG'` had it iterated character by character and was told
      `No channel named "E"`, and one who passed `[1]` — a position, reasonably enough — got
      `TypeError: rawTerm.trim is not a function` out of the middle of the selector, naming
      nothing they had written. Both are the option being the wrong shape, which is the case
      this function exists for.
    */
    if (!Array.isArray(channels) || channels.some((term) => typeof term !== 'string')) {
      throw new OptionError(`channels must be a list of channel names, got ${describeValue(channels)}.`);
    }
    if (channels.every((term) => term.trim() === '')) {
      throw new OptionError('channels was given but lists no channel names.');
    }
  }
}

/**
 * The channel list two exported functions take, checked the way their other argument is.
 *
 * `selectChannels(signals, terms)` has checked `terms` since 0.6.x — "`'ECG'` was iterated
 * character by character and answered `No channel named \"E\"`… naming nothing the caller had
 * written" — and never checked `signals`, which is the argument in front of it. Passing one
 * signal where the list goes, or a header where its `signals` goes, came back as
 * `TypeError: signals.filter is not a function`: a local of this package, over a value the
 * caller did write.
 *
 * `buildColumnNames` is worse off, because a string is iterable. `buildColumnNames('ECG')`
 * returned `Map { null => 'undefined_chundefined' }` and no error at all — a column name for a
 * channel that does not exist, keyed by a position that is not one.
 *
 * The bad entry is named by position rather than the whole list being printed back: a header
 * may declare hundreds of channels, and a message is not the place for all of them.
 */
export function assertSignals(signals: unknown): void {
  if (!Array.isArray(signals)) {
    throw new OptionError(
      `signals must be the channel list from a header, got ${describeValue(signals)}.`,
    );
  }
  /*
    The fields the callers read, not just the one that identifies a channel.

    This asked for `index` and stopped, and its callers go on to read `label` and
    `isAnnotations` off the same objects. So a list of channel-shaped objects without them
    passed the check that exists to say "these are not channels from a header" and failed one
    line further in, or did not fail at all:

        selectChannels([{ index: 0 }], ['ECG'])
        TypeError: Cannot read properties of undefined (reading 'toLowerCase')

        selectChannels([{ index: 0, label: 42 }], ['42'])
        TypeError: signal.label.toLowerCase is not a function

        buildColumnNames([{ index: 0 }])
        Map { 0 => null }

    The first two are the failure this function was written to remove, one level down — a
    local of this package named at a caller who wrote neither. The third is worse: a column
    name of `null`, where a channel with no label at all is named `signal_0`, so `null` is not
    a name this tool ever writes.
  */
  const FIELDS = [
    ['index', 'number'],
    ['label', 'string'],
    ['isAnnotations', 'boolean'],
  ] as const;
  for (const [at, signal] of signals.entries()) {
    if (typeof signal !== 'object' || signal === null) {
      throw new OptionError(
        `signals[${at}] is not a channel from a header, got ${describeValue(signal)}.`,
      );
    }
    const fields = signal as Record<string, unknown>;
    const wrong = FIELDS.find(([name, kind]) => typeof fields[name] !== kind);
    if (wrong === undefined) continue;
    const [name, kind] = wrong;
    throw new OptionError(
      `signals[${at}].${name} must be a ${kind}, got ${describeValue(fields[name])}. A channel ` +
        `from a header carries ${FIELDS.map(([f]) => f).join(', ')}.`,
    );
  }
}

/**
 * What `buildPlan` is told about the recording, checked the way what it is asked for is.
 *
 * `assertOptions` runs at the top of `buildPlan` and covers the second argument completely.
 * The first was not looked at, and it is the one carrying the numbers every figure in the plan
 * is derived from. Two of them missing produced a plan rather than an error:
 *
 *     buildPlan({ signals, recordDuration: 1 }, {})
 *     // groups: 3, estimate.rows: 0, range.endSeconds: null
 *
 * A plan saying the conversion writes nothing, handed back as an answer — which is the "takes
 * the whole recording without saying so" this checker exists to stop, one field over. A record
 * count below zero was worse: it came back as
 *
 *     TimeRangeError: --start 0s is at or past the end of this -5s recording.
 *
 * a flag the caller never passed, about a recording that cannot exist, blaming the request for
 * the input. And `recordDuration: '1'` was coerced by the arithmetic and accepted, where the
 * same string is refused for `end` two functions down.
 *
 * A real header cannot produce any of them: the parser refuses a record duration that is not a
 * positive number, "Infinity" included.
 */
export function assertPlanInput(input: {
  signals?: unknown;
  recordDuration?: unknown;
  recordCount?: unknown;
}): void {
  assertSignals(input.signals);
  assertRecordShape(input);
  assertPlannableSignals(input.signals as readonly Record<string, unknown>[]);
}

/**
 * The two numbers on a channel that `buildPlan` reads and `assertSignals` does not ask about.
 *
 * `assertSignals` asks for `index`, `label` and `isAnnotations`, which is what its other two
 * callers read — they name columns and match terms. `buildPlan` goes further: it groups the
 * channels by `samplingRate` and counts rows from `samplesPerRecord`, and asked nothing of
 * either. So a list of channel-shaped objects carrying the three fields it does check reached
 * the rate formatter and came back
 *
 *     buildPlan({ signals: [{ index: 0, label: 'ECG', isAnnotations: false }], … }, {})
 *     OptionError: hz must be a sampling rate in hertz, got undefined.
 *
 * naming `hz`, a parameter of a function three calls down, at a caller who passed `signals`.
 * That is the failure `assertSignals` exists to remove, and it is the same one its own
 * docstring quotes for `label`.
 *
 * The values it takes are the ones a header can really state, which is wider than it looks:
 * `samplesPerRecord` may be zero — that is what `NO_SAMPLES` reports — and a rate may be zero
 * or `Infinity`, because a record duration small enough to overflow the division is five
 * characters in an eight-character field. What a header cannot state is a fractional or
 * negative sample count, and those went through as arithmetic:
 *
 *     samplesPerRecord: 2.5   // estimate.rows: 394.5, half a row
 *     samplesPerRecord: -4    // estimate.rows falls, with nothing said
 *
 * Split out rather than folded into `assertSignals`, for the reason `assertRecordShape` gives
 * one function down: `selectChannels` and `buildColumnNames` never look at either field, and a
 * checker should not demand what its caller does not read.
 */
function assertPlannableSignals(signals: readonly Record<string, unknown>[]): void {
  for (const [at, signal] of signals.entries()) {
    const rate = signal['samplingRate'];
    if (typeof rate !== 'number' || Number.isNaN(rate) || rate < 0) {
      throw new OptionError(
        `signals[${at}].samplingRate must be a sampling rate in hertz, got ` +
          `${describeValue(rate)}. It is samplesPerRecord over the record duration, and it is ` +
          `what the channels are grouped into output files by.`,
      );
    }
    const samples = signal['samplesPerRecord'];
    if (!Number.isInteger(samples) || (samples as number) < 0) {
      throw new OptionError(
        `signals[${at}].samplesPerRecord must be a whole number of samples, got ` +
          `${describeValue(samples)}. Every row this plan counts comes from it.`,
      );
    }
  }
}

/**
 * The two numbers a window is measured against, apart from the channel list.
 *
 * `resolveRange` is exported on its own and has its own signature block on the api page, and
 * `buildPlan` calls it — so it was covered only from above. Called directly it took both
 * numbers unexamined and answered with a range:
 *
 *     resolveRange({ recordDuration: 1 })       // recordCount undefined
 *     // { startSeconds: 0, endSeconds: null, startRecord: 0, endRecord: 0 }
 *
 * A range over no records, returned as a fact about a recording. Its own opening comment
 * already says why that is the wrong answer — "no error, no warning, and a range read back as
 * `startSeconds: null, startRecord: null`, which is the 'takes the whole recording without
 * saying so'" — about the three fields it does check. `resolveRange(42)` went the same way,
 * since reading `.start` off a number is `undefined` rather than a throw.
 *
 * Split out rather than calling `assertPlanInput`, which would demand a channel list this
 * function never looks at.
 */
export function assertRecordShape(input: {
  recordDuration?: unknown;
  recordCount?: unknown;
  recordStarts?: unknown;
}): void {
  const { recordDuration, recordCount, recordStarts } = input ?? {};
  if (typeof recordDuration !== 'number' || !Number.isFinite(recordDuration) || recordDuration <= 0) {
    throw new OptionError(
      `recordDuration must be a positive number of seconds, got ${describeValue(recordDuration)}.`,
    );
  }
  if (!Number.isInteger(recordCount) || (recordCount as number) < 0) {
    throw new OptionError(
      `recordCount must be a whole number of data records, got ${describeValue(recordCount)}.`,
    );
  }
  /*
    And where the records really sit, which is what makes a discontinuous file's span longer
    than its duration. Nothing asked what it was, and the two ways of getting it wrong fail
    differently:

        resolveRange({ recordDuration: 1, recordCount: 3, recordStarts: 'x' })
        { startSeconds: 0, endSeconds: 3, startRecord: 0, endRecord: 0, isWholeRecording: true }

    A string is iterable, so it spreads to its characters and the span comes out over no
    records at all — a range that says it is the whole recording and covers none of it, which
    is a contradiction rather than an answer.

        resolveRange({ ..., recordStarts: 42 })
        TypeError: recordStarts is not iterable

    which names this function's own parameter at a caller holding the wrong thing. A list is
    what it takes: the `Float64Array` the reader builds, or an ordinary array — `readAnnotations`
    hands back `(number | null)[]`, and a null start is a record whose position is not known,
    which this already allows for.
  */
  if (
    recordStarts !== null &&
    recordStarts !== undefined &&
    !Array.isArray(recordStarts) &&
    !ArrayBuffer.isView(recordStarts)
  ) {
    throw new OptionError(
      `recordStarts must be a list of record start times, or null, got ` +
        `${describeValue(recordStarts)}. It is where the records really sit, which is what ` +
        `makes a discontinuous recording span more time than it holds.`,
    );
  }
  /*
    And what is in the list, which is where the failure above actually lands.

    That check asks whether the argument is a list and stops, and the contradiction its own
    paragraph describes for a string comes straight back from a list of them:

        resolveRange({ recordDuration: 1, recordCount: 3, recordStarts: ['a', 'b', 'c'] })
        { startSeconds: 0, endSeconds: 3, startRecord: 0, endRecord: 0, isWholeRecording: true }

    A range that calls itself the whole recording and covers none of it. `span` reads each
    start to find the earliest and the latest, and every comparison against a string is false,
    so it falls back to the contiguous span — which is why `endSeconds` looks right. Then
    `selectRecords` compares the same strings again and matches no record at all. `NaN` takes
    the identical route, and `NaN` is what a list built by parsing text arrives as.

    A record whose position is unknown is `null`, which `readAnnotations` really does hand
    back and which the code below already places from its neighbours. That is the one
    non-number this takes.
  */
  if (recordStarts !== null && recordStarts !== undefined) {
    const starts = recordStarts as ArrayLike<unknown>;
    /*
      And one for every record, which is what the field is documented to be: "True start time
      of each data record". A shorter list is not a partial answer, it is a shorter recording:

          resolveRange({ recordDuration: 1, recordCount: 3, recordStarts: [0] })
          { startSeconds: 0, endSeconds: 1, startRecord: 0, endRecord: 1,
            isWholeRecording: true }

      One record of the three, called the whole recording — the same contradiction the check
      below removes for a list of strings, reached by leaving entries out instead of filling
      them wrongly. `span` reads the earliest and latest off whatever it is given and
      `selectRecords` matches only the indexes it holds, so a list of one describes a file of
      one however many records the caller said there were.

      Empty is the exception, and it is not a short list: `[]` is how "no record times are
      known" arrives, which the two functions below already answer by falling back to
      contiguous positions. `null` says the same thing and is the form the reader hands over.
    */
    if (starts.length !== 0 && starts.length !== recordCount) {
      // Both counts through the helpers, like every other sentence that puts one number
      // against another: the phrase exists to compare them.
      throw new OptionError(
        `recordStarts has ${grouped(starts.length)} of the ` +
          `${counted(recordCount as number, 'record start time')} this recording needs. It is ` +
          `where each data record really sits, so a shorter list describes a shorter ` +
          `recording; pass null, or an empty list, where none are known.`,
      );
    }
    for (let at = 0; at < starts.length; at++) {
      const start = starts[at];
      if (start === null || start === undefined || Number.isFinite(start)) continue;
      throw new OptionError(
        `recordStarts[${at}] must be the second that record starts at, or null where it is ` +
          `not known, got ${describeValue(start)}. A start that is not a number matches no ` +
          `record, so the window comes back empty and calls itself the whole recording.`,
      );
    }
  }
}

/**
 * The recording to read, checked before it is opened.
 *
 * `EdfFile.open` hands whatever it is given to `fs`, and the refusal comes back as an
 * `EdfError` coded `UNREADABLE`, hinted "Check the path is spelled the way it is on disk and
 * that you have permission to read it" — advice about a path, over a value that is not one,
 * filed as a problem with the recording rather than with the call. `convert({ input: 'a.edf' })`,
 * which is the option-bag shape the second parameter has, answered `Cannot read "[object
 * Object]"`; `convert(['a.edf', 'b.edf'])` answered `Cannot read "a.edf,b.edf"`, a path the
 * caller never wrote, because `String` of an array joins it with commas.
 *
 * The empty string is left to `fs`, which has no such file and says so truthfully — the same
 * reasoning `outputDir` states for not trimming: a path is not a keyword.
 */
export function assertInputPath(input: unknown): void {
  if (typeof input !== 'string') {
    throw new OptionError(`input must be a path to a recording, got ${describeValue(input)}.`);
  }
}

/**
 * How a rejected value reads in the refusal: numbers bare, everything else quoted so its
 * type is visible.
 *
 * `JSON.stringify` has no text for a function or a symbol — it returns `undefined`, not a
 * string — so `layout: () => 'long'` came back as `layout must be "wide" or "long", got
 * undefined.`, which names the one value that does not raise this: every option here is
 * optional, and `undefined` is how a caller says they are not passing it. `input` was worse,
 * since `convert(undefined)` and `convert(someFunction)` then produced the same sentence, and
 * the first is a forgotten argument while the second is a wrong one.
 *
 * Exported because time-range.ts had the identical function, fixed there and not here — the
 * same two-copies-of-one-helper the derived precision and the pluraliser were each pulled
 * together for.
 */
export function describeValue(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value);
}
