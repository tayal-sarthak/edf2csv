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

/**
 * The name of the column the writer puts in front of the channels, which no channel may take.
 *
 * Exported and used by the writer rather than repeated there, because the whole point of
 * reserving it here is that the two cannot drift apart.
 */
export const TIME_COLUMN = 'time_s';

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

    The time column counts as taken, for the same reason. It is a name this file does not
    supply and the writer does, and a channel labelled `time_s` collided with it in silence:
    the header came out `time_s,time_s,ECG`, channels.csv named the channel's column `time_s`,
    and every read-back the documentation gives — `index_col="time_s"`, `pop("time_s")`,
    `pivot(index="time_s")` — resolves that to one of the two columns without saying which.
    pandas and Python's own `csv.DictReader` resolve it opposite ways round.
  */
  for (let round = 0; round < 8; round++) {
    const taken = new Map<string, number>([[TIME_COLUMN, 1]]);
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
      /*
        The one term that is certainly not a typo: a column name.

        Matching is on the label, and where a label collides the column gains a `_ch<index>`
        suffix — so `T8-P8_ch1` is a name this tool invented, prints in the COLUMN column of
        --info, writes into channels.csv and puts at the head of signals.csv, and then
        rejects with "No channel named "T8-P8_ch1". Run with --info to list the channels in
        this file", which is where the user copied it from. The reference documents the trap;
        the message a user actually hits did not.

        Answered where it is asked instead, and with the thing that works: `#<index>` selects
        one channel of a colliding pair, which is exactly what someone reaching for the
        suffixed column name wants and the only way to get it.
      */
      const columns = buildColumnNames(candidates);
      const owner = candidates.find(
        (signal) => (columns.get(signal.index) ?? '').toLowerCase() === term.toLowerCase(),
      );
      if (owner) {
        // A channel with no label at all gets the column `signal_<index>`, and offering its
        // label back would be offering `""` — there is nothing to type. Position is the only
        // way to reach it, and saying so is more use than quoting an empty string twice.
        throw new ChannelSelectionError(
          owner.label === ''
            ? `"${term}" is a column name, not a channel name: --channels matches the label, ` +
              `and this channel has none.\n` +
              `Use "#${owner.index}" — a channel with no label can only be addressed by position.`
            : `"${term}" is a column name, not a channel name: --channels matches the label, ` +
              `which for this channel is "${owner.label}".\n` +
              (typeable(owner.label) === null
                ? `Use "#${owner.index}" — ${untypeableBecause(owner.label)}, so position is ` +
                  `the only way to reach it.`
                : `Use "#${owner.index}" to select just this one, or ${typeable(owner.label)} ` +
                  `for every channel sharing that label.`),
        );
      }
      /*
        The annotation channel is a channel, and this said the file had none by that name.

        `EDF Annotations` is a label the file really carries — the spec reserves it, --info
        counts it on the "Channels" line, and it is the name anyone reading about EDF+ meets
        first. Asking for it got "No channel named "EDF Annotations". Run with --info to list
        the channels in this file", which is false about the file and points at a table that
        does not list it either, so following the advice returns the reader to the same
        message. What they were after is already being written: every conversion of a file
        with this channel writes annotations.csv from it.
      */
      const asAnnotations = signals.find(
        (signal) => signal.isAnnotations && signal.label.toLowerCase() === term.toLowerCase(),
      );
      if (asAnnotations) {
        throw new ChannelSelectionError(
          `"${term}" is this recording's annotation channel, not a signal: it holds event ` +
            `text rather than samples, so it has no column to select.\n` +
            `Its events are already written to annotations.csv by any conversion of this ` +
            `file — pass --annotations-only for those and no signal data.`,
        );
      }
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
    .sort((a, b) => a.distance - b.distance);
  if (scored.length === 0) return '';
  /*
    A suggestion is something to retype, so it has to be retypeable.

    `Did you mean "EEG "A1""?` collapses in a shell to `EEG A1`, which this then rejects with
    the same sentence and the same suggestion — a loop the reader cannot get out of by doing
    what it says. Same failure the header parser's `--channels` advice was fixed for in
    0.7.18, and the branch above it here; a label carrying `$` or a backtick is the same thing
    again, since a shell expands both inside double quotes.

    Where nothing can be typed — a label with a comma, which --channels splits after the shell
    has finished with it, or one with a control byte in it — the position is offered instead.
    It is not the name they asked about, but it is the answer to what they wanted.
  */
  /*
    Cut to three, and the rest counted rather than dropped.

    `.slice(0, 3)` said nothing about what it left. On a recording with channels ECG1 to ECG5,
    `--channels ECG` is one edit from all five and the answer was `Did you mean "ECG1", "ECG2",
    "ECG3"?` — three of five equally good answers, with nothing to say the list was cut. A
    reader has no way to tell ECG4 from a channel that does not exist, and this sentence is the
    only place the tool offers to tell them what does.

    Through `listed`, which every other list in a sentence goes through: it counts what it
    leaves, and shows a fourth item rather than hiding it behind a phrase longer than the item.
  */
  const offered = scored.map((c) => typeable(c.label) ?? `"#${positionOf(c.label, candidates)}"`);
  return ` Did you mean ${listed(offered, 3)}?`;
}

/** The first channel carrying this label, for a suggestion that cannot be made by name. */
function positionOf(label: string, candidates: readonly EdfSignal[]): number {
  return candidates.find((signal) => signal.label === label)?.index ?? 0;
}

/**
 * The label written so that typing it back selects this channel, or null when nothing does.
 *
 * Double quotes wherever they survive, since they also show where the label begins and ends
 * and every documented example is written that way. They do not survive a label containing a
 * quote of their own, and — less obviously — a shell still expands `$`, a backtick and a
 * backslash inside them, so `EEG $ref` would arrive as `EEG ` with nothing said. Those go in
 * single quotes, the one POSIX form with no escapes inside it, where a single quote in the
 * label closes, escapes and reopens.
 *
 * Two labels have no form at all. `--channels` splits its list on commas after the shell has
 * finished quoting, so no quoting reaches a label with one in it; and a control character
 * cannot be typed. Both take a position instead, which is what NONPRINTABLE_LABEL already
 * says for the same two reasons.
 */
export function typeable(label: string): string | null {
  if (label === '' || label.includes(',')) return null;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(label)) return null;
  if (!/["$`\\]/u.test(label)) return `"${label}"`;
  return `'${label.replaceAll("'", "'\\''")}'`;
}

/** Why a label has no typeable form, for the sentence that offers a position instead. */
function untypeableBecause(label: string): string {
  if (label.includes(',')) return 'a comma in the label would read as two names';
  return 'the label cannot be typed';
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
