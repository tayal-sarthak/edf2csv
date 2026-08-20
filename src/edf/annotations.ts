/**
 * EDF+ annotation (TAL) decoding.
 *
 * The annotations channel stores UTF-8 text in place of samples. Its bytes are a
 * run of Time-stamped Annotation Lists, each terminated by a NUL, with the rest
 * of the channel NUL-padded:
 *
 *   +<onset>[<0x15><duration>]<0x14><text><0x14>...<0x00>
 *
 * The first TAL of every data record must carry that record's start time and no
 * text; that is how an EDF+D file states where each record actually sits in time.
 *
 *   +1.25<0x15>0.5<0x14>Seizure onset<0x14><0x00>
 */

import { decodeText } from './bytes.js';

const SEP_TEXT = 0x14; // separates onset/duration from text, and text from text
const SEP_DURATION = 0x15; // separates onset from duration
const TAL_END = 0x00;

const TEXT_SEP_CHAR = String.fromCharCode(SEP_TEXT);
const DURATION_SEP_CHAR = String.fromCharCode(SEP_DURATION);

export interface Annotation {
  /** Seconds from the start of the recording. */
  onset: number;
  /**
   * Seconds, or null when the TAL stated no duration that could be read.
   *
   * Null covers two cases the file distinguishes and this field does not: a TAL that omitted
   * the duration, and a TAL that stated one which is not a number. They are told apart by
   * `unreadableDurations`, which is what raises the warning; the value itself has nowhere
   * honest to put "the file said `abc`".
   */
  duration: number | null;
  text: string;
  /** Index of the data record this annotation was stored in. */
  recordIndex: number;
  /**
   * True when the file stated a duration that could not be read.
   *
   * `duration` is null either way, which is the ambiguity the counts beside it exist to
   * flag — and those counts were of the whole file while `annotations.csv` is filtered to
   * the requested window. A conversion of one second of a recording warned that "1
   * annotation states a duration that is not a number, so its duration_s cell is empty"
   * about an event two seconds outside it, and failed `--strict` for it. Carrying the fact
   * on the event lets the count be taken where the window has already been applied.
   */
  durationUnreadable?: boolean;
}

export interface DecodedRecordAnnotations {
  /** Record start time in seconds, from the leading timekeeping TAL. */
  recordStart: number | null;
  annotations: Annotation[];
  /** Non-empty chunks that were not valid TALs, so the caller can report them. */
  malformed: number;
  /** Unreadable TALs in first position, which carry a record's start time, not an event. */
  malformedTimekeeping: number;
  /**
   * How many of those also carried event text, and so lost events as well as a position.
   *
   * A TAL in first position holds the record's start time, and may hold events after it — the
   * specification allows both in the one entry, and writers use it. When such a TAL cannot be
   * parsed, both are gone, and counting it only as lost timekeeping let the warning beside it
   * say "No event was lost" over a conversion that had just dropped four of them.
   *
   * Counted rather than inferred, because the sentence has to be right in the ordinary case
   * too: a bare timekeeping TAL really does lose no event, and that is nearly all of them.
   */
  malformedTimekeepingWithText: number;
  /**
   * Events kept whose stated duration could not be read.
   *
   * Counted apart again, for the same reason the two above are: the entry was exported and
   * nothing about it is missing except the one field, so calling it an entry that "could not
   * be exported" describes a loss that did not happen and hides the one that did.
   */
  unreadableDurations: number;
  /**
   * Events kept whose stated duration is a readable number below zero.
   *
   * Separate from the count above because the value survives: it is written to the CSV as
   * the file gave it, and what is wrong with it is arithmetic rather than parsing.
   */
  negativeDurations: number;
}

/**
 * Decode one data record's annotation bytes.
 *
 * Malformed TALs are skipped rather than thrown, because a single bad annotation
 * should not cost the user an entire conversion. The count of skipped chunks is
 * returned so the caller can tell the user rather than losing them in silence.
 */
export function decodeRecordAnnotations(
  bytes: Uint8Array,
  recordIndex: number,
  carriesTimekeeping = true,
): DecodedRecordAnnotations {
  const annotations: Annotation[] = [];
  let recordStart: number | null = null;
  let isFirstTal = true;
  let malformed = 0;
  let malformedTimekeeping = 0;
  let malformedTimekeepingWithText = 0;
  let unreadableDurations = 0;
  let negativeDurations = 0;

  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i !== bytes.length && bytes[i] !== TAL_END) continue;

    if (i > start) {
      const chunk = bytes.subarray(start, i);
      /*
        Padding is not a lost annotation.

        The spec pads the slot with NUL, which the loop above already skips because it is what
        separates one TAL from the next. Writers pad with spaces instead, and a run of spaces
        after the last TAL is a non-empty chunk — so a file holding one perfectly readable
        event, exported in full, was told "2 annotation entries were unreadable and could not
        be exported", one per record. Nothing was lost. Under --strict that is a failed run
        over the whitespace at the end of a slot.

        Only whitespace. A chunk of anything else that does not parse is a real loss and is
        still counted, which is the case this warning exists for.
      */
      if (chunk.every(isPaddingByte)) {
        start = i + 1;
        continue;
      }
      const parsed = parseTal(chunk, recordIndex);

      // The timekeeping TAL is the one in first POSITION, whether or not it decodes.
      // Clearing this flag only on a successful parse meant that an unreadable first TAL
      // promoted the next ordinary annotation to timekeeping, and its onset silently
      // became the record's start time — shifting every sample in that record. Leaving
      // recordStart null instead is what the caller already handles, with a fallback
      // timestamp and an ANNOTATION_DECODE_FAILED warning naming the record.
      /*
        Only one annotation channel carries a record's start time.

        This flagged the first TAL of *every* annotation channel as timekeeping. In a second
        channel the first TAL is an ordinary event — so when one failed to parse, the event
        was dropped and counted as a lost timekeeping entry, which produced the warning
        "3 data records carry a timekeeping annotation that could not be read" followed by
        "No event was lost". Three events had been lost, and the timekeeping in that file was
        perfectly readable. Both sentences false, about the same three records.
      */
      const isTimekeeping = isFirstTal && carriesTimekeeping;
      isFirstTal = false;

      if (parsed) {
        if (isTimekeeping) recordStart = parsed.onset;
        for (const annotation of parsed.annotations) annotations.push(annotation);
        unreadableDurations += parsed.unreadableDurations;
        negativeDurations += parsed.negativeDurations;
      } else {
        /*
          Counted apart from the events, because losing one is a different loss.

          A timekeeping TAL is never exported — it says where the record sits, not what
          happened — so counting it among the entries that "could not be exported" both
          overstated what was lost from annotations.csv and said nothing about the thing that
          actually went missing, which is a record's position in time. A file with one
          unreadable timekeeping TAL and three perfectly good events reported "1 annotation
          entry was unreadable and could not be exported" while exporting all three.

          The other direction is just as wrong. A first-position TAL may carry events after
          the start time, and when one of those cannot be parsed the events go with it — so
          counting it only as lost timekeeping produced the opposite false sentence: "No event
          was lost", printed over a run whose annotations.csv had gone from six rows to two.
          It is one entry that could not be exported and one record with no position, and it
          is counted as both.
        */
        if (isTimekeeping) {
          malformedTimekeeping++;
          if (carriesAnnotationText(chunk)) {
            malformedTimekeepingWithText++;
            malformed++;
          }
        } else malformed++;
      }
    }
    start = i + 1;
  }

  return {
    recordStart,
    annotations,
    malformed,
    malformedTimekeeping,
    malformedTimekeepingWithText,
    unreadableDurations,
    negativeDurations,
  };
}

interface ParsedTal {
  onset: number;
  annotations: Annotation[];
  /** How many of those annotations carry a duration the file stated and this could not read. */
  unreadableDurations: number;
  /** How many carry a duration that read as a number below zero. */
  negativeDurations: number;
}

/**
 * Whether a TAL that could not be parsed still carried event text.
 *
 * A TAL is `onset[<0x15>duration]<0x14>text<0x14>...`, so anything other than padding after
 * the first 0x14 is a description the file meant to export. Read from the raw chunk, since by
 * the time this is asked the parse has already failed and there is no structure to consult.
 */
function carriesAnnotationText(chunk: Uint8Array): boolean {
  let afterSeparator = false;
  for (const byte of chunk) {
    if (byte === 0x14) {
      afterSeparator = true;
      continue;
    }
    if (afterSeparator && !isPaddingByte(byte)) return true;
  }
  return false;
}

/** Space, tab, CR, LF or NUL — what a writer fills the rest of the slot with. */
function isPaddingByte(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a || byte === 0x00;
}

function parseTal(chunk: Uint8Array, recordIndex: number): ParsedTal | null {
  // The onset must be explicitly signed; anything else is not a TAL.
  const first = chunk[0];
  if (first !== 0x2b /* + */ && first !== 0x2d /* - */) return null;

  const text = decodeText(chunk);
  const parts = text.split(TEXT_SEP_CHAR);
  const head = parts[0] ?? '';

  let onsetText = head;
  let durationText: string | null = null;
  const durationSep = head.indexOf(DURATION_SEP_CHAR);
  if (durationSep >= 0) {
    onsetText = head.slice(0, durationSep);
    durationText = head.slice(durationSep + 1);
  }

  const onset = Number(onsetText);
  if (!Number.isFinite(onset)) return null;

  /*
    A duration the file stated and this could not read is not the same as no duration.

    Both came out as `null` and so as an empty `duration_s` cell, which the documentation
    defines as meaning the file gave no duration — so an event whose duration was written as
    `abc` was exported as an event with no duration, indistinguishable from one beside it
    that genuinely had none, and nothing anywhere said a field had been dropped. The onset is
    already held to this standard: one that is not a number costs the whole TAL and is
    reported. A duration is one field of an otherwise readable event, so the event is kept —
    but it is counted, and the run says so.
  */
  /*
    Fill in the field is an absent duration, not a zero.

    `Number` reads a run of whitespace as 0 — the rule that makes `Number('')` zero, one step
    along — so a TAL whose duration field held nothing but the writer's padding was exported
    with a `duration_s` of `0`, byte-identical to the event beside it whose file really did
    say `0`. An instantaneous event is a claim about the recording, and no writer made it;
    inventing it is the one thing this tool does not do, and it did so in silence, exit 0.

    The empty field this condition already declines is the same field without the fill in it,
    so padding takes the same answer: the file stated no duration. `trim` empties exactly the
    strings `Number` would otherwise have swallowed into a zero, so `  2.5  ` still reads as
    2.5 and `abc` is still counted as unreadable below.
  */
  let duration: number | null = null;
  let durationUnreadable = false;
  if (durationText !== null && durationText.trim() !== '') {
    const d = Number(durationText);
    if (Number.isFinite(d)) duration = d;
    else durationUnreadable = true;
  }

  /*
    A duration is a length of time, and a length below zero is not one.

    The value is kept and written as the file gave it — inventing a zero, or dropping it to
    an empty cell, would put a number in annotations.csv that no writer wrote, which is the
    one thing this tool does not do. But it is reported, because everything downstream
    quietly does the wrong thing with it: the recipe this documentation gives for the samples
    an event covers is `onset_s + duration_s`, which for a duration of -3 ends three seconds
    before the event starts and selects nothing at all, with no error anywhere.
  */
  const durationNegative = duration !== null && duration < 0;

  const annotations: Annotation[] = [];
  for (const raw of parts.slice(1)) {
    /*
      A trailing separator yields an empty segment; a timekeeping TAL is all empty.

      Whitespace counts as empty here, which it did not, and the padding at the end of the
      slot became an event. The chunk loop above already refuses to call a run of spaces a
      lost annotation — but it only sees chunks between NULs, and a writer that leaves its
      last TAL unterminated puts the fill *inside* the chunk, after the final 0x14. Split on
      that separator it is a text segment like any other, and " " is not "".

      A file holding two events exported four rows: `0.5,,Lights off,0` and `0.5,,   ,0`,
      twice, sharing the real event's onset, with annotations_written and the run summary
      agreeing with the inflated number and nothing warned. An event whose description is
      genuinely nothing but spaces cannot be told from fill, and inventing rows out of fill
      is the worse of the two answers.
    */
    if ([...raw].every((c) => isPaddingByte(c.charCodeAt(0)))) continue;
    annotations.push({
      onset,
      duration,
      text: raw,
      recordIndex,
      ...(durationUnreadable ? { durationUnreadable: true } : {}),
    });
  }

  // Per event rather than per TAL: one TAL may carry several texts, and each becomes a row
  // of annotations.csv with the same cell in it.
  return {
    onset,
    annotations,
    unreadableDurations: durationUnreadable ? annotations.length : 0,
    negativeDurations: durationNegative ? annotations.length : 0,
  };
}

export { SEP_TEXT, SEP_DURATION, TAL_END };
