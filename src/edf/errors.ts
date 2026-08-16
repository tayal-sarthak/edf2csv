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
  | 'TIME_RESOLUTION'
  | 'VALUE_RESOLUTION'
  | 'HEADER_BYTES_MISMATCH'
  | 'NONPRINTABLE_LABEL'
  /**
   * Header text that a spreadsheet will run instead of read.
   *
   * Excel, LibreOffice and Google Sheets treat a cell beginning `=`, `+` or `@` as a formula,
   * whatever file it arrived in. EDF labels, units, transducer and prefiltering fields are
   * free text out of the header, and this tool writes them through unchanged on purpose — so
   * a channel labelled `=1+1` becomes a column header that computes 2, and one labelled
   * `=HYPERLINK(...)` becomes a link the reader did not write. The README says the output
   * opens in Excel and SECURITY.md already treats these fields as attacker-controlled; this
   * is the one place they reach a program that executes text.
   *
   * A warning rather than a rewrite. Prefixing the cell with a quote is the usual mitigation
   * and it would mean writing something the header does not say, which is the one thing this
   * tool does not do — the same answer NONPRINTABLE_LABEL gives for control bytes.
   */
  | 'FORMULA_LABEL'
  /**
   * The header's start date or time is not a date or a time.
   *
   * Every other unusable header field reports itself. This one did not, so a recording whose
   * timestamp cannot be read converted in silence, passed `--strict`, and left
   * `start_datetime_local` null in metadata.json with nothing saying why — on the field the
   * documented recipe for an absolute instant depends on.
   */
  | 'START_TIME_UNREADABLE'
  /**
   * An annotation channel with a non-zero origin, in a file marked neither EDF+C nor EDF+D.
   *
   * The marker decides whether the origin is applied, and the annotation channel is found by
   * label instead. So a file carrying one without the marker got samples timed from zero and events
   * timed from the origin, and the two CSVs came out on clocks seconds apart.
   */
  | 'MISSING_EDF_PLUS_MARKER'
  /**
   * `--info --stdout` on a recording `--stdout` would refuse.
   *
   * Only `--info` raises it. A conversion refuses outright instead, with the same words —
   * this is that refusal shown ahead of time, which is what `--info` is for.
   */
  | 'STDOUT_UNSUPPORTED';

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
