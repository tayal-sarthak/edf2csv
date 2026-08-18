/**
 * Executing a conversion.
 *
 * Everything is written in a single pass over the data records. All rate groups are
 * open at once and fed from the same batch of bytes, so a file is read once no
 * matter how many output tables it produces, and memory stays flat.
 */

import { createWriteStream, fstatSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { createGzip, gzipSync } from 'node:zlib';
import path from 'node:path';

import type { RecordBatch } from '../edf/reader.js';
import { EdfFile } from '../edf/reader.js';
import { describeFormat, formatRates, formatWallClock } from '../edf/header.js';
import type { Diagnostic } from '../edf/errors.js';
import { EdfError } from '../edf/errors.js';
import type { Annotation } from '../edf/annotations.js';
import {
  BufferedLineWriter,
  DEFAULT_FLUSH_THRESHOLD,
  UTF8_BOM,
  csvRow,
  escapeCsvField,
} from '../format/csv.js';
import { listed } from '../format/list.js';
import {
  makeSampleFormatter,
  makeTimeFormatter,
  newOffsetBudget,
  newSampleCacheBudget,
} from '../format/number.js';
import type { SampleFormatter } from '../format/number.js';
import { TIME_COLUMN } from './channels.js';
import { buildPlan, withoutFileRateWarning } from './plan.js';
import type { ConversionPlan, PlanOptions, RateGroup } from './plan.js';
import { deriveRecordStarts, withTimingPromiseKept } from './timing.js';
import { sampleTimeIsInRange, toleranceFor } from './time-range.js';
import { VERSION as TOOL_VERSION } from '../version.js';

export { TOOL_VERSION };

export type ConversionErrorCode =
  | 'OUTPUT_EXISTS'
  | 'OUTPUT_UNWRITABLE'
  | 'INPUT_OUTPUT_COLLISION'
  | 'INPUT_UNREADABLE'
  | 'UNSUPPORTED_REQUEST'
  | 'CALLBACK_FAILED'
  | 'WRITE_FAILED';

/**
 * Codes that mean the command cannot be carried out as written, rather than that something
 * about the file or the destination went wrong.
 *
 * The distinction is the one the exit codes draw: 1 is "the file or the destination is the
 * problem", 2 is "the command line is the problem". A caller with a `--stdout` conflict is
 * being told to change the flags — the hints say exactly that — so filing it under 1 sent
 * scripts looking at the disk. Exit 2 already covers checks that need the header first,
 * such as a `--channels` term matching nothing.
 */
export const USAGE_ERROR_CODES: ReadonlySet<ConversionErrorCode> = new Set(['UNSUPPORTED_REQUEST']);

export class ConversionError extends Error {
  readonly code: ConversionErrorCode;
  readonly hint: string | undefined;
  constructor(code: ConversionErrorCode, message: string, hint?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConversionError';
    this.code = code;
    this.hint = hint;
  }
}

export interface ConvertOptions extends PlanOptions {
  /** Destination directory. Defaults to the input file's name without its extension. */
  outputDir?: string | undefined;
  /** Overwrite an existing output directory. */
  force?: boolean | undefined;
  /** Record a SHA-256 of the input in metadata.json. Costs one extra read of the file. */
  checksum?: boolean | undefined;
  /**
   * Write the signal CSV to stdout instead of to a directory.
   *
   * Only valid when the conversion produces exactly one signal file. In the default wide
   * layout a mixed-rate recording becomes several tables, and merging them into one stream
   * would mean inventing the samples this tool exists not to invent; `layout: 'long'` gives
   * one table for any recording, so it lifts the restriction. No sidecar files are written.
   */
  toStdout?: boolean | undefined;
  onProgress?: ((progress: ConversionProgress) => void) | undefined;
}

export interface ConversionProgress {
  recordsDone: number;
  recordsTotal: number;
  bytesWritten: number;
}

export interface WrittenFile {
  name: string;
  rows: number;
}

export interface ConvertResult {
  outputDir: string;
  files: WrittenFile[];
  /**
   * True when a `--stdout` reader closed the pipe before the conversion finished.
   *
   * `edf2csv rec.edf --stdout | head -1` is an ordinary thing to type and not a failure, but
   * it is also not a conversion: the row count is rows formatted before the close was
   * noticed, which is neither the recording's total nor what the reader received.
   */
  readerHungUp: boolean;
  annotationCount: number;
  diagnostics: Diagnostic[];
  plan: ConversionPlan;
  file: EdfFile;
  elapsedMs: number;
}

interface OpenGroup {
  group: RateGroup;
  writer: BufferedLineWriter;
  formatters: SampleFormatter[];
  formatTime: (recordStart: number, sample: number) => string;
  rows: number;
  /** Resolves once a compressed stream's bytes have reached the file behind it. */
  settled: Promise<void>;
  /** Detaches the compressor's error forwarding from a stream this tool does not own. */
  release: () => void;
}

export async function convert(inputPath: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  const startedAt = Date.now();
  const file = await EdfFile.open(inputPath);

  try {
    /*
      Hashed before a record is read, and only published if the file held still.

      A checksum taken afterwards cannot be trusted whichever descriptor it goes through. A
      file overwritten in place keeps its inode, so the open handle sees the new bytes too,
      and the old ones are simply gone — there is nowhere left to read what was converted.
      Taking it first at least means the hash describes the file the header was read from.

      What makes it a guarantee rather than a hope is the check at the end: if size or
      modification time moved at any point, the hash is dropped and the run says why. So
      `sha256` present means the file demonstrably did not change while it was read, and a
      recording still being written gets a null and a warning instead of a plausible hash of
      the wrong bytes. (A change reverted within the same modification timestamp would slip
      through; nothing short of copying the input first can close that.)
    */
    const checksumAtOpen = options.checksum === true ? await file.sha256() : null;

    // One pass over the annotation channel supplies everything annotation-related:
    // where each record sits in time, and the full event list. It reads the whole
    // file even when a window was requested, because an annotation inside the window
    // may be stored in a record outside it.
    const annotationData =
      file.annotationSignals.length > 0
        ? await file.readAnnotations()
        : { annotations: [] as Annotation[], recordStarts: [] as (number | null)[], malformed: 0 };

    const timing = deriveRecordStarts(file, annotationData);

    const plan = buildPlan(
      {
        signals: file.header.signals,
        recordDuration: file.header.recordDuration,
        recordCount: file.recordCount,
        hasAnnotationChannel: file.annotationSignals.length > 0,
        recordStarts: timing.starts,
      },
      options,
    );
    plan.diagnostics.push(...timing.diagnostics);

    if (options.toStdout === true) {
      const refusal = stdoutRefusal(file, plan);
      if (refusal) throw refusal;
      let readerHungUp = false;
      const written = await writeSignalFiles(file, plan, null, timing.starts, options, (hungUp) => {
        readerHungUp = hungUp;
      });
      if (await file.changedSinceOpen()) plan.diagnostics.push(inputChanged(false));
      return {
        outputDir: '-',
        files: written,
        readerHungUp,
        annotationCount: 0,
        diagnostics: [...withTimingPromiseKept(withoutFileRateWarning(file.diagnostics), timing.starts !== null), ...plan.diagnostics],
        plan,
        file,
        elapsedMs: Date.now() - startedAt,
      };
    }

    /*
      A destination whose last component is `.` or `..` does not name a directory of its own.

      `prepareOutputDir` claims the final component with a single non-recursive mkdir, having
      created its parents recursively — which is what makes two conversions racing for one
      directory safe. `path.dirname("out/.")` is `"out"`, so for these the parent step creates
      the destination itself and the claim then asks the filesystem to make `.` inside it,
      which always exists. The result was a refusal naming a directory this same run had just
      made, one line after making it:

          edf2csv rec.edf --out ./fresh/.
          error: "./fresh/." already exists.
                 Pass --force to overwrite it, or --out to choose a different directory.

      Exit 1, nothing converted, and an empty `fresh/` left on disk. `--force` does not help:
      the claim fails the same way whatever it is told, so the path was unusable rather than
      occupied.

      Normalised only in that case, so `--out ./converted` keeps the spelling it was given —
      that one is already how the directory is found on disk, which is what `output_dir`
      promises, and rewriting it to `converted` would churn every example for no gain.
    */
    const asked = options.outputDir ?? defaultOutputDir(inputPath);
    const outputDir = /(?:^|[\\/])\.\.?$/u.test(asked) ? path.normalize(asked) : asked;
    await assertInputDoesNotOverlapOutputs(inputPath, outputDir, file, plan, options);
    await prepareOutputDir(outputDir, options.force === true);

    const written: WrittenFile[] = [];

    if (plan.writeSignals && plan.groups.length > 0) {
      const signals = await writeSignalFiles(file, plan, outputDir, timing.starts, options);
      written.push(...signals);
    } else if (plan.writeSignals) {
      /*
        Asked for signal data and given none to write.

        Every channel selected carries zero samples per record, so there is no table to make
        — `edf2csv rec.edf --channels unused` writes channels.csv and metadata.json and no
        signals.csv at all. The NO_SAMPLES warning explains the channel; nothing explained the
        missing file, and the documentation says signals.csv is written unless
        --annotations-only was passed. Someone looking for it should be told where it went.

        There are two ways to arrive with no groups, and the wording above is only true of
        one of them. A recording that holds nothing but EDF+ annotations has no channel that
        could have been selected, its channels.csv is a header row and nothing else, and no
        channel of it carries samples — so "every channel selected", "channels.csv still
        describes them" and "which channels do carry samples" were three false statements in
        one warning, printed under a warning that had just said the file has no signal
        channels. `--stdout` distinguishes the two cases a few lines up and `--info` prints
        one accurate line; this path was the only one that did not.
      */
      const noChannelsAtAll = file.dataSignals.length === 0;
      plan.diagnostics.push({
        code: 'NO_SAMPLES',
        severity: 'warning',
        message: noChannelsAtAll
          ? 'No signal file was written: there is no signal data in this recording to put in ' +
            'one.'
          : 'No signal file was written: every channel selected carries zero samples per data ' +
            'record, so there is nothing to put in one.',
        hint: noChannelsAtAll
          ? 'annotations.csv holds whatever events it carries. channels.csv lists signal ' +
            'channels, so it has none to list.'
          : 'channels.csv still describes them. Run with --info to see which channels do carry ' +
            'samples.',
      });
    }

    if (options.annotationsOnly === true && file.annotationSignals.length === 0) {
      plan.diagnostics.push({
        code: 'NO_ANNOTATIONS',
        severity: 'warning',
        message:
          '--annotations-only was requested but this recording has no annotation channel, ' +
          'so there are no events to export.',
        hint: 'Plain EDF files carry no annotations. Convert without --annotations-only to get the signals.',
      });
    }

    let annotationsWritten = 0;
    if (file.annotationSignals.length > 0) {
      const window = requestedAnnotationWindow(options, plan.range.recordingStartSeconds);
      // Reported against the rows that will be written, not against the file; see
      // durationDiagnostics.
      plan.diagnostics.push(...durationDiagnostics(annotationData.annotations, window));
      const result = await writeAnnotationsCsv(
        outputDir,
        annotationData.annotations,
        window,
        options.gzip === true,
        options.bom === true,
      );
      written.push(result);
      annotationsWritten = result.rows;
    }

    written.push(
      await writeChannelsCsv(outputDir, file, plan, options.gzip === true, options.bom === true),
    );

    /*
      The file moved under the conversion. Said out loud, because nothing else shows it.

      The CSVs are still correct for the records that were read, and metadata.json still
      describes the file as it was opened — so the record is consistent with the output
      whatever happens here. What stops being true is that the checksum describes the bytes
      that were converted, since an in-place overwrite leaves nowhere to read them from. It
      is dropped rather than guessed at.
    */
    const changed = await file.changedSinceOpen();
    if (changed) plan.diagnostics.push(inputChanged(options.checksum === true));

    await writeMetadata(
      outputDir,
      inputPath,
      file,
      plan,
      written,
      annotationsWritten,
      changed ? null : checksumAtOpen,
      timing.starts !== null,
    );

    const stale = await findStaleOutput(outputDir, written);

    return {
      outputDir,
      files: written,
      readerHungUp: false,
      annotationCount: annotationsWritten,
      diagnostics: [...withTimingPromiseKept(withoutFileRateWarning(file.diagnostics), timing.starts !== null), ...plan.diagnostics, ...stale],
      plan,
      file,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await file.close();
  }
}

/*
  Files this tool produces, used to spot leftovers from an earlier conversion.

  The rate part has to allow every shape a filename can now take, not just the plain ones:

    signals_256hz.csv         an integer rate
    signals_12_5hz.csv        a fractional rate, decimal point written as an underscore
    signals_1_000e-7hz.csv    a rate small enough to need exponent form  (0.2.2)
    signals_256hz.csv.gz      any of the above, compressed                (0.3.0)
    signals_0hz_2.csv         a second group whose rate slug collided    (0.2.1)

  The previous `[\w.]+hz` matched neither of the last two — `-` and `+` are not word
  characters, and the collision suffix falls after the `hz`. Both were introduced by
  recent changes and both silently stopped being recognised as this tool's own output, so
  leftovers of exactly those kinds went unreported: the one situation the warning exists
  for. Requiring a digit after the underscore keeps a user's own `signals_notes.csv` out.
*/
const OUTPUT_PATTERN =
  /^(signals(_\d[\w.+-]*hz(_\d+)?)?\.csv(\.gz)?|annotations\.csv(\.gz)?|channels\.csv(\.gz)?|metadata\.json)$/u;

/**
 * Detect output from a previous run that this one did not replace.
 *
 * `--force` overwrites files but does not empty the directory, so converting a
 * mixed-rate recording and then a single-rate one into the same place leaves
 * `signals_256hz.csv` sitting next to a fresh `signals.csv`. Both look current.
 * Nothing is deleted here — the user is told, and decides.
 */
async function findStaleOutput(
  outputDir: string,
  written: readonly WrittenFile[],
): Promise<Diagnostic[]> {
  const entries = await readdir(outputDir).catch(() => null);
  if (!entries) return [];

  // metadata.json is rewritten on every run but is not part of the reported file list.
  const fresh = new Set([...written.map((f) => f.name), 'metadata.json']);
  const stale = entries.filter((name) => OUTPUT_PATTERN.test(name) && !fresh.has(name)).sort();
  if (stale.length === 0) return [];

  return [
    {
      code: 'STALE_OUTPUT',
      severity: 'warning',
      /*
        Through `listed`, like every other message that enumerates something this run does not
        control. How many stale files a directory holds is up to the directory, and a
        mixed-rate recording converted into a reused one is exactly how it fills up: 120 old
        `signals_<rate>hz.csv` files produced a single 2,373-character warning line. That is
        the failure `listed` was written for — its own comment quotes the 1,600-character
        version of it — and this was the one message still joining its own list.

        The hint said "Delete them" whatever the count, so one stale file read "signals_999hz
        .csv is left over ... Delete them."
      */
      message:
        `${listed(stale)} ${stale.length === 1 ? 'is' : 'are'} left over from an earlier ` +
        `conversion into this directory and ${stale.length === 1 ? 'was' : 'were'} not rewritten.`,
      hint:
        `Delete ${stale.length === 1 ? 'it' : 'them'}, or convert into a fresh directory, so ` +
        'the two runs do not get mixed up.',
    },
  ];
}

export function defaultOutputDir(inputPath: string): string {
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(path.dirname(inputPath), `${base}_csv`);
}

/** Never let an output target resolve to the recording being read, even with --force. */
async function assertInputDoesNotOverlapOutputs(
  inputPath: string,
  outputDir: string,
  file: EdfFile,
  plan: ConversionPlan,
  options: ConvertOptions,
): Promise<void> {
  /*
    The names this run will actually write, compressed ones included.

    The rate files come from the plan and already carry `.csv.gz` under --gzip; the sidecars
    were spelled out here and did not. So a compressed run checked two names it would never
    write and missed the two it would: a recording sitting at <outdir>/channels.csv.gz was
    overwritten by its own conversion, with --force, reported as a success. The same file
    named signals.csv.gz was refused, which is what gives the oversight away.
  */
  const suffix = options.gzip === true ? '.csv.gz' : '.csv';
  const names = new Set(plan.groups.map((group) => group.fileName));
  if (file.annotationSignals.length > 0) names.add(`annotations${suffix}`);
  names.add(`channels${suffix}`);
  names.add('metadata.json');

  const inputResolved = path.resolve(inputPath);
  const inputInfo = await stat(inputPath);

  for (const name of names) {
    const target = path.join(outputDir, name);
    const targetResolved = path.resolve(target);
    const targetInfo = await stat(target).catch(() => null);
    const samePath = targetResolved === inputResolved;
    const sameFile =
      targetInfo !== null && targetInfo.dev === inputInfo.dev && targetInfo.ino === inputInfo.ino;
    if (!samePath && !sameFile) continue;

    throw new ConversionError(
      'INPUT_OUTPUT_COLLISION',
      `Output file "${target}" is the same file as the input recording.`,
      'Choose a separate directory with --out. The input was not modified.',
    );
  }
}

async function prepareOutputDir(dir: string, force: boolean): Promise<void> {
  /*
    Claim the directory with a single atomic mkdir rather than asking whether it exists
    and then creating it.

    Checking first left a window between the two: two conversions started together both
    saw "not there", both proceeded, and both opened write streams on the same signals.csv.
    Neither reported anything — both exited 0, having half-written one file between them.
    A non-recursive mkdir cannot do that. Exactly one caller creates the directory; every
    other one gets EEXIST from the filesystem and takes the already-exists path below.

    Parents are still created recursively, since --out ./a/b/c should work. Only the final
    component is the claim.
  */
  const parent = path.dirname(dir);
  if (parent && parent !== dir) {
    try {
      await mkdir(parent, { recursive: true });
    } catch (cause: unknown) {
      // A parent that is a regular file surfaces as EEXIST naming the parent, which reads
      // as though the destination already exists rather than as "you cannot put a
      // directory inside a file". Name the real obstacle instead of the errno.
      const info = await stat(parent).catch(() => null);
      if (info && !info.isDirectory()) {
        throw new ConversionError(
          'OUTPUT_UNWRITABLE',
          `Cannot create "${dir}": "${parent}" is a file, not a directory.`,
          'Choose a destination whose parent directories are directories, with --out.',
        );
      }
      throw new ConversionError(
        'OUTPUT_UNWRITABLE',
        `Cannot create "${dir}": ${describeFsError(cause)}.`,
        'Check the path exists and that you have permission to write there.',
      );
    }
  }

  let claimed = true;
  try {
    await mkdir(dir);
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new ConversionError(
        'OUTPUT_UNWRITABLE',
        `Cannot create "${dir}": ${describeFsError(cause)}.`,
        'Check the path exists and that you have permission to write there.',
      );
    }
    claimed = false;
  }

  if (!claimed) {
    const existing = await stat(dir).catch(() => null);

    // --force means "replace my previous output", not "write output files into
    // whatever this happens to be". Pointing it at a regular file needs saying so.
    if (existing && !existing.isDirectory()) {
      throw new ConversionError(
        'OUTPUT_UNWRITABLE',
        `"${dir}" is a file, but the converted data needs a directory.`,
        'Choose a directory with --out.',
      );
    }
    if (!force) {
      throw new ConversionError(
        'OUTPUT_EXISTS',
        `"${dir}" already exists.`,
        'Pass --force to overwrite it, or --out to choose a different directory.',
      );
    }
  }
}

/** Turn a Node filesystem error into something a person can act on. */
function describeFsError(cause: unknown): string {
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return 'permission denied';
  if (code === 'ENOSPC') return 'the disk is full';
  // The one that actually happens on a shared filesystem, and the one this list left out.
  if (code === 'EDQUOT') return 'you are over your disk quota on this filesystem';
  if (code === 'ENOTDIR') return 'part of the path is a file, not a directory';
  if (code === 'EROFS') return 'the filesystem is read-only';
  if (code === 'ENAMETOOLONG') return 'the path is too long';
  return cause instanceof Error ? cause.message : String(cause);
}

async function writeSignalFiles(
  file: EdfFile,
  plan: ConversionPlan,
  outputDir: string | null,
  recordStarts: Float64Array | null,
  options: ConvertOptions,
  onHangUp?: (hungUp: boolean) => void,
): Promise<WrittenFile[]> {
  // One budget for every table in this conversion, not one per table: see OffsetBudget.
  const offsets = newOffsetBudget();
  // Likewise one for every channel, not one per channel: see SampleCacheBudget.
  const sampleCaches = newSampleCacheBudget();
  // Only the stdout path needs this; --out finds a full disk on its own, because it always
  // has another file to write afterwards. See auditStdout.
  const audit = outputDir === null ? auditStdout() : null;
  /*
    In the long layout every group writes into one table, so they share one stream. Opening
    a stream per group on the same path is what the rate-slug collision fix in groupByRate
    was about: two writers on one file interleave rows under a header naming one of them.
  */
  let shared: {
    stream: Writable;
    settled: Promise<void>;
    release: () => void;
    target: Writable;
    writer: BufferedLineWriter;
  } | null = null;

  /*
    One buffer's worth of memory for the conversion, not one per table.

    Every group had its own writer at the default 1 MiB threshold, so pending output was
    group count × 1 MiB before anything drained. A 6.5 MB recording with 40 sampling rates
    — the header allows thousands of channels, and a research montage really does mix a
    dozen rates — died with a raw V8 heap out-of-memory and exit 134 under a 96 MB cap,
    while the site advertises 48 MB. The recording is small; it is the fan-out that is not.

    Split evenly with a floor, so the single-rate case, which is nearly every recording,
    keeps exactly the buffer it always had, and forty tables cost 2.5 MB rather than 40.
    The long layout shares one writer already and is unaffected either way.
  */
  const MIN_FLUSH_THRESHOLD = 8 * 1024;
  const flushThreshold = Math.max(
    MIN_FLUSH_THRESHOLD,
    Math.floor(DEFAULT_FLUSH_THRESHOLD / Math.max(1, plan.groups.length)),
  );
  /*
    The stream's own buffer is the other half of the same sum.

    0.5.6 shared the line-buffer budget and left `createWriteStream` at its 64 KiB default,
    which is per stream: 200 rate groups meant 12.8 MB of stream buffer on top of 12.8 MB of
    line buffer, and an 855 KB recording still died at a 48 MB cap. Shared the same way, with
    a floor that keeps an ordinary conversion writing in useful-sized pieces.
  */
  const streamBuffer = Math.max(
    16 * 1024,
    Math.floor(DEFAULT_FLUSH_THRESHOLD / Math.max(1, plan.groups.length)),
  );

  const open: OpenGroup[] = plan.groups.map((group, groupIndex) => {
    // A null directory means the single table goes to stdout. process.stdout is already a
    // writable stream, so the same buffered writer and backpressure handling apply.
    const target =
      shared?.target ??
      (outputDir === null
        ? process.stdout
        : createWriteStream(path.join(outputDir, group.fileName), {
            highWaterMark: streamBuffer,
          }));
    const { stream, settled, release } = shared ?? compressed(target, options.gzip === true);
    /*
      Under --gzip the writer feeds the compressor, so its byte count is the CSV before
      compression and says nothing about what reached the descriptor. The compressor's own
      output is what stdout is handed, so that is what is counted. `pipe` uses a 'data'
      listener of its own and a second one is delivered the same chunks.

      Once per stream, which in the long layout is once for all the groups. Attaching per
      group put N listeners on the one shared compressor, so every chunk was counted N
      times: `--stdout --layout long --gzip` on a 40-rate recording claimed 622,240 of
      622,240 bytes where 15,556 had been written, failed with a disk-full error over a
      perfectly good file, and printed Node's MaxListenersExceededWarning to stderr on the
      way past ten. 0.5.4 fixed the same arithmetic in the uncompressed branch and left
      this one, because the uncompressed branch is where the count is a sum and this one is
      where it is a subscription.
    */
    if (audit && stream !== target && !shared) {
      stream.on('data', (chunk: Buffer) => audit.count(chunk.length));
    }
    /*
      One writer, not one per group, when the table is shared. Separate writers over one
      stream each hold their own buffer and flush on their own schedule, so the rows would
      reach the file in whatever order the buffers filled — which is not the order they
      were produced in, and the long layout's whole claim is that its rows are in time
      order.
    */
    const writer = shared?.writer ?? new BufferedLineWriter(stream, flushThreshold);
    if (plan.layout === 'long' && !shared) shared = { stream, settled, release, target, writer };

    // Only the first group writes the header of a shared table, and the mark before it.
    if (plan.layout !== 'long' || groupIndex === 0) {
      if (options.bom === true) writer.push(UTF8_BOM);
      writer.pushLine(
        plan.layout === 'long'
          ? csvRow([TIME_COLUMN, 'channel', 'value'])
          : csvRow([TIME_COLUMN, ...group.channels.map((c) => c.column)]),
      );
    }
    return {
      group,
      writer,
      formatters: group.channels.map((c) => makeSampleFormatter(c.signal, c.decimals, sampleCaches)),
      formatTime: makeTimeFormatter(
        group.samplesPerRecord,
        group.rate,
        group.timeDecimals,
        offsets,
      ),
      rows: 0,
      settled,
      release,
    };
  });

  try {
    const written = await streamSignalRows(file, plan, open, recordStarts, options);

    /*
      Checked once everything has been flushed and ended, and not when the reader hung up.

      `--stdout | head -1` closes the pipe on purpose, which is a shell idiom rather than a
      failure. A pipe is not a regular file, so auditStdout declines it anyway — the second
      guard is here because the cost of getting this one wrong is reporting a failure for a
      command that worked.
    */
    if (audit) {
      // Uncompressed, the writer hands its bytes straight to the descriptor; compressed,
      // they were counted on the compressor's way out.
      if (options.gzip !== true) {
        /*
          Once per writer, not once per group. The long layout gives every group the same
          writer, so counting per group multiplied its byte total by the number of rates:
          `--stdout --layout long` on a three-rate recording handed over 32,043 bytes, was
          credited with 96,129, and failed with a disk-full error for a file that was
          complete on disk. It only showed with stdout redirected to a regular file, since
          that is the one case the audit applies to — which is the command the --layout
          documentation gives.
        */
        for (const writer of new Set(open.map((entry) => entry.writer))) {
          audit.count(writer.bytesOut);
        }
      }
      if (!open.some((entry) => entry.writer.hungUp)) audit.verify();
    }
    onHangUp?.(open.some((entry) => entry.writer.hungUp));
    return written;
  } catch (cause) {
    for (const entry of open) entry.writer.destroy();

    /*
      Reading and writing both fail through here, and both were reported as writing.

      A recording that shrinks mid-conversion — still being written by the acquisition
      software, say — raises the reader's own error, which names the record and says the
      file changed size while it was being read. That precise diagnosis was then filed under
      `Writing to "<dir>" failed` and given the hint about freeing disk space, which sends
      someone to look at the one part of the system that was working.

      The reader's message and its advice are kept; only the note about partial output is
      added, since that much is true of either failure.
    */
    // A ConversionError arrived already saying what went wrong — a callback that threw, say.
    // Wrapping it again turned "the onProgress callback threw" into `Writing to "out"
    // failed: the onProgress callback threw`, under a hint about checking the destination.
    if (cause instanceof ConversionError) throw cause;

    if (cause instanceof EdfError) {
      const where = outputDir === null ? 'stdout' : `"${outputDir}"`;
      throw new ConversionError(
        'INPUT_UNREADABLE',
        cause.message,
        `${cause.hint ? `${cause.hint} ` : ''}What was written to ${where} before it failed is ` +
          `incomplete and should not be used.`,
      );
    }

    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConversionError(
      'WRITE_FAILED',
      `Writing to ${outputDir === null ? 'stdout' : `"${outputDir}"`} failed: ${detail}`,
      writeHint(cause, outputDir === null),
    );
  }
}

/**
 * One record's samples in the long layout: `time_s,channel,value`, in time order.
 *
 * The groups are merged rather than written one after another. Every sample in a record
 * falls inside that record's span, so taking the earliest next sample across the groups
 * each time leaves the whole file sorted by `time_s` — which is the only thing that makes a
 * mixed-rate long table useful, since sorting 3 million rows afterwards is the reader's
 * problem and a large one.
 *
 * Ties go to the group with the higher rate, which is the order the groups are already in.
 * Within a sample time the channels come out in the order the file declares them.
 */
/**
 * Whether two sample times are close enough that only rounding could separate them.
 *
 * A relative epsilon, because the gap between doubles grows with magnitude. Well below any
 * real sample interval — the finest a recording can declare is bounded by its record
 * duration and samples-per-record fields — and well above the one-ULP disagreement that two
 * exact divisions of the same instant produce.
 */
function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-12;
}

/** The chosen instant as it will be written, for deciding which channels share it. */
function formatAt(
  open: readonly OpenGroup[],
  cursors: Int32Array,
  recordStart: number,
  earliest: number,
): string {
  for (let g = 0; g < open.length; g++) {
    const entry = open[g];
    if (!entry) continue;
    const sample = cursors[g] ?? 0;
    if (sample >= entry.group.samplesPerRecord) continue;
    if (recordStart + sample / entry.group.rate === earliest) {
      return entry.formatTime(recordStart, sample);
    }
  }
  return '';
}

async function writeLongRecord(
  file: EdfFile,
  open: readonly OpenGroup[],
  batch: RecordBatch,
  recordInBatch: number,
  recordStart: number,
  range: ConversionPlan['range'],
): Promise<void> {
  const writer = open[0]?.writer;
  if (!writer) return;

  const cursors = new Int32Array(open.length);
  /* Reused across sample times so a three-million-row conversion allocates one of these. */
  const due: { entry: OpenGroup; groupIndex: number; sample: number; channel: number }[] = [];

  for (;;) {
    let earliest = Infinity;
    for (let g = 0; g < open.length; g++) {
      const entry = open[g];
      if (!entry) continue;
      const sample = cursors[g] ?? 0;
      if (sample >= entry.group.samplesPerRecord) continue;
      const time = recordStart + sample / entry.group.rate;
      if (time < earliest) earliest = time;
    }
    if (earliest === Infinity) return;

    /*
      Everything at this instant, in the order the file declares its channels.

      Groups are ordered by rate, largest first, because that is how the wide layout names
      its files. Emitting a tie group by group therefore ordered the channels by descending
      sampling rate — so a recording declaring `slow, medium, fast` wrote `fast, medium,
      slow`, while the documentation promised file order and channels.csv listed file order.
      Signal index is the file's own order, and the only one a reader can predict.

      "At this instant" is decided on the time as written, not on the double. `s / rate` for
      two channels at one moment need not give the same double: a 0.3 s record holding 12 and
      4 samples makes 40 Hz and 13.333… Hz, and 9/40 is 0.22500000000000000555 while 3/13.333…
      is 0.22499999999999997780. Equality missed that, so those two rows fell out in numeric
      order — `slow` before `fast`, once, in the middle of a file that was otherwise right.

      Two rows are at one time exactly when they carry the same `time_s`, which is the only
      definition a reader of the CSV can apply. The numeric pre-filter keeps the common case
      to one comparison; formatting happens only for candidates already within a hair.
    */
    const earliestText = formatAt(open, cursors, recordStart, earliest);
    due.length = 0;
    for (let g = 0; g < open.length; g++) {
      const entry = open[g];
      if (!entry) continue;
      const sample = cursors[g] ?? 0;
      if (sample >= entry.group.samplesPerRecord) continue;
      const time = recordStart + sample / entry.group.rate;
      if (time !== earliest) {
        // Far away in the ordinary case; only a near-tie is worth formatting.
        if (!nearlyEqual(time, earliest)) continue;
        if (entry.formatTime(recordStart, sample) !== earliestText) continue;
      }
      cursors[g] = sample + 1;
      // Same window rule as the wide layout, with the same per-rate slack.
      if (
        !sampleTimeIsInRange(earliest, range.startSeconds, range.endSeconds, toleranceFor(entry.group.rate))
      ) {
        continue;
      }
      for (let c = 0; c < entry.group.channels.length; c++) {
        due.push({ entry, groupIndex: g, sample, channel: c });
      }
    }
    if (due.length === 0) continue;
    if (due.length > 1) {
      due.sort(
        (a, b) =>
          (a.entry.group.channels[a.channel]?.signal.index ?? 0) -
          (b.entry.group.channels[b.channel]?.signal.index ?? 0),
      );
    }

    for (const item of due) {
      const channel = item.entry.group.channels[item.channel];
      const format = item.entry.formatters[item.channel];
      if (!channel || !format) continue;
      if (writer.hungUp) return;
      writer.pushLine(
        `${item.entry.formatTime(recordStart, item.sample)},${escapeCsvField(channel.column)},` +
          `${format(file.sampleAt(batch, recordInBatch, channel.signal, item.sample))}`,
      );
      item.entry.rows++;
      // Flushed inside the record for the same reason the wide layout is; see there.
      if (writer.full) await writer.flush();
    }
  }
}

async function streamSignalRows(
  file: EdfFile,
  plan: ConversionPlan,
  open: OpenGroup[],
  recordStarts: Float64Array | null,
  options: ConvertOptions,
): Promise<WrittenFile[]> {
  const { startSeconds, endSeconds, startRecord, endRecord } = plan.range;
  const { recordDuration } = file.header;
  let recordsDone = 0;

  /*
    Every destination has hung up, so nothing formatted from here on could reach anyone.
    `--stdout | head -1` is the usual way to arrive here: the reader takes one line and
    closes the pipe while the conversion is still near the start of the recording.

    Stopping also makes the reported row count mean what it says — rows that reached the
    consumer, rather than rows the loop went on formatting into a discarded buffer.
  */
  const allHungUp = (): boolean => open.length > 0 && open.every((entry) => entry.writer.hungUp);

  for await (const batch of file.readRecords({ startRecord, endRecord })) {
    if (allHungUp()) break;
    for (let r = 0; r < batch.recordCount; r++) {
      if (allHungUp()) break;
      const index = batch.firstRecordIndex + r;
      const recordStart = recordStarts ? (recordStarts[index] ?? index * recordDuration) : index * recordDuration;

      if (plan.layout === 'long') {
        await writeLongRecord(file, open, batch, r, recordStart, plan.range);
        recordsDone++;
        continue;
      }

      for (const entry of open) {
        const { group, writer, formatters, formatTime } = entry;
        const { channels, rate } = group;
        // Slack that never reaches the next sample; see toleranceFor.
        const slack = toleranceFor(rate);

        for (let sample = 0; sample < group.samplesPerRecord; sample++) {
          const time = recordStart + sample / rate;
          if (!sampleTimeIsInRange(time, startSeconds, endSeconds, slack)) continue;

          let row = formatTime(recordStart, sample);
          for (let c = 0; c < channels.length; c++) {
            const channel = channels[c];
            const format = formatters[c];
            if (!channel || !format) continue;
            row += ',' + format(file.sampleAt(batch, r, channel.signal, sample));
          }
          if (writer.hungUp) break;
          writer.pushLine(row);
          entry.rows++;

          /*
            Flushed inside the record, not only at the end of one.

            The buffer was drained once per record, so the rows of a single record piled up
            with nothing emptying them — memory followed samples-per-record rather than the
            batch size the writer exists to hold to. One record of 16,000,000 samples died
            with a heap out of memory under a 256 MB cap, while the same 32 MB of samples
            split into 16,000 records converted to the same 283 MB CSV without trouble. The
            format allows either layout and says nothing about which to expect.

            `full` is a synchronous read of the pending size, so the twenty million rows that
            are not at a boundary cost a comparison rather than a microtask each.
          */
          if (writer.full) await writer.flush();
        }
        await writer.maybeFlush();
      }

      recordsDone++;
    }

    if (options.onProgress) {
      /*
        A caller's callback is the caller's, and its failures are not the destination's.

        This ran inside the same try that turns a stream failure into WRITE_FAILED, so a
        progress callback that threw came back as `Writing to "out" failed: caller bug`,
        advising the reader to check a destination that was working perfectly. It is the
        same misattribution the write hints had until 0.4.36, one layer up.

        The original is kept as `cause`, so the stack that actually matters survives, and
        the conversion still stops — the callback threw, and carrying on writing into a
        directory whose owner has just failed is not an improvement.
      */
      try {
        options.onProgress({
          recordsDone,
          recordsTotal: endRecord - startRecord,
          // Once per writer: the long layout's groups share one, so summing per group
          // reported a figure larger than the file being written.
          bytesWritten: [...new Set(open.map((entry) => entry.writer))].reduce(
            (sum, entry) => sum + entry.charsWritten,
            0,
          ),
        });
      } catch (cause) {
        throw new ConversionError(
          'CALLBACK_FAILED',
          `The onProgress callback threw: ${cause instanceof Error ? cause.message : String(cause)}`,
          'This is the caller\'s callback, not the recording or the destination. Whatever was ' +
            'written before it threw is incomplete and should not be used.',
          { cause },
        );
      }
    }
  }

  const closed = new Set<BufferedLineWriter>();
  for (const entry of open) {
    if (closed.has(entry.writer)) continue;
    closed.add(entry.writer);
    try {
      await entry.writer.end();
      // With --gzip the writer's stream is the compressor, whose end callback fires when the
      // compressor is done rather than when the file behind it is. Awaiting only that would
      // report success with the tail of the file still in flight.
      await entry.settled;
    } finally {
      // In a finally for the reason 0.5.45 gives about the writer's own release: a
      // conversion that fails here still has to leave process.stdout as it found it, and a
      // failure is exactly when a caller goes on to convert something else.
      entry.release();
    }
  }

  // A shared table is one file, and its row count is every group's rows, not the first's.
  if (plan.layout === 'long') {
    const first = open[0];
    if (!first) return [];
    return [{ name: first.group.fileName, rows: open.reduce((sum, e) => sum + e.rows, 0) }];
  }
  return open.map((entry) => ({ name: entry.group.fileName, rows: entry.rows }));
}

/**
 * The stream rows are written to, plus a promise for the data reaching its destination.
 *
 * Compression sits between the writer and the file as a transform. Failures below it — a
 * full disk, an unwritable path — surface on the file stream, where nothing is listening,
 * so they are forwarded onto the compressor: that is the stream the writer watches, and
 * routing them there keeps one error path rather than two.
 */
function compressed(
  target: Writable,
  gzip: boolean,
): { stream: Writable; settled: Promise<void>; release: () => void } {
  if (!gzip) return { stream: target, settled: Promise.resolve(), release: (): void => {} };
  const compressor = createGzip();
  /*
    Removable, because one of the streams this can be handed outlives the conversion.

    0.5.36 fixed exactly this leak for the writer's own listener: a library caller running
    twelve `toStdout` conversions left twelve 'error' listeners on `process.stdout` and got
    Node's MaxListenersExceededWarning on the eleventh. That fix is `BufferedLineWriter`'s
    `#release()`, and it cannot reach this one — under `gzip` the writer's stream is the
    compressor, and `process.stdout` is only ever the compressor's destination. So the same
    leak survived on the same stream, behind one extra flag, and the regression test written
    to catch it does not pass `gzip: true`.

    A file stream is a different matter and needs no release: it is created for this
    conversion and closed with it. The discipline is the writer's — release only from a
    stream this tool does not own.
  */
  const forward = (error: Error): void => {
    compressor.destroy(error);
  };
  target.on('error', forward);
  const release = (): void => {
    if (target === process.stdout || target === process.stderr) target.off('error', forward);
  };

  /*
    pipe() ends its destination when the source ends, and stdout must survive the
    conversion: the writer already refuses to close it, because a closed stdout breaks
    every later write in the process. Nothing waits on stdout either — it is not this
    tool's to finish.
  */
  const toStdout = target === process.stdout;
  compressor.pipe(target, { end: !toStdout });
  if (toStdout) {
    /*
      Waited on, even though stdout is not ours to end.

      This returned an already-resolved promise, so `await entry.settled` waited for nothing
      and the conversion declared itself finished while the compressor still held the tail of
      the stream. `--stdout --gzip` onto a destination that filled up therefore printed the
      ENOSPC *and then* "Wrote 102,400 rows to stdout." — and exited 0, over a file 11,270
      bytes short whose gzip member has no trailer and will not decompress. Through `--out`,
      on the same volume with the same space, the identical failure is reported and exits 1.

      The byte audit could not see it either: it stats the descriptor as soon as the writers
      are done, which on this path is before the compressor has pushed its last chunks.

      `finished(compressor)` is the source side, not the destination — it resolves when the
      compressor has flushed everything into stdout, and it is stdout's own write that fails.
      That keeps `end: !toStdout` exactly as it was: nothing here closes stdout.
    */
    const flushed = finished(compressor).catch((error: unknown) => {
      /*
        EPIPE is not a failure here, and turning it into one is the trap this nearly fell
        into: `--stdout --gzip | head` is an ordinary thing to type, and the documented
        answer to it is "Stopped: the reader closed the pipe after 52,507 of 102,400 rows
        had been written", exit 0. Waiting on the compressor surfaced the EPIPE that the
        uncompressed path already routes through the writer's hang-up flag — the writer
        sees the same error, forwarded, and records it — so the wait has to let that one
        through and keep everything else.
      */
      if ((error as NodeJS.ErrnoException | null)?.code === 'EPIPE') return;
      throw error;
    });
    flushed.catch(() => {});
    return { stream: compressor, settled: flushed, release };
  }

  /*
    A failure under the compressor rejects both this promise and the writer's own end(),
    and end() is the one awaited first. Without a handler attached here that rejection
    belonged to nobody, and Node killed the process over it: `--gzip` into an unwritable
    path printed a raw EISDIR stack trace instead of the ordinary "Writing to ... failed"
    message and exit 1, which is what the same path does uncompressed.

    Attaching the handler is enough to make it handled. Awaiting `settled` downstream still
    reports the failure in the case where end() happened to succeed.
  */
  const settled = finished(target);
  settled.catch(() => {});
  return { stream: compressor, settled, release };
}

/**
 * Write one of the sidecar files, reporting a failure the way the signal writer does.
 *
 * These three used to call `writeFile` bare, so a failure escaped as whatever the
 * filesystem said — `EISDIR: illegal operation on a directory, open '...'` with no hint
 * and, more importantly, no mention that the signal files had already been written. The
 * conversion stopped half-done and the message gave no sign of it.
 */
async function writeOutputFile(
  outputDir: string,
  name: string,
  contents: string,
  gzip = false,
  bom = false,
): Promise<void> {
  // metadata.json never gets one: JSON.parse rejects a leading U+FEFF, so a mark there
  // would break every reader of the file to help a spreadsheet that will not open it.
  if (bom) contents = UTF8_BOM + contents;
  try {
    // The sidecars are built in memory before being written, so compressing them in memory
    // costs nothing extra. Only the signal tables are large enough to need a stream.
    await writeFile(path.join(outputDir, name), gzip ? gzipSync(contents) : contents, gzip ? undefined : 'utf8');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConversionError(
      'WRITE_FAILED',
      `Writing "${name}" to "${outputDir}" failed: ${detail}`,
      writeHint(cause),
    );
  }
}

async function writeChannelsCsv(
  outputDir: string,
  file: EdfFile,
  plan: ConversionPlan,
  gzip: boolean,
  bom: boolean,
): Promise<WrittenFile> {
  const includedColumns = new Set(plan.groups.flatMap((g) => g.channels.map((c) => c.signal.index)));
  const fileFor = new Map<number, string>();
  for (const group of plan.groups) {
    for (const channel of group.channels) fileFor.set(channel.signal.index, group.fileName);
  }

  const lines = [
    csvRow([
      'column',
      'signal_index',
      'label',
      'unit',
      'sampling_rate_hz',
      'samples_per_record',
      'physical_min',
      'physical_max',
      'digital_min',
      'digital_max',
      'transducer',
      'prefiltering',
      'output_file',
      'converted',
    ]),
  ];

  for (const signal of file.header.signals) {
    if (signal.isAnnotations) continue;
    const column = plan.columnNames.get(signal.index) ?? `signal_${signal.index}`;
    lines.push(
      csvRow([
        column,
        String(signal.index),
        signal.label,
        signal.physicalDimension,
        String(signal.samplingRate),
        String(signal.samplesPerRecord),
        String(signal.physicalMin),
        String(signal.physicalMax),
        String(signal.digitalMin),
        String(signal.digitalMax),
        signal.transducer,
        signal.prefiltering,
        fileFor.get(signal.index) ?? '',
        includedColumns.has(signal.index) ? 'yes' : 'no',
      ]),
    );
  }

  const name = gzip ? 'channels.csv.gz' : 'channels.csv';
  await writeOutputFile(outputDir, name, lines.join('\n') + '\n', gzip, bom);
  return { name, rows: lines.length - 1 };
}

/*
  The bounds an annotation is filtered against: what the caller actually asked for, not the
  window that survived being clamped to the recording.

  Filtering by the resolved window meant an unbounded request still lost events. `--end 999h`
  on a three-second file clamps to 3, and `--start 0` gets its end from the recording, so
  both filtered to [0, 3) and dropped the markers at 3.0 and 3.5 that a bare invocation
  keeps — asking for more of a recording returned less of it.

  An end the caller did not give is unbounded, not "the end of the data": EDF+ lets an
  annotation sit past the last sample, which is exactly where an end-of-recording marker is.

  `--duration` is measured from wherever the conversion actually starts. Anchoring it at 0
  instead read the same absent `--start` two ways in two adjacent lines, and on a recording
  that does not begin at zero the two windows did not even overlap: an EDF+D file whose first
  record sits at 30 s converted its samples from [30, 35) while filtering annotations against
  (-inf, 5), so every event inside the converted window was dropped and `annotations.csv` came
  back empty. `resolveRange` has always defaulted the same missing start to the earliest
  record, which is where this now takes it from.
*/
/**
 * What the durations in the events that will actually be written look like.
 *
 * These two warnings were raised from the file-wide counts the decoder accumulates, while
 * `annotations.csv` is filtered to the requested window. A conversion of one second of a
 * recording therefore warned that "1 annotation states a duration that is not a number, so
 * its duration_s cell is empty" about an event two seconds outside it — naming a cell that is
 * not in the output — and `--strict` failed the run for it. There is no such value, no such
 * cell, and no such row.
 *
 * Taken from the events themselves, after the same filter the writer applies, so the count
 * and the sentence describe the same rows. An unreadable duration is carried on the event
 * because `duration: null` cannot say whether the file gave one; a negative duration needs no
 * flag, since the value is right there.
 */
export function durationDiagnostics(
  annotations: readonly Annotation[],
  window: { from: number; to: number },
): Diagnostic[] {
  const written = annotations.filter((a) => a.onset >= window.from && a.onset < window.to);
  const diagnostics: Diagnostic[] = [];

  const negative = written.filter((a) => a.duration !== null && a.duration < 0).length;
  if (negative > 0) {
    const one = negative === 1;
    diagnostics.push({
      code: 'ANNOTATION_DECODE_FAILED',
      severity: 'warning',
      message:
        `${negative} annotation${one ? '' : 's'} state${one ? 's' : ''} a duration below zero, ` +
        `which is not a length of time.`,
      hint:
        'The value is written to annotations.csv as the file gave it. Adding it to onset_s ' +
        'ends the event before it starts, so check these rows before using the durations.',
    });
  }

  const unreadable = written.filter((a) => a.durationUnreadable === true).length;
  if (unreadable > 0) {
    const one = unreadable === 1;
    diagnostics.push({
      code: 'ANNOTATION_DECODE_FAILED',
      severity: 'warning',
      message:
        `${unreadable} annotation${one ? '' : 's'} state${one ? 's' : ''} a duration that is ` +
        `not a number, so ${one ? 'its' : 'their'} duration_s cell is empty.`,
      hint:
        'The onset and the description were read normally. An empty duration_s otherwise ' +
        'means the file stated no duration, so these rows cannot be told apart from those.',
    });
  }

  return diagnostics;
}

function requestedAnnotationWindow(
  options: ConvertOptions,
  recordingStart: number,
): { from: number; to: number } {
  const from = options.start ?? -Infinity;
  const to =
    options.end !== undefined
      ? options.end
      : options.duration !== undefined
        ? (options.start ?? recordingStart) + options.duration
        : Infinity;
  return { from, to };
}

async function writeAnnotationsCsv(
  outputDir: string,
  annotations: readonly Annotation[],
  window: { from: number; to: number },
  gzip: boolean,
  bom: boolean,
): Promise<WrittenFile> {
  const inWindow = annotations
    .filter((a) => a.onset >= window.from && a.onset < window.to)
    .sort((a, b) => a.onset - b.onset || a.recordIndex - b.recordIndex);

  const lines = [csvRow(['onset_s', 'duration_s', 'description', 'record_index'])];
  for (const annotation of inWindow) {
    lines.push(
      csvRow([
        String(annotation.onset),
        annotation.duration === null ? '' : String(annotation.duration),
        annotation.text,
        String(annotation.recordIndex),
      ]),
    );
  }

  const name = gzip ? 'annotations.csv.gz' : 'annotations.csv';
  await writeOutputFile(outputDir, name, lines.join('\n') + '\n', gzip, bom);
  return { name, rows: inWindow.length };
}

/**
 * What to try next, chosen from what actually went wrong.
 *
 * Every write failure carried the same advice — "Free up space or choose another destination
 * with --out" — which fits exactly one errno. A directory sitting where signals.csv belongs
 * came back telling the reader to free up disk space, and so did a read-only volume, a
 * permission denial and a path too long for the filesystem. Wrong advice is worse than none:
 * it sends someone to check `df` on a disk that is fine, and the thing that is actually
 * wrong stays unexamined.
 *
 * The errno is the one piece of the failure that names the cause, so it is what picks the
 * sentence. Anything unrecognised keeps the general form rather than guessing.
 */
function writeHint(cause: unknown, toStdout = false): string {
  /*
    The stdout path writes no files, and --out is the flag its user chose not to pass.

    Both halves of this sentence were wrong there: "the files written so far" named files
    that do not exist, and "choose another destination with --out" is advice for a different
    command — the destination is whatever the shell redirected the stream to. Same class as
    the disk-space hint this function replaced, one flag over.
  */
  const preamble = toStdout
    ? 'What reached stdout before it failed is incomplete and should not be used. '
    : 'The files written so far are incomplete and should not be used. ';
  const elsewhere = toStdout ? 'redirect it somewhere else' : 'choose another with --out';
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'ENOSPC':
      return `${preamble}The destination is out of space; free some up or ${elsewhere}.`;
    case 'EDQUOT':
      return `${preamble}You are over your disk quota on this filesystem; ${elsewhere}.`;
    case 'EACCES':
    case 'EPERM':
      return `${preamble}You do not have permission to write there; ${elsewhere}.`;
    case 'EROFS':
      return `${preamble}That filesystem is mounted read-only; ${elsewhere}.`;
    case 'EISDIR':
      return `${preamble}A directory is sitting where that file belongs; remove or rename it, or ${elsewhere}.`;
    case 'ENOENT':
      return `${preamble}Part of that path no longer exists; make sure nothing is removing it while the conversion runs.`;
    case 'ENAMETOOLONG':
      return `${preamble}That path is longer than the filesystem allows; ${toStdout ? 'redirect it somewhere shorter' : 'choose a shorter destination with --out'}.`;
    case 'EMFILE':
    case 'ENFILE':
      return `${preamble}Too many files are open; a recording with many sampling rates opens one output file per rate, so --channels narrows it.`;
    case 'EPIPE':
      return `${preamble}Whatever was reading the output closed it before the conversion finished.`;
    default:
      return `${preamble}Check the destination and run the conversion again.`;
  }
}

/**
 * Confirms that everything handed to a file-backed stdout actually arrived.
 *
 * `edf2csv rec.edf --stdout > out.csv` onto a volume that the output very nearly fills lost
 * the tail in silence: 94,977 of 102,400 rows on disk, the file ending mid-row, stderr
 * announcing "Wrote 102,400 rows to stdout." and the process exiting 0. The same recording
 * onto the same volume through `--out` fails correctly, which is what gives it away.
 *
 * POSIX `write` returns a short count rather than an error when the disk fills partway
 * through a single call, and only the NEXT write raises ENOSPC. `--out` always has a next
 * write — channels.csv and metadata.json come after — so it always finds out. `--stdout`
 * has nothing after it, and when fd 1 is a regular file Node's stdout is a SyncWriteStream
 * whose `_write` discards the byte count `writeSync` returns, so nothing is raised at all.
 * No error means no `#failure`, so checking that alone would not have caught this.
 *
 * What can be checked is the descriptor: how much it grew against how much it was given.
 * Only for a regular file — a pipe, a terminal or a socket has no size to compare, and on
 * those a short write cannot go unreported this way. Appending (`>>`) is fine, since the
 * starting size is taken before anything is written.
 */
/**
 * Exported so `--info` can use the same audit a `--stdout` conversion does.
 *
 * `--info` wrote its description with `process.stdout.write` and looked at nothing: redirected
 * into a full filesystem it produced a zero-byte file and exited 0, so `edf2csv rec.edf --info
 * > desc.txt` reported success over nothing at all. A 900-channel recording's description is
 * 58 KB, which is not a size a destination is guaranteed to have.
 */
export function auditStdout(): { count: (bytes: number) => void; verify: () => void } | null {
  let startSize: number;
  try {
    const info = fstatSync(1);
    if (!info.isFile()) return null;
    startSize = info.size;
  } catch {
    // No usable descriptor to audit; the conversion is not the place to complain about it.
    return null;
  }

  let expected = 0;
  return {
    count: (bytes: number): void => {
      expected += bytes;
    },
    verify: (): void => {
      let landed: number;
      try {
        landed = fstatSync(1).size - startSize;
      } catch {
        return;
      }
      if (landed >= expected) return;

      /*
        This audit exists for the failure nothing else reports: a write that is accepted, and
        silently truncated. When the stream itself raised an error there is nothing left for
        it to add, and what it added was a second `error:` line denying the first —

          error: Writing to stdout failed: ENOSPC: no space left on device, write
          error: Writing to stdout failed: 58900 of 58900 bytes did not reach the destination,
                 which stopped accepting them part way through.
                 ... nothing after it raised an error because there was nothing after it.

        one failure, reported twice, the second of the two wrong about it.
      */
      if (process.stdout.errored) return;

      /*
        Nothing landing at all is not a short write, and was described as one.

        `--info > desc.txt` onto a full filesystem left a zero-byte file, and this said the
        destination "stopped accepting them part way through" and that "what is there ends
        mid-row" — of a file with nothing in it and no rows in it.
      */
      if (landed === 0) {
        throw new ConversionError(
          'WRITE_FAILED',
          `Writing to stdout failed: none of the ${expected} bytes reached the destination.`,
          'The destination is almost certainly out of space. Nothing was written, so there ' +
            'is nothing there to discard.',
        );
      }
      throw new ConversionError(
        'WRITE_FAILED',
        `Writing to stdout failed: ${expected - landed} of ${expected} bytes did not reach ` +
          `the destination, which stopped accepting them part way through.`,
        'What is there ends mid-row and should not be used. The destination is almost ' +
          'certainly out of space — a short write is how a filesystem reports filling up ' +
          'mid-write, and nothing after it raised an error because there was nothing after it.',
      );
    },
  };
}

/**
 * Why `--stdout` cannot take this recording, or null when it can.
 *
 * Lifted out of the conversion so `--info` can ask the same question. It was not asking:
 * `--info --stdout` on a three-rate recording predicted "Would write 1,155 rows, roughly
 * 22.2 KB" and said the channels "are written to one file per rate" — for a command that
 * refuses to run, writes nothing, and names no files. `--info` exists to say what a
 * conversion will do, and this is one of the things it does.
 *
 * Reported by `--info` as a warning rather than a refusal, for the reason 0.5.51 gives about
 * the destination guards: `--info` writes nothing, so a rule about what the output would be
 * has no business stopping it from describing the recording — and being told the command
 * will not work is exactly what you asked.
 */
export function stdoutRefusal(file: EdfFile, plan: ConversionPlan): ConversionError | null {
  if (!plan.writeSignals) {
    return new ConversionError(
      'UNSUPPORTED_REQUEST',
      '--stdout has no signal data to write because --annotations-only was given.',
      'Drop one of the two flags.',
    );
  }

    /*
      No table at all is its own answer, and neither layout gave it.

      A recording with no signal channels — one holding only EDF+ annotations — produced
      zero rate groups. The wide layout then said "--stdout needs exactly one table, but
      this recording produces 0, one for each sampling rate its channels use ()", with an
      empty parenthetical, advice to narrow to one of no rates, and advice to use
      `--layout long` — which wrote zero bytes to stdout, not even a header row, and exited
      0 while warning that "the signal files hold their headers and no data". There were no
      files and there was no header. The one path that was right about this is
      `--annotations-only`, which refuses outright, and this is the same situation reached
      by a different route.
    */
    if (plan.groups.length === 0) {
      return new ConversionError(
        'UNSUPPORTED_REQUEST',
        file.dataSignals.length === 0
          ? '--stdout has no signal data to write: this recording has no signal channels, ' +
            'only EDF+ annotations.'
          : '--stdout has no signal data to write: nothing was selected that carries samples.',
        file.dataSignals.length === 0
          ? 'Convert to a directory to get its annotations.csv, or drop --stdout.'
          : 'Check --channels and the requested window, or convert to a directory instead.',
      );
    }

    // The long layout is one table whatever the rates are, so it has nothing to refuse.
    if (plan.layout !== 'long' && plan.groups.length !== 1) {
      return new ConversionError(
        'UNSUPPORTED_REQUEST',
        // Naming the rates is the point: the hint says to narrow the selection, and this
        // is what there is to narrow it to. The parenthetical used to repeat the count
        // that had just been given — "produces 3 (its channels use 3 different sampling
        // rates)" — which told nobody anything they could act on.
        `--stdout needs exactly one table, but this recording produces ${plan.groups.length}, ` +
          `one for each sampling rate its channels use ` +
          `(${listed(formatRates(plan.groups.map((g) => g.rate)).map((r) => `${r} Hz`))}).`,
        'Narrow it to one rate with --channels, write --layout long to get them all in ' +
          'one table, or convert to a directory instead.',
      );
    }
  return null;
}



/** Raised when the input moved while it was being read. See where it is pushed. */
function inputChanged(hadChecksum: boolean): Diagnostic {
  return {
    code: 'INPUT_CHANGED',
    severity: 'warning',
    message:
      'The input changed while it was being converted, so this output covers the file as ' +
      'it was when the conversion started, not as it is now.',
    hint: hadChecksum
      ? 'No checksum was recorded: the bytes that were converted are no longer there to ' +
        'hash. Convert again once the recording is finished.'
      : 'Convert again once the recording is finished to pick up the rest.',
  };
}

async function writeMetadata(
  outputDir: string,
  inputPath: string,
  file: EdfFile,
  plan: ConversionPlan,
  written: readonly WrittenFile[],
  annotationCount: number,
  /** Hash of the bytes that were converted, or null when it could not be vouched for. */
  checksum: string | null,
  /** Whether the record start times could be read; see withTimingPromiseKept. */
  timedFromRecords: boolean,
): Promise<void> {
  const { header } = file;

  /*
    The file as it was when it was opened, not as it is now.

    Both of these used to come from re-opening the path once the CSVs were written, which
    describes whatever answers to that name by then rather than what was converted. A
    recording still being written grew from 2,000 records to 3,000 mid-conversion and
    metadata.json recorded `data_records: 2000` — correct, the CSV holds 2,000 — beside the
    byte count and SHA-256 of the 3,000-record file. The two halves of one provenance record
    described two different files, and the checksum covered bytes nobody had converted.
    Replacing the file at that path did the same thing more thoroughly.

    `file.fileSize` is the number every record count and window in this output was derived
    from, and the hash is taken over exactly those bytes through the descriptor already open
    on them, so the record describes one file throughout.
  */
  const metadata = {
    tool: { name: 'edf2csv', version: TOOL_VERSION },
    source: {
      path: path.resolve(inputPath),
      bytes: file.fileSize,
      modified: new Date(file.modifiedAtOpenMs).toISOString(),
      sha256: checksum,
    },
    recording: {
      format: describeFormat(header),
      version: header.version,
      patient_id: header.patientId,
      recording_id: header.recordingId,
      // Zone-less on purpose: EDF records local wall-clock digits and no timezone.
      start_datetime_local: formatWallClock(header.startDateTime),
      start_date_raw: header.startDateRaw,
      start_time_raw: header.startTimeRaw,
      data_records: file.recordCount,
      data_records_declared: header.declaredRecordCount,
      record_duration_seconds: header.recordDuration,
      duration_seconds: file.durationSeconds,
      signal_count: header.signalCount,
      annotation_channels: file.annotationSignals.length,
    },
    conversion: {
      converted_at: new Date().toISOString(),
      start_seconds: plan.range.startSeconds,
      end_seconds: plan.range.endSeconds,
      whole_recording: plan.range.isWholeRecording,
      records_converted: [plan.range.startRecord, plan.range.endRecord],
      annotations_written: annotationCount,
      /*
        Which shape the signal table is in, which nothing recorded.

        A wide `signals.csv` and a long one are different files with different columns, and
        metadata.json described them identically — so a pipeline handed an output directory
        could not tell from the archive which it had. It matters most for `rate_groups` right
        below: in the wide layout those entries are one per file and their `channels` are that
        file's columns, and in the long layout every entry names the one shared table and its
        `channels` are values in that table's `channel` column. Same array, two readings, and
        no way to know which applied.
      */
      layout: plan.layout,
      files: written.map((f) => ({ name: f.name, rows: f.rows })),
      rate_groups: plan.groups.map((g) => ({
        file: g.fileName,
        sampling_rate_hz: g.rate,
        channels: g.channels.map((c) => c.column),
        decimals: g.channels.map((c) => c.decimals),
      })),
    },
    notes: [
      ...withTimingPromiseKept(withoutFileRateWarning(file.diagnostics), timedFromRecords),
      ...plan.diagnostics,
    ].map((d) => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
    })),
  };

  await writeOutputFile(outputDir, 'metadata.json', JSON.stringify(metadata, null, 2) + '\n');
}


