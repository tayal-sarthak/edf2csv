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
 * How many cached sample slots a conversion has left to spend.
 *
 * MAX_CACHED_SPAN is a bound on one channel, and a bound on one channel is not a bound: a
 * file may declare as many channels as it likes, and each was handed its own cache. A
 * channel declaring the ordinary full 16-bit digital range takes the whole 512 KB, so a
 * 256-channel montage reserved 134 MB of pointers before writing a row — a 7.9 MB
 * recording that needed a 192 MB heap and died with a V8 out-of-memory fatal error under
 * anything smaller. The caches were the live set; nothing else in the conversion came near
 * them. It is the same shape of mistake the offset budget below was made to fix, one level
 * over: there the unbounded count was rate groups, here it is channels.
 *
 * One budget for the whole conversion leaves the ordinary recording exactly as it was and
 * puts a ceiling on the dense montage: the same 256-channel file now holds its caches to
 * 16 MB and converts under a 48 MB heap. Channels ask in the order the groups are written,
 * which is fastest rate first, so the cache goes to the channels with the most cells to
 * format. The ones that miss out fall back to formatting directly, which produces
 * identical text — the output is byte-for-byte what it was.
 */
export interface SampleCacheBudget {
  remaining: number;
}

/**
 * Slots for the whole conversion: 16 MB of pointers if every one is claimed.
 *
 * Enough that a full 32-channel montage declaring the whole 16-bit range keeps every cache
 * it had before, and 512 channels of an ordinary 12-bit ADC do too. Past that the extra
 * channels format directly, which costs about a quarter of the conversion's time on a
 * recording where almost none of them are cached — against a file that did not convert at
 * all under a 128 MB heap.
 */
const MAX_CACHED_SAMPLES = 1 << 21;

export function newSampleCacheBudget(): SampleCacheBudget {
  return { remaining: MAX_CACHED_SAMPLES };
}

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

export function makeSampleFormatter(
  signal: EdfSignal,
  decimals: number,
  budget: SampleCacheBudget = newSampleCacheBudget(),
): SampleFormatter {
  const scale = makeScaler(signal);
  const low = Math.min(signal.digitalMin, signal.digitalMax);
  const high = Math.max(signal.digitalMin, signal.digitalMax);
  const span = high - low + 1;

  if (
    !Number.isFinite(span) ||
    span <= 0 ||
    span > MAX_CACHED_SPAN ||
    span > budget.remaining
  ) {
    return (digital: number): string => fixed(scale(digital), decimals);
  }
  budget.remaining -= span;

  /*
    The cache covers the channel's declared digital range, not the whole int16 domain.

    Allocating 65536 slots regardless of span cost 512 KB of pointers per channel, which a
    dense montage cannot afford: a 400-channel recording needed over 200 MB of cache alone
    and died with a V8 out-of-memory fatal error before writing a row. Sizing to the
    declared span makes the ordinary 12-bit channel 32 KB instead — the same 400 channels
    now fit in about 13 MB. Channels that declare the full range still take the whole 512 KB,
    which is what the budget above is for.

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
 * The interval between samples is 1/rate, which has a terminating decimal expansion of d
 * places exactly when 10^d divides evenly by the rate. Writing that many places makes sample
 * times exact rather than rounded, so `time_s * rate` comes back as a whole number instead
 * of 8191.999999.
 *
 * The search used to stop at nine places, and the comment here claimed "every rate in common
 * use clears this — 256 Hz needs 8 places, 512 Hz needs 9". The next two powers of two do
 * not: 1/1024 needs ten places and 1/2048 needs eleven, and those are the rates a BioSemi
 * ActiveTwo records at by default. Both fell through to the rounding fallback, so the two
 * most common high-rate EEG recordings got exactly the behaviour this function exists to
 * avoid — 0.0009766 for an interval of 0.0009765625.
 *
 * A rate of 2^a * 5^b terminates in max(a, b) places, so fifteen covers every power of two up
 * to 32768 Hz, far past anything that records biosignals. Rates with a repeating expansion
 * (3 Hz, say) still fall back to enough places to keep consecutive samples distinct, and that
 * fallback keeps its own cap.
 *
 * Fifteen and not more, because the test below has to stay exact: 10^16 is past 2^53, where a
 * double can no longer hold every integer, and `Number.isInteger(10 ** 17 / 3)` is true — so a
 * larger bound reports a terminating expansion for rates that have none, and 3 Hz would ask
 * for seventeen decimals of a number that repeats forever.
 *
 * The fallback is bounded by the same fifteen. It used to stop at nine, which defeated the
 * one thing it exists to do: at 3e10 Hz — non-terminating, so no exact expansion to find —
 * the interval is 3.3e-11 and nine places rounded every sample in a record to the same
 * timestamp. A column that cannot tell two samples apart is not keeping them distinct, which
 * is what this branch is for.
 */
const MAX_TIME_DECIMALS = 15;

export function timeDecimals(samplingRate: number): number {
  if (!(samplingRate > 0) || !Number.isFinite(samplingRate)) return 3;
  for (let d = 0; d <= MAX_TIME_DECIMALS; d++) {
    if (Number.isInteger(10 ** d / samplingRate)) return Math.max(3, d);
  }
  return Math.min(MAX_TIME_DECIMALS, Math.max(3, Math.ceil(Math.log10(samplingRate)) + 3));
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
  let rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  // Rounding can carry into the next unit, and the unit was chosen before it: 1,048,575 bytes
  // is 1023.999 KB, which printed as "1024 KB". The same slip formatDuration below fixed by
  // rounding before splitting, one function up.
  if (rounded === 1024 && unit < units.length - 1) {
    unit++;
    rounded = 1;
  }
  return `${rounded} ${units[unit]}`;
}

/** Human-readable duration: 1h 05m 12s. */
export function formatDuration(seconds: number): string {
  // A duration that is not a number cannot be broken into hours and minutes, and saying so
  // beats the alternative: the fallback below rendered these as "NaNs" and "Infinitys".
  if (!Number.isFinite(seconds)) return 'unknown';

  /*
    Past 2^53 the decomposition stops being arithmetic and starts being noise.

    `total - h * 3600 - m * 60` cannot be exact once `total` exceeds what a double can hold
    as a whole number, and the error lands in the seconds field, where it shows up as a
    value that cannot exist. A header declaring a record duration of 1e300 printed:

        Duration   8.333333333333333e+296h 48m -2880s

    Forty-eight minutes and minus forty-eight seconds, under an hours field in exponent
    notation. The seconds are the honest form for a figure this size — nobody reads
    285 million years as hours — and the record count and duration are printed beside it
    anyway, so a corrupt header stays just as visible.
  */
  if (seconds < 0 || seconds >= Number.MAX_SAFE_INTEGER) return `${seconds}s`;

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
 * How many cached offsets a conversion has left to spend.
 *
 * The cap used to be per rate group, and a file may hold as many rate groups as it has
 * channels. Twelve channels at twelve rates just under the cap — a 25 MB file — took
 * 1.66 GB and 36 seconds, where a 92 MB file at one rate takes 283 MB and finishes in a
 * fraction of that; twenty-four of them never finished at all. A per-group limit is not a
 * limit, since nothing bounds the number of groups.
 *
 * One budget for the whole conversion makes the single-group case identical to what it was
 * and the many-group case bounded. Groups ask in order of rate, fastest first, so the cache
 * goes to the tables with the most rows to write and the ones that miss out are the ones
 * that would have gained least.
 */
export interface OffsetBudget {
  remaining: number;
}

export function newOffsetBudget(): OffsetBudget {
  return { remaining: MAX_CACHED_OFFSETS };
}

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
  budget: OffsetBudget = newOffsetBudget(),
): (recordStart: number, sample: number) => string {
  const usable = rate > 0 && Number.isFinite(rate);

  /** The sum, formatted. Right only where the decomposition below does not apply. */
  const summed = (recordStart: number, sample: number): string =>
    fixed(recordStart + sample / rate, decimals);

  /*
    The same decomposition the table holds, computed on the spot.

    This used to be the sum, and that made the time column two columns depending on how much
    of the budget above was left. `recordStart + sample / rate` cannot carry the fraction once
    the record start is large: at a start of 1e9 and 30 kHz the exact instant is
    1000000000.0000333333, and the double nearest the sum prints as 1000000000.00003338 —
    the last two places are the addition's rounding, not the recording's clock.

    Which of the two a rate group got was decided by the groups ahead of it, since they ask
    from one budget fastest first. So a recording whose fast channel takes the table left its
    slow channel adding doubles, and the same channel asked for on its own got the table:

        edf2csv far.edf --out whole                 ->  1000000000.00003338
        edf2csv far.edf --out one --channels slow   ->  1000000000.00003333

    Two files from one recording disagreeing about when a sample was taken, in a tool whose
    documentation says `--channels` selects columns and changes nothing else. The narrowing
    sweep asserts exactly that and could not see it: its fixtures are small enough that the
    budget never runs out, so both conversions took the table.

    The sum is still the answer where the decomposition has nothing to stand on — a record
    starting on a fraction or before zero, where the whole part and the fraction are not
    separable — and past 1e21, where the whole part stops printing in full.
  */
  const composed = (recordStart: number, sample: number): string => {
    const text = fixed(sample / rate, decimals);
    const dot = text.indexOf('.');
    const whole = recordStart + (dot === -1 ? Number(text) : Number(text.slice(0, dot)));
    if (whole >= 1e21) return summed(recordStart, sample);
    return dot === -1 ? `${whole}` : `${whole}${text.slice(dot)}`;
  };

  /** What every row gets when the table is not there to be read. */
  const direct = (recordStart: number, sample: number): string =>
    usable && sample >= 0 && Number.isInteger(recordStart) && recordStart >= 0
      ? composed(recordStart, sample)
      : summed(recordStart, sample);

  if (!usable || samplesPerRecord <= 0 || samplesPerRecord > budget.remaining) {
    return direct;
  }
  budget.remaining -= samplesPerRecord;

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
    const whole = recordStart + (wholeOffset[sample] as number);
    /*
      The same 1e21 cliff `fixed` guards against, arriving through the back door.

      `${whole}` is the implicit Number-to-String conversion, which switches to exponent
      notation at 1e21 exactly as `toFixed` does — and then the cached fraction is glued onto
      the end of it, so the cell reads "1e+21.000". That is not a number in any notation:
      pandas and R both parse it as NaN, and a column of ordinary decimals ends in a run of
      them. A header may legitimately say `1e21` in its 8-character record-duration field, so
      three records are enough to reach it.

      The slow path already expands these with BigInt. One comparison per row keeps that
      correct without giving up the cache for the other twenty million.
    */
    if (whole >= 1e21) return summed(recordStart, sample);
    return `${whole}${fractionText[sample] as string}`;
  };
}
