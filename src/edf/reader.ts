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
import { counted, grouped } from '../format/list.js';
// Crossing into convert/ as header.ts already does for `typeable`: the check belongs to the
// call rather than to the file, and there is one of it.
import { OptionError, assertInputPath, describeValue } from '../convert/options.js';
// A path comes out of the filesystem and nobody vets it; see printable's own comment.
import { printable } from '../format/unprintable.js';

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
          // Both figures grouped, like the shortfall message this file raises one function
          // over — `Expected 8,386,560 bytes of data at record 0 but only 2,899,456 bytes
          // were available` — and for the reason 0.8.5 gives: the sentence exists to put one
          // against the other, and at nine digits that is work the separators do.
          `Expected ${grouped(this.fileSize)} bytes to checksum but the file ended at ` +
            `${grouped(at)}; it appears to have changed size while it was being read.`,
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

  /*
    A sentence, and advice under it, like the destination-side twin.

    `Cannot read "rec.edf": no such file` was the one diagnostic this tool prints that does not
    end in a full stop — 68 of its 69 do — and the only member of its family with nothing
    indented under it. `Cannot create "out": part of the path does not exist.` has carried
    advice under it since the destination errors were given sentences — one line for every
    cause until 0.8.12, and the cause's own since — the mid-conversion UNREADABLE beside it
    carries one too, and this is the form a mistyped path actually reaches.
  */
  static readonly #UNREADABLE_HINT =
    'Check the path is spelled the way it is on disk and that you have permission to read it.';

  static async open(path: string): Promise<EdfFile> {
    /*
      A path, checked before `fs` is asked about it.

      `assertInputPath` was written for exactly this and applied one level up. Its docstring
      names the function it was describing — "`EdfFile.open` hands whatever it is given to
      `fs`, and the refusal comes back as an `EdfError` coded `UNREADABLE`, hinted 'Check the
      path is spelled the way it is on disk and that you have permission to read it' — advice
      about a path, over a value that is not one, filed as a problem with the recording rather
      than with the call" — and then went into `convert`, leaving `EdfFile.open` itself, which
      is exported from the package root and is how the api page says to read a header without
      converting anything, doing the thing being described:

          EdfFile.open({ path: 'a.edf' })
          EdfError[UNREADABLE]: Cannot read "[object Object]": The "path" argument must be of
          type string or an instance of Buffer or URL. Received an instance of Object.

      Node's own argument-type text, under a hint about spelling and permissions, over a
      value that has neither. `EdfFile.open(['a.edf', 'b.edf'])` was worse: it answered
      `Cannot read "a.edf,b.edf"`, quoting a path the caller never wrote, because `String` of
      an array joins it with commas.

      The same `OptionError` `convert` raises for the same mistake, so one mistake has one
      answer whichever entry point it arrives at.
    */
    assertInputPath(path);
    const info = await stat(path).catch((cause: unknown) => {
      throw new EdfError(
        'UNREADABLE',
        `Cannot read "${printable(path)}": ${describe(cause)}.`,
        EdfFile.#UNREADABLE_HINT,
      );
    });
    /*
      Both of these said what was wrong and nothing about what to do, which is the gap
      `#UNREADABLE_HINT` two lines up was added to close for the third member of this family.

      Neither is reached from the command line, and that is the point: a folder there is
      expanded to the recordings inside it and a socket is filtered out by the walk, so the
      caller who arrives here is holding a path in code and has no walk behind them.
    */
    if (info.isDirectory()) {
      throw new EdfError(
        'UNREADABLE',
        `"${printable(path)}" is a directory, not an EDF file.`,
        'Name a recording inside it. The command line expands a folder to the recordings it ' +
          'holds; this takes one file.',
      );
    }
    if (!info.isFile()) {
      throw new EdfError(
        'UNREADABLE',
        `"${printable(path)}" is not a regular file.`,
        'A pipe, socket or device cannot be read as a recording: the parser seeks to a byte ' +
          'offset inside the file, which only a real file supports.',
      );
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
      throw new EdfError(
        'UNREADABLE',
        `Cannot read "${printable(path)}": ${describe(cause)}.`,
        EdfFile.#UNREADABLE_HINT,
      );
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
      The bag the three options arrive in, which nothing looked at.

      The default `= {}` covers `undefined` and nothing else, and every read below is
      `options.startRecord` — so a value that is not an object had its properties read off it
      and came back `undefined`, which is how a caller says they are not passing one:

          file.readRecords(42)      // every record, as though no options were given
          file.readRecords('x')     //     "
          file.readRecords(null)    // TypeError: Cannot read properties of null

      `null` is what `JSON.parse` of a config gives for a field left unset, which is the door
      `assertOptions` names for the flags; the other two are a caller who thought this took a
      record index. The first two are the worse pair, because reading the whole file is a
      plausible answer and they got it in silence. `resolveRange` was given this same check on
      its own bag in 0.8.75, for the same reason: reading `.start` off a number is `undefined`
      rather than a throw.
    */
    if (typeof options !== 'object' || options === null) {
      throw new OptionError(
        `readRecords: options must be an object, got ${describeValue(options)}. It carries ` +
          'startRecord, endRecord and chunkBytes; omit it to read every record.',
      );
    }

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
        /*
          An `OptionError`, because it is the call that is wrong and not the recording.

          This raised an `EdfError` coded `BAD_HEADER_FIELD` — a code the reference defines
          as "a field that should contain a number doesn't", about the file's header — for a
          number the *caller* passed. A script branching on that code to report a corrupt
          recording blamed the recording for its own bug, and `chunkBytes` below did the same
          under `UNREADABLE`, which means the file could not be read.

          The same class `EdfFile.open` raises for a path that is not one and `parseHeader`
          for a byte count that is not one, both settled in this same series, and for the
          reason `assertInputPath` gives.
        */
        throw new OptionError(
          /*
            Through `describeValue`, like every other refusal that quotes a rejected value.

            Its rule is "numbers bare, everything else quoted so its type is visible", and
            these two were the sites that never used it — so a refusal *for not being a
            number* showed the value as one: `readRecords({ startRecord: '1' })` came back
            `startRecord must be a whole record index, got 1.`, where 1 is a whole record
            index and the caller is left looking for what else could be wrong. An array came
            back `got .`, a hole where the value should be, and an object came back
            `got [object Object]` — the string `assertInputPath`'s own docstring names as the
            reason it exists.
          */
          `readRecords: ${name} must be a whole record index, got ${describeValue(value)}. ` +
            'Record boundaries are the unit the file can be read in; a fractional index ' +
            'would decode samples from the middle of a record.',
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
      // `OptionError` for the same reason as the record bounds above; see there.
      throw new OptionError(
        `chunkBytes must be a positive number of bytes, got ${describeValue(options.chunkBytes)}. ` +
          'It is a ceiling on how much of the file is held at once; one record is read ' +
          'whatever it says.',
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

  /**
   * The channel, confirmed to be one of this recording's.
   *
   * The three methods that take an `EdfSignal` turn its `byteOffsetInRecord` and
   * `samplesPerRecord` into a position in a batch of this file's bytes. Nothing said the
   * channel had to come from this file, and a channel from another one reads as though it
   * did: handing `sampleAt` a `.bdf` channel — three bytes a sample, its own offset — while
   * reading a `.edf` batch returned the first EDF channel's samples, `0 74 147 219 290`,
   * every one of them a real number from the recording and none of them the caller's.
   *
   * Two open files is how it arrives. It is also what a plain object gets: `{}` and `42`
   * both have an undefined offset, which the arithmetic below turns into `NaN` and then
   * into a sample of 0.
   *
   * By identity at its own index, not by scanning the list: `sampleAt` is called once per
   * sample, and the caller already holds these objects — `header.signals[i]`, or the subsets
   * `annotationSignals` and `selectChannels` filter out of it, which are the same references.
   */
  #assertSignalHere(signal: EdfSignal, method: string): void {
    if (this.header.signals[(signal as { index?: number } | null)?.index as number] === signal) {
      return;
    }
    /*
      A channel-shaped argument is placed rather than dumped.

      `describeValue` renders an object as its JSON, and a channel is fourteen fields — a
      458-character refusal, most of it the caller's own data handed back. Its index is the
      part that locates the mistake, and it is the field this check just read. Anything that
      is not object-shaped is quoted the ordinary way, since there it is the value itself
      that is wrong.
    */
    const elsewhere =
      `A channel read out of a different file names a position in that file's records, ` +
      `not this one's.`;
    throw new OptionError(
      signal !== null && typeof signal === 'object'
        ? `${method}: signal is a channel object, but not one of this recording's — ` +
          `header.signals at index ${describeValue((signal as { index?: unknown }).index)} ` +
          `is a different channel. ${elsewhere}`
        : `${method}: signal must be one of this recording's own channels, from ` +
          `header.signals — got ${describeValue(signal)}. ${elsewhere}`,
    );
  }

  /**
   * The record, confirmed to be one this batch holds.
   *
   * 0.8.62 put this on `sampleAt`, where it turns a position into a sample. `offsetOf` does
   * the same arithmetic and hands the position back, and `annotationBytes` slices at it, and
   * neither asked anything of it:
   *
   *     file.offsetOf(batch, -5, signal)    // -1300
   *     file.offsetOf(batch, 1.5, signal)   // 390, half a record in
   *     file.annotationBytes(batch, 99, s)  // Uint8Array(0)
   *
   * A negative byte position, a position that decodes the second half of one record against
   * the first half of the next — the failure `readRecords` refuses a fractional `startRecord`
   * for — and an empty slice that reads as "this record carries no annotations" for a record
   * that is not in the batch at all.
   *
   * The batch is checked first, because the bound is read off it: `offsetOf` never touched
   * `batch` before this, so a caller who passed the wrong thing got no complaint from it. Its
   * bytes are checked with it, for the reason given where that check sits.
   */
  #assertRecordOffset(batch: RecordBatch, recordOffset: number, method: string): void {
    if (!Number.isInteger((batch as RecordBatch | null)?.recordCount)) {
      throw new OptionError(
        `${method}: batch must be one of the batches readRecords yields, got ` +
          `${describeValue(batch)}.`,
      );
    }
    /*
      And the bytes, which are what the position is a position into.

      The count above was the whole of what this asked, and all three methods go on to read
      `batch.data`: `sampleAt` indexes it, `annotationBytes` slices it, and `offsetOf` hands
      back a position for it. A batch-shaped object without any failed differently depending
      on which one was called, and two of those failures were answers:

          file.sampleAt({ recordCount: 2, data: [1, 2, 3, 4] }, 0, signal, 0)   // 513
          file.sampleAt({ recordCount: 2, data: new Float64Array(64) }, ...)    // 0
          file.annotationBytes({ recordCount: 2, data: new Float64Array(8) }, …) // 20 values

      513 is a digital code this recording could have held; 0 is the commonest sample in any
      recording; and the third is a run of numbers that are not the bytes of anything,
      returned as the annotation channel's own. `ArrayBuffer.isView` is true of all of them
      and of a `DataView`, which is why the check is the one 0.8.84 and 0.8.85 settled on for
      the two other places this parser is handed bytes: a view whose elements are one byte.
    */
    const bytes = (batch as { data?: unknown }).data;
    if (!ArrayBuffer.isView(bytes) || (bytes as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT !== 1) {
      const carries = 'A batch carries firstRecordIndex, recordCount, and the record bytes themselves.';
      // Named rather than quoted back: a batch is megabytes, and the kind of thing it is is
      // the part that locates the mistake — the same reasoning `#assertSignalHere` gives for
      // placing a channel by its index instead of printing its fourteen fields. The article
      // is worked out because `Array` and `Int16Array` both arrive here and "a Array" is not
      // a sentence.
      const kind =
        typeof bytes === 'object' && bytes !== null
          ? ((bytes as object).constructor?.name ?? 'object')
          : null;
      throw new OptionError(
        kind !== null
          ? `${method}: batch.data is ${/^[AEIOU]/u.test(kind) ? 'an' : 'a'} ${kind}, which is ` +
            `not a view of bytes. ${carries}`
          : `${method}: batch.data must be the record bytes, got ${describeValue(bytes)}. ${carries}`,
      );
    }
    if (!Number.isInteger(recordOffset) || recordOffset < 0 || recordOffset >= batch.recordCount) {
      throw new OptionError(
        `${method}: recordOffset must be a record's position within this batch, 0 to ` +
          `${batch.recordCount - 1}, got ${describeValue(recordOffset)}. Absolute record ` +
          `indexes are batch.firstRecordIndex higher.`,
      );
    }
  }

  /** Read one sample as its raw digital value. */
  sampleAt(batch: RecordBatch, recordOffset: number, signal: EdfSignal, sampleIndex: number): number {
    this.#assertSignalHere(signal, 'sampleAt');
    /*
      In range, because out of it this invented a number.

      The arithmetic below turns four values into a byte position and reads there. Nothing
      stopped that position from landing outside the sample it names. Past the end of the
      buffer, `bytes[position]` is `undefined`, which `| 0` and `<< 8` both turn into 0 — so a
      read past the batch came back as a plausible sample of zero. Inside the buffer but past
      the channel's own samples, it came back as the *next channel's* data: a 256-sample
      channel asked for sample 261 returned 243, which is a real number from the recording
      and belongs to another column.

      Both are reachable from the mistake the api page warns about in the sentence that
      describes this method — "`recordOffset` is the record's position within the batch, from
      0 to `batch.recordCount - 1`, not its index in the file". A caller who passes the
      absolute index reads past the batch and gets zeros for every sample of it.

      Two integer comparisons each, on a call that then formats a number.
    */
    this.#assertRecordOffset(batch, recordOffset, 'sampleAt');
    if (
      !Number.isInteger(sampleIndex) ||
      sampleIndex < 0 ||
      sampleIndex >= signal.samplesPerRecord
    ) {
      throw new OptionError(
        `sampleIndex must be 0 to ${signal.samplesPerRecord - 1} for this channel, got ` +
          `${describeValue(sampleIndex)}.`,
      );
    }
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
    this.#assertSignalHere(signal, 'offsetOf');
    this.#assertRecordOffset(batch, recordOffset, 'offsetOf');
    return recordOffset * this.header.recordBytes + signal.byteOffsetInRecord;
  }

  /** The annotation channel's raw bytes for one record in a batch. */
  annotationBytes(batch: RecordBatch, recordOffset: number, signal: EdfSignal): Uint8Array {
    // Before delegating, so the refusal names the method the caller called rather than the
    // one underneath it.
    this.#assertSignalHere(signal, 'annotationBytes');
    this.#assertRecordOffset(batch, recordOffset, 'annotationBytes');
    const start = this.offsetOf(batch, recordOffset, signal);
    return batch.data.subarray(start, start + signal.samplesPerRecord * this.header.bytesPerSample);
  }

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
   * That mitigation covers records that could not be read, and not records that said nothing:
   * an empty annotation slot is not a TAL that failed, so nothing is counted and nothing is
   * raised. Twenty records whose only timekeeping entry is in record 16 therefore convert with
   * `time_s` from the origin it states and are reported here as beginning at zero, in silence
   * on both sides — and `--start` and `--end` are read against that same clock. The bound
   * stays, since it is what makes `--info` a header read on a file of any size; what was
   * wrong was the account of what it costs, which every page giving it said was a warning.
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
   *
   * All three counters, not one. A first-position TAL may carry events after the start time,
   * and when it cannot be parsed those go with it — which is what `malformedTimekeepingWithText`
   * counts and what decides whether the warning says "No event was lost" or names the events
   * that were. Counting only the first meant `--info` took the first sentence every time: it
   * announced that a record had lost its position and that nothing else had gone, over a file
   * whose conversion said, correctly, that an event had gone with it. One file, two answers,
   * and the confident one was `--info`, which is the command run first to find out what a
   * conversion will say.
   *
   * `malformed` comes back for the same reason one sentence further on: that hint ends "and is
   * counted above", which is only true where the entry warning is printed too.
   *
   * All three are of the records this actually read, which is as far as the first record that
   * states a time — so they are lower bounds on the file, as `malformedTimekeeping` has been
   * since it was returned at all. A conversion reads every record and may count more. What
   * they must not be is inconsistent with each other, which is what a hard-coded zero made
   * them.
   */
  async scanOrigin(): Promise<{
    origin: number | null;
    malformed: number;
    malformedTimekeeping: number;
    malformedTimekeepingWithText: number;
    /**
     * What each record it read said its own start time was, or null where it said nothing.
     *
     * One entry per record searched, so shorter than the file — a lower bound like the three
     * counters above, and for the same reason. `--info` compares these against where
     * continuity puts them, which is how an `EDF+C` file that contradicts itself is reported
     * without reading every record of it.
     */
    recordStarts: (number | null)[];
  }> {
    this.#assertOpen();

    const counts = { malformed: 0, malformedTimekeeping: 0, malformedTimekeepingWithText: 0 };
    const recordStarts: (number | null)[] = [];
    const channel = this.timekeepingSignal;
    if (!channel || this.recordCount === 0) return { origin: null, ...counts, recordStarts };

    const { headerBytes, bytesPerSample, recordBytes, recordDuration } = this.header;
    /*
      Every annotation channel with room in it, not only the one the timekeeping is in.

      EDF+ permits more than one, and only the first carries a record's start time — which is
      the whole of what this function was written for, so it read that one and stopped. The
      entries it did not read are still entries, and an unreadable one there is an event lost
      out of annotations.csv exactly as it is in the first channel:

          edf2csv two-channels.edf --info     nothing
          edf2csv two-channels.edf --out out  "3 annotation entries were unreadable and
                                               could not be exported."

      `two-annotation-channels.edf` in this repository is that file. Its three unreadable
      entries are all in the second channel, so `--info --strict` passed it and converting it
      exits 1 — the screening pass this tool documents for a folder, saying nothing about the
      recording that will fail.

      The bound is per record, not per channel: the same sixteen records, one slot each. A
      file with two annotation channels reads two slots of a few hundred bytes for each of
      them, which is the same order as the one slot it read before.
    */
    const channels = this.annotationSignals.filter((signal) => signal.samplesPerRecord > 0);
    const buffers = channels.map((signal) => Buffer.alloc(signal.samplesPerRecord * bytesPerSample));
    const buffer = buffers[channels.indexOf(channel)] as Buffer;
    if (buffer.length === 0) return { origin: null, ...counts, recordStarts };

    /*
      The budget is read, rather than abandoned at the first record that answers.

      This returned the moment one record stated a time, which is all the origin needs — and
      everything the remaining fifteen records of its own bound would have said went unread.
      What they say is whether the file keeps the promise its reserved field makes: an `EDF+C`
      recording whose records contradict continuity is reported by a conversion and was
      reported by nothing here, so

          edf2csv liar.edf --info --strict     exit 0, no warning
          edf2csv liar.edf --out out --strict  exit 1, "This file is marked continuous
                                               (EDF+C), but 1 of its 3 data records says it
                                               starts somewhere other than where continuity
                                               puts it."

      and cli-reference.md recommends the first for screening a folder before converting it.
      That is the sentence `noAnnotations` gives for the same defect one diagnostic over.

      The bound does not move: it was always "at most the first sixteen records", which is
      what every page says this mode costs. Only the early exit goes, so the cost is now what
      was documented rather than under it.
    */
    const searched = Math.min(this.recordCount, RECORDS_SEARCHED_FOR_ORIGIN);
    let origin: number | null = null;
    for (let record = 0; record < searched; record++) {
      for (const [position, reading] of channels.entries()) {
        const slot = buffers[position] as Buffer;
        if (slot.length === 0) continue;
        const offset = headerBytes + record * recordBytes + reading.byteOffsetInRecord;
        const bytesRead = await readFully(this.#handle, slot, 0, slot.length, offset);
        if (bytesRead < slot.length) return { origin, ...counts, recordStarts };

        // Only the timekeeping channel carries the record's start; see timekeepingSignal.
        const decoded = decodeRecordAnnotations(slot, record, reading === channel);
        counts.malformed += decoded.malformed;
        counts.malformedTimekeeping += decoded.malformedTimekeeping;
        counts.malformedTimekeepingWithText += decoded.malformedTimekeepingWithText;
        if (reading !== channel) continue;
        recordStarts.push(decoded.recordStart);
        if (origin === null && decoded.recordStart !== null) {
          origin = decoded.recordStart - record * recordDuration;
        }
      }
    }
    return { origin, ...counts, recordStarts };
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
    if (this.#closed) {
      throw new EdfError(
        'UNREADABLE',
        'This EDF file has already been closed.',
        // The same advice `changedSinceOpen` gives for the same mistake, which is the only
        // other method that has anything to say about a closed file.
        'Open it again, or keep it open until the last read.',
      );
    }
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
    `Expected ${grouped(expected)} bytes of ${subject} at record ${record} but only ` +
      `${counted(actual, 'byte')} ${actual === 1 ? 'was' : 'were'} available; the file appears ` +
      `to have changed size while it was being read.`,
    'Make sure the recording is not still being written to, then try again.',
  );
}
