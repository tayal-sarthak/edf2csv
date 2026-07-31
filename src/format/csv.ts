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

/** Flush once this many characters have accumulated. */
const DEFAULT_FLUSH_THRESHOLD = 1 << 20; // 1 MiB

const NEEDS_QUOTING = /[",\r\n]/u;

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
  #ended = false;

  constructor(stream: Writable, threshold: number = DEFAULT_FLUSH_THRESHOLD) {
    this.#stream = stream;
    this.#threshold = threshold;
  }

  /** Characters written to the stream so far, before any encoding expansion. */
  get charsWritten(): number {
    return this.#bytesWritten;
  }

  push(text: string): void {
    this.#parts.push(text);
    this.#pending += text.length;
  }

  pushLine(text: string): void {
    this.push(text);
    this.push('\n');
  }

  /** Flush if enough has accumulated. Await this at row boundaries. */
  async maybeFlush(): Promise<void> {
    if (this.#pending >= this.#threshold) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.#parts.length === 0) return;
    const chunk = this.#parts.join('');
    this.#parts = [];
    this.#pending = 0;
    this.#bytesWritten += chunk.length;

    if (!this.#stream.write(chunk)) {
      // The consumer is behind; wait rather than letting Node buffer without bound.
      await once(this.#stream, 'drain');
    }
  }

  /** Flush anything left and close the stream. */
  async end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    await this.flush();
    // stdout must not be closed; ending it would break piping for the rest of the process.
    if (this.#stream === process.stdout || this.#stream === process.stderr) return;
    await new Promise<void>((resolve, reject) => {
      this.#stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }
}
