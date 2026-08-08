/**
 * Human-readable output for the terminal.
 *
 * Everything here is plain text with no colour codes, so piping to a file or a log
 * produces exactly what appeared on screen.
 */

import type { Diagnostic } from '../edf/errors.js';
import type { EdfFile } from '../edf/reader.js';
import { describeFormat, formatRates, formatWallClock } from '../edf/header.js';
import { formatBytes, formatDuration } from '../format/number.js';
import type { ConversionPlan } from '../convert/plan.js';
import { withoutFileRateWarning } from '../convert/plan.js';
import type { ConvertResult } from '../convert/run.js';

function table(rows: readonly (readonly string[])[], alignRight: ReadonlySet<number>): string {
  if (rows.length === 0) return '';
  const width: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      width[i] = Math.max(width[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => {
          const w = width[i] ?? 0;
          return alignRight.has(i) ? cell.padStart(w) : cell.padEnd(w);
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/**
 * Make header text safe to print to a terminal.
 *
 * EDF identification fields and channel labels are free text copied verbatim out of the
 * file, and `--info` puts them straight on stdout. A header carrying ANSI escapes could
 * therefore drive the reader's terminal — `\x1b[2J\x1b[H` clears the screen and homes the
 * cursor, which is enough to hide the rest of the output or repaint it as something else.
 * Nobody writes an EDF header that way on purpose, which is exactly why a file that does
 * should not be trusted with the terminal.
 *
 * Control bytes are shown as their escape instead, so a corrupt field stays diagnosable
 * rather than being silently swallowed. This affects display only: `channels.csv` and
 * `metadata.json` still copy the field verbatim, and CSV quoting already makes that safe.
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, (c) =>
    `\\x${c.codePointAt(0)!.toString(16).padStart(2, '0')}`,
  );
}

/**
 * The same protection for text that is meant to span lines.
 *
 * `printable` escapes newlines along with everything else, which is right for a channel
 * label — one has no business containing a line break, and it would break the `--info`
 * table's alignment. It is wrong for a whole message: several are written on two lines,
 * and Node's own option errors run to three. Escaping those turned the break into text:
 *
 *     error: No channel named "ECQ". Did you mean "ECG"?\x0aRun with --info to list ...
 *
 * Each line is escaped on its own, so nothing here gains the ability to drive a terminal.
 * A carriage return is still escaped, so no line can be repainted after it is printed —
 * which is the property that mattered. A newline can only add a line, never overwrite one.
 */
export function printableLines(text: string, indent = ''): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? '' : indent) + printable(line))
    .join('\n');
}

/** The `--info` view: what is in this recording, and what would converting it produce. */
export function formatInfo(file: EdfFile, plan: ConversionPlan): string {
  const { header } = file;
  const lines: string[] = [];

  lines.push(`File       ${file.path}`);
  lines.push(`Format     ${describeFormat(header)}`);
  lines.push(
    `Recorded   ${
      formatWallClock(header.startDateTime)?.replace('T', ' ') ??
      `${printable(header.startDateRaw)} ${printable(header.startTimeRaw)} (unparseable)`
    }`,
  );
  lines.push(
    `Duration   ${formatDuration(file.durationSeconds)}  (${file.recordCount} records of ${header.recordDuration}s)`,
  );
  const elapsedSpan = plan.range.recordingEndSeconds - plan.range.recordingStartSeconds;
  if (Math.abs(elapsedSpan - file.durationSeconds) > 1e-9) {
    lines.push(`Time span  ${formatDuration(elapsedSpan)}  (includes discontinuities)`);
  }
  lines.push(`Size       ${formatBytes(file.fileSize)}`);
  if (header.patientId) lines.push(`Patient    ${printable(header.patientId)}`);
  if (header.recordingId) lines.push(`Recording  ${printable(header.recordingId)}`);

  const signals = file.dataSignals;
  lines.push('');
  // The signal count was pluralised but the annotation-channel count was not, so a file
  // carrying two of them read "2 annotation channel". EDF+ permits more than one.
  const annotationCount = file.annotationSignals.length;
  const annotationPart =
    annotationCount > 0
      ? ` + ${annotationCount} annotation channel${annotationCount === 1 ? '' : 's'}`
      : '';
  lines.push(
    `Channels   ${signals.length} signal${signals.length === 1 ? '' : 's'}${annotationPart}`,
  );
  lines.push('');

  const rows: string[][] = [['#', 'COLUMN', 'LABEL', 'UNIT', 'RATE', 'RANGE', 'OUTPUT']];
  const fileFor = new Map<number, string>();
  for (const group of plan.groups) {
    for (const channel of group.channels) fileFor.set(channel.signal.index, group.fileName);
  }
  // Rendered as a group so that two channels recorded at different rates never show the
  // same figure in the RATE column, which is the one thing this table is asked to settle.
  const rateText = formatRates(signals.map((signal) => signal.samplingRate));
  for (const [row, signal] of signals.entries()) {
    rows.push([
      String(signal.index),
      printable(plan.columnNames.get(signal.index) ?? ''),
      printable(signal.label),
      printable(signal.physicalDimension),
      `${rateText[row]} Hz`,
      `${signal.physicalMin} to ${signal.physicalMax}`,
      /*
        A channel with no samples was reported as "(not selected)", which is a different
        thing and not true when it was named on --channels. `edf2csv rec.edf --info
        --channels unused` said the channel the command asked for had not been chosen, when
        what is actually the case is that the file gives it nothing to convert. The
        NO_SAMPLES warning below the table says so; the table contradicted it.
      */
      fileFor.get(signal.index) ??
        (signal.samplesPerRecord === 0 ? '(no samples)' : '(not selected)'),
    ]);
  }
  lines.push(table(rows, new Set([0])));

  lines.push('');
  if (plan.groups.length > 1) {
    lines.push(
      plan.layout === 'long'
        ? `Sampling rates differ, and the long layout puts them in one table anyway: each row ` +
          `carries its own time, so nothing has to line up. No channel is resampled.`
        : `Sampling rates differ, so channels are written to ${plan.groups.length} files, one per rate. ` +
          `No channel is resampled.`,
    );
  }
  /*
    The estimate describes the signal tables, and says so when that is not what will be
    written.

    Under --annotations-only there are no signal tables, and the line read "Would write 0
    rows, roughly 0 B." for a conversion that goes on to write annotations.csv with three
    events in it. --info exists to say what a conversion will do; asserting it will write
    nothing, when it will write a file, is the one thing it must not do.

    How many events there are cannot be answered from the header — the annotation channel has
    to be read record by record, which is the scan --info is for avoiding. So it says which
    file, and that the count is not knowable this cheaply, rather than inventing a zero.
  */
  /*
    No signal table to describe, whichever way that came about.

    This asked only whether `--annotations-only` had been given. A recording that has no
    signal channels — one holding nothing but EDF+ annotations — has none either, and fell
    through to the estimate line: "Would write 0 rows, roughly 0 B." for a conversion that
    goes on to write an annotations.csv with events in it, beside channels.csv and
    metadata.json. That is the sentence 0.4.51 removed, arriving by the other route.
  */
  if (!plan.writeSignals || plan.groups.length === 0) {
    // Named as they will be written. --info is read to find out what a run leaves behind,
    // and a script that opens the name it was given must find a file there.
    const suffix = plan.gzip ? '.csv.gz' : '.csv';
    lines.push(
      file.annotationSignals.length > 0
        ? `Would write annotations${suffix} and channels${suffix}, and no signal data. How ` +
          'many events there are cannot be told from the header.'
        : `Would write channels${suffix} and no signal data — and no annotations${suffix} ` +
          'either, since this recording has no annotation channel.',
    );
    return lines.join('\n');
  }

  // The estimate counts the characters of the CSV, which is what --gzip then compresses.
  // Reporting it as the size on disk would overstate a compressed conversion several-fold.
  const compressing = plan.gzip;
  lines.push(
    `Would write ${plan.estimate.rows.toLocaleString('en-US')} rows, roughly ` +
      `${formatBytes(plan.estimate.bytes)}${compressing ? ' before compression' : ''}.`,
  );

  return lines.join('\n');
}

/**
 * The `--info` view as JSON, for surveying files from a script.
 *
 * `indent` is 2 for a single recording, matching what this has always printed, and null for
 * a batch — several pretty-printed documents run together are readable by a streaming parser
 * but not by anything that expects one record per line, and a batch is exactly where
 * line-oriented reading is wanted. null rather than undefined because a default parameter
 * takes effect when undefined is passed, which quietly restored the indentation this was
 * meant to drop; JSON.stringify itself wants undefined, so it is translated at the call.
 *
 * `--info` answers "what is in this recording and what would converting it cost", which
 * is exactly the question you want to ask across a directory of hundreds of recordings —
 * and the text table is the wrong shape for that. `--json` previously applied only to
 * conversions, so scripts had to parse the aligned columns or convert files just to learn
 * what was in them.
 *
 * Field names match `metadata.json` where the two describe the same thing, so a survey and
 * a conversion can be read by the same code.
 */
export function infoJson(file: EdfFile, plan: ConversionPlan, indent: number | null = 2): string {
  const { header } = file;
  const fileFor = new Map<number, string>();
  for (const group of plan.groups) {
    for (const channel of group.channels) fileFor.set(channel.signal.index, group.fileName);
  }

  return JSON.stringify(
    {
      path: file.path,
      bytes: file.fileSize,
      format: describeFormat(header),
      start_datetime_local: formatWallClock(header.startDateTime),
      start_date_raw: header.startDateRaw,
      start_time_raw: header.startTimeRaw,
      patient_id: header.patientId,
      recording_id: header.recordingId,
      data_records: file.recordCount,
      data_records_declared: header.declaredRecordCount,
      record_duration_seconds: header.recordDuration,
      duration_seconds: file.durationSeconds,
      // For a discontinuous file this exceeds duration_seconds by the length of the gaps.
      time_span_seconds: plan.range.recordingEndSeconds - plan.range.recordingStartSeconds,
      annotation_channels: file.annotationSignals.length,
      channels: file.dataSignals.map((signal) => ({
        signal_index: signal.index,
        column: plan.columnNames.get(signal.index) ?? '',
        label: signal.label,
        unit: signal.physicalDimension,
        sampling_rate_hz: signal.samplingRate,
        samples_per_record: signal.samplesPerRecord,
        physical_min: signal.physicalMin,
        physical_max: signal.physicalMax,
        digital_min: signal.digitalMin,
        digital_max: signal.digitalMax,
        transducer: signal.transducer,
        prefiltering: signal.prefiltering,
        output_file: fileFor.get(signal.index) ?? null,
      })),
      estimate: {
        rows: plan.estimate.rows,
        // Character count of the CSV. With --gzip the file on disk is smaller than this.
        bytes: plan.estimate.bytes,
        exceeds_spreadsheet_limit: plan.estimate.exceedsSpreadsheetLimit,
      },
      // The plan's mixed-rate warning replaces the header parser's, as it does everywhere
      // else. This was the one consumer left out of that when 0.3.2 made the warning follow
      // --channels, so `--info --json` carried it twice: once counting the rates being
      // converted and once counting every rate in the file, with the same code and severity.
      warnings: plan.diagnostics
        .concat(withoutFileRateWarning(file.diagnostics))
        .map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
    },
    null,
    indent ?? undefined,
  );
}

/** One line per diagnostic, prefixed so warnings are greppable. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      // Diagnostics quote channel labels, which come from the file, so they need the
      // same treatment as the --info table.
      const head = `${d.severity === 'warning' ? 'warning' : 'note'}: ${printable(d.message)}`;
      return d.hint ? `${head}\n         ${printable(d.hint)}` : head;
    })
    .join('\n');
}

export function formatSummary(result: ConvertResult): string {
  const lines: string[] = [];
  const rows: string[][] = [];
  for (const file of result.files) {
    // `.csv.gz` is still a CSV, and its rows are still rows. The suffix test dropped the
    // unit from every line of a --gzip summary, so the numbers stood on their own.
    rows.push([
      `  ${file.name}`,
      file.rows.toLocaleString('en-US'),
      /\.csv(\.gz)?$/u.test(file.name) ? 'rows' : '',
    ]);
  }
  lines.push(`Wrote ${result.outputDir}`);
  lines.push(table(rows, new Set([1])));
  lines.push(`Done in ${(result.elapsedMs / 1000).toFixed(1)}s.`);
  return lines.join('\n');
}

export function summaryJson(result: ConvertResult, indent: number | null = 2): string {
  return JSON.stringify(
    {
      output_dir: result.outputDir,
      files: result.files,
      annotations: result.annotationCount,
      duration_seconds: result.file.durationSeconds,
      records: result.file.recordCount,
      elapsed_ms: result.elapsedMs,
      warnings: result.diagnostics.map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
    },
    null,
    indent ?? undefined,
  );
}
