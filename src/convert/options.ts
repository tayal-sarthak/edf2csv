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
const MAX_DECIMALS = 20;

export function assertOptions(options: {
  decimals?: number | undefined;
  start?: number | undefined;
  duration?: number | undefined;
  end?: number | undefined;
  layout?: string | undefined;
  channels?: readonly string[] | undefined;
}): void {
  const { decimals } = options;
  if (decimals !== undefined) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
      throw new OptionError(
        `decimals must be a whole number between 0 and ${MAX_DECIMALS}, got ${describe(decimals)}.`,
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
    const positive = name === 'duration';
    if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value < 0)) {
      throw new OptionError(`${name} must be a number of seconds, got ${describe(value)}.`);
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
    throw new OptionError(`layout must be "wide" or "long", got ${describe(layout)}.`);
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
      throw new OptionError(`channels must be a list of channel names, got ${describe(channels)}.`);
    }
    if (channels.every((term) => term.trim() === '')) {
      throw new OptionError('channels was given but lists no channel names.');
    }
  }
}

/** `NaN` and `-1` read better unquoted; anything else is quoted so its type is visible. */
function describe(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}
