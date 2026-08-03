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

import { decodeUtf8 } from './bytes.js';

const SEP_TEXT = 0x14; // separates onset/duration from text, and text from text
const SEP_DURATION = 0x15; // separates onset from duration
const TAL_END = 0x00;

const TEXT_SEP_CHAR = String.fromCharCode(SEP_TEXT);
const DURATION_SEP_CHAR = String.fromCharCode(SEP_DURATION);

export interface Annotation {
  /** Seconds from the start of the recording. */
  onset: number;
  /** Seconds, or null when the TAL omitted a duration. */
  duration: number | null;
  text: string;
  /** Index of the data record this annotation was stored in. */
  recordIndex: number;
}

export interface DecodedRecordAnnotations {
  /** Record start time in seconds, from the leading timekeeping TAL. */
  recordStart: number | null;
  annotations: Annotation[];
  /** Non-empty chunks that were not valid TALs, so the caller can report them. */
  malformed: number;
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
): DecodedRecordAnnotations {
  const annotations: Annotation[] = [];
  let recordStart: number | null = null;
  let isFirstTal = true;
  let malformed = 0;

  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i !== bytes.length && bytes[i] !== TAL_END) continue;

    if (i > start) {
      const chunk = bytes.subarray(start, i);
      const parsed = parseTal(chunk, recordIndex);

      // The timekeeping TAL is the one in first POSITION, whether or not it decodes.
      // Clearing this flag only on a successful parse meant that an unreadable first TAL
      // promoted the next ordinary annotation to timekeeping, and its onset silently
      // became the record's start time — shifting every sample in that record. Leaving
      // recordStart null instead is what the caller already handles, with a fallback
      // timestamp and an ANNOTATION_DECODE_FAILED warning naming the record.
      const isTimekeeping = isFirstTal;
      isFirstTal = false;

      if (parsed) {
        if (isTimekeeping) recordStart = parsed.onset;
        for (const annotation of parsed.annotations) annotations.push(annotation);
      } else {
        malformed++;
      }
    }
    start = i + 1;
  }

  return { recordStart, annotations, malformed };
}

interface ParsedTal {
  onset: number;
  annotations: Annotation[];
}

function parseTal(chunk: Uint8Array, recordIndex: number): ParsedTal | null {
  // The onset must be explicitly signed; anything else is not a TAL.
  const first = chunk[0];
  if (first !== 0x2b /* + */ && first !== 0x2d /* - */) return null;

  const text = decodeUtf8(chunk);
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

  let duration: number | null = null;
  if (durationText !== null && durationText !== '') {
    const d = Number(durationText);
    duration = Number.isFinite(d) ? d : null;
  }

  const annotations: Annotation[] = [];
  for (const raw of parts.slice(1)) {
    // A trailing separator yields an empty segment; a timekeeping TAL is all empty.
    if (raw === '') continue;
    annotations.push({ onset, duration, text: raw, recordIndex });
  }

  return { onset, annotations };
}

export { SEP_TEXT, SEP_DURATION, TAL_END };
