/**
 * Channel naming and selection.
 *
 * Two real-world facts drive this module. EDF labels are free text that routinely
 * contain spaces and punctuation ("EEG Fpz-Cz"), and they are not guaranteed to be
 * unique — CHB-MIT recordings ship two channels both labelled "T8-P8", and some
 * carry a channel labelled "-". Labels are therefore preserved verbatim in output,
 * and only disambiguated when the file itself is ambiguous.
 */

import type { EdfSignal } from '../edf/header.js';
import { listed } from '../format/list.js';

export class ChannelSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelSelectionError';
  }
}

/**
 * Column name for a signal.
 *
 * Names are derived from the whole file, not from the current selection, so a given
 * channel always produces the same column regardless of which channels were asked
 * for. Duplicated labels get a `_ch<index>` suffix pointing at their position in
 * the file, which is the only thing that reliably tells them apart.
 */
export function buildColumnNames(signals: readonly EdfSignal[]): Map<number, string> {
  const counts = new Map<string, number>();
  for (const signal of signals) {
    if (signal.isAnnotations) continue;
    const base = baseName(signal);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }

  const names = new Map<number, string>();
  for (const signal of signals) {
    if (signal.isAnnotations) continue;
    const base = baseName(signal);
    const duplicated = (counts.get(base) ?? 0) > 1;
    names.set(signal.index, duplicated ? `${base}_ch${signal.index}` : base);
  }

  /*
    The suffix has to be checked against the file, not only against the label it disambiguates.

    Counting collisions on the raw label alone made the suffix a guess: `_ch<index>` is unique
    among the channels sharing that label, and nothing stopped it from landing on a label some
    other channel already had. A file labelled T8, T8, T8_ch0 — all three legal, since EDF
    labels are free text and nothing enforces uniqueness — produced

        time_s,T8_ch0,T8_ch1,T8_ch0

    two columns with one name, while the warning beside it said the suffix kept them
    "distinguishable". channels.csv listed the same name against two signal indices, so the
    join it exists for could not resolve it either, and `df["T8_ch0"]` in pandas or R returns
    one of the two with nothing to say which.

    Anything still shared after the first pass takes its own position as well. That is unique
    by construction, so the loop settles immediately in practice; the bound is there because
    a second round could in principle land on yet another literal label.
  */
  for (let round = 0; round < 8; round++) {
    const taken = new Map<string, number>();
    for (const name of names.values()) taken.set(name, (taken.get(name) ?? 0) + 1);

    const clashing = [...names].filter(([, name]) => (taken.get(name) ?? 0) > 1);
    if (clashing.length === 0) break;
    for (const [index, name] of clashing) names.set(index, `${name}_ch${index}`);
  }
  return names;
}

function baseName(signal: EdfSignal): string {
  return signal.label === '' ? `signal_${signal.index}` : signal.label;
}

/**
 * Channels whose column name was pushed off their own label to keep the header unique.
 *
 * A channel genuinely labelled `T8_ch0` loses that name when another label's disambiguating
 * suffix wants it, and the resulting column is the one thing in the output that no longer
 * matches the file. Silence there is what made the collision hard to see in the first place:
 * the only warning raised was about the *other* label.
 */
export function renamedByCollision(
  signals: readonly EdfSignal[],
  columnNames: ReadonlyMap<number, string>,
): EdfSignal[] {
  const counts = new Map<string, number>();
  for (const signal of signals) {
    if (signal.isAnnotations) continue;
    const base = baseName(signal);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return signals.filter(
    (signal) =>
      !signal.isAnnotations &&
      (counts.get(baseName(signal)) ?? 0) === 1 &&
      columnNames.get(signal.index) !== baseName(signal),
  );
}

export interface ChannelSelection {
  signals: EdfSignal[];
  /** Labels that matched more than one channel, so the user knows why they got extras. */
  ambiguous: { term: string; matched: EdfSignal[] }[];
}

/**
 * Resolve a `--channels` specification against the file's signals.
 *
 * Matching is case-insensitive on the exact label, with `#<index>` available to
 * address a specific channel when labels collide. A term that matches nothing is an
 * error rather than a silent omission: quietly dropping a requested channel would
 * hand the user a CSV that is missing data they explicitly asked for.
 */
export function selectChannels(signals: readonly EdfSignal[], terms: readonly string[]): ChannelSelection {
  const candidates = signals.filter((s) => !s.isAnnotations);
  const byLabel = new Map<string, EdfSignal[]>();
  for (const signal of candidates) {
    const key = signal.label.toLowerCase();
    const bucket = byLabel.get(key);
    if (bucket) bucket.push(signal);
    else byLabel.set(key, [signal]);
  }

  const chosen = new Map<number, EdfSignal>();
  const ambiguous: { term: string; matched: EdfSignal[] }[] = [];

  for (const rawTerm of terms) {
    const term = rawTerm.trim();
    if (term === '') continue;

    // '#N' addresses a channel by position, but a label may literally be "#5".
    // A real label always wins, so no channel becomes unreachable.
    const literal = byLabel.get(term.toLowerCase());
    if (term.startsWith('#') && (!literal || literal.length === 0)) {
      /*
        A position must be written in plain digits.

        `Number()` was doing the parsing, and it accepts a great deal more than a position:
        `#0x2` reached channel 2 through hex, `#0b1` channel 1 through binary, `#1e0` and
        `#2.0` and `# 2` all landed somewhere, and `#` on its own became `Number('')`, which
        is 0. Every one of them selected a channel and exited 0, so a slip did not fail —
        it quietly converted a different channel than the one asked for, which for this tool
        is the worst way to be wrong.
      */
      const position = term.slice(1);
      if (!/^\d+$/u.test(position)) {
        throw new ChannelSelectionError(
          `"${term}" is not a channel position: a position is #0, #1, #2 and so on.\n` +
            `This file has signal channels at ${listed(candidates.map((s) => `#${s.index}`))}.`,
        );
      }
      const index = Number(position);
      const signal = candidates.find((s) => s.index === index);
      if (!signal) {
        throw new ChannelSelectionError(
          `No channel at position ${term}. This file has signal channels at ` +
            `${listed(candidates.map((s) => `#${s.index}`))}.`,
        );
      }
      chosen.set(signal.index, signal);
      continue;
    }

    const matched = byLabel.get(term.toLowerCase());
    if (!matched || matched.length === 0) {
      throw new ChannelSelectionError(
        `No channel named "${term}".${suggest(term, candidates)}\n` +
          `Run with --info to list the channels in this file.`,
      );
    }
    if (matched.length > 1) ambiguous.push({ term, matched: [...matched] });
    for (const signal of matched) chosen.set(signal.index, signal);
  }

  const selected = [...chosen.values()].sort((a, b) => a.index - b.index);
  if (selected.length === 0) {
    throw new ChannelSelectionError('No channels were selected.');
  }
  return { signals: selected, ambiguous };
}

function suggest(term: string, candidates: readonly EdfSignal[]): string {
  // Duplicated labels would otherwise be suggested twice, which reads like two
  // different options while naming the same thing.
  const unique = [...new Set(candidates.map((s) => s.label))];
  const scored = unique
    .map((label) => ({ label, distance: editDistance(term.toLowerCase(), label.toLowerCase()) }))
    .filter((c) => c.label !== '' && c.distance <= Math.max(2, Math.floor(term.length / 3)))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
  if (scored.length === 0) return '';
  return ` Did you mean ${scored.map((c) => `"${c.label}"`).join(', ')}?`;
}

/** Levenshtein distance, two-row variant. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] ?? 0;
}
