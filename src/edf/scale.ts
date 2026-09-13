/**
 * Digital-to-physical conversion.
 *
 * EDF defines the mapping by two calibration points, (digitalMin -> physicalMin)
 * and (digitalMax -> physicalMax), which the specification writes as:
 *
 *   gain     = (physicalMax - physicalMin) / (digitalMax - digitalMin)
 *   physical = (digital - digitalMin) * gain + physicalMin
 *
 * That form is evaluated here in EDFlib's algebraically equivalent arrangement:
 *
 *   offset   = physicalMax / gain - digitalMax
 *   physical = gain * (offset + digital)
 *
 * The rearrangement is not cosmetic. Written the first way, a channel spanning
 * +/-800 uV computes a value near 800 and then subtracts 800, and the cancellation
 * throws away low-order bits: digital 0 yields 0.19536019536019467 when the exact
 * value is 0.19536019536019536. EDFlib's form keeps the intermediate small
 * (offset + digital = 0.5 here) and returns the correctly rounded result.
 *
 * Both properties matter. The values are as accurate as a double can express, and
 * they are bit-identical to pyEDFlib and EDFbrowser, which share EDFlib's arithmetic,
 * so the test suite can assert exact equality against a reference implementation
 * rather than settling for a tolerance.
 */

import type { EdfSignal } from './header.js';
import { OptionError, describeValue } from '../convert/options.js';

export type Scaler = (digital: number) => number;

/** The four header fields this reads, in the order a message should name them. */
const CALIBRATION = ['digitalMin', 'digitalMax', 'physicalMin', 'physicalMax'] as const;

/**
 * The four calibration numbers, confirmed to be on the thing that was passed.
 *
 * Written for `makeScaler` in 0.8.61 and shared since 0.8.76, when the two functions beside
 * it turned out to read the same four fields off the same argument and ask nothing of it.
 * Both answer rather than refuse:
 *
 *     quantizationStep({})     // 0     — the step of a channel whose header contradicts itself
 *     decimalsForSignal(42)    // 3     — the precision an ordinary EEG channel gets
 *
 * `undefined - undefined` is `NaN`, `NaN === 0` is false, and the division that follows gives
 * `NaN`; `quantizationStep` returns it as a step, and `decimalsForSignal` reads a step that is
 * not a positive number as "this channel has none to derive from" and falls back to three
 * places. Both of those are real answers for real channels — a zero digital span is what
 * `DEGENERATE_DIGITAL_RANGE` reports, and three places is what most EEG gets — so a caller
 * holding the wrong object gets a number they have no way to doubt.
 */
function assertCalibration(signal: EdfSignal): void {
  if (typeof signal !== 'object' || signal === null) {
    throw new OptionError(`signal must be a channel from a header, got ${describeValue(signal)}.`);
  }
  const missing = CALIBRATION.find((name) => typeof signal[name] !== 'number');
  if (missing !== undefined) {
    throw new OptionError(
      `signal.${missing} must be a number, got ${describeValue(signal[missing])}.`,
    );
  }
}

export function makeScaler(signal: EdfSignal): Scaler {
  /*
    The argument, checked like the arguments of the other exported functions.

    Every branch below reads four numbers off `signal`, and the first of them — the one that
    catches a header contradicting itself — is `digitalMax === digitalMin`. On an object that
    has neither, that comparison is `undefined === undefined`, which is true. So
    `makeScaler({})` came back as a working function returning NaN for every sample, which is
    exactly what a real channel with a zero digital span returns.

    A caller cannot tell the two apart. The api page recommends this function for reading
    physical units out of a file, and the empty column it produces is documented as meaning
    "the header contradicts itself" — a sentence about the recording, over a call that passed
    the wrong object. The diagnostic that normally accompanies it, DEGENERATE_DIGITAL_RANGE,
    comes from the header parser and is not raised here at all.
  */
  assertCalibration(signal);
  const { digitalMin, digitalMax, physicalMin, physicalMax } = signal;

  // A zero digital span leaves the mapping undefined — the header contradicts itself,
  // so there is no physical value for any sample on this channel.
  //
  // NaN rather than a stand-in number. Writing the physical minimum produces a column
  // of plausible readings ("-100.000" repeated) that is indistinguishable from a real
  // flat recording once the CSV is opened somewhere else, which is exactly the kind of
  // invented data this tool exists to avoid. NaN carries through to an empty CSV cell
  // and reads back as NaN in pandas, matching how a missing annotation duration is
  // already written. DEGENERATE_DIGITAL_RANGE is raised alongside it.
  if (digitalMax === digitalMin) return () => NaN;

  const gain = (physicalMax - physicalMin) / (digitalMax - digitalMin);

  /*
    A flat physical range makes every sample the same value, and would divide by zero in the
    offset below. That mapping is defined, so its constant is written.

    A gain of zero does not always mean flat, and this could not tell the difference. A range
    of -1e-320 to 1e-320 is not flat — it is 65,536 distinct physical values — but the gain
    is 2e-320/65535, which is smaller than the smallest subnormal double and underflows to
    +0. Every distinct sample then took `physicalMin`, so eight codes spanning -16,000 to
    +12,000 came out as one repeated number, with no diagnostic anywhere and `--strict`
    exiting 0. At 1e-319, one power of ten away, the same file raises VALUE_RESOLUTION.

    That is the same situation as the overflow below it, which this codebase already reasoned
    about and answered: the span cannot be represented, so there is no mapping, so the cells
    are left empty rather than filled with a value the header cannot justify. Underflow only
    got the flat-range treatment because `gain === 0` is what both look like from here.
  */
  if (gain === 0) return physicalMax === physicalMin ? (): number => physicalMin : (): number => NaN;

  // A non-finite gain is a different thing: the physical span overflowed a double, so
  // there is no mapping at all. Returning physicalMin filled the column with one enormous
  // constant — every distinct sample rendered as the same 300-digit number — and raised
  // nothing. NaN takes the same route as a degenerate digital range: empty cells, plus
  // UNUSABLE_PHYSICAL_RANGE from the header parser.
  if (!Number.isFinite(gain)) return () => NaN;

  // Deriving the offset divides by the gain. For every realistic calibration that is
  // both safe and more accurate, but an absurd header (a huge physical range over a
  // near-zero gain) could overflow it, so fall back to the specification's own
  // arrangement rather than emitting Infinity.
  const offset = physicalMax / gain - digitalMax;
  if (!Number.isFinite(offset)) {
    return (digital: number): number => (digital - digitalMin) * gain + physicalMin;
  }

  return (digital: number): number => gain * (offset + digital);
}

/**
 * Smallest physical step this channel can express — one digital unit.
 * Used to choose a decimal precision that preserves every distinct sample value.
 */
export function quantizationStep(signal: EdfSignal): number {
  // See `assertCalibration`: without it `quantizationStep({})` answered 0, which is the step
  // of a channel whose header contradicts itself.
  assertCalibration(signal);
  const digitalSpan = signal.digitalMax - signal.digitalMin;
  if (digitalSpan === 0) return 0;
  return Math.abs((signal.physicalMax - signal.physicalMin) / digitalSpan);
}

/**
 * The most `toFixed` accepts. 101 is a RangeError, so this is the ceiling, not a taste.
 *
 * It used to be 20, on the stated grounds that 20 was what `toFixed` allowed. It is not,
 * and the gap was not academic: a magnetometer channel spanning ±1e-16 T over a 16-bit
 * converter has a step of 3.05e-21 and needs 23 places. Clamped to 20, every value landed
 * on a 1e-20 grid — about three digital codes to a printed value — so 69% of the samples
 * could not be recovered, the conversion exited 0, and nothing said a word. The channel
 * type the old comment named as the reason for the ceiling was the one it broke.
 */
const MAX_DERIVED_DECIMALS = 100;

/**
 * Places this channel needs before any ceiling, or null when it has no step to derive one from.
 *
 * One expression, because two functions depend on agreeing about it. `decimalsForSignal`
 * computed `Math.ceil(-Math.log10(step)) + 2` and clamped it; `decimalsAreClamped` computed the
 * same thing again and compared it to the same ceiling. Two copies of one formula whose only
 * job is to give the same answer — change either `+ 2` and they part company at the boundary,
 * so a channel whose precision really was capped is reported as not capped, VALUE_RESOLUTION is
 * not raised, and its codes print indistinguishable in silence. Which is the exact thing that
 * warning exists to say.
 */
function decimalsNeeded(signal: EdfSignal): number | null {
  const step = quantizationStep(signal);
  if (!(step > 0) || !Number.isFinite(step)) return null;
  return Math.ceil(-Math.log10(step)) + 2;
}

/**
 * Decimal places needed so that two adjacent digital codes never round to the same
 * string. Two places past the quantization step keep rounding error far below the
 * resolution the hardware actually recorded, without padding the file with digits
 * that carry no information.
 *
 * Ordinary channels land at three or four: a ±800 µV channel over 12 bits steps by
 * 0.39 µV and needs three. The ceiling is only reached by calibrations whose step is
 * below 1e-98, which an 8-character physical bound can still express — `1e-99` is five
 * characters. Those get VALUE_RESOLUTION rather than silence.
 */
export function decimalsForSignal(signal: EdfSignal, max = MAX_DERIVED_DECIMALS): number {
  /*
    The ceiling, which is the caller's to choose and was the caller's to get wrong.

    0.8.76 checked the channel. The second argument went on being whatever was passed, and
    `Math.min` carries it straight out:

        decimalsForSignal(signal, -5)    // -5
        decimalsForSignal(signal, 2.5)   // 2.5
        decimalsForSignal(signal, 'x')   // NaN

    A negative number of decimal places, a fractional one, and not a number — from the
    function whose whole answer is how many places a column needs. Each is a `RangeError` out
    of `toFixed` at the point the caller uses it, one call later and somewhere else.

    A whole number of places, and not bounded above: handing this a ceiling nothing can reach
    is how a caller asks what a channel would need without one, which is how
    `decimalsAreClamped` is checked against this function rather than against its own copy of
    the formula.
  */
  if (!Number.isInteger(max) || max < 0) {
    throw new OptionError(
      `max must be a whole number of decimal places, zero or more, got ${describeValue(max)}. ` +
        `It is a ceiling on the precision this derives; the default is ` +
        `${MAX_DERIVED_DECIMALS}, which is what toFixed accepts.`,
    );
  }
  const needed = decimalsNeeded(signal);
  // The ceiling applies to the fallback too. A channel with no step to derive from takes the
  // ordinary three places, and `decimalsForSignal(signal, 0)` returned them — a ceiling of
  // zero answered with three, on the one branch that does not measure anything.
  if (needed === null) return Math.min(max, 3);
  return Math.min(max, Math.max(0, needed));
}

/**
 * Whether this channel's step is finer than any precision the tool can print.
 *
 * Asked of the ceiling, not of the precision in use. `--decimals 2` on a channel needing 3
 * is a trade the caller made knowingly and is not this warning's business — 0.5.10 fixed a
 * version of this that fired on every ordinary EEG at `--decimals 2` and made
 * `--decimals 2 --strict` impossible. But it fixed it by asking "did the caller choose the
 * precision", which suppressed the real case too: at `--decimals 20` a channel stepping by
 * 1e-106 printed every one of its codes as `0.00000000000000000000`, in silence.
 *
 * The question is whether anything the tool can print would separate consecutive codes. When
 * the answer is no, that is a ceiling nobody chose, and it holds whatever `--decimals` says.
 */
export function decimalsAreClamped(signal: EdfSignal): boolean {
  const needed = decimalsNeeded(signal);
  return needed !== null && needed > MAX_DERIVED_DECIMALS;
}
