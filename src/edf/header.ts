/**
 * EDF / EDF+ header parsing.
 *
 * Layout (all fields are ASCII, left-justified, space-padded):
 *
 *   fixed header, 256 bytes
 *     0    8   version ('0', or 255 + 'BIOSEMI' for BDF)
 *     8   80   patient identification
 *    88   80   recording identification
 *   168    8   start date  dd.mm.yy
 *   176    8   start time  hh.mm.ss
 *   184    8   number of bytes in the header record
 *   192   44   reserved  ('EDF+C' / 'EDF+D' live here)
 *   236    8   number of data records (-1 if unknown)
 *   244    8   duration of a data record, in seconds (may be fractional)
 *   252    4   number of signals (ns)
 *
 *   signal header, ns * 256 bytes, stored FIELD-major rather than signal-major:
 *   all ns labels, then all ns transducer types, and so on.
 *     ns * 16   label
 *     ns * 80   transducer type
 *     ns *  8   physical dimension
 *     ns *  8   physical minimum
 *     ns *  8   physical maximum
 *     ns *  8   digital minimum
 *     ns *  8   digital maximum
 *     ns * 80   prefiltering
 *     ns *  8   number of samples in each data record
 *     ns * 32   reserved
 */

import { EdfError } from './errors.js';
import type { Diagnostic } from './errors.js';
import { listed } from '../format/list.js';
import { decodeLatin1 } from './bytes.js';

/** Label the EDF+ spec reserves for the annotations channel. */
export const ANNOTATIONS_LABEL = 'EDF Annotations';
/** BDF+ uses its own spelling for the same channel. */
export const BDF_ANNOTATIONS_LABEL = 'BDF Annotations';

export const FIXED_HEADER_BYTES = 256;
export const SIGNAL_HEADER_BYTES = 256;

export interface EdfSignal {
  /** Position in the file, 0-based. Stable even when labels collide. */
  index: number;
  label: string;
  transducer: string;
  physicalDimension: string;
  physicalMin: number;
  physicalMax: number;
  digitalMin: number;
  digitalMax: number;
  prefiltering: string;
  samplesPerRecord: number;
  reserved: string;
  /** True for the EDF+ 'EDF Annotations' channel, which carries text, not signal. */
  isAnnotations: boolean;
  /** samplesPerRecord / recordDuration, in Hz. */
  samplingRate: number;
  /** Byte offset of this signal's samples within one data record. */
  byteOffsetInRecord: number;
}

export interface EdfHeader {
  version: string;
  patientId: string;
  recordingId: string;
  /** Raw 'dd.mm.yy' as written in the file. */
  startDateRaw: string;
  /** Raw 'hh.mm.ss' as written in the file. */
  startTimeRaw: string;
  /** Resolved start instant, or null when the file's date/time fields are unusable. */
  startDateTime: Date | null;
  /**
   * Header size in bytes, computed from the signal count rather than read from the field.
   *
   * Every data record offset is derived from this, so it has to be the one the layout
   * actually uses: 256 for the fixed header plus 256 per signal. A writer that fills the
   * field in carelessly is common enough to have its own warning, HEADER_BYTES_MISMATCH,
   * and trusting the field over the arithmetic would put every sample at the wrong offset.
   */
  headerBytes: number;
  /**
   * What the header's own length field says, which need not be the above.
   *
   * Exposed for the same reason `declaredRecordCount` is: the two disagreeing is a fact
   * about the file, and a caller checking how a recording was written should be able to see
   * what it claimed rather than only what was believed.
   */
  declaredHeaderBytes: number;
  reserved: string;
  isEdfPlus: boolean;
  /** True for BioSemi BDF/BDF+ files, whose samples are 3 bytes rather than 2. */
  isBdf: boolean;
  /** 'EDF+C' continuous, 'EDF+D' discontinuous, or null for plain EDF. */
  continuity: 'EDF+C' | 'EDF+D' | null;
  /** As declared in the header. -1 means "unknown", which the spec permits. */
  declaredRecordCount: number;
  recordDuration: number;
  signalCount: number;
  signals: EdfSignal[];
  bytesPerSample: number;
  recordBytes: number;
}

/** Everything derived by combining the header with the file's real size. */
export interface EdfHeaderInfo {
  header: EdfHeader;
  /** Record count implied by the actual file size — the one we trust for reading. */
  recordCount: number;
  /** Bytes after the last complete data record. */
  trailingBytes: number;
  diagnostics: Diagnostic[];
}

/**
 * A byte the terminal treats as an instruction rather than as text.
 *
 * C0 and C1, plus DEL. Tab is included deliberately: it is harmless to a terminal but it
 * makes a CSV column name that cannot be typed or matched reliably, which is the other half
 * of what this warning is for.
 */
function isControlCharacter(character: string): boolean {
  const code = character.codePointAt(0) as number;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

const dec = (buf: Uint8Array, start: number, len: number): string =>
  decodeLatin1(buf, start, start + len);

/** EDF fields are space-padded; trailing NULs also occur in files written by sloppy tools. */
const trimField = (s: string): string => s.replace(/[\0\s]+$/u, '').replace(/^\s+/u, '');

/**
 * How many signals the fixed header says there are, read exactly as `parseHeader` will.
 *
 * `EdfFile.open` needs this before it can know how much header to read, and it used to work
 * it out with its own `Number(...)` — which was NUL-tolerant but not comma-tolerant, unlike
 * every other numeric field here. A header written with a comma decimal separator, which
 * COMMA_DECIMAL exists to accept and which the documentation lists this field among, was
 * therefore never given its signal headers at all, and the file died on a message that
 * contradicted itself: "needs a 768-byte header, but the file is only 848 bytes".
 *
 * Sharing the parse is what keeps the two from disagreeing again about which files are
 * readable. Null means "not a usable count", and the caller reads no further header — the
 * real error then comes from `parseHeader`, which is the one place that decides.
 */
export function peekSignalCount(fixed: Uint8Array): number | null {
  const count = Number(normaliseNumberField(dec(fixed, 252, 4)).text);
  return Number.isInteger(count) && count > 0 ? count : null;
}

/** A numeric header field, trimmed and with a comma decimal separator turned into a dot. */
function normaliseNumberField(raw: string): { text: string; sawComma: boolean } {
  const text = trimField(raw);
  // Some writers emit a comma decimal separator despite the spec requiring '.'.
  if (text.includes(',') && !text.includes('.')) {
    return { text: text.replace(',', '.'), sawComma: true };
  }
  return { text, sawComma: false };
}

function parseNumberField(
  raw: string,
  field: string,
  { integer = false, sawComma }: { integer?: boolean; sawComma?: { value: boolean } } = {},
): number {
  const normalised = normaliseNumberField(raw);
  const text = normalised.text;
  if (normalised.sawComma && sawComma) sawComma.value = true;
  if (text === '') {
    throw new EdfError('BAD_HEADER_FIELD', `Header field "${field}" is empty.`);
  }
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new EdfError(
      'BAD_HEADER_FIELD',
      `Header field "${field}" is not a number (found ${JSON.stringify(text)}).`,
      'The file may be truncated, byte-shifted, or not an EDF file at all.',
    );
  }
  if (integer && !Number.isInteger(n)) {
    throw new EdfError(
      'BAD_HEADER_FIELD',
      `Header field "${field}" must be a whole number (found ${JSON.stringify(text)}).`,
    );
  }
  return n;
}

/**
 * EDF stores a two-digit year. The spec pins the century: 85-99 mean 1985-1999
 * and 00-84 mean 2000-2084. Files outside 1985-2084 cannot express their date.
 */
function resolveStartDateTime(dateRaw: string, timeRaw: string): Date | null {
  const d = /^(\d{2})[.\-/](\d{2})[.\-/](\d{2})$/u.exec(trimField(dateRaw));
  const t = /^(\d{2})[.:\-](\d{2})[.:\-](\d{2})$/u.exec(trimField(timeRaw));
  if (!d || !t) return null;

  const dd = Number(d[1]);
  const mm = Number(d[2]);
  const yy = Number(d[3]);
  const hh = Number(t[1]);
  const mi = Number(t[2]);
  const ss = Number(t[3]);

  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 60) return null;

  const year = yy >= 85 ? 1900 + yy : 2000 + yy;
  const date = new Date(Date.UTC(year, mm - 1, dd, hh, mi, Math.min(ss, 59)));
  // Reject dates that rolled over, e.g. 31.02.
  if (date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;
  return date;
}

/**
 * Parse the fixed 256-byte header plus the per-signal header block.
 *
 * @param buf   At least FIXED_HEADER_BYTES + ns * SIGNAL_HEADER_BYTES bytes.
 * @param fileSize Total size of the file on disk, used to derive the real record count.
 */
export function parseHeader(buf: Uint8Array, fileSize: number): EdfHeaderInfo {
  const diagnostics: Diagnostic[] = [];
  const sawComma = { value: false };

  if (buf.length < FIXED_HEADER_BYTES) {
    throw new EdfError(
      'FILE_TOO_SMALL',
      `File is ${fileSize} bytes; an EDF header alone needs at least ${FIXED_HEADER_BYTES}.`,
    );
  }

  // BDF (BioSemi) marks itself with byte 255 followed by 'BIOSEMI', and stores
  // 3-byte samples instead of 2. Everything else about the layout is identical.
  const isBdf = buf[0] === 0xff && dec(buf, 1, 7) === 'BIOSEMI';
  const version = isBdf ? 'BIOSEMI' : trimField(dec(buf, 0, 8));

  const patientId = trimField(dec(buf, 8, 80));
  const recordingId = trimField(dec(buf, 88, 80));
  const startDateRaw = trimField(dec(buf, 168, 8));
  const startTimeRaw = trimField(dec(buf, 176, 8));
  const headerBytes = parseNumberField(dec(buf, 184, 8), 'number of header bytes', {
    integer: true,
    sawComma,
  });
  const reserved = trimField(dec(buf, 192, 44));
  const declaredRecordCount = parseNumberField(dec(buf, 236, 8), 'number of data records', {
    integer: true,
    sawComma,
  });
  const recordDuration = parseNumberField(dec(buf, 244, 8), 'duration of a data record', {
    sawComma,
  });
  const signalCount = parseNumberField(dec(buf, 252, 4), 'number of signals', {
    integer: true,
    sawComma,
  });

  if (signalCount <= 0) {
    throw new EdfError(
      'INVALID_SIGNAL_COUNT',
      `Header declares ${signalCount} signals; expected at least 1.`,
    );
  }
  if (!(recordDuration > 0)) {
    throw new EdfError(
      'INVALID_RECORD_DURATION',
      `Header declares a data record duration of ${recordDuration}s; expected a positive number.`,
    );
  }

  const expectedHeaderBytes = FIXED_HEADER_BYTES + signalCount * SIGNAL_HEADER_BYTES;
  if (buf.length < expectedHeaderBytes) {
    throw new EdfError(
      'FILE_TOO_SMALL',
      /*
        Which of the two is actually short.

        The file size was quoted either way, so a caller that had read too little — the
        signal count parsed one way here and another way there — produced arithmetic that
        refuted itself: "needs a 768-byte header, but the file is only 848 bytes". A reader
        following that looks for a truncation that is not there.
      */
      `File declares ${signalCount} signals, which needs a ${expectedHeaderBytes}-byte header, ` +
        (fileSize < expectedHeaderBytes
          ? `but the file is only ${fileSize} bytes.`
          : `but only ${buf.length} bytes of it were handed to the parser.`),
    );
  }
  if (headerBytes !== expectedHeaderBytes) {
    diagnostics.push({
      code: 'HEADER_BYTES_MISMATCH',
      severity: 'warning',
      message:
        `Header says it is ${headerBytes} bytes, but ${signalCount} signals require ` +
        `${expectedHeaderBytes} bytes. Using the value computed from the signal count.`,
    });
  }

  // Signal headers are field-major: all labels, then all transducers, and so on.
  const base = FIXED_HEADER_BYTES;
  const readField = (offsetUnits: number, width: number, i: number): string =>
    dec(buf, base + offsetUnits * signalCount + i * width, width);

  // EDF+ writes 'EDF+C'/'EDF+D' here; BDF+ writes 'BDF+C'/'BDF+D'. The two mean the
  // same thing, so both are normalised to a single continuity marker.
  const continuityTag = /^(?:EDF|BDF)\+([CD])/u.exec(reserved);
  const continuity: 'EDF+C' | 'EDF+D' | null =
    continuityTag === null ? null : continuityTag[1] === 'D' ? 'EDF+D' : 'EDF+C';

  const signals: EdfSignal[] = [];
  let byteOffsetInRecord = 0;
  const bytesPerSample = isBdf ? 3 : 2;
  const seenLabels = new Map<string, number[]>();

  for (let i = 0; i < signalCount; i++) {
    const label = trimField(readField(0, 16, i));
    const transducer = trimField(readField(16, 80, i));
    const physicalDimension = trimField(readField(96, 8, i));
    const physicalMin = parseNumberField(readField(104, 8, i), `physical minimum (signal ${i})`, {
      sawComma,
    });
    const physicalMax = parseNumberField(readField(112, 8, i), `physical maximum (signal ${i})`, {
      sawComma,
    });
    const digitalMin = parseNumberField(readField(120, 8, i), `digital minimum (signal ${i})`, {
      integer: true,
      sawComma,
    });
    const digitalMax = parseNumberField(readField(128, 8, i), `digital maximum (signal ${i})`, {
      integer: true,
      sawComma,
    });
    const prefiltering = trimField(readField(136, 80, i));
    const samplesPerRecord = parseNumberField(
      readField(216, 8, i),
      `samples per record (signal ${i})`,
      { integer: true, sawComma },
    );
    const sigReserved = trimField(readField(224, 32, i));

    if (samplesPerRecord < 0) {
      throw new EdfError(
        'BAD_HEADER_FIELD',
        `Signal ${i} ("${label}") declares ${samplesPerRecord} samples per record.`,
      );
    }

    const isAnnotations = label === ANNOTATIONS_LABEL || label === BDF_ANNOTATIONS_LABEL;

    signals.push({
      index: i,
      label,
      transducer,
      physicalDimension,
      physicalMin,
      physicalMax,
      digitalMin,
      digitalMax,
      prefiltering,
      samplesPerRecord,
      reserved: sigReserved,
      isAnnotations,
      samplingRate: samplesPerRecord / recordDuration,
      byteOffsetInRecord,
    });
    byteOffsetInRecord += samplesPerRecord * bytesPerSample;

    if (!isAnnotations) {
      /*
        A label is free text out of the file, and it becomes a column name in signals.csv.

        `--info` has escaped control bytes since it was written, because an ANSI escape in a
        header can drive the reader's terminal — `\x1b[2J` clears the screen. The CSV had no
        such protection and needed none for correctness: quoting makes any byte safe for a
        parser, and this still passes the label through exactly as the file gives it, because
        losing what the header says is not an improvement.

        What was missing is the sentence saying so. A recording whose channel is labelled
        `\x1b[2Jgone` converted with no warning at all, and `cat signals.csv` then cleared
        the terminal — while a script referencing that column by name carried an invisible
        control character in it. NONPRINTABLE_LABEL has been declared and documented as
        reserved since 0.1; this is it doing its job.
      */
      const control = [...label, ...physicalDimension].filter(isControlCharacter);
      if (control.length > 0) {
        const shown = [...new Set(control)]
          .map((c) => `\\x${(c.codePointAt(0) as number).toString(16).padStart(2, '0')}`)
          .join(', ');
        diagnostics.push({
          code: 'NONPRINTABLE_LABEL',
          severity: 'warning',
          message:
            `Signal ${i}'s label or unit contains ${control.length} control ` +
            `character${control.length === 1 ? '' : 's'} (${shown}), which will appear in the ` +
            `CSV column name exactly as the header has them.`,
          hint:
            'Address the channel by position with --channels "#' +
            `${i}" rather than by name, since the name cannot be typed. Printing the CSV to a ` +
            'terminal may do more than print it.',
        });
      }

      if (label === '') {
        diagnostics.push({
          code: 'EMPTY_LABEL',
          severity: 'warning',
          message: `Signal ${i} has no label. It will appear as "signal_${i}".`,
        });
      } else {
        // Collected rather than reported here: a label repeated five times should
        // produce one warning naming all five, not four near-identical pairs.
        const seen = seenLabels.get(label);
        if (seen) seen.push(i);
        else seenLabels.set(label, [i]);
      }

      if (samplesPerRecord === 0) {
        diagnostics.push({
          code: 'NO_SAMPLES',
          severity: 'warning',
          message: `Signal ${i} ("${label}") carries no samples at all (0 per data record).`,
          hint: 'It is described in channels.csv but left out of the converted data.',
        });
      }

      if (!Number.isFinite(physicalMax - physicalMin)) {
        diagnostics.push({
          code: 'UNUSABLE_PHYSICAL_RANGE',
          severity: 'warning',
          message:
            `Signal ${i} ("${label}") declares a physical range from ${physicalMin} to ` +
            `${physicalMax}, whose span is too large to represent, so its values cannot be scaled.`,
          hint: 'Its cells are left empty rather than filled with a value the header cannot justify.',
        });
      } else if (digitalMax === digitalMin) {
        diagnostics.push({
          code: 'DEGENERATE_DIGITAL_RANGE',
          severity: 'warning',
          message:
            `Signal ${i} ("${label}") has digital minimum equal to digital maximum ` +
            `(${digitalMin}), so its values cannot be scaled.`,
          hint: 'Its cells are left empty rather than filled with a value the header cannot justify.',
        });
      } else if (physicalMax === physicalMin) {
        diagnostics.push({
          code: 'DEGENERATE_PHYSICAL_RANGE',
          severity: 'warning',
          message:
            `Signal ${i} ("${label}") has physical minimum equal to physical maximum ` +
            `(${physicalMin}), so every sample converts to the same value.`,
        });
      } else if ((physicalMax - physicalMin) * (digitalMax - digitalMin) < 0) {
        /*
          Polarity is inverted when the gain is negative, and the gain is
          (physicalMax - physicalMin) / (digitalMax - digitalMin) — so it is the sign of the
          two spans together that matters, not the physical pair alone.

          Testing only `physicalMax < physicalMin` was wrong in both directions. A file with
          its DIGITAL bounds reversed is just as inverted and drew no warning at all, handing
          back sign-flipped EEG with nothing to indicate it. A file with BOTH pairs reversed
          has a positive gain and is not inverted, yet was warned about — a message that was
          simply untrue of that recording.
        */
        const reversed =
          physicalMax < physicalMin
            ? `physical minimum ${physicalMin} above physical maximum ${physicalMax}`
            : `digital minimum ${digitalMin} above digital maximum ${digitalMax}`;
        diagnostics.push({
          code: 'INVERTED_PHYSICAL_RANGE',
          severity: 'warning',
          message: `Signal ${i} ("${label}") declares ${reversed}, which inverts its polarity.`,
          hint: 'The values are converted exactly as the header specifies, inversion included.',
        });
      }
    }
  }

  for (const [label, indices] of seenLabels) {
    if (indices.length < 2) continue;
    diagnostics.push({
      code: 'DUPLICATE_LABEL',
      severity: 'warning',
      message: `${indices.length} signals share the label "${label}" (positions ${indices.join(', ')}).`,
      hint: 'Their columns are suffixed with the signal number so they stay distinguishable.',
    });
  }

  const recordBytes = byteOffsetInRecord;
  if (recordBytes <= 0) {
    throw new EdfError(
      'NO_SAMPLES',
      'No signal in this file carries any samples (every channel declares 0 samples per record).',
    );
  }

  if (sawComma.value) {
    diagnostics.push({
      code: 'COMMA_DECIMAL',
      severity: 'warning',
      message: 'Some header numbers use a comma decimal separator, which the EDF spec does not allow.',
      hint: 'They were read as decimal points. Check the values in the channel table.',
    });
  }

  const dataBytes = fileSize - expectedHeaderBytes;
  if (dataBytes < 0) {
    throw new EdfError('FILE_TOO_SMALL', `File is smaller than its own header.`);
  }
  const recordCount = Math.floor(dataBytes / recordBytes);
  const trailingBytes = dataBytes - recordCount * recordBytes;

  if (recordCount === 0) {
    throw new EdfError(
      'NO_DATA_RECORDS',
      'The file contains a header but no complete data record.',
      'The recording was probably interrupted before any data was written.',
    );
  }

  if (declaredRecordCount === -1) {
    diagnostics.push({
      code: 'RECORD_COUNT_UNKNOWN',
      severity: 'warning',
      message:
        `The header does not say how many data records the file has (-1), which the spec allows ` +
        `for recordings still in progress. Using the ${recordCount} records the file actually contains.`,
    });
  } else if (declaredRecordCount !== recordCount) {
    diagnostics.push({
      code: 'RECORD_COUNT_MISMATCH',
      severity: 'warning',
      message:
        `The header declares ${declaredRecordCount} data records but the file contains ` +
        `${recordCount}. Converting the ${recordCount} records that are present.`,
      hint:
        declaredRecordCount > recordCount
          ? 'The recording looks truncated. It may have been cut short or copied incompletely.'
          : 'The file is longer than its header claims.',
    });
  }

  if (trailingBytes > 0) {
    diagnostics.push({
      code: 'TRAILING_BYTES',
      severity: 'warning',
      message: `${trailingBytes} bytes after the last complete data record were ignored.`,
    });
  }

  const isEdfPlus = continuity !== null;
  if (continuity === 'EDF+D') {
    diagnostics.push({
      code: 'DISCONTINUOUS',
      severity: 'warning',
      message:
        `This is a discontinuous (${isBdf ? 'BDF+D' : 'EDF+D'}) recording: its data records are ` +
        `not contiguous in time.`,
      hint: 'Each row carries its true recording time, so gaps stay visible instead of being closed.',
    });
  }

  const dataSignals = signals.filter((s) => !s.isAnnotations);
  if (dataSignals.length === 0) {
    diagnostics.push({
      code: 'NO_SIGNAL_CHANNELS',
      severity: 'warning',
      message: 'This file has no signal channels; it contains only EDF+ annotations.',
    });
  }

  // A channel declaring zero samples per record has no sampling rate to speak of — it is
  // reported separately as NO_SAMPLES and no file is written for it. Counting its nominal
  // 0 Hz as a rate made a single-rate recording warn that it used "2 different sampling
  // rates (4 Hz, 0 Hz)" and claim it was splitting output it never split.
  const rates = new Set(dataSignals.filter((s) => s.samplesPerRecord > 0).map((s) => s.samplingRate));
  if (rates.size > 1) {
    diagnostics.push({
      code: 'MIXED_SAMPLING_RATES',
      severity: 'warning',
      message:
        `Channels use ${rates.size} different sampling rates ` +
        `(${listed(formatRates([...rates].sort((a, b) => b - a)).map((r) => `${r} Hz`))}).`,
      hint: 'They are written to one file per rate so no channel is resampled.',
    });
  }

  return {
    header: {
      version,
      patientId,
      recordingId,
      startDateRaw,
      startTimeRaw,
      startDateTime: resolveStartDateTime(startDateRaw, startTimeRaw),
      headerBytes: expectedHeaderBytes,
      declaredHeaderBytes: headerBytes,
      reserved,
      isEdfPlus,
      isBdf,
      continuity,
      declaredRecordCount,
      recordDuration,
      signalCount,
      signals,
      bytesPerSample,
      recordBytes,
    },
    recordCount,
    trailingBytes,
    diagnostics,
  };
}

/**
 * The recording start as a zone-less wall clock, "YYYY-MM-DDTHH:MM:SS".
 *
 * EDF stores the start time as local wall-clock digits with no timezone anywhere in
 * the format. `startDateTime` is built with Date.UTC purely so those digits survive a
 * round trip unshifted, which makes it a carrier for the wall clock rather than a
 * real instant. Serialising it with `toISOString()` would append a Z and assert UTC,
 * and any reader converting to local time would then shift the recording by their own
 * offset: 13:43:04 in the file becomes 08:43:04 in New York. The Z is omitted because
 * the file genuinely does not say which zone it meant.
 */
export function formatWallClock(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString().slice(0, 19);
}

/** "EDF", "EDF+ (EDF+D)", "BDF", "BDF+ (EDF+C)". */
export function describeFormat(header: EdfHeader): string {
  const base = header.isBdf ? 'BDF' : 'EDF';
  if (!header.isEdfPlus) return base;
  return `${base}+ (${header.continuity === 'EDF+D' ? 'discontinuous' : 'continuous'})`;
}

/** Render a sampling rate without trailing noise: 256, 0.5, 12.5. */
export function formatRate(hz: number): string {
  if (Number.isInteger(hz)) return String(hz);
  const rounded = Number(hz.toFixed(6));
  // A rate below 5e-7 rounds away to "0", which reads as "this channel has no sampling
  // rate" and made the mixed-rate warning contradict itself: it announced two different
  // rates and then printed both as "0 Hz". Exponent form keeps a real rate legible, and
  // keeps distinct rates distinct in the channel table and in output filenames.
  if (rounded === 0) return hz.toExponential(3);
  return String(rounded);
}

/**
 * Renders a group of rates so that rates which differ read as differing.
 *
 * `formatRate` rounds to six decimals, which is what keeps an ordinary rate free of
 * float noise — 30 samples in a 0.1-second record is 299.99999999999994 as a double,
 * and belongs on screen as 300. Two rates separated by less than that round to one
 * string, so a file carrying 1e-6 Hz and 1.25e-6 Hz warned that it used "2 different
 * sampling rates (0.000001 Hz, 0.000001 Hz)" and named both files the same thing.
 *
 * That is the contradiction the exponent fallback above already removes for rates that
 * round away to zero; this is the same one a step further out. On a collision every rate
 * in the group switches to its shortest exact form, which is unique for distinct values,
 * rather than only the pair that collided — one column in one notation reads better than
 * two.
 */
export function formatRates(rates: readonly number[]): string[] {
  const rounded = rates.map(formatRate);
  const distinct = new Set(rates).size;
  return new Set(rounded).size === distinct ? rounded : rates.map((hz) => String(hz));
}
