/**
 * Programmatic API.
 *
 * edf2csv is primarily a command-line tool, but the parser underneath is useful on
 * its own — reading an EDF header, listing channels, or streaming raw samples
 * without going through CSV at all.
 */

export { EdfFile, DEFAULT_CHUNK_BYTES } from './edf/reader.js';
export type { RecordBatch, ReadRecordsOptions } from './edf/reader.js';

export { parseHeader, formatRate, formatRates, describeFormat, formatWallClock, ANNOTATIONS_LABEL, BDF_ANNOTATIONS_LABEL } from './edf/header.js';
export type { EdfHeader, EdfHeaderInfo, EdfSignal } from './edf/header.js';

export { decodeRecordAnnotations } from './edf/annotations.js';
export type { Annotation, DecodedRecordAnnotations } from './edf/annotations.js';

export { makeScaler, quantizationStep, decimalsForSignal } from './edf/scale.js';
export type { Scaler } from './edf/scale.js';

export { EdfError } from './edf/errors.js';
export type { Diagnostic, DiagnosticCode, EdfErrorCode } from './edf/errors.js';

export { convert, defaultOutputDir, ConversionError, TOOL_VERSION } from './convert/run.js';
/*
  ConversionErrorCode is here because `ConversionError.code` has it.

  A caller that catches one and wants to branch on the code could read the field — it is
  typed — but could not name the type, so there was no way to write the function taking it,
  the Record keyed by it, or the exhaustive switch over it. Its two siblings, EdfErrorCode
  and DiagnosticCode, have always been exported; this one was reachable and unnameable, and
  `import type { ConversionErrorCode } from 'edf2csv'` was a TS2724 telling the reader they
  probably meant ConversionError.

  Same for OutputEstimate and ChannelSelection below. A type that the public API hands you
  is part of the public API whether or not it was listed.
*/
export type {
  ConvertOptions,
  ConvertResult,
  ConversionProgress,
  WrittenFile,
  ConversionErrorCode,
} from './convert/run.js';

export { buildPlan, rateSlug, SPREADSHEET_ROW_LIMIT } from './convert/plan.js';
export type {
  ConversionPlan,
  PlanOptions,
  PlanInput,
  RateGroup,
  PlannedChannel,
  OutputEstimate,
} from './convert/plan.js';

export { selectChannels, buildColumnNames, ChannelSelectionError } from './convert/channels.js';
export type { ChannelSelection } from './convert/channels.js';
export { OptionError } from './convert/options.js';
export { parseTimeSpec, resolveRange, TimeRangeError } from './convert/time-range.js';
export type { ResolvedRange } from './convert/time-range.js';
