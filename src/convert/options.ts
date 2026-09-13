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
}): void {
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
}): void {
  const { recordDuration, recordCount } = input ?? {};
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
