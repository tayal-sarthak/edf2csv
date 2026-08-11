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
import { counted, listed } from '../format/list.js';
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
      `File declares ${counted(signalCount, 'signal')}, which needs a ${expectedHeaderBytes}-byte header, ` +
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
        `Header says it is ${headerBytes} bytes, but ${counted(signalCount, 'signal')} ` +
        `${signalCount === 1 ? 'requires' : 'require'} ${expectedHeaderBytes} bytes. ` +
        `Using the value computed from the signal count.`,
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
  const emptyLabels: number[] = [];

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
      /*
        Which of the two fields carries them, because the consequences are not the same.

        The message said "label or unit", and then said the bytes "will appear in the CSV
        column name" and that "the name cannot be typed" — both of which are about the label.
        A channel labelled plainly `ECG` in a unit of `u\x07V` got all of it: its column is
        `ECG`, `--channels ECG` selects it and exits 0, and the byte is in channels.csv's
        `unit` cell, which the warning never mentioned. Three sentences, none of them true of
        the file that raised it, on a warning whose whole purpose is to say where an invisible
        byte went.
      */
      /*
        All four free-text fields, not the two that were checked.

        `transducer` and `prefiltering` are free text out of the header exactly as the label
        and the unit are, and they land in channels.csv exactly as the unit does — so an ESC
        byte in a transducer field reached the CSV raw with nothing said, and `cat
        channels.csv` would drive the terminal. That is the hazard this warning exists for,
        two columns over. 0.5.71 made it name which field carries them; this is the rest of
        the fields it can name.
      */
      const fields = [
        ['label', label],
        ['unit', physicalDimension],
        ['transducer', transducer],
        ['prefiltering', prefiltering],
      ] as const;
      const affected = fields.filter(([, text]) => [...text].some(isControlCharacter));
      const control = affected.flatMap(([, text]) => [...text].filter(isControlCharacter));
      if (control.length > 0) {
        const shown = [...new Set(control)]
          .map((c) => `\\x${(c.codePointAt(0) as number).toString(16).padStart(2, '0')}`)
          .join(', ');
        const plural = control.length === 1 ? '' : 's';
        const inLabel = affected.some(([name]) => name === 'label');
        // "label and unit", not "label, unit" — `listed` is for long enumerations that get
        // truncated, and this is a sentence with at most four items in it.
        const names = affected.map(([name]) => name);
        const named =
          names.length === 1
            ? (names[0] as string)
            : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`;
        // Where they land, which is the question the reader has. A label becomes a column
        // name in signals.csv; the other three are cells of channels.csv and nothing else.
        // Named down to the cell when there is one of them, because that is the answer to
        // "where did it go" — `channels.csv` alone leaves a reader scanning fourteen columns.
        const cells = affected.filter(([name]) => name !== 'label').map(([name]) => name);
        const where =
          cells.length === 1 ? `channels.csv's ${cells[0] as string} cell` : 'channels.csv';
        const lands =
          inLabel && cells.length > 0
            ? `which will appear in the CSV column name and in ${where}`
            : inLabel
              ? 'which will appear in the CSV column name'
              : `which will appear in ${where}`;
        diagnostics.push({
          code: 'NONPRINTABLE_LABEL',
          severity: 'warning',
          message:
            `Signal ${i}'s ${named} ${affected.length === 1 ? 'contains' : 'contain'} ` +
            `${control.length} control character${plural} (${shown}), ${lands} exactly as the ` +
            `header has ${control.length === 1 ? 'it' : 'them'}.`,
          hint:
            /*
              Every branch has to print a command that works.

              The middle one quoted the label back, which is right until the label is empty:
              an unlabelled channel got `--channels ""`, and that exits 2 with "--channels was
              given but lists no channel names". A hint whose command fails is worse than no
              hint, and this warning's whole job is to say how to reach a channel whose header
              text you cannot type. `EMPTY_LABEL` already says the position is the only way in
              for such a channel; so does this now.

              A comma is the third way. `--channels` separates names with one, and splits on
              every occurrence, so a channel labelled `EEG Fpz-Cz, ref` cannot be selected by
              name at all: the quoted-back advice printed `--channels "EEG Fpz-Cz, ref"`, which
              exits 2 with `No channel named "EEG Fpz-Cz"` — a channel the file does not have,
              named after half of one it does. Commas in labels are ordinary, since EDF labels
              are free text, and the CSV header quotes them; only this one hint claimed
              something about them that isn't so.
            */
            (inLabel || label === '' || label.includes(',')
              ? `Address the channel by position with --channels "#${i}" rather than by name, ` +
                `since ${
                  inLabel
                    ? 'the name cannot be typed'
                    : label === ''
                      ? 'it has no label'
                      : 'a comma in the label would read as two names'
                }. `
              : `The column name is unaffected, so --channels "${label}" still selects it. `) +
            'Printing the CSV to a terminal may do more than print it.',
        });
      }

      if (label === '') {
        // Collected, not reported here: what this channel's column ends up called depends on
        // whether some later channel is literally labelled `signal_<i>`, and inside this loop
        // the later channels do not exist yet. See the pass below.
        emptyLabels.push(i);
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

      /*
        Too large to represent, and too small — the second was silent.

        The gain is the span divided by the digital range, and a span of 2e-320 over 65,535
        codes is 3e-325: below the smallest subnormal double, so it underflows to +0. The
        scaler's flat-range branch then handed every code the same physical value, and a
        channel of 65,536 distinct readings became one repeated number with nothing raised at
        all. One power of ten away, at 1e-319, the same file raises VALUE_RESOLUTION.

        Both are the same fact about the header — the span cannot be turned into a mapping —
        so both get this code, and both leave the cells empty rather than filling them with a
        value the header cannot justify.
      */
      const span = physicalMax - physicalMin;
      const underflowed = span !== 0 && span / (digitalMax - digitalMin) === 0;
      if (!Number.isFinite(span) || underflowed) {
        diagnostics.push({
          code: 'UNUSABLE_PHYSICAL_RANGE',
          severity: 'warning',
          message:
            `Signal ${i} ("${label}") declares a physical range from ${physicalMin} to ` +
            `${physicalMax}, whose span is too ${underflowed ? 'small' : 'large'} to ` +
            `represent, so its values cannot be scaled.`,
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

  /*
    What an unlabelled channel is actually called, which the message used to guess.

    A channel with no label takes `signal_<index>` — unless another channel is literally
    labelled that, which EDF permits, since labels are free text and nothing enforces anything
    about them. Then both collide and both are suffixed. The warning said "It will appear as
    "signal_0"" while the file's header read `time_s,signal_0_ch0,signal_0_ch1`: the one
    sentence the run printed named a column that exists in neither signals.csv nor
    channels.csv.

    The other half was silent. The channel that genuinely carries the label `signal_0` lost
    its own column name to a collision with a synthesised one, and nothing said so —
    DUPLICATE_LABEL did not fire, because the two labels are not the same label. Both halves
    are one sentence here, because they are one event.

    No specific suffixed name is quoted. The suffix rule has a second pass for names that are
    still shared afterwards, and a message that hard-coded `_ch<index>` would be guessing again
    in exactly the way this is fixing.
  */
  for (const index of emptyLabels) {
    const taken = seenLabels.get(`signal_${index}`);
    diagnostics.push({
      code: 'EMPTY_LABEL',
      severity: 'warning',
      message:
        taken === undefined
          ? `Signal ${index} has no label. It will appear as "signal_${index}".`
          : `Signal ${index} has no label, so it takes the name "signal_${index}" — which ` +
            `${taken.length === 1 ? 'signal' : 'signals'} ${listed(taken.map(String))} already ` +
            `${taken.length === 1 ? 'carries' : 'carry'} as a label, so both columns are ` +
            `suffixed with their position instead.`,
    });
  }

  /*
    A timestamp that is not one.

    EDF gives the start date and time eight characters each, and nothing stops a writer
    putting `32.13.99` and `25.61.61` there. `--info` has always echoed the raw fields with
    "(unparseable)" beside them, but nothing was raised: the conversion exited 0, `--strict`
    passed, and metadata.json recorded `start_datetime_local: null` with no note against it.

    Every other unusable header field reports itself — a degenerate digital range, a physical
    span that cannot be represented, a comma decimal separator, a header whose declared size
    disagrees with its signal count. This was the one that did not, and it is the field
    output-files points at for turning `time_s` into an absolute instant.
  */
  if (resolveStartDateTime(startDateRaw, startTimeRaw) === null) {
    diagnostics.push({
      code: 'START_TIME_UNREADABLE',
      severity: 'warning',
      message:
        `The header's start date and time ("${startDateRaw}" and ` +
        `"${startTimeRaw}") are not a date and a time, so the recording has ` +
        `no start instant.`,
      hint:
        'time_s is unaffected — it counts from the start of the recording either way. What ' +
        'cannot be done is turning it into a wall-clock instant, and metadata.json records ' +
        'start_datetime_local as null.',
    });
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
    /*
      Which of the two, and with the numbers.

      "The recording was probably interrupted before any data was written" is right about an
      empty file and wrong about the other way to get here: a header declaring records larger
      than the data present. A 606 KB file holding 589 KB of samples — 60% of one record, more
      than half a million readings — was told no data was written, and the message carried no
      figures at all, so nothing in it could be checked against the file. The declared record
      size is the thing to look at, and it was the one thing not said.

      Still an error either way. A record is the unit the format is addressed in, and there is
      nothing smaller to convert.
    */
    const empty = dataBytes === 0;
    throw new EdfError(
      'NO_DATA_RECORDS',
      empty
        ? 'The file contains a header and no data at all.'
        : `The file contains ${counted(dataBytes, 'byte')} of data, which is less than the ` +
          `${recordBytes} its header says one data record takes.`,
      empty
        ? 'The recording was probably interrupted before any data was written.'
        : 'Either the recording was cut short part way through its first record, or the ' +
          'header describes records larger than the ones actually written. Check the ' +
          'samples-per-record fields against the file size.',
    );
  }

  if (declaredRecordCount === -1) {
    diagnostics.push({
      code: 'RECORD_COUNT_UNKNOWN',
      severity: 'warning',
      message:
        `The header does not say how many data records the file has (-1), which the spec allows ` +
        `for recordings still in progress. Using the ${counted(recordCount, 'record')} the file actually contains.`,
    });
  } else if (declaredRecordCount !== recordCount) {
    diagnostics.push({
      code: 'RECORD_COUNT_MISMATCH',
      severity: 'warning',
      message:
        `The header declares ${declaredRecordCount} data records but the file contains ` +
        `${recordCount}. Converting the ${counted(recordCount, 'record')} that ${recordCount === 1 ? 'is' : 'are'} present.`,
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
      message: `${counted(trailingBytes, 'byte')} after the last complete data record ${trailingBytes === 1 ? 'was' : 'were'} ignored.`,
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
