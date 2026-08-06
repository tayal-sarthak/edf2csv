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
