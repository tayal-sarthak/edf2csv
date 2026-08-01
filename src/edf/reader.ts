/**
 * Chunked reader for EDF / EDF+ files.
 *
 * Data records are read in batches sized by a byte budget rather than all at once,
 * so peak memory stays flat regardless of how long the recording is. A 4 GB file
 * and a 4 MB file use the same working set.
 */

import { open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import { EdfError } from './errors.js';
import type { Diagnostic } from './errors.js';
import { FIXED_HEADER_BYTES, SIGNAL_HEADER_BYTES, parseHeader } from './header.js';
import type { EdfHeader, EdfSignal } from './header.js';
import { decodeRecordAnnotations } from './annotations.js';
import type { Annotation } from './annotations.js';

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
  data: Buffer;
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
  readonly header: EdfHeader;
  /** Records actually present in the file, which may differ from the header's claim. */
  readonly recordCount: number;
  readonly trailingBytes: number;
  readonly diagnostics: Diagnostic[];

  #handle: FileHandle;
  #closed = false;

  private constructor(init: {
    path: string;
    fileSize: number;
    header: EdfHeader;
    recordCount: number;
    trailingBytes: number;
    diagnostics: Diagnostic[];
    handle: FileHandle;
  }) {
    this.path = init.path;
    this.fileSize = init.fileSize;
    this.header = init.header;
    this.recordCount = init.recordCount;
    this.trailingBytes = init.trailingBytes;
    this.diagnostics = init.diagnostics;
    this.#handle = init.handle;
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

    const handle = await open(path, 'r');
    try {
      const fixed = Buffer.alloc(Math.min(FIXED_HEADER_BYTES, info.size));
      if (fixed.length > 0) await handle.read(fixed, 0, fixed.length, 0);

      // The signal count decides how much more header there is to read.
      let headerBuffer = fixed;
      if (fixed.length === FIXED_HEADER_BYTES) {
        const ns = Number(fixed.subarray(252, 256).toString('latin1').trim());
        if (Number.isInteger(ns) && ns > 0) {
          const total = FIXED_HEADER_BYTES + ns * SIGNAL_HEADER_BYTES;
          if (total <= info.size) {
            headerBuffer = Buffer.alloc(total);
            await handle.read(headerBuffer, 0, total, 0);
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

    const start = Math.max(0, options.startRecord ?? 0);
    const end = Math.min(this.recordCount, options.endRecord ?? this.recordCount);
    if (start >= end) return;

    const { recordBytes } = this.header;
    const budget = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const perChunk = Math.max(1, Math.floor(budget / recordBytes));
    const buffer = Buffer.alloc(perChunk * recordBytes);

    for (let record = start; record < end; record += perChunk) {
      const count = Math.min(perChunk, end - record);
      const bytes = count * recordBytes;
      const position = this.header.headerBytes + record * recordBytes;

      const { bytesRead } = await this.#handle.read(buffer, 0, bytes, position);
      if (bytesRead < bytes) {
        // The file shrank underneath us, or the size check was wrong.
        const whole = Math.floor(bytesRead / recordBytes);
        if (whole === 0) return;
        yield { firstRecordIndex: record, recordCount: whole, data: buffer.subarray(0, whole * recordBytes) };
        return;
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
    return batch.data.readInt16LE(position);
  }

  /** Byte offset of a signal's samples within a batch. */
  offsetOf(batch: RecordBatch, recordOffset: number, signal: EdfSignal): number {
    return recordOffset * this.header.recordBytes + signal.byteOffsetInRecord;
  }

  /** The annotation channel's raw bytes for one record in a batch. */
  annotationBytes(batch: RecordBatch, recordOffset: number, signal: EdfSignal): Buffer {
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
  async readAnnotations(): Promise<{
    annotations: Annotation[];
    recordStarts: (number | null)[];
    malformed: number;
  }> {
    this.#assertOpen();

    const annotations: Annotation[] = [];
    const recordStarts: (number | null)[] = new Array<number | null>(this.recordCount).fill(null);
    let malformed = 0;

    const channels = this.annotationSignals;
    if (channels.length === 0) return { annotations, recordStarts, malformed };

    const { headerBytes, recordBytes, bytesPerSample } = this.header;
    const buffers = channels.map((c) => Buffer.alloc(c.samplesPerRecord * bytesPerSample));

    for (let record = 0; record < this.recordCount; record++) {
      for (const [position, channel] of channels.entries()) {
        const buffer = buffers[position];
        if (!buffer || buffer.length === 0) continue;

        const offset = headerBytes + record * recordBytes + channel.byteOffsetInRecord;
        const { bytesRead } = await this.#handle.read(buffer, 0, buffer.length, offset);
        if (bytesRead < buffer.length) return { annotations, recordStarts, malformed };

        const decoded = decodeRecordAnnotations(buffer, record);
        // Only the first annotation channel carries the record's timekeeping TAL.
        if (position === 0) recordStarts[record] = decoded.recordStart;
        for (const annotation of decoded.annotations) annotations.push(annotation);
        malformed += decoded.malformed;
      }
    }

    annotations.sort((a, b) => a.onset - b.onset || a.recordIndex - b.recordIndex);
    return { annotations, recordStarts, malformed };
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
    if (code === 'EACCES') return 'permission denied';
    return cause.message;
  }
  return String(cause);
}
