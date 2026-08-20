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

export type Scaler = (digital: number) => number;

export function makeScaler(signal: EdfSignal): Scaler {
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

export function decimalsForSignal(signal: EdfSignal, max = MAX_DERIVED_DECIMALS): number {
  const needed = decimalsNeeded(signal);
  if (needed === null) return 3;
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
