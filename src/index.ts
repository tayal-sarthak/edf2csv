/**
 * Programmatic API.
 *
 * edf2csv is primarily a command-line tool, but the parser underneath is useful on
 * its own — reading an EDF header, listing channels, or streaming raw samples
 * without going through CSV at all.
 */

export { EdfFile, DEFAULT_CHUNK_BYTES } from './edf/reader.js';
export type { RecordBatch, ReadRecordsOptions } from './edf/reader.js';

export { parseHeader, formatRate, ANNOTATIONS_LABEL } from './edf/header.js';
export type { EdfHeader, EdfHeaderInfo, EdfSignal } from './edf/header.js';

export { decodeRecordAnnotations } from './edf/annotations.js';
export type { Annotation, DecodedRecordAnnotations } from './edf/annotations.js';

export { makeScaler, quantizationStep, decimalsForSignal } from './edf/scale.js';
export type { Scaler } from './edf/scale.js';

export { EdfError } from './edf/errors.js';
export type { Diagnostic, DiagnosticCode, EdfErrorCode } from './edf/errors.js';

export { convert, defaultOutputDir, ConversionError, TOOL_VERSION } from './convert/run.js';
export type { ConvertOptions, ConvertResult, ConversionProgress, WrittenFile } from './convert/run.js';

export { buildPlan, rateSlug, SPREADSHEET_ROW_LIMIT } from './convert/plan.js';
export type { ConversionPlan, PlanOptions, PlanInput, RateGroup, PlannedChannel } from './convert/plan.js';

export { selectChannels, buildColumnNames, ChannelSelectionError } from './convert/channels.js';
export { parseTimeSpec, resolveRange, TimeRangeError } from './convert/time-range.js';
export type { ResolvedRange } from './convert/time-range.js';
