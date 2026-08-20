/**
 * Human-readable output for the terminal.
 *
 * Everything here is plain text with no colour codes, so piping to a file or a log
 * produces exactly what appeared on screen.
 */

import type { Diagnostic } from '../edf/errors.js';
import type { EdfFile } from '../edf/reader.js';
import { describeFormat, formatRates, formatWallClock } from '../edf/header.js';
import { fixed, formatBytes, formatDuration } from '../format/number.js';
import { counted } from '../format/list.js';
import type { ConversionPlan } from '../convert/plan.js';
import { withoutFileRateWarning } from '../convert/plan.js';
import type { ConvertResult } from '../convert/run.js';
import { VERSION } from '../version.js';

/** Where terminal prose wraps. The width --help is written to, and the ANSI default. */
const WRAP_COLUMNS = 80;

/** The continuation indent under a `warning: ` / `note: ` prefix. */
const HINT_INDENT = ' '.repeat(9);

/**
 * Greedy word wrap, `indent` on every line including the first.
 *
 * Only free prose goes through this. The aligned parts of `--info` — the `Format`/`Size`
 * key-value lines and the channel table — are laid out in columns, and re-flowing a column
 * is how you turn a table into a paragraph.
 *
 * A word wider than the column is left to overrun rather than broken. The long words here
 * are file paths and quoted channel labels, and neither survives being split across lines:
 * the point of printing a path is that it can be copied back out.
 */
export function wrap(text: string, indent = '', width = WRAP_COLUMNS): string {
  const lines: string[] = [];
  let line = indent;
  for (const word of text.split(/\s+/u)) {
    if (word === '') continue;
    if (line === indent) line += word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = indent + word;
    }
  }
  if (line !== indent) lines.push(line);
  return lines.join('\n');
}

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
  // The control characters are what this function is for, not an oversight in it.
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
    .map((line, index) => {
      const safe = printable(line);
      // The first line is the one that follows `error: ` or `warning: `, so it is the line
      // a log gets grepped for, and it stays whole at whatever width it runs to.
      if (index === 0) return safe;

      /*
        Callers write the continuation indent one of two ways: most pass it here and leave
        their message lines flush, but the two usage builders bake `       ` into the string
        itself because they are printed without an `error: ` prefix in front. Reading the
        line's own leading space when none was passed keeps both working, and keeps the
        wrap aligned under the same column either way.
      */
      const body = safe.trimStart();
      const pad = indent === '' ? safe.slice(0, safe.length - body.length) : indent;

      /*
        A continuation that is a command is copied, not read.

        `edf2csv -- "--chanels"` is the line the unknown-option error ends on, and it exists
        to be pasted back into the shell. Wrapping puts `edf2csv --` on one line and the
        flag on the next, and what gets pasted is half a command. Prose survives being
        re-flowed and a command does not, so the two are told apart rather than being
        treated alike and hoping today's strings stay short.
      */
      if (body.startsWith('edf2csv ')) return pad + body;
      return wrap(body, pad);
    })
    .join('\n');
}

/** The `--info` view: what is in this recording, and what would converting it produce. */
export function formatInfo(
  file: EdfFile,
  plan: ConversionPlan,
  /**
   * How many events a conversion would write, when that is already known.
   *
   * Null when it is not. `--info` reads the whole annotation channel of a discontinuous file,
   * because that is where its record times are; a continuous one it reads only far enough to
   * find the origin. So the count is in hand for one of the two, and the line below said "How
   * many events there are cannot be told from the header" for both — true of the header, and
   * beside the point on a file whose events had just been read and counted.
   */
  events: number | null = null,
): string {
  const { header } = file;
  const lines: string[] = [];

  /*
    Escaped, like every other value that came out of the filesystem.

    A path is untrusted text: a folder may be named with an ESC byte, and a file name may
    hold a newline on every platform this runs on. The `[n/m]` header a batch prints has
    always escaped it and these two lines did not, so one line of a run reached the terminal
    as `study/esc\x1b[31mred.edf` and the next as a live colour change — and a name holding a
    newline split `Wrote` across two lines, so the summary reported a path that reads as two.
    NONPRINTABLE_LABEL exists because a header field can carry these bytes; a directory entry
    can carry them just as easily.
  */
  lines.push(`File       ${printable(file.path)}`);
  lines.push(`Format     ${describeFormat(header)}`);
  lines.push(
    `Recorded   ${
      formatWallClock(header.startDateTime)?.replace('T', ' ') ??
      `${printable(header.startDateRaw)} ${printable(header.startTimeRaw)} (unparseable)`
    }`,
  );
  lines.push(
    `Duration   ${formatDuration(file.durationSeconds)}  (${counted(file.recordCount, 'record')} of ${header.recordDuration}s)`,
  );
  const elapsedSpan = plan.range.recordingEndSeconds - plan.range.recordingStartSeconds;
  if (Math.abs(elapsedSpan - file.durationSeconds) > 1e-9) {
    /*
      Which way the two differ decides what to call it, and the parenthetical used to say
      "includes discontinuities" both ways round.

      A span LONGER than the duration is the gap case this line was written for: 3 records of
      1s covering 11 seconds. A span SHORTER than the duration cannot be a gap — it is records
      that overlap, which an EDF+D file gets when a device re-sends a buffer. Three records of
      1s starting at 0, 0.5 and 1 print:

          Duration   3s  (3 records of 1s)
          Time span  2s  (includes discontinuities)

      A recording covering less time than its own records account for, blamed on gaps it does
      not have — while the warning below it says, correctly, that two records overlap.

      A file holding both is described by whichever wins the subtraction, and the overlap
      warning is printed either way.
    */
    const overlapping = elapsedSpan < file.durationSeconds;
    lines.push(
      `Time span  ${formatDuration(elapsedSpan)}  ` +
        `(${overlapping ? 'records overlap in time' : 'includes discontinuities'})`,
    );
  }
  /*
    Where the samples begin, when that is not zero.

    0.4.9 made the first record's timekeeping TAL the point a recording is timed from, so a
    file whose TALs start at +1000 writes `time_s` from 1000.000 and takes `--start` and
    `--end` on that same clock. None of that appeared here: the report said "Duration 3s",
    which reads as 0 to 3, and `--start 0 --end 1` then selected nothing and answered with
    "The window is inside the recording but lands where there is no data ... Run with --info
    to see where the records actually sit" — pointing at this report, which was the one place
    the number was missing. It is in `plan.range` already and governs the estimate printed
    below; it was simply never shown.
  */
  const startsAt = plan.range.recordingStartSeconds;
  if (Number.isFinite(startsAt) && Math.abs(startsAt) > 1e-9) {
    // In seconds rather than through formatDuration, because this number is meant to be
    // typed back in: `--start` takes `1000s`, and "16m 40s" is not something it accepts.
    // It is also how the empty-window warning renders the window it was given.
    //
    // Through `fixed` rather than `toFixed`, which switches to exponent notation at 1e21 —
    // and `--start 1e+21s` is refused by the time parser with "uses an unknown unit \"e\"",
    // so the one line that says which clock to use handed back a number that clock rejects.
    // Reachable from a conforming file: an EDF+ onset is plain digits of any length, and a
    // record duration large enough to keep samples apart at that magnitude is four
    // characters. `fixed` expands these with BigInt, which is exact past 2^53 where a double
    // carries no fraction anyway, and is byte-for-byte `toFixed` everywhere else.
    lines.push(
      `Timed from ${fixed(startsAt, 3)}s  (first sample; --start and --end use this clock)`,
    );
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
  /*
    From here down --info stops laying out columns and starts explaining itself, so from
    here down it wraps. The key-value lines and the channel table above are aligned to each
    other and must not be re-flowed; these are sentences, and the longest of them ran to 156
    columns — which is not a line anyone reads, it is a line a terminal breaks somewhere.
    --help has been written to 80 since it existed and hints joined it in 0.7.1; --info is
    the mode whose whole purpose is being read by a person, and it was the last one guessing.
  */
  if (plan.groups.length > 1) {
    lines.push(
      wrap(
        plan.layout === 'long'
          ? `Sampling rates differ, and the long layout puts them in one table anyway: each row ` +
            `carries its own time, so nothing has to line up. No channel is resampled.`
          : `Sampling rates differ, so channels are written to ${counted(plan.groups.length, 'file')}, one per rate. ` +
            `No channel is resampled.`,
      ),
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
      wrap(
        file.annotationSignals.length > 0
          ? events === null
            ? `Would write annotations${suffix} and channels${suffix}, and no signal data. How ` +
              'many events there are cannot be told from the header, and finding out means ' +
              'reading the annotation channel record by record.'
            : `Would write annotations${suffix} with ${counted(events, 'event')} and ` +
              `channels${suffix}, and no signal data.`
          : `Would write channels${suffix} and no signal data — and no annotations${suffix} ` +
            'either, since this recording has no annotation channel.',
      ),
    );
    return lines.join('\n');
  }

  // The estimate counts the characters of the CSV, which is what --gzip then compresses.
  // Reporting it as the size on disk would overstate a compressed conversion several-fold.
  const compressing = plan.gzip;
  lines.push(
    wrap(
      // A window narrow enough to select one sample is an ordinary thing to ask for, and this
      // read "Would write 1 rows, roughly 22 B." — the slip 0.5.74 fixed on the lines above it
      // and missed here, because the recording that test builds never estimates exactly one.
      `Would write ${plan.estimate.rows.toLocaleString('en-US')} ` +
        `${plan.estimate.rows === 1 ? 'row' : 'rows'}, roughly ` +
        `${formatBytes(plan.estimate.bytes)}${compressing ? ' before compression' : ''}.`,
    ),
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
      tool: TOOL,
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
      // Where `time_s` begins, and the clock `--start` and `--end` are read against. Usually
      // zero; not when the first record's timekeeping TAL puts the recording elsewhere. Both
      // of the fields above are lengths and neither says where that length sits.
      first_sample_seconds: plan.range.recordingStartSeconds,
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
      /*
        Null rather than zero when the run writes no signal table.

        The text form has refused to say "Would write 0 rows, roughly 0 B." since 0.4.51,
        because a run that goes on to write an annotations.csv with events in it has not
        written nothing — and it is `--annotations-only`, or a recording holding only
        annotations, that reaches this. The JSON went on saying it to the surface a script
        reads. There is no estimate for a table that does not exist, and null is how this
        document already says that.
      */
      estimate:
        plan.writeSignals && plan.groups.length > 0
          ? {
              rows: plan.estimate.rows,
              // Character count of the CSV. With --gzip the file on disk is smaller than this.
              bytes: plan.estimate.bytes,
              exceeds_spreadsheet_limit: plan.estimate.exceedsSpreadsheetLimit,
            }
          : { rows: null, bytes: null, exceeds_spreadsheet_limit: false },
      // The plan's mixed-rate warning replaces the header parser's, as it does everywhere
      // else. This was the one consumer left out of that when 0.3.2 made the warning follow
      // --channels, so `--info --json` carried it twice: once counting the rates being
      // converted and once counting every rate in the file, with the same code and severity.
      // The file's own first, then the plan's, which is the order the text form prints them
      // in. Concatenating the other way round listed the same warnings about the same
      // recording in two different sequences depending on which form you asked for.
      warnings: withoutFileRateWarning(file.diagnostics)
        .concat(plan.diagnostics)
        .map((d) => ({ code: d.code, severity: d.severity, message: d.message })),
    },
    null,
    indent ?? undefined,
  );
}

/**
 * One diagnostic per `warning: ` line, prefixed so warnings are greppable; the hint below it
 * wrapped to the terminal.
 *
 * The hint has been on its own unprefixed continuation line since these gained hints at all,
 * so grepping for `warning:` never picked it up and wrapping it costs nothing that was being
 * relied on — which is what 0.6.132 got wrong when it left every diagnostic long on the
 * grounds that they are one line each. Half of that is true. The `warning:` head is a line
 * per diagnostic and stays one, at whatever width the message runs to; the hint underneath
 * it is prose addressed to a person reading a terminal, and 17 of them ran past 80 columns,
 * the widest to 180. At that width the second half of the advice is wherever the terminal
 * decided to put it, indented under nothing, and the 9-space rule that says "this belongs to
 * the warning above" is lost at exactly the moment there is enough text for it to matter.
 */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((d) => {
      // Diagnostics quote channel labels, which come from the file, so they need the
      // same treatment as the --info table.
      const head = `${d.severity === 'warning' ? 'warning' : 'note'}: ${printable(d.message)}`;
      return d.hint ? `${head}\n${wrap(printable(d.hint), HINT_INDENT)}` : head;
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
      // Singular at one, like every other count this prints: a one-row table is what a
      // narrow window produces, and "1 rows" is the same slip 0.5.74 fixed elsewhere.
      /\.csv(\.gz)?$/u.test(file.name) ? (file.rows === 1 ? 'row' : 'rows') : '',
    ]);
  }
  lines.push(`Wrote ${printable(result.outputDir)}`);  // Escaped; see the File line above.
  lines.push(table(rows, new Set([1])));
  lines.push(`Done in ${(result.elapsedMs / 1000).toFixed(1)}s.`);
  return lines.join('\n');
}

/**
 * Which version produced this record.
 *
 * `metadata.json` has carried it since the file existed, because a conversion should be
 * reproducible later. The two JSON *streams* did not, and they are the ones most likely to
 * outlive the run: `--json` exists to be piped into something, logged, or committed beside a
 * result, where the question a year on is which release's field names and rounding these are.
 * The same shape as metadata.json's, so a consumer reads one field either way.
 */
const TOOL = { name: 'edf2csv', version: VERSION } as const;

export function summaryJson(result: ConvertResult, indent: number | null = 2): string {
  return JSON.stringify(
    {
      tool: TOOL,
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
