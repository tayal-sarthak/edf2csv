/**
 * Human-readable output for the terminal.
 *
 * Everything here is plain text with no colour codes, so piping to a file or a log
 * produces exactly what appeared on screen.
 */

import type { Diagnostic } from '../edf/errors.js';
import type { EdfFile } from '../edf/reader.js';
import { describeFormat, formatRate, formatWallClock } from '../edf/header.js';
import { formatBytes, formatDuration } from '../format/number.js';
import type { ConversionPlan } from '../convert/plan.js';
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

/** The `--info` view: what is in this recording, and what would converting it produce. */
export function formatInfo(file: EdfFile, plan: ConversionPlan): string {
  const { header } = file;
  const lines: string[] = [];

  lines.push(`File       ${file.path}`);
  lines.push(`Format     ${describeFormat(header)}`);
  lines.push(
    `Recorded   ${
      formatWallClock(header.startDateTime)?.replace('T', ' ') ??
      `${header.startDateRaw} ${header.startTimeRaw} (unparseable)`
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
  if (header.patientId) lines.push(`Patient    ${header.patientId}`);
  if (header.recordingId) lines.push(`Recording  ${header.recordingId}`);

  const signals = file.dataSignals;
  lines.push('');
  lines.push(`Channels   ${signals.length} signal${signals.length === 1 ? '' : 's'}${file.annotationSignals.length > 0 ? ` + ${file.annotationSignals.length} annotation channel` : ''}`);
  lines.push('');

  const rows: string[][] = [['#', 'COLUMN', 'LABEL', 'UNIT', 'RATE', 'RANGE', 'OUTPUT']];
  const fileFor = new Map<number, string>();
  for (const group of plan.groups) {
    for (const channel of group.channels) fileFor.set(channel.signal.index, group.fileName);
  }
  for (const signal of signals) {
    rows.push([
      String(signal.index),
      plan.columnNames.get(signal.index) ?? '',
      signal.label,
      signal.physicalDimension,
      `${formatRate(signal.samplingRate)} Hz`,
      `${signal.physicalMin} to ${signal.physicalMax}`,
      fileFor.get(signal.index) ?? '(not selected)',
    ]);
  }
  lines.push(table(rows, new Set([0])));

  lines.push('');
  if (plan.groups.length > 1) {
    lines.push(
      `Sampling rates differ, so channels are written to ${plan.groups.length} files, one per rate. ` +
        `No channel is resampled.`,
    );
  }
  lines.push(
    `Would write ${plan.estimate.rows.toLocaleString('en-US')} rows, roughly ${formatBytes(plan.estimate.bytes)}.`,
  );

  return lines.join('\n');
}

/** One line per diagnostic, prefixed so warnings are greppable. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      const head = `${d.severity === 'warning' ? 'warning' : 'note'}: ${d.message}`;
      return d.hint ? `${head}\n         ${d.hint}` : head;
    })
    .join('\n');
}

export function formatSummary(result: ConvertResult): string {
  const lines: string[] = [];
  const rows: string[][] = [];
  for (const file of result.files) {
    rows.push([`  ${file.name}`, file.rows.toLocaleString('en-US'), file.name.endsWith('.csv') ? 'rows' : '']);
  }
  lines.push(`Wrote ${result.outputDir}`);
  lines.push(table(rows, new Set([1])));
  lines.push(`Done in ${(result.elapsedMs / 1000).toFixed(1)}s.`);
  return lines.join('\n');
}

export function summaryJson(result: ConvertResult): string {
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
    2,
  );
}
