/**
 * A minimal EDF / EDF+ writer used only to build test fixtures.
 *
 * Generating fixtures rather than committing binaries keeps the repository small
 * and, more importantly, makes every edge case explicit and adjustable in code.
 * The files this produces have been checked against pyEDFlib, which reads them
 * without complaint — including the EDF+ annotation records.
 */

import { writeFileSync } from 'node:fs';

const SEP_TEXT = '\u0014'; // separates onset/duration from text, and text from text
const SEP_DURATION = '\u0015'; // separates onset from duration
const TAL_END = '\u0000'; // terminates each TAL

/** Left-justified, space-padded ASCII, exactly `width` bytes. */
function ascii(value, width) {
  const buffer = Buffer.alloc(width, 0x20);
  const source = Buffer.from(String(value), 'latin1');
  source.copy(buffer, 0, 0, Math.min(width, source.length));
  return buffer;
}

/** Numeric fields keep as many significant digits as the field width allows. */
function num(value, width) {
  let text = String(value);
  if (text.length > width) {
    for (let decimals = width; decimals >= 0; decimals--) {
      const candidate = Number(value).toFixed(decimals);
      if (candidate.length <= width) {
        text = candidate;
        break;
      }
    }
    text = text.slice(0, width);
  }
  return ascii(text, width);
}

/** Build the byte string for one record's annotation channel. */
export function buildTal(recordStart, annotations = []) {
  let text = `+${recordStart}${SEP_TEXT}${SEP_TEXT}${TAL_END}`;
  for (const a of annotations) {
    text +=
      a.duration === undefined || a.duration === null
        ? `+${a.onset}${SEP_TEXT}${a.text}${SEP_TEXT}${TAL_END}`
        : `+${a.onset}${SEP_DURATION}${a.duration}${SEP_TEXT}${a.text}${SEP_TEXT}${TAL_END}`;
  }
  return text;
}

/**
 * @param {object} spec
 * @param {string} spec.path              destination file
 * @param {number} spec.numRecords        records to write
 * @param {number} spec.recordDuration    seconds per record
 * @param {Array}  spec.signals           per-signal headers plus `gen(record, sample)` or `annotations: true`
 * @param {number} [spec.declaredRecords] override the header's record count (-1 = unknown)
 * @param {number} [spec.truncateRecords] write fewer records than the header claims
 * @param {Function} [spec.talsForRecord] returns the annotation text for a record
 */
export function writeEdf(spec) {
  const {
    path,
    patient = 'X X X X',
    recording = 'Startdate X X X X',
    startDate = '01.01.85',
    startTime = '00.00.00',
    reserved = '',
    numRecords,
    recordDuration,
    signals,
    talsForRecord = null,
    truncateRecords = null,
    declaredRecords = null,
  } = spec;

  const bdf = spec.bdf === true;
  const bytesPerSample = bdf ? 3 : 2;

  // BDF announces itself with byte 255 followed by 'BIOSEMI'.
  const versionField = bdf
    ? Buffer.concat([Buffer.from([0xff]), Buffer.from('BIOSEMI', 'latin1')])
    : ascii('0', 8);

  const ns = signals.length;
  const headerBytes = 256 * (1 + ns);
  const parts = [
    versionField,
    ascii(patient, 80),
    ascii(recording, 80),
    ascii(startDate, 8),
    ascii(startTime, 8),
    ascii(headerBytes, 8),
    ascii(reserved, 44),
    ascii(declaredRecords === null ? numRecords : declaredRecords, 8),
    num(recordDuration, 8),
    ascii(ns, 4),
  ];

  const textField = (pick, width) => signals.forEach((s) => parts.push(ascii(pick(s), width)));
  const numField = (pick, width) => signals.forEach((s) => parts.push(num(pick(s), width)));

  textField((s) => s.label, 16);
  textField((s) => s.transducer ?? '', 80);
  textField((s) => s.dimension ?? '', 8);
  numField((s) => s.physMin, 8);
  numField((s) => s.physMax, 8);
  numField((s) => s.digMin, 8);
  numField((s) => s.digMax, 8);
  textField((s) => s.prefilter ?? '', 80);
  textField((s) => s.samplesPerRecord, 8);
  textField(() => '', 32);

  const header = Buffer.concat(parts);
  if (header.length !== headerBytes) {
    throw new Error(`header is ${header.length} bytes, expected ${headerBytes}`);
  }

  const recordBytes = signals.reduce((total, s) => total + s.samplesPerRecord, 0) * bytesPerSample;
  const recordsToWrite = truncateRecords ?? numRecords;
  const body = Buffer.alloc(recordBytes * recordsToWrite);

  let offset = 0;
  for (let record = 0; record < recordsToWrite; record++) {
    for (const signal of signals) {
      if (signal.annotations) {
        const slot = Buffer.alloc(signal.samplesPerRecord * bytesPerSample, 0x00);
        const text = talsForRecord ? talsForRecord(record) : buildTal(record * recordDuration);
        const encoded = Buffer.from(text, 'utf8');
        if (encoded.length > slot.length) {
          throw new Error(
            `annotations for record ${record} need ${encoded.length} bytes but only ${slot.length} are allocated`,
          );
        }
        encoded.copy(slot);
        slot.copy(body, offset);
        offset += slot.length;
      } else {
        for (let sample = 0; sample < signal.samplesPerRecord; sample++) {
          let value = Math.round(signal.gen(record, sample));
          if (value > signal.digMax) value = signal.digMax;
          if (value < signal.digMin) value = signal.digMin;
          if (bdf) {
            const unsigned = value < 0 ? value + 0x1000000 : value;
            body[offset] = unsigned & 0xff;
            body[offset + 1] = (unsigned >> 8) & 0xff;
            body[offset + 2] = (unsigned >> 16) & 0xff;
          } else {
            body.writeInt16LE(value, offset);
          }
          offset += bytesPerSample;
        }
      }
    }
  }

  writeFileSync(path, Buffer.concat([header, body.subarray(0, offset)]));
  return path;
}
