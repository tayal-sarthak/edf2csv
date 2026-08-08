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

/** The largest `toFixed` will accept, and what `--decimals` has always documented. */
const MAX_DECIMALS = 20;

export function assertOptions(options: {
  decimals?: number | undefined;
  start?: number | undefined;
  duration?: number | undefined;
  end?: number | undefined;
  layout?: string | undefined;
}): void {
  const { decimals } = options;
  if (decimals !== undefined) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
      throw new OptionError(
        `decimals must be a whole number between 0 and ${MAX_DECIMALS}, got ${describe(decimals)}.`,
      );
    }
  }

  // Seconds from the start of the recording, so a negative one names a moment before the
  // recording began. The command line cannot express these — parseTimeSpec rejects them —
  // and the library could, all the way through to a half-written directory.
  for (const name of ['start', 'duration', 'end'] as const) {
    const value = options[name];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
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
}

/** `NaN` and `-1` read better unquoted; anything else is quoted so its type is visible. */
function describe(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}
