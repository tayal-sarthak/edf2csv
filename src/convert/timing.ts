import type { Diagnostic } from '../edf/errors.js';
import type { EdfFile } from '../edf/reader.js';
import { counted } from '../format/list.js';

export interface AnnotationTimingData {
  recordStarts: (number | null)[];
  malformed: number;
  /** Unreadable TALs in first position, which carry timing rather than an event. */
  malformedTimekeeping?: number;
}

/**
 * The EDF+D warning's promise, withdrawn when the file cannot keep it.
 *
 * The header parser raises DISCONTINUOUS with the hint "Each row carries its true recording
 * time, so gaps stay visible instead of being closed" — which is what an EDF+D conversion
 * does, when the record times can be read. When they cannot, the very next warning in the
 * same run says the opposite: "Times are written as if the records were contiguous. Any gaps
 * are lost." Two warnings, printed together, and the second denies the first.
 *
 * The parser cannot know: whether the starts can be derived is settled here, after the
 * annotation channel has been read. So the hint is amended where the answer is, the same way
 * `withoutFileRateWarning` drops a header diagnostic the plan has superseded.
 */
export function withTimingPromiseKept(
  diagnostics: readonly Diagnostic[],
  derived: boolean,
): Diagnostic[] {
  if (derived) return [...diagnostics];
  return diagnostics.map((d) =>
    d.code === 'DISCONTINUOUS' && d.hint?.includes('gaps stay visible')
      ? {
          ...d,
          hint:
            'Where its records sit in time is not recorded in this file, so they are written ' +
            'as if contiguous — see the warning below.',
        }
      : d,
  );
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
    A timekeeping TAL is not an event, and saying it "could not be exported" describes the
    wrong loss twice over.

    These were counted among the annotations, so a file with one unreadable timekeeping TAL
    and three good events announced "1 annotation entry was unreadable and could not be
    exported" — while exporting all three. Nothing was missing from annotations.csv; what
    went missing was a record's position in time, which the message never mentioned.
  */
  const lostTimekeeping = annotationData.malformedTimekeeping ?? 0;
  // The EDF+D branch below raises its own, which names the records and is more specific.
  // Saying both would report one problem twice.
  if (lostTimekeeping > 0 && file.header.continuity !== 'EDF+D') {
    const one = lostTimekeeping === 1;
    diagnostics.push({
      code: 'ANNOTATION_DECODE_FAILED',
      severity: 'warning',
      message:
        `${lostTimekeeping} data record${one ? '' : 's'} carr${one ? 'ies' : 'y'} a timekeeping ` +
        `annotation that could not be read, so ${one ? 'it does' : 'they do'} not say where in ` +
        `time ${one ? 'it sits' : 'they sit'}.`,
      hint:
        'No event was lost — a timekeeping annotation states a record\'s start time and is ' +
        'never exported. Times are derived from the records that could be read.',
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
    if (file.header.continuity !== 'EDF+C') {
      /*
        An annotation channel the reserved field never claimed.

        Without an `EDF+C` or `EDF+D` marker this is a plain EDF file, so the origin is not
        applied and the samples are timed from zero. The annotation channel is found by label
        rather than by the marker, though, so its events are still read and exported — with
        the onsets the file gives them.

        On a file whose timekeeping says the records start at 1000s, that put signals.csv at
        0.000 and the event at 1000.5 in annotations.csv: two files from one conversion, a
        thousand seconds apart, and nothing said so. output-files promises the opposite —
        "`onset_s` is on the same clock as `time_s` in the signal files".

        Reported rather than repaired. Which clock is right is not knowable from here: the
        marker says plain EDF and the annotation channel says otherwise, and picking one would
        move either the samples or the events by the origin on a guess.
      */
      const stated = annotationData.recordStarts.find((start) => start !== null) ?? null;
      if (stated !== null && Math.abs(stated) > 0) {
        diagnostics.push({
          code: 'MISSING_EDF_PLUS_MARKER',
          severity: 'warning',
          message:
            `This file has an annotation channel stating that its records begin at ` +
            `${stated}s, but its reserved field carries no EDF+C or EDF+D marker — so it is ` +
            `read as plain EDF, time_s counts from zero, and the two disagree by ${stated}s.`,
          hint:
            'annotations.csv keeps the onsets the file gives, so its events and signals.csv ' +
            'are on different clocks. Mark the file EDF+C, or subtract the offset from the ' +
            'onsets, before joining them.',
        });
      }
      return { starts: null, diagnostics };
    }

    /*
      The origin comes from whichever record first states one, not from record 0 alone.

      Reading only `recordStarts[0]` meant a single unreadable timekeeping TAL threw the
      origin away and timed the whole file from zero — while records 1 and 2, saying plainly
      that they start at 1.5s and 2.5s, went unread. A recording whose records sit at 0.5s,
      1.5s and 2.5s came out with every sample 0.5s earlier than the file states, against
      annotation onsets that kept their true values. That is precisely the mismatch 0.4.9
      fixed, arriving through the one hole left in it, and the byte-identical EDF+D twin
      timed it correctly, which is what gives it away.

      Continuity is what makes this recoverable: record i sits at `origin + i * duration`,
      so any readable record determines the origin for all of them.
    */
    const origin = originOf(annotationData.recordStarts, file.header.recordDuration);
    if (origin === null) return { starts: null, diagnostics };

    const contiguous = new Float64Array(file.recordCount);
    for (let i = 0; i < file.recordCount; i++) {
      contiguous[i] = origin + i * file.header.recordDuration;
    }

    /*
      A file marked continuous whose own records disagree about it.

      Nothing looked at records past the first, so an EDF+C file whose records are in fact
      spread out was timed as though they were contiguous and said nothing. The records are
      being read here anyway, so the contradiction costs nothing to notice — and it is the
      file, not the reader, that has to be wrong for this to fire.

      Compared against what the file can express, not for equality. 0.4.41 asked whether the
      two doubles were the same, which they are not: a recording of 0.1s records sitting at
      0.1, 0.2, 0.3 ... is contiguous by construction, and 0.1 + 2 * 0.1 is
      0.30000000000000004. Two of its eight records were reported as contradicting
      continuity, on an ordinary file — and under --strict that was a failed run. The
      smallest interval the recording distinguishes is one sample of its fastest channel;
      anything below half of that is arithmetic, not a gap. `canCarry` has already refused
      origins where the double spacing swamps that interval, so the representation error is
      under the tolerance by construction rather than by hope.
    */
    const tolerance = finestInterval(file) / 2;
    const contradicting = annotationData.recordStarts.filter(
      (declared, i) =>
        typeof declared === 'number' && Math.abs(declared - (contiguous[i] as number)) > tolerance,
    ).length;
    if (contradicting > 0) {
      const continuous = file.header.isBdf ? 'BDF+C' : 'EDF+C';
      const discontinuous = file.header.isBdf ? 'BDF+D' : 'EDF+D';
      diagnostics.push({
        code: 'DISCONTINUOUS',
        severity: 'warning',
        /*
          The markers as the file spells them.

          `continuity` normalises `BDF+C` to the internal `EDF+C` tag, and that tag reached
          the message: a BDF+ recording was told it is "marked continuous (EDF+C)" — a string
          it does not contain — and advised that it "should have been marked EDF+D", which is
          not a value BDF+ defines. A reader grepping the header for either finds nothing.

          The sibling discontinuous warning has done this since 0.3.x: `${'$'}{isBdf ? 'BDF+D' :
          'EDF+D'}`. Same code, same header field, and the continuous branch never got it.
        */
        message:
          `This file is marked continuous (${continuous}), but ${contradicting} of its ` +
          `${counted(file.recordCount, 'data record')} ` +
          `${contradicting === 1 ? 'says it starts' : 'say they start'} somewhere other than ` +
          `where continuity puts ${contradicting === 1 ? 'it' : 'them'}.`,
        hint:
          `Times are written as if the records were contiguous, which is what ${continuous} ` +
          `means. If the recording really has gaps, the file should have been marked ` +
          `${discontinuous}.`,
      });
    }
    const first = origin;
    const last = contiguous[file.recordCount - 1] ?? first;
    if (!canCarry(last, file)) {
      diagnostics.push(unusableOrigin(first, file));
      return { starts: null, diagnostics };
    }
    /*
      An origin of zero is the same as no origin, for timing. It is not the same for the
      check above.

      This returned early on `origin === 0`, which is right about the times — contiguous
      starts from zero are what timing from zero already produces — and skipped the
      contradiction check on the way past. So an EDF+C file whose records say 0, 5 and 10 on
      one-second records went unreported, while the same file shifted one second, saying 1, 6
      and 11, was reported. The contradiction is in records 1 and 2 either way; where record 0
      happens to sit decides nothing about it.
    */
    if (origin === 0) return { starts: null, diagnostics };
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

  /*
    A record with no readable time is placed from the origin the other records establish,
    not from zero.

    `i * recordDuration` assumed the recording began at zero, which is the one thing the
    other records are in a position to contradict: a file starting at 0.5s put its
    unreadable record at 0.000 while its neighbours sat at 1.5s and 2.5s. The guess is still
    a guess — a discontinuous file may have a gap exactly there — and it is still reported
    below, but starting it from where the recording actually begins is strictly closer, and
    it makes an EDF+D file agree with its byte-identical EDF+C twin about record 0.
  */
  const base = originOf(annotationData.recordStarts, file.header.recordDuration) ?? 0;
  const starts = new Float64Array(file.recordCount);
  const missing: number[] = [];
  for (let i = 0; i < file.recordCount; i++) {
    const declared = annotationData.recordStarts[i];
    if (declared === null || declared === undefined) {
      missing.push(i);
      starts[i] = base + i * file.header.recordDuration;
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

  /*
    Furthest from zero, in either direction.

    This took the signed maximum and seeded it with 0, so a recording whose records all sit
    at negative onsets never got past the seed: `furthest` stayed 0, which any interval can
    carry. Then the samples collapsed anyway, because the arithmetic that defeats a large
    positive origin defeats a large negative one identically — at -1e16 seconds, adding a
    1-second sample interval leaves the double unchanged.

    A four-record recording of eight samples wrote two rows, exit 0, no warning. Its
    byte-for-byte positive mirror wrote all eight and explained why it had to time them from
    zero. Same file, same failure, opposite sign, opposite outcome — and the silent one is
    the one that loses data, which is exactly what unusableOrigin exists to prevent.
  */
  let furthest = 0;
  for (const start of starts) if (Math.abs(start) > Math.abs(furthest)) furthest = start;
  if (!canCarry(furthest, file)) {
    diagnostics.push(unusableOrigin(furthest, file));
    return { starts: null, diagnostics };
  }

  /*
    Two ways a record can put the time column out of order, and only one was being looked for.

    A record starting before the one before it is the obvious case. The other is a record
    starting before the one before it *ends*: starts of 0, 0.5 and 1.0 on one-second records
    are strictly increasing, so nothing fired, and the rows still came out 0.25, 0.5, 0.75,
    0.5 — because record 0's samples run to 0.75 while record 1 begins at 0.5. Overlapping
    acquisition is what a device does when it re-sends a buffer, and the reader has no more
    to say about it than about the reversed case: every sample is written, in file order,
    with the time the file gives it.

    Contiguity is not overlap. A continuous recording has `starts[i] === starts[i-1] +
    duration` exactly, so the comparison is made strict by a fraction of the finest interval
    the recording can express — the same measure the origin check uses.
  */
  const slack = finestInterval(file) / 2;
  let outOfOrder = 0;
  let overlapping = 0;
  for (let i = 1; i < starts.length; i++) {
    const previous = starts[i - 1] as number;
    const current = starts[i] as number;
    if (current < previous) outOfOrder++;
    else if (current + slack < previous + file.header.recordDuration) overlapping++;
  }
  if (outOfOrder > 0) {
    diagnostics.push({
      code: 'DISCONTINUOUS',
      severity: 'warning',
      message: `${outOfOrder} data record${outOfOrder === 1 ? '' : 's'} start earlier than the record before it.`,
      hint: 'Rows are written in file order, so the time column will not increase monotonically.',
    });
  }
  if (overlapping > 0) {
    diagnostics.push({
      code: 'DISCONTINUOUS',
      severity: 'warning',
      message:
        `${overlapping} data record${overlapping === 1 ? '' : 's'} start before the record ` +
        `before ${overlapping === 1 ? 'it' : 'them'} ends, so their samples overlap in time.`,
      hint: 'Rows are written in file order, so the time column will not increase monotonically.',
    });
  }

  return { starts, diagnostics };
}

/**
 * The recording's origin, from the first record that states where it is.
 *
 * Records of a continuous recording sit end to end, so record `i` beginning at `t` puts the
 * origin at `t - i * duration`. Any one readable timekeeping TAL is therefore enough, which
 * is what stops one unreadable entry from costing the whole file its position in time.
 */
function originOf(recordStarts: readonly (number | null)[], recordDuration: number): number | null {
  for (const [index, declared] of recordStarts.entries()) {
    if (typeof declared !== 'number') continue;
    const origin = declared - index * recordDuration;
    return Number.isFinite(origin) ? origin : null;
  }
  return null;
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
  // Asked of the origin furthest from zero, whichever side it is on: the spacing of doubles
  // grows with magnitude, not with value, so -1e16 and +1e16 fail this identically.
  return origin + finestInterval(file) > origin;
}

/**
 * The shortest span this recording can tell apart: one sample of its fastest channel.
 *
 * The time column is made of these, so nothing below one is a distinction the file is in a
 * position to make — which is what makes it the right size for both the "can this origin
 * still separate two samples" question and the "is this record really somewhere else"
 * question.
 */
function finestInterval(file: EdfFile): number {
  let interval = file.header.recordDuration;
  for (const signal of file.header.signals) {
    if (signal.isAnnotations || !(signal.samplesPerRecord > 0)) continue;
    const step = file.header.recordDuration / signal.samplesPerRecord;
    if (step > 0 && step < interval) interval = step;
  }
  return interval;
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
