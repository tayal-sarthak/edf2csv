/**
 * Number formatting for CSV cells.
 *
 * A one-hour, 23-channel, 256 Hz recording is about 21 million numeric cells, so
 * this is the hottest code in a conversion. Two things keep it cheap:
 *
 *  - Every sample in a channel comes from a bounded set of integers (digitalMin to
 *    digitalMax, typically 4096 distinct values for a 12-bit ADC). The formatted
 *    text for a digital code never changes, so it is computed once and reused.
 *  - The cache fills lazily. Real recordings visit only a fraction of the range,
 *    and a channel with an implausibly wide range falls back to direct formatting
 *    rather than reserving memory it will never use.
 */

import type { EdfSignal } from '../edf/header.js';
import { makeScaler } from '../edf/scale.js';

/** Widest digital range worth caching: 16 bits of pointers is 512 KB per channel. */
const MAX_CACHED_SPAN = 1 << 16;

/**
 * Format with a fixed number of decimals, normalising negative zero.
 *
 * Without this, a sample that scales to a very small negative value prints as
 * "-0.000", which looks like a distinct measurement but is not.
 */
export function fixed(value: number, decimals: number): string {
  // An undefined value becomes an empty cell rather than the text "NaN" or "Infinity".
  // A channel whose header leaves the digital-to-physical mapping undefined scales to
  // NaN, and an empty field is the CSV convention for "no value here" — the same one
  // annotations.csv uses for an absent duration. Readers parse it back as NaN / NA
  // rather than as a measurement.
  if (!Number.isFinite(value)) return '';
  const text = value.toFixed(decimals);
  if (text.charCodeAt(0) !== 45 /* - */) return text;
  // Cheap check for "-0", "-0.0", "-0.000"...
  for (let i = 1; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 46 /* . */ || c === 48 /* 0 */) continue;
    return text;
  }
  return text.slice(1);
}

/** Maps a raw digital sample to its formatted physical value. */
export type SampleFormatter = (digital: number) => string;

export function makeSampleFormatter(signal: EdfSignal, decimals: number): SampleFormatter {
  const scale = makeScaler(signal);
  const low = Math.min(signal.digitalMin, signal.digitalMax);
  const high = Math.max(signal.digitalMin, signal.digitalMax);
  const span = high - low + 1;

  // Samples may fall outside the declared digital range in non-conforming files,
  // so the cache covers the full int16 domain when the declared range is small.
  if (!Number.isFinite(span) || span <= 0 || span > MAX_CACHED_SPAN) {
    return (digital: number): string => fixed(scale(digital), decimals);
  }

  const cacheLow = -32768;
  const cache = new Array<string | undefined>(65536);
  return (digital: number): string => {
    const slot = digital - cacheLow;
    if (slot >= 0 && slot < 65536) {
      const hit = cache[slot];
      if (hit !== undefined) return hit;
      const text = fixed(scale(digital), decimals);
      cache[slot] = text;
      return text;
    }
    return fixed(scale(digital), decimals);
  };
}

/**
 * Decimals for the time column.
 *
 * The interval between samples is 1/rate, which has a terminating decimal
 * expansion of d places exactly when 10^d divides evenly by the rate. Every rate
 * in common use clears this — 256 Hz needs 8 places, 512 Hz needs 9, 250 Hz and
 * 1000 Hz need 3 — so sample times are written exactly rather than rounded, and
 * `time_s * rate` comes back as a whole number instead of 8191.999999.
 *
 * Rates with a repeating expansion (3 Hz, say) fall back to enough places to keep
 * consecutive samples distinct.
 */
export function timeDecimals(samplingRate: number): number {
  if (!(samplingRate > 0) || !Number.isFinite(samplingRate)) return 3;
  for (let d = 0; d <= 9; d++) {
    if (Number.isInteger(10 ** d / samplingRate)) return Math.max(3, d);
  }
  return Math.min(9, Math.max(3, Math.ceil(Math.log10(samplingRate)) + 3));
}

/** Human-readable byte size for warnings and summaries. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${rounded} ${units[unit]}`;
}

/** Human-readable duration: 1h 05m 12s. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds - h * 3600 - m * 60;
  const sText = Number.isInteger(s) ? String(s) : s.toFixed(3).replace(/\.?0+$/u, '');
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${sText}s`;
  if (m > 0) return `${m}m ${sText}s`;
  return `${sText}s`;
}
