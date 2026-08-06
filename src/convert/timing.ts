import type { Diagnostic } from '../edf/errors.js';
import type { EdfFile } from '../edf/reader.js';

export interface AnnotationTimingData {
  recordStarts: (number | null)[];
  malformed: number;
}

/**
 * Resolve the true start time of every data record.
 *
 * Continuous recordings need no table because their record positions are
 * arithmetic. EDF+D recordings carry their positions in the annotation channel;
 * missing or malformed timekeeping entries are reported before falling back.
 */
export function deriveRecordStarts(
  file: EdfFile,
  annotationData: AnnotationTimingData,
): { starts: Float64Array | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];

  if (annotationData.malformed > 0) {
    diagnostics.push({
      code: 'ANNOTATION_DECODE_FAILED',
      severity: 'warning',
      message:
        `${annotationData.malformed} annotation entr${annotationData.malformed === 1 ? 'y was' : 'ies were'} ` +
        `unreadable and could not be exported.`,
      hint: 'The rest were exported normally. The file may have been written by a non-conforming tool.',
    });
  }

  /*
    A continuous recording's records are contiguous, but the first one need not sit at zero.

    EDF+ puts the header's start time and every annotation onset on one origin, and says the
    first data record's timekeeping TAL "always starts with +0.X", stating the fraction of a
    second by which that record follows it. Ignoring that fraction timed the samples from 0
    while the events kept their true onsets, so the two ended up on origins half a second
    apart — an event at +0.75 in a 4 Hz recording whose first TAL reads +0.5 landed on sample
    3 instead of sample 1. The same file marked EDF+D, byte-identical but for the reserved
    field, placed it correctly, which is what gives the omission away.

    Records stay contiguous, which is what continuous means: only the origin moves. A first
    TAL of +0 needs no table at all, and that is nearly every file.
  */
  if (file.header.continuity !== 'EDF+D') {
    const first = annotationData.recordStarts[0];
    if (file.header.continuity !== 'EDF+C' || typeof first !== 'number' || first === 0) {
      return { starts: null, diagnostics };
    }
    const contiguous = new Float64Array(file.recordCount);
    for (let i = 0; i < file.recordCount; i++) {
      contiguous[i] = first + i * file.header.recordDuration;
    }
    const last = contiguous[file.recordCount - 1] ?? first;
    if (!canCarry(last, file)) {
      diagnostics.push(unusableOrigin(first, file));
      return { starts: null, diagnostics };
    }
    return { starts: contiguous, diagnostics };
  }

  if (file.annotationSignals.length === 0) {
    diagnostics.push({
      code: 'DISCONTINUOUS',
      severity: 'warning',
      message:
        'This file is marked discontinuous but has no annotation channel, so where its ' +
        'records sit in time is not recorded anywhere.',
      hint: 'Times are written as if the records were contiguous. Any gaps are lost.',
    });
    return { starts: null, diagnostics };
  }

  const starts = new Float64Array(file.recordCount);
  const missing: number[] = [];
  for (let i = 0; i < file.recordCount; i++) {
    const declared = annotationData.recordStarts[i];
    if (declared === null || declared === undefined) {
      missing.push(i);
      starts[i] = i * file.header.recordDuration;
    } else {
      starts[i] = declared;
    }
  }

  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(', ');
    diagnostics.push({
      code: 'ANNOTATION_DECODE_FAILED',
      severity: 'warning',
      message:
        `${missing.length} of ${file.recordCount} data records carry no readable timekeeping ` +
        `annotation (record${missing.length === 1 ? '' : 's'} ${shown}` +
        `${missing.length > 5 ? ', …' : ''}), so their true position in time is unknown.`,
      hint: 'Those records are timed as if they were contiguous; treat their timestamps as unreliable.',
    });
  }

  let furthest = 0;
  for (const start of starts) if (start > furthest) furthest = start;
  if (!canCarry(furthest, file)) {
    diagnostics.push(unusableOrigin(furthest, file));
    return { starts: null, diagnostics };
  }

  let outOfOrder = 0;
  for (let i = 1; i < starts.length; i++) {
    if ((starts[i] as number) < (starts[i - 1] as number)) outOfOrder++;
  }
  if (outOfOrder > 0) {
    diagnostics.push({
      code: 'DISCONTINUOUS',
      severity: 'warning',
      message: `${outOfOrder} data record${outOfOrder === 1 ? '' : 's'} start earlier than the record before it.`,
      hint: 'Rows are written in file order, so the time column will not increase monotonically.',
    });
  }

  return { starts, diagnostics };
}

/**
 * Whether times this far out can still tell one sample from the next.
 *
 * A double spaces its values further apart the larger they get: at 1e16 the gap is 2
 * seconds, so `t + 1` is `t`. Past that point a recording's declared origin stops being a
 * position and becomes a wall — the arithmetic that places records and samples returns the
 * origin itself, whatever is added to it.
 *
 * The finest thing that has to survive is the gap between two consecutive samples of the
 * fastest channel, since that is what the time column is made of. If that survives, so does
 * a whole record.
 */
function canCarry(origin: number, file: EdfFile): boolean {
  if (!Number.isFinite(origin)) return false;
  let interval = file.header.recordDuration;
  for (const signal of file.header.signals) {
    if (signal.isAnnotations || !(signal.samplesPerRecord > 0)) continue;
    const step = file.header.recordDuration / signal.samplesPerRecord;
    if (step > 0 && step < interval) interval = step;
  }
  return origin + interval > origin;
}

/**
 * An origin the file's own arithmetic cannot express, reported rather than acted on.
 *
 * Two things went wrong when this was taken at face value, both of them quiet. A file whose
 * records all collapsed onto one instant made the recording zero seconds long, and the
 * window resolver — which had no reason to suspect the recording rather than the request —
 * blamed a flag nobody had passed:
 *
 *     error: --start 100000000000000000s is at or past the end of this
 *            100000000000000000s recording.
 *
 * Slightly below that, the collapse is partial: `records[i].start + recordDuration` equals
 * the start again, so the test for "does this record overlap the window" fails for every
 * record whose neighbour rounded onto it. A twelve-row recording wrote four rows, exit 0,
 * no warning — the eight that vanished looked exactly like a file that never had them.
 *
 * Timing from zero is what the file did before 0.4.9 taught it to honour the first
 * timekeeping TAL, and at this magnitude it is the only column that can hold distinct
 * values. The origin is lost, so this says so.
 */
function unusableOrigin(origin: number, file: EdfFile): Diagnostic {
  return {
    code: 'DISCONTINUOUS',
    severity: 'warning',
    message:
      `This recording's timekeeping annotations place it ${origin}s from its own start ` +
      `date, which is too far out for its ${file.header.recordDuration}s records to be told ` +
      `apart: at that magnitude adding a sample interval leaves the number unchanged.`,
    hint:
      'Sample times are written from zero instead, so every row is present and the column ' +
      'increases. Add the onsets in annotations.csv to recover absolute times if you need them.',
  };
}
