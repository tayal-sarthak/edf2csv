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
  return names;
}

function baseName(signal: EdfSignal): string {
  return signal.label === '' ? `signal_${signal.index}` : signal.label;
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
      const index = Number(term.slice(1));
      const signal = candidates.find((s) => s.index === index);
      if (!signal) {
        throw new ChannelSelectionError(
          `No channel at position ${term}. This file has signal channels at ` +
            `#${candidates.map((s) => s.index).join(', #')}.`,
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
