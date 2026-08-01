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

  // A zero digital span leaves the mapping undefined — the header contradicts itself.
  // Reporting the physical minimum is the least misleading answer, and the header
  // parser has already raised DEGENERATE_DIGITAL_RANGE so the user is not misled.
  if (digitalMax === digitalMin) return () => physicalMin;

  const gain = (physicalMax - physicalMin) / (digitalMax - digitalMin);

  // A flat physical range makes every sample the same value, and would divide by
  // zero in the offset below.
  if (gain === 0 || !Number.isFinite(gain)) return () => physicalMin;

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
 * Decimal places needed so that two adjacent digital codes never round to the same
 * string. Two places past the quantization step keep rounding error far below the
 * resolution the hardware actually recorded, without padding the file with digits
 * that carry no information.
 *
 * The ceiling is 15 rather than a tidier number because a channel calibrated in
 * volts rather than microvolts has a step near 1e-7, and one in tesla smaller
 * still. A lower cap would round genuinely different samples to the same text. It
 * costs nothing for ordinary channels, whose step lands them at three or four.
 */
export function decimalsForSignal(signal: EdfSignal, max = 15): number {
  const step = quantizationStep(signal);
  if (!(step > 0) || !Number.isFinite(step)) return 3;
  const needed = Math.ceil(-Math.log10(step)) + 2;
  return Math.min(max, Math.max(0, needed));
}
