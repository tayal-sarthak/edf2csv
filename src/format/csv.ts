/**
 * CSV escaping and a buffered, backpressure-aware line writer.
 *
 * Rows are accumulated in memory and flushed in large blocks. Writing row by row
 * would issue millions of small stream writes, and ignoring the return value of
 * `write()` would let Node buffer the entire output in RAM — which for an hour of
 * 23-channel EEG is several hundred megabytes.
 */

import type { Writable } from 'node:stream';
import { once } from 'node:events';

/**
 * Flush once this many characters have accumulated.
 *
 * Exported because it is a budget for the whole conversion rather than a per-writer
 * constant: a mixed-rate recording opens one writer per rate, and each taking a megabyte
 * meant memory followed the number of tables. See writeSignalFiles.
 */
export const DEFAULT_FLUSH_THRESHOLD = 1 << 20; // 1 MiB

const NEEDS_QUOTING = /[",\r\n]/u;

/**
 * U+FEFF, written as EF BB BF, which is what `--bom` prepends to each CSV.
 *
 * Excel on Windows reads a CSV with no byte order mark in the system code page rather than
 * UTF-8, so `µV` — two bytes of UTF-8 for one character — shows up as `Âµ`. The mark tells
 * it the file is UTF-8.
 *
 * Opt-in because it is not free. pandas strips it either engine (checked against 3.0.5),
 * but Python's own `csv.reader` over a plain `open()` does not, and neither does
 * `fs.readFileSync(path, 'utf8')`: the first column name comes back as `\ufefftime_s`, and
 * a lookup of `time_s` misses. Readers that want it gone ask for `utf-8-sig`.
 */
export const UTF8_BOM = '\ufeff';

/** Quote a field only when CSV requires it, doubling any embedded quotes. */
export function escapeCsvField(value: string): string {
  if (value === '') return '';
  if (!NEEDS_QUOTING.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

export function csvRow(cells: readonly string[]): string {
  return cells.map(escapeCsvField).join(',');
}

/**
 * Accumulates text and flushes it to a stream, respecting backpressure.
 *
 * Call `push()` freely, then `await maybeFlush()` at a row boundary. Memory stays
 * bounded by the flush threshold plus whatever the stream has not yet drained.
 */
export class BufferedLineWriter {
  #stream: Writable;
  #parts: string[] = [];
  #pending = 0;
  #threshold: number;
  #bytesWritten = 0;
  /** Real bytes handed to the stream, as opposed to characters. See `bytesOut`. */
  #bytesOut = 0;
  #ended = false;
  /** The reader closed the pipe; there is nowhere left to write, but this is not a failure. */
  #hungUp = false;
  #failure: Error | null = null;

  /** Kept so the listener can come off again; see the constructor. */
  #onError: ((error: NodeJS.ErrnoException) => void) | null = null;

  constructor(stream: Writable, threshold: number = DEFAULT_FLUSH_THRESHOLD) {
    this.#stream = stream;
    this.#threshold = threshold;
    /*
      A stream with no 'error' listener throws asynchronously and takes the whole process
      down with a raw stack trace. Capturing the error here lets the next flush surface it as
      a normal failure with a usable message.

      Removed again when the writer is finished with, because one of these streams outlives
      the writer: `process.stdout`. A library caller converting twelve recordings with
      `toStdout` left twelve listeners on it and got Node's MaxListenersExceededWarning on
      the eleventh — a leak warning that was, for once, describing a real leak.
    */
    this.#onError = (error: NodeJS.ErrnoException) => {
      /*
        EPIPE is the reader hanging up, not a write failure.

        `edf2csv recording.edf --stdout | head -1` closes the pipe while the conversion is
        still writing, and treating that as an error produced exit 1 and a message about
        files that do not exist and disk space that is not the problem. A file stream
        cannot raise EPIPE, so this only ever means "the consumer stopped reading", which
        is what a shell pipeline does routinely and on purpose.
      */
      if (error.code === 'EPIPE') {
        this.#hungUp = true;
        return;
      }
      this.#failure ??= error;
    };
    this.#stream.on('error', this.#onError);
  }

  /** Take the 'error' listener off a stream that outlives this writer. */
  #release(): void {
    if (!this.#onError) return;
    this.#stream.off('error', this.#onError);
    this.#onError = null;
  }

  /** True once the reader closed the pipe. Nothing more can reach the consumer. */
  get hungUp(): boolean {
    return this.#hungUp;
  }

  /** Characters written to the stream so far, before any encoding expansion. */
  get charsWritten(): number {
    return this.#bytesWritten;
  }

  /**
   * Bytes handed to the stream, counting a multi-byte character once per byte.
   *
   * `charsWritten` drives the progress meter, where the difference does not matter. This is
   * for checking that what was handed over actually arrived, which is a byte question: a
   * channel labelled in Cyrillic makes the two differ by hundreds of bytes on the header
   * line alone.
   */
  get bytesOut(): number {
    return this.#bytesOut;
  }

  push(text: string): void {
    this.#parts.push(text);
    this.#pending += text.length;
  }

  pushLine(text: string): void {
    this.push(text);
    this.push('\n');
  }

  /**
   * Whether enough has accumulated to be worth writing out.
   *
   * A synchronous question, so a row loop can ask it every row without paying for a
   * microtask on the twenty million that answer no.
   */
  get full(): boolean {
    return this.#pending >= this.#threshold;
  }

  /** Flush if enough has accumulated. Await this at row boundaries. */
  async maybeFlush(): Promise<void> {
    if (this.full) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.#failure) throw this.#failure;
    /*
      The reader hung up (see the EPIPE note above); there is nowhere left to write.

      The buffer is DISCARDED rather than left in place. Returning without clearing it let
      push() keep appending for the rest of the conversion with nothing ever draining it,
      so `--stdout | head -1` on a 165 MB conversion grew to a 1.3 GB working set and died
      with a heap out-of-memory under a 256 MB limit — worse than the error this replaced.
      Bounded memory is the invariant this class exists to hold, and a hung-up reader is no
      reason to abandon it.

      Deliberately not `#ended`, which end() sets before its own final flush.
    */
    if (this.#hungUp) {
      this.#parts = [];
      this.#pending = 0;
      return;
    }
    if (this.#parts.length === 0) return;

    const chunk = this.#parts.join('');
    this.#parts = [];
    this.#pending = 0;
    this.#bytesWritten += chunk.length;
    this.#bytesOut += Buffer.byteLength(chunk);

    if (!this.#stream.write(chunk)) {
      // The consumer is behind; wait rather than letting Node buffer without bound.
      // Waiting only on 'drain' would hang forever if the stream fails instead.
      await this.#drain();
    }
  }

  /** Resolve on 'drain', reject if the stream fails first. */
  async #drain(): Promise<void> {
    if (this.#failure) throw this.#failure;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.#stream.off('drain', onDrain);
        this.#stream.off('error', onError);
        this.#stream.off('close', onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: NodeJS.ErrnoException): void => {
        cleanup();
        // A pipe closing while we wait for drain is the same benign hang-up as one
        // closing during a write, and has to be handled here too: this listener is
        // registered for the duration of the wait and sees the error first.
        if (error.code === 'EPIPE') {
          this.#hungUp = true;
          resolve();
          return;
        }
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(this.#failure ?? new Error('The output stream closed before the data was written.'));
      };
      this.#stream.once('drain', onDrain);
      this.#stream.once('error', onError);
      this.#stream.once('close', onClose);
    });
  }

  /** Flush anything left and close the stream. */
  async end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    await this.flush();
    /*
      The reader is gone, so there is nothing to close and possibly nothing left to close it
      on. Under --gzip this stream is the compressor, and the EPIPE forwarded from stdout
      destroyed it — end() on a destroyed stream fails with ERR_STREAM_DESTROYED, which is
      not EPIPE, so it escaped the hang-up guard and came back as a write failure:

          edf2csv big.edf --stdout --gzip | head
          error: Writing to stdout failed: Cannot call end after a stream was destroyed

      Exactly the three symptoms 0.2.30 removed from the uncompressed path — exit 1 for a
      routine shell idiom, a claim about files that were never written, and advice about disk
      space — reappearing on the one path 0.3.1 said would behave identically.
    */
    if (this.#hungUp) {
      this.#release();
      return;
    }
    // stdout must not be closed; ending it would break piping for the rest of the process.
    // The failure still has to be reported: returning here without looking meant an error
    // recorded on the stream, but not yet surfaced by a later flush, was simply dropped.
    if (this.#stream === process.stdout || this.#stream === process.stderr) {
      const failure = this.#failure;
      this.#release();
      if (failure) throw failure;
      return;
    }
    /*
      Released after the stream has finished ending, not before.

      Releasing first meant an EACCES arriving during that final end had no listener left and
      went out as an unhandled 'error' event — a raw stack trace, which is the one thing this
      listener exists to prevent. The leak it was added to fix is about streams this writer
      does not own; the window it must stay attached for runs to the last byte either way.
    */
    try {
      await new Promise<void>((resolve, reject) => {
        this.#stream.end((error?: Error | null) => {
          const failure = error ?? this.#failure;
          if (failure) reject(failure);
          else resolve();
        });
      });
    } finally {
      this.#release();
    }
  }

  /** Close the stream without caring whether the data made it out. */
  destroy(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#parts = [];
    this.#pending = 0;
    this.#release();
    this.#stream.destroy();
  }
}
