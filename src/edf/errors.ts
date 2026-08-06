/**
 * Error and diagnostic types.
 *
 * The distinction that matters here: an EdfError means we cannot produce
 * trustworthy output and must stop. A Diagnostic with severity 'warning' means
 * we can continue, but the user needs to know something about their data that
 * they would not otherwise see.
 */

export type DiagnosticCode =
  | 'MIXED_SAMPLING_RATES'
  | 'DISCONTINUOUS'
  | 'RECORD_COUNT_UNKNOWN'
  | 'RECORD_COUNT_MISMATCH'
  | 'TRAILING_BYTES'
  | 'DEGENERATE_DIGITAL_RANGE'
  | 'DEGENERATE_PHYSICAL_RANGE'
  | 'UNUSABLE_PHYSICAL_RANGE'
  | 'INVERTED_PHYSICAL_RANGE'
  | 'DUPLICATE_LABEL'
  | 'EMPTY_LABEL'
  | 'NO_ANNOTATIONS'
  | 'ANNOTATION_DECODE_FAILED'
  | 'COMMA_DECIMAL'
  | 'LARGE_OUTPUT'
  | 'NO_SIGNAL_CHANNELS'
  | 'NO_SAMPLES'
  | 'STALE_OUTPUT'
  | 'INPUT_CHANGED'
  | 'EMPTY_WINDOW'
  | 'HEADER_BYTES_MISMATCH'
  | 'NONPRINTABLE_LABEL';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'warning' | 'info';
  message: string;
  /** What the user can do about it. Omitted when there is nothing useful to say. */
  hint?: string;
}

export type EdfErrorCode =
  | 'FILE_TOO_SMALL'
  | 'BAD_HEADER_FIELD'
  | 'NO_DATA_RECORDS'
  | 'INVALID_SIGNAL_COUNT'
  | 'INVALID_RECORD_DURATION'
  | 'NO_SAMPLES'
  | 'UNREADABLE';

/**
 * A fatal problem with the recording itself. Carries a stable `code` so the CLI
 * can map it to an exit status, and a `hint` so the user is not left guessing.
 */
export class EdfError extends Error {
  readonly code: EdfErrorCode;
  readonly hint: string | undefined;

  constructor(code: EdfErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'EdfError';
    this.code = code;
    this.hint = hint;
  }
}
