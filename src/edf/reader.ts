/**
 * Chunked reader for EDF / EDF+ files.
 *
 * Data records are read in batches sized by a byte budget rather than all at once,
 * so peak memory stays flat regardless of how long the recording is. A 4 GB file
 * and a 4 MB file use the same working set.
 */

import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { createHash } from 'node:crypto';

import { EdfError } from './errors.js';
import type { Diagnostic } from './errors.js';
import { FIXED_HEADER_BYTES, SIGNAL_HEADER_BYTES, parseHeader, peekSignalCount } from './header.js';
import type { EdfHeader, EdfSignal } from './header.js';
import { decodeRecordAnnotations } from './annotations.js';
import type { Annotation } from './annotations.js';
import { readInt16LE } from './bytes.js';
import { counted } from '../format/list.js';

/**
 * How far `readOrigin` looks for a record that states its own start time.
 *
 * Enough that one or two unreadable timekeeping entries at the top of a file cost nothing,
 * few enough that `--info` stays a header read rather than a scan.
 */
const RECORDS_SEARCHED_FOR_ORIGIN = 16;

/** Default read budget per batch. Large enough to amortise syscalls, small enough to stay cheap. */
export const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

export interface RecordBatch {
  /** Index of the first record in this batch, relative to the whole file. */
  firstRecordIndex: number;
  recordCount: number;
  /**
   * Raw record bytes, `recordCount * header.recordBytes` long.
   *
   * The buffer is reused between iterations. Copy anything you need to keep past
   * the current loop turn.
   */
  data: Uint8Array;
}

export interface ReadRecordsOptions {
  /** First record to read, inclusive. Defaults to 0. */
  startRecord?: number;
  /** Last record to read, exclusive. Defaults to the file's record count. */
  endRecord?: number;
  chunkBytes?: number;
}

export class EdfFile {
  readonly path: string;
  readonly fileSize: number;
  /**
   * Last-modified time when this file was opened, in milliseconds, for the same reason as
   * `fileSize`.
   *
   * Kept as the raw number rather than a Date because `new Date(ms).getTime()` truncates to
   * whole milliseconds: comparing that against a later `fstat`, which carries the
   * filesystem's sub-millisecond precision, reported every undisturbed conversion as one
   * whose input had changed underneath it.
   */
  readonly modifiedAtOpenMs: number;
  readonly header: EdfHeader;
  /** Records actually present in the file, which may differ from the header's claim. */
  readonly recordCount: number;
  readonly trailingBytes: number;
  readonly diagnostics: Diagnostic[];

  #handle: FileHandle;
  #closed = false;
  /** The last answer `changedSinceOpen` computed, so it survives the file being closed. */
  #changed: boolean | null = null;

  private constructor(init: {
    path: string;
    fileSize: number;
    modifiedAtOpenMs: number;
    header: EdfHeader;
    recordCount: number;
    trailingBytes: number;
    diagnostics: Diagnostic[];
    handle: FileHandle;
  }) {
    this.path = init.path;
    this.fileSize = init.fileSize;
    this.modifiedAtOpenMs = init.modifiedAtOpenMs;
    this.header = init.header;
    this.recordCount = init.recordCount;
    this.trailingBytes = init.trailingBytes;
    this.diagnostics = init.diagnostics;
    this.#handle = init.handle;
  }

  /**
   * SHA-256 of the bytes this conversion actually read.
   *
   * Hashed through the open descriptor, over exactly the `fileSize` bytes that were there
   * when the file was opened — the same number every record count and window in the output
   * was derived from. Re-opening the path to hash it afterwards described whatever was at
   * that name by then: a recording still being written grew from 2,000 records to 3,000
   * mid-conversion and metadata.json recorded `data_records: 2000` beside the checksum and
   * byte count of the 3,000-record file, which is provenance for bytes nobody converted.
   * Replacing the file at that path did the same thing more completely.
   */
  async sha256(): Promise<string> {
    this.#assertOpen();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(this.fileSize, 4 * 1024 * 1024) || 1);
    for (let at = 0; at < this.fileSize; ) {
      const want = Math.min(buffer.length, this.fileSize - at);
      const { bytesRead } = await this.#handle.read(buffer, 0, want, at);
      if (bytesRead <= 0) {
        throw new EdfError(
          'UNREADABLE',
          `Expected ${this.fileSize} bytes to checksum but the file ended at ${at}; ` +
            `it appears to have changed size while it was being read.`,
          'Make sure the recording is not still being written to, then try again.',
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      at += bytesRead;
    }
    return hash.digest('hex');
  }

  /**
   * Whether the file has changed since it was opened, by size or by modification time.
   *
   * Checked through the descriptor, so it answers for the bytes that were read rather than
   * for whatever now answers to the same name. A recording still being written is the
   * ordinary cause, and the conversion is still correct for the data it saw — it is the
   * claim that the output describes the file as it now stands that stops being true.
   */
  async changedSinceOpen(): Promise<boolean> {
    /*
      A closed file remembers its last answer rather than inventing a new one.

      Returning false once closed asserted "it did not change", which is not something a
      closed descriptor can know — and `convert()` closes the file before it returns, so
      `result.file.changedSinceOpen()` denied the very change the INPUT_CHANGED diagnostic
      in the same result object had just reported. One object, two answers.

      `convert()` always asks before closing, so the cached answer is the true one. A caller
      who closed the file without ever asking gets an error, which is the same treatment
      every other method on a closed file gets.
    */
    if (this.#closed) {
      if (this.#changed !== null) return this.#changed;
      throw new EdfError(
        'UNREADABLE',
        `"${this.path}" is closed, and whether it changed while it was open was never checked.`,
        'Ask before closing the file. A ConvertResult carries the answer already, since ' +
          'convert() checks it on the way out.',
      );
    }
    const now = await this.#handle.stat().catch(() => null);
    if (now === null) return this.#changed ?? false;
    this.#changed = now.size !== this.fileSize || now.mtimeMs !== this.modifiedAtOpenMs;
    return this.#changed;
  }

  static async open(path: string): Promise<EdfFile> {
    const info = await stat(path).catch((cause: unknown) => {
      throw new EdfError('UNREADABLE', `Cannot read "${path}": ${describe(cause)}`);
    });
    if (info.isDirectory()) {
      throw new EdfError('UNREADABLE', `"${path}" is a directory, not an EDF file.`);
    }
    if (!info.isFile()) {
      throw new EdfError('UNREADABLE', `"${path}" is not a regular file.`);
    }

    /*
      Opening is a second chance to be refused, and it was the one that got through.

      `stat` needs the parent directory searchable and says nothing about the file's own mode,
      so a recording with no read permission passes it and fails here — the commonest
      permission failure there is. Unwrapped, it escaped as Node's own error: the CLI printed
      `error: EACCES: permission denied, open '...'` where every neighbouring failure prints
      the tool's sentence, and the library threw a plain Error whose `code` was the errno.

      api.md says `UNREADABLE` "covers a missing file, a directory passed where a file was
      expected, a permission failure, and a file that changed size while being read. Branch on
      `code`, never on the message text." A consumer doing exactly that fell through to its
      generic handler.
    */
    const handle = await open(path, 'r').catch((cause: unknown) => {
      throw new EdfError('UNREADABLE', `Cannot read "${path}": ${describe(cause)}`);
    });
    try {
      const fixed = Buffer.alloc(Math.min(FIXED_HEADER_BYTES, info.size));
      if (fixed.length > 0) {
        const bytesRead = await readFully(handle, fixed, 0, fixed.length, 0);
        if (bytesRead < fixed.length) throw changedWhileReading(0, fixed.length, bytesRead);
      }

      // The signal count decides how much more header there is to read. Read by the header
      // parser itself, so the two cannot disagree about which files are readable: this used
      // to have its own Number(), which tolerated the NUL padding sloppy writers emit but
      // not the comma decimal separator that COMMA_DECIMAL exists to accept.
      let headerBuffer = fixed;
      if (fixed.length === FIXED_HEADER_BYTES) {
        const ns = peekSignalCount(fixed);
        if (ns !== null) {
          const total = FIXED_HEADER_BYTES + ns * SIGNAL_HEADER_BYTES;
          if (total <= info.size) {
            headerBuffer = Buffer.alloc(total);
            const bytesRead = await readFully(handle, headerBuffer, 0, total, 0);
            if (bytesRead < total) throw changedWhileReading(0, total, bytesRead);
          }
        }
      }

      const { header, recordCount, trailingBytes, diagnostics } = parseHeader(
        headerBuffer,
        info.size,
      );

      return new EdfFile({
        path,
        fileSize: info.size,
        modifiedAtOpenMs: info.mtimeMs,
        header,
        recordCount,
        trailingBytes,
        diagnostics,
        handle,
      });
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  /** Signal channels, excluding the EDF+ annotations channel. */
  get dataSignals(): EdfSignal[] {
    return this.header.signals.filter((s) => !s.isAnnotations);
  }

  /**
   * The annotation channel a record's start time is read from.
   *
   * EDF+ puts the timekeeping TAL first in the first annotation channel, and this was read as
   * `annotationSignals[0]` — the first one declared, whether or not it can hold anything. A
   * writer that declares an annotation channel and gives it zero samples per record leaves a
   * slot of zero bytes, so nothing was read from it, and the timekeeping in the channel after
   * it went unread: a three-record EDF+D reported "3 of 3 data records carry no readable
   * timekeeping annotation" about three that were perfectly readable, and timed the file from
   * zero.
   *
   * A channel with no room carries nothing, so it is not the one the TAL is in.
   */
  get timekeepingSignal(): EdfSignal | undefined {
    return this.annotationSignals.find((signal) => signal.samplesPerRecord > 0);
  }

  get annotationSignals(): EdfSignal[] {
    return this.header.signals.filter((s) => s.isAnnotations);
  }

  /** Total recording duration in seconds, based on records actually present. */
  get durationSeconds(): number {
    return this.recordCount * this.header.recordDuration;
  }

  /** Read a half-open range of records in batches. */
  async *readRecords(options: ReadRecordsOptions = {}): AsyncGenerator<RecordBatch> {
    this.#assertOpen();

    /*
      Record bounds have to be whole records.

      A fractional `startRecord` was carried straight into `position = headerBytes +
      record * recordBytes`, so reading from 1.5 began half a record in and every sample
      after it was decoded from the wrong offset: on the two-channel test fixture it
      returned channel 2's values under channel 1's signal, with no error. Clamping
      silently would be no better, since a caller asking for record 1.5 has a bug the
      library should name rather than paper over.
    */
    for (const [name, value] of [
      ['startRecord', options.startRecord],
      ['endRecord', options.endRecord],
    ] as const) {
      if (value !== undefined && !Number.isInteger(value)) {
        throw new EdfError(
          'BAD_HEADER_FIELD',
          `readRecords: ${name} must be a whole record index, got ${value}.`,
          'Record boundaries are the unit the file can be read in; a fractional index would decode samples from the middle of a record.',
        );
      }
    }

    const start = Math.max(0, options.startRecord ?? 0);
    const end = Math.min(this.recordCount, options.endRecord ?? this.recordCount);
    if (start >= end) return;

    const { recordBytes } = this.header;
    /*
      Checked rather than handed to Buffer.alloc.

      `chunkBytes: NaN` came back as `RangeError: The value of "size" is out of range` from
      inside Node, with no mention of the option that caused it — while a fractional
      `startRecord` two lines up gets a typed EdfError naming the field. Every other option
      here is checked; this one reached the allocator.
    */
    const budget = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    if (!Number.isFinite(budget) || budget < 1) {
      throw new EdfError(
        'UNREADABLE',
        `chunkBytes must be a positive number of bytes, got ${String(options.chunkBytes)}.`,
        'It is a ceiling on how much of the file is held at once; one record is read whatever it says.',
      );
    }
    /*
      The budget is a ceiling, not an amount to reserve.

      `Math.floor(budget / recordBytes)` is how many records would fit in it, and the buffer
      was that many — whether or not the file had that many. A 848-byte fixture read with a
      512 MB budget allocated 536,870,880 bytes for its two records, and every ordinary read
      of a small file reserved the full 8 MB default. Nothing was wrong with the data; the
      memory just had nothing to do with it.

      Bounded by what is actually going to be read, so a batch of five hundred short
      recordings costs five hundred short buffers rather than five hundred 8 MB ones.
    */
    const perChunk = Math.max(1, Math.min(Math.floor(budget / recordBytes), end - start));
    const buffer = Buffer.alloc(perChunk * recordBytes);

    for (let record = start; record < end; record += perChunk) {
      const count = Math.min(perChunk, end - record);
      const bytes = count * recordBytes;
      const position = this.header.headerBytes + record * recordBytes;

      const bytesRead = await readFully(this.#handle, buffer, 0, bytes, position);
      if (bytesRead < bytes) {
        // The file is shorter than its own size said. Quietly stopping here would
        // hand back a conversion missing its tail with nothing to show for it.
        //
        // Through the shared builder rather than a second copy of its sentence: the two were
        // character-for-character identical, which is how a wording fixed in one of them
        // would have been fixed in only one of them.
        throw changedWhileReading(record, bytes, bytesRead);
      }

      yield { firstRecordIndex: record, recordCount: count, data: buffer.subarray(0, bytes) };
    }
  }

  /** Read one sample as its raw digital value. */
  sampleAt(batch: RecordBatch, recordOffset: number, signal: EdfSignal, sampleIndex: number): number {
    const position =
      recordOffset * this.header.recordBytes +
      signal.byteOffsetInRecord +
      sampleIndex * this.header.bytesPerSample;

    if (this.header.bytesPerSample === 3) {
      // BDF stores 24-bit little-endian two's complement. Loading the three bytes
      // into the top of a 32-bit word and shifting back down sign-extends them.
      const data = batch.data;
      return (
        ((data[position] as number) << 8) |
        ((data[position + 1] as number) << 16) |
        ((data[position + 2] as number) << 24)
      ) >> 8;
    }
    return readInt16LE(batch.data, position);
  }

  /** Byte offset of a signal's samples within a batch. */
  offsetOf(batch: RecordBatch, recordOffset: number, signal: EdfSignal): number {
    return recordOffset * this.header.recordBytes + signal.byteOffsetInRecord;
  }

  /** The annotation channel's raw bytes for one record in a batch. */
  annotationBytes(batch: RecordBatch, recordOffset: number, signal: EdfSignal): Uint8Array {
    const start = this.offsetOf(batch, recordOffset, signal);
    return batch.data.subarray(start, start + signal.samplesPerRecord * this.header.bytesPerSample);
  }

  /**
   * Read every EDF+ annotation in the file, plus the start time each record declares.
   *
   * Only the annotation channel is read, seeking straight to it inside each record
   * rather than pulling whole records through memory. On a multi-gigabyte recording
   * that is the difference between a few kilobytes of I/O and all of it.
   *
   * The whole file is always scanned, never just the records inside a requested
   * window: writers are not obliged to store an annotation in the record its onset
   * falls in, and some put every annotation in the first record. Reading only the
   * window's records would drop those entirely.
   */
  /**
   * Where this continuous recording begins, from the first record that says.
   *
   * A few records' worth of annotation bytes rather than the whole channel. A continuous
   * recording's origin is the fraction of a second by which its first record follows the
   * header's start time, and `--info` needs that to place a requested window — but it does
   * not need the events, and finding one number by reading every record costs a seek per
   * record across the whole file, which is the scan `--info` was deliberately spared.
   *
   * It reads on past record 0 because a conversion does. This used to stop there, so the
   * moment one timekeeping TAL was unreadable the two disagreed: the conversion took the
   * origin from record 1 and timed the file from 0.5s, while `--info` found nothing at
   * record 0 and reported a recording starting at zero — the same file described two ways by
   * one tool. Records are contiguous, so record `i` beginning at `t` puts the origin at
   * `t - i * duration`, and any one of them settles it.
   *
   * The bound is what keeps this cheap: a file whose first `RECORDS_SEARCHED_FOR_ORIGIN`
   * timekeeping entries are all unreadable reports an origin of zero here, and converting it
   * raises ANNOTATION_DECODE_FAILED for every one of them.
   *
   * Returns null when there is nothing to read it from, in which case the origin is zero.
   */
  async readOrigin(): Promise<number | null> {
    return (await this.scanOrigin()).origin;
  }

  /**
   * The origin, and what the search saw on the way to it.
   *
   * `--info` takes this route for a continuous recording rather than reading every record,
   * and reported nothing when the timekeeping it read was unreadable: the count was hard-coded
   * to zero at the call site, so a file whose first TAL cannot be parsed raised
   * ANNOTATION_DECODE_FAILED when converted and nothing under `--info`. Its byte-identical
   * EDF+D twin — same bytes but for the reserved field, which has nothing to do with the
   * defect — raised it both ways, because that path reads every record and counts as it goes.
   *
   * The failure was being read and then thrown away. `readOrigin` keeps its shape for callers
   * who only want the number.
   */
  async scanOrigin(): Promise<{ origin: number | null; malformedTimekeeping: number }> {
    this.#assertOpen();

    let malformedTimekeeping = 0;
    const channel = this.timekeepingSignal;
    if (!channel || this.recordCount === 0) return { origin: null, malformedTimekeeping };

    const { headerBytes, bytesPerSample, recordBytes, recordDuration } = this.header;
    const buffer = Buffer.alloc(channel.samplesPerRecord * bytesPerSample);
    if (buffer.length === 0) return { origin: null, malformedTimekeeping };

    const searched = Math.min(this.recordCount, RECORDS_SEARCHED_FOR_ORIGIN);
    for (let record = 0; record < searched; record++) {
      const offset = headerBytes + record * recordBytes + channel.byteOffsetInRecord;
      const bytesRead = await readFully(this.#handle, buffer, 0, buffer.length, offset);
      if (bytesRead < buffer.length) return { origin: null, malformedTimekeeping };

      const decoded = decodeRecordAnnotations(buffer, record);
      malformedTimekeeping += decoded.malformedTimekeeping;
      if (decoded.recordStart !== null) {
        return { origin: decoded.recordStart - record * recordDuration, malformedTimekeeping };
      }
    }
    return { origin: null, malformedTimekeeping };
  }

  async readAnnotations(): Promise<{
    annotations: Annotation[];
    recordStarts: (number | null)[];
    malformed: number;
    /** Unreadable TALs in first position, which carry timing rather than an event. */
    malformedTimekeeping: number;
    /** How many of those also carried event text, so events were lost with the position. */
    malformedTimekeepingWithText: number;
    /** Events kept whose stated duration could not be read; see Annotation.duration. */
    unreadableDurations: number;
    /** Events kept whose stated duration read as a number below zero. */
    negativeDurations: number;
  }> {
    this.#assertOpen();

    const annotations: Annotation[] = [];
    const recordStarts: (number | null)[] = new Array<number | null>(this.recordCount).fill(null);
    let malformed = 0;
    let malformedTimekeeping = 0;
    let malformedTimekeepingWithText = 0;
    let unreadableDurations = 0;
    let negativeDurations = 0;

    const channels = this.annotationSignals;
    if (channels.length === 0) {
      return {
        annotations,
        recordStarts,
        malformed,
        malformedTimekeeping,
        malformedTimekeepingWithText,
        unreadableDurations,
        negativeDurations,
      };
    }

    const { headerBytes, recordBytes, bytesPerSample } = this.header;
    const buffers = channels.map((c) => Buffer.alloc(c.samplesPerRecord * bytesPerSample));
    const timekeeping = this.timekeepingSignal;

    for (let record = 0; record < this.recordCount; record++) {
      for (const [position, channel] of channels.entries()) {
        const buffer = buffers[position];
        if (!buffer || buffer.length === 0) continue;

        const offset = headerBytes + record * recordBytes + channel.byteOffsetInRecord;
        const bytesRead = await readFully(this.#handle, buffer, 0, buffer.length, offset);
        if (bytesRead < buffer.length) {
          throw changedWhileReading(record, buffer.length, bytesRead, 'annotation data');
        }

        // Only the timekeeping channel carries the record's start; see timekeepingSignal.
        const decoded = decodeRecordAnnotations(buffer, record, channel === timekeeping);
        if (channel === timekeeping) recordStarts[record] = decoded.recordStart;
        for (const annotation of decoded.annotations) annotations.push(annotation);
        malformed += decoded.malformed;
        malformedTimekeeping += decoded.malformedTimekeeping;
        malformedTimekeepingWithText += decoded.malformedTimekeepingWithText;
        unreadableDurations += decoded.unreadableDurations;
        negativeDurations += decoded.negativeDurations;
      }
    }

    annotations.sort((a, b) => a.onset - b.onset || a.recordIndex - b.recordIndex);
    return {
      annotations,
      recordStarts,
      malformed,
      malformedTimekeeping,
      malformedTimekeepingWithText,
      unreadableDurations,
      negativeDurations,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new EdfError('UNREADABLE', 'This EDF file has already been closed.');
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'no such file';
    // EPERM beside EACCES, because everywhere else in this codebase that reads an errno pairs
    // the two, and ENOTDIR because a path that runs through a regular file — `rec.edf/inner`,
    // which a shell completes and a script builds by joining — is otherwise the one input
    // failure that answers in errno text while its output-side twin answers in a sentence.
    if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
    if (code === 'ENOTDIR') return 'part of the path is a file, not a directory';
    return cause.message;
  }
  return String(cause);
}

/**
 * The most `fs.read` will accept as a length.
 *
 * Node asserts on a length that does not fit in a signed 32-bit integer, and it asserts in
 * C++: `Assertion failed: args[3]->IsInt32()`, forty frames of native stack, SIGABRT. Not an
 * exception — nothing in JavaScript sees it, so no catch block and no `uncaughtException`
 * handler runs, and a library consumer's whole process goes down with it.
 *
 * A round gigabyte rather than the exact limit, so the loop below does whole even reads.
 */
const MAX_READ_BYTES = 1024 * 1024 * 1024;

/** Fill a requested region unless EOF is reached; regular-file reads may legally be short. */
async function readFully(
  handle: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  let total = 0;
  while (total < length) {
    /*
      Capped, because one data record can be larger than a single read may be.

      A record is read in one call when it exceeds the chunk budget — there is nothing
      smaller to divide it by, since a record is the unit the format is addressed in. EDF's
      samples-per-record field is 8 characters, so eleven channels at 99,999,999 samples make
      a record of 2.2 GB, and a long record duration at ordinary rates gets there too. That
      went to `fs.read` as a single length over 2^31-1 and took the process out with a native
      assertion rather than an error.

      Looping was already how a short read is handled, so the cap costs one more iteration
      per gigabyte and nothing else.
    */
    const want = Math.min(length - total, MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, offset + total, want, position + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

function changedWhileReading(
  record: number,
  expected: number,
  actual: number,
  subject = 'data',
): EdfError {
  return new EdfError(
    'UNREADABLE',
    `Expected ${expected} bytes of ${subject} at record ${record} but only ` +
      `${counted(actual, 'byte')} ${actual === 1 ? 'was' : 'were'} available; the file appears ` +
      `to have changed size while it was being read.`,
    'Make sure the recording is not still being written to, then try again.',
  );
}
