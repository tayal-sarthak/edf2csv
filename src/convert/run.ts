/**
 * Executing a conversion.
 *
 * Everything is written in a single pass over the data records. All rate groups are
 * open at once and fed from the same batch of bytes, so a file is read once no
 * matter how many output tables it produces, and memory stays flat.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

import { EdfFile } from '../edf/reader.js';
import { describeFormat, formatWallClock } from '../edf/header.js';
import type { Diagnostic } from '../edf/errors.js';
import type { Annotation } from '../edf/annotations.js';
import { BufferedLineWriter, csvRow } from '../format/csv.js';
import { fixed, makeSampleFormatter } from '../format/number.js';
import type { SampleFormatter } from '../format/number.js';
import { buildPlan } from './plan.js';
import type { ConversionPlan, PlanOptions, RateGroup } from './plan.js';
import { deriveRecordStarts } from './timing.js';
import { sampleTimeIsInRange } from './time-range.js';
import { VERSION as TOOL_VERSION } from '../version.js';

export { TOOL_VERSION };

export type ConversionErrorCode =
  | 'OUTPUT_EXISTS'
  | 'OUTPUT_UNWRITABLE'
  | 'INPUT_OUTPUT_COLLISION'
  | 'WRITE_FAILED';

export class ConversionError extends Error {
  readonly code: ConversionErrorCode;
  readonly hint: string | undefined;
  constructor(code: ConversionErrorCode, message: string, hint?: string) {
    super(message);
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
  rows: number;
}

export async function convert(inputPath: string, options: ConvertOptions = {}): Promise<ConvertResult> {
  const startedAt = Date.now();
  const file = await EdfFile.open(inputPath);

  try {
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

    const outputDir = options.outputDir ?? defaultOutputDir(inputPath);
    await assertInputDoesNotOverlapOutputs(inputPath, outputDir, file, plan);
    await prepareOutputDir(outputDir, options.force === true);

    const written: WrittenFile[] = [];

    if (plan.writeSignals && plan.groups.length > 0) {
      written.push(...(await writeSignalFiles(file, plan, outputDir, timing.starts, options)));
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
      const result = await writeAnnotationsCsv(
        outputDir,
        annotationData.annotations,
        plan,
        options.start !== undefined || options.end !== undefined || options.duration !== undefined,
      );
      written.push(result);
      annotationsWritten = result.rows;
    }

    written.push(await writeChannelsCsv(outputDir, file, plan));
    await writeMetadata(outputDir, inputPath, file, plan, written, annotationsWritten, options);

    const stale = await findStaleOutput(outputDir, written);

    return {
      outputDir,
      files: written,
      annotationCount: annotationsWritten,
      diagnostics: [...file.diagnostics, ...plan.diagnostics, ...stale],
      plan,
      file,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    await file.close();
  }
}

/** Files this tool produces, used to spot leftovers from an earlier conversion. */
const OUTPUT_PATTERN = /^(signals(_[\w.]+hz)?\.csv|annotations\.csv|channels\.csv|metadata\.json)$/u;

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
      message:
        `${stale.join(', ')} ${stale.length === 1 ? 'is' : 'are'} left over from an earlier ` +
        `conversion into this directory and ${stale.length === 1 ? 'was' : 'were'} not rewritten.`,
      hint: 'Delete them, or convert into a fresh directory, so the two runs do not get mixed up.',
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
): Promise<void> {
  const names = new Set(plan.groups.map((group) => group.fileName));
  if (file.annotationSignals.length > 0) names.add('annotations.csv');
  names.add('channels.csv');
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
    await mkdir(parent, { recursive: true }).catch((cause: unknown) => {
      throw new ConversionError(
        'OUTPUT_UNWRITABLE',
        `Cannot create "${dir}": ${describeFsError(cause)}.`,
        'Check the path exists and that you have permission to write there.',
      );
    });
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
  if (code === 'ENOTDIR') return 'part of the path is a file, not a directory';
  if (code === 'EROFS') return 'the filesystem is read-only';
  if (code === 'ENAMETOOLONG') return 'the path is too long';
  return cause instanceof Error ? cause.message : String(cause);
}

async function writeSignalFiles(
  file: EdfFile,
  plan: ConversionPlan,
  outputDir: string,
  recordStarts: Float64Array | null,
  options: ConvertOptions,
): Promise<WrittenFile[]> {
  const open: OpenGroup[] = plan.groups.map((group) => {
    const stream = createWriteStream(path.join(outputDir, group.fileName));
    const writer = new BufferedLineWriter(stream);
    writer.pushLine(csvRow(['time_s', ...group.channels.map((c) => c.column)]));
    return {
      group,
      writer,
      formatters: group.channels.map((c) => makeSampleFormatter(c.signal, c.decimals)),
      rows: 0,
    };
  });

  try {
    return await streamSignalRows(file, plan, open, recordStarts, options);
  } catch (cause) {
    for (const entry of open) entry.writer.destroy();
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ConversionError(
      'WRITE_FAILED',
      `Writing to "${outputDir}" failed: ${detail}`,
      'The files written so far are incomplete and should not be used. Free up space or ' +
        'choose another destination with --out, then run the conversion again.',
    );
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

  for await (const batch of file.readRecords({ startRecord, endRecord })) {
    for (let r = 0; r < batch.recordCount; r++) {
      const index = batch.firstRecordIndex + r;
      const recordStart = recordStarts ? (recordStarts[index] ?? index * recordDuration) : index * recordDuration;

      for (const entry of open) {
        const { group, writer, formatters } = entry;
        const { channels, rate, timeDecimals: tDecimals } = group;

        for (let sample = 0; sample < group.samplesPerRecord; sample++) {
          const time = recordStart + sample / rate;
          if (!sampleTimeIsInRange(time, startSeconds, endSeconds)) continue;

          let row = fixed(time, tDecimals);
          for (let c = 0; c < channels.length; c++) {
            const channel = channels[c];
            const format = formatters[c];
            if (!channel || !format) continue;
            row += ',' + format(file.sampleAt(batch, r, channel.signal, sample));
          }
          writer.pushLine(row);
          entry.rows++;
        }
        await writer.maybeFlush();
      }

      recordsDone++;
    }

    options.onProgress?.({
      recordsDone,
      recordsTotal: endRecord - startRecord,
      bytesWritten: open.reduce((sum, g) => sum + g.writer.charsWritten, 0),
    });
  }

  for (const entry of open) await entry.writer.end();
  return open.map((entry) => ({ name: entry.group.fileName, rows: entry.rows }));
}

async function writeChannelsCsv(
  outputDir: string,
  file: EdfFile,
  plan: ConversionPlan,
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

  await writeFile(path.join(outputDir, 'channels.csv'), lines.join('\n') + '\n', 'utf8');
  return { name: 'channels.csv', rows: lines.length - 1 };
}

async function writeAnnotationsCsv(
  outputDir: string,
  annotations: readonly Annotation[],
  plan: ConversionPlan,
  windowRequested: boolean,
): Promise<WrittenFile> {
  const { startSeconds, endSeconds } = plan.range;

  /*
    Filter only when the caller actually asked for a window.

    EDF+ does not oblige an annotation's onset to fall inside the data span: a marker for
    the end of a recording sits at exactly `duration`, and files carry markers at negative
    onsets ahead of the first record. The window on a whole-file conversion is
    [0, duration), so filtering by it unconditionally dropped both from a plain
    `edf2csv recording.edf` with no time options given, and no flag could ask for them back.

    The test is whether a window was requested, not whether the resolved one happens to
    cover everything: `--end 3` on a three-second recording resolves to the whole file but
    is still an explicit request for [0, 3), and an event at exactly 3 belongs outside it.
  */
  const inWindow = annotations
    .filter((a) => !windowRequested || (a.onset >= startSeconds && a.onset < endSeconds))
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

  await writeFile(path.join(outputDir, 'annotations.csv'), lines.join('\n') + '\n', 'utf8');
  return { name: 'annotations.csv', rows: inWindow.length };
}

async function writeMetadata(
  outputDir: string,
  inputPath: string,
  file: EdfFile,
  plan: ConversionPlan,
  written: readonly WrittenFile[],
  annotationCount: number,
  options: ConvertOptions,
): Promise<void> {
  const { header } = file;
  const info = await stat(inputPath).catch(() => null);

  const metadata = {
    tool: { name: 'edf2csv', version: TOOL_VERSION },
    source: {
      path: path.resolve(inputPath),
      bytes: info?.size ?? null,
      modified: info ? new Date(info.mtimeMs).toISOString() : null,
      sha256: options.checksum === true ? await sha256(inputPath) : null,
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
      files: written.map((f) => ({ name: f.name, rows: f.rows })),
      rate_groups: plan.groups.map((g) => ({
        file: g.fileName,
        sampling_rate_hz: g.rate,
        channels: g.channels.map((c) => c.column),
        decimals: g.channels.map((c) => c.decimals),
      })),
    },
    notes: [...file.diagnostics, ...plan.diagnostics].map((d) => ({
      code: d.code,
      severity: d.severity,
      message: d.message,
    })),
  };

  await writeFile(path.join(outputDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
