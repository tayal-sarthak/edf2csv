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

  // toFixed switches to exponent notation at 1e21, which would put "1e+21" in a column
  // whose every other cell is plain fixed-decimal — and a reader parsing the column as
  // decimal text has no reason to expect it. Reachable because EDF's 8-character physical
  // range fields accept exponent form, so a header may legitimately say "1e30".
  //
  // Above 2^53 a double carries no fractional part anyway, so the integer expansion is
  // exact rather than an approximation of one.
  if (Math.abs(value) >= 1e21) {
    const whole = BigInt(Math.trunc(value)).toString();
    return decimals > 0 ? `${whole}.${'0'.repeat(decimals)}` : whole;
  }

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

  if (!Number.isFinite(span) || span <= 0 || span > MAX_CACHED_SPAN) {
    return (digital: number): string => fixed(scale(digital), decimals);
  }

  /*
    The cache covers the channel's declared digital range, not the whole int16 domain.

    Allocating 65536 slots regardless of span cost 512 KB of pointers per channel, which a
    dense montage cannot afford: a 400-channel recording needed over 200 MB of cache alone
    and died with a V8 out-of-memory fatal error before writing a row. Sizing to the
    declared span makes the ordinary 12-bit channel 32 KB instead — the same 400 channels
    now fit in about 13 MB.

    Samples outside the declared range still occur in non-conforming files. They simply
    miss the cache and are formatted directly, which produces identical text.
  */
  const cache = new Array<string | undefined>(span);
  return (digital: number): string => {
    const slot = digital - low;
    if (slot >= 0 && slot < span) {
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

  // Round to the precision that will actually be printed BEFORE splitting into units.
  // Splitting first left the remainder to be rounded on its own, so 3599.9996 s decomposed
  // as 59 minutes and 59.9996 seconds and then printed as "59m 60s" — a duration that
  // cannot exist. Rounding first carries the extra second into the minute where it belongs.
  const total = Math.round(seconds * 1000) / 1000;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.round((total - h * 3600 - m * 60) * 1000) / 1000;
  const sText = Number.isInteger(s) ? String(s) : s.toFixed(3).replace(/\.?0+$/u, '');
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${sText}s`;
  if (m > 0) return `${m}m ${sText}s`;
  return `${sText}s`;
}

/** A record can declare a great many samples; two arrays this size is the cost of caching. */
const MAX_CACHED_OFFSETS = 1 << 20;

/**
 * Formats the time column, reusing the part of it that repeats.
 *
 * Every value cell is already cached — a channel has at most `digitalMax - digitalMin + 1`
 * distinct readings, so the same handful of strings serve millions of rows. The time column
 * had no such luck: it rises monotonically, so no two rows share a string and `toFixed` ran
 * once per row. On a ten-million-row conversion that was a third of the total time, more
 * than reading the file and writing the CSV put together.
 *
 * What repeats is the offset within a record. Sample `s` sits at `s / rate` from the start of
 * whichever record holds it, and there are only `samplesPerRecord` such offsets in the whole
 * recording. Splitting each into whole seconds and printed fraction turns the per-row work
 * into one integer addition and a concatenation:
 *
 *     record starting at 42s, sample 7 of a 100 Hz record
 *     -> 42 + 0 whole seconds, fraction ".070"  ->  "42.070"
 *
 * The decomposition is only valid when the record starts on a whole, non-negative second,
 * which is what lets the fraction come entirely from the offset. A record starting at 0.5 s would mix the
 * two, so those fall back to formatting the sum directly. Continuous recordings start every
 * record at `index * recordDuration`, so this holds for all of them whose record duration is
 * a whole number of seconds, and for discontinuous files it holds per record depending on
 * where that record actually starts.
 */
export function makeTimeFormatter(
  samplesPerRecord: number,
  rate: number,
  decimals: number,
): (recordStart: number, sample: number) => string {
  const direct = (recordStart: number, sample: number): string =>
    fixed(recordStart + sample / rate, decimals);

  if (
    !(rate > 0) ||
    !Number.isFinite(rate) ||
    samplesPerRecord <= 0 ||
    samplesPerRecord > MAX_CACHED_OFFSETS
  ) {
    return direct;
  }

  // Whole seconds and printed fraction of each offset, taken from the formatted offset
  // itself so that an offset which rounds up to the next second (0.9996 at three places)
  // carries that second rather than losing it.
  const wholeOffset = new Float64Array(samplesPerRecord);
  const fractionText: string[] = new Array<string>(samplesPerRecord);
  for (let sample = 0; sample < samplesPerRecord; sample++) {
    const text = fixed(sample / rate, decimals);
    const dot = text.indexOf('.');
    wholeOffset[sample] = dot === -1 ? Number(text) : Number(text.slice(0, dot));
    fractionText[sample] = dot === -1 ? '' : text.slice(dot);
  }

  return (recordStart: number, sample: number): string => {
    /*
      Non-negative only. Appending a fraction to a negative whole part moves the time the
      wrong way: a record at -5 s and an offset of half a second is -4.5, but "-5" and
      ".500" concatenate to -5.500. Recording times start at zero, so this is unreachable
      from a well-formed file — an EDF+ timekeeping TAL is free to carry a negative onset
      though, and that is enough reason for the fast path to decline it.
    */
    if (
      sample < 0 ||
      sample >= samplesPerRecord ||
      !Number.isInteger(recordStart) ||
      recordStart < 0
    ) {
      return direct(recordStart, sample);
    }
    return `${recordStart + (wholeOffset[sample] as number)}${fractionText[sample] as string}`;
  };
}
