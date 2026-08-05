#!/usr/bin/env node
/**
 * Command-line entry point.
 *
 * Output discipline: anything that is the *result* of a command goes to stdout
 * (`--info`'s channel table, `--json`'s summary). Progress, warnings and the
 * conversion summary go to stderr, so a conversion can be run in a pipeline without
 * its chatter contaminating the data.
 */

import { parseArgs } from 'node:util';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { EdfError } from './edf/errors.js';
import { EdfFile } from './edf/reader.js';
import { buildPlan, withoutFileRateWarning } from './convert/plan.js';
import { ConversionError, convert, defaultOutputDir } from './convert/run.js';
import { ChannelSelectionError } from './convert/channels.js';
import { TimeRangeError, parseTimeSpec } from './convert/time-range.js';
import { deriveRecordStarts } from './convert/timing.js';
import { formatDiagnostics, formatInfo, infoJson, formatSummary, printable, printableLines, summaryJson } from './cli/report.js';
import { VERSION } from './version.js';

const USAGE = `edf2csv ${VERSION}
Convert EDF, EDF+ and BDF recordings to CSV

Usage
  edf2csv <recording.edf> [more.edf ...] [options]

Options
  -i, --info             Show the recording's structure and estimated output size,
                         without converting anything
  -o, --out <dir>        Output directory (default: <recording>_csv beside the input)
  -c, --channels <list>  Only these channels, comma-separated. Use #N to pick a
                         channel by position when two share a label
      --start <time>     Begin at this offset (30s, 5m, 1h30m, 00:30:00)
      --duration <time>  Convert this much
      --end <time>       Stop at this offset (instead of --duration)
      --annotations-only Write only the EDF+ annotations, no signal data
      --decimals <n>     Fix the decimal places instead of deriving them per channel
      --checksum         Record a SHA-256 of the input in metadata.json
      --gzip             Compress every CSV, writing .csv.gz files
  -f, --force            Overwrite the output directory if it exists
  -q, --quiet            Suppress the summary; warnings and errors still print
      --json             Print machine-readable JSON to stdout (works with --info too)
      --strict           Exit 1 if the recording raised any warning
      --stdout           Write the signal CSV to stdout instead of a directory
                         (single-rate recordings only)
  -h, --help             Show this help
  -V, --version          Show the version

Several recordings
  Pass more than one and each is converted in turn. Without --out each lands
  beside itself as usual; with --out that directory becomes the parent and each
  recording gets its own inside it. A file that cannot be read is reported and
  the rest still convert, with a non-zero exit at the end.

Output
  A directory containing signals.csv, channels.csv, metadata.json, and
  annotations.csv when the recording carries EDF+ annotations. Channels recorded
  at different sampling rates are written to separate files, never resampled.
  With --gzip each CSV becomes a .csv.gz; metadata.json stays plain text so the
  directory can still be read at a glance.

Examples
  edf2csv recording.edf
  edf2csv recording.edf --info
  edf2csv recording.edf --channels "EEG Fpz-Cz,ECG" --out ./converted
  edf2csv recording.edf --start 30m --duration 5m
  edf2csv recording.edf --annotations-only
  edf2csv /data/*.edf --out ./converted
`;

/** A problem with how the command was invoked, as opposed to a problem with the file. */
class OptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionError';
  }
}

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

/**
 * Piping into a consumer that exits early (`| head -1`) closes our stdout, and the
 * next write raises EPIPE. That is normal in a shell pipeline, not an error worth a
 * stack trace, so it is swallowed while anything else still surfaces.
 */
function ignoreBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      // A reader closing early (`edf2csv ... --info | head -5`) is not a failure, so the
      // error is swallowed rather than thrown. It deliberately does NOT set an exit code:
      // forcing 0 here would erase a real failure whenever the pipe happened to close
      // after the run had already failed, reporting success for a conversion that did
      // not happen. Node exits 0 on its own when nothing sets a code.
      return;
    }
    throw error;
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  ignoreBrokenPipe(process.stdout);
  ignoreBrokenPipe(process.stderr);

  let values: Record<string, unknown>;
  let positionals: string[];

  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        info: { type: 'boolean', short: 'i' },
        out: { type: 'string', short: 'o' },
        channels: { type: 'string', short: 'c', multiple: true },
        start: { type: 'string' },
        duration: { type: 'string' },
        end: { type: 'string' },
        'annotations-only': { type: 'boolean' },
        decimals: { type: 'string' },
        checksum: { type: 'boolean' },
        gzip: { type: 'boolean' },
        force: { type: 'boolean', short: 'f' },
        quiet: { type: 'boolean', short: 'q' },
        json: { type: 'boolean' },
        strict: { type: 'boolean' },
        stdout: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'V' },
      },
    });
    values = parsed.values as Record<string, unknown>;
    positionals = parsed.positionals;
  } catch (error) {
    process.stderr.write(`${message(error)}\n\nRun edf2csv --help to see the options.\n`);
    return EXIT_USAGE;
  }

  if (values['help'] === true) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (values['version'] === true) {
    process.stdout.write(`${VERSION}\n`);
    return EXIT_OK;
  }

  if (positionals.length === 0) {
    process.stderr.write(`No input file given.\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  const inputs = positionals;
  const batch = inputs.length > 1;
  const quiet = values['quiet'] === true;
  const asJson = values['json'] === true;
  const strict = values['strict'] === true;
  const toStdout = values['stdout'] === true;

  // Both of these claim stdout. Allowing them together wrote the CSV and then the summary
  // object onto one stream, producing a document that is neither valid CSV nor valid
  // JSON — and silently, since each half looked right on its own.
  if (toStdout && asJson) {
    process.stderr.write(
      '--stdout and --json both write to stdout, so they cannot be combined.\n' +
        'Use --stdout for the CSV, or --json for the summary.\n',
    );
    return EXIT_USAGE;
  }

  // One stream holds one table, for the same reason it holds one recording: concatenating
  // them would give a CSV whose rows come from different files with nothing marking where
  // one ends. Naming the count makes it obvious a glob was the cause.
  if (toStdout && batch) {
    process.stderr.write(
      `--stdout writes a single CSV, so it cannot take ${inputs.length} recordings.\n` +
        `Convert them to directories instead, or run edf2csv once per file.\n`,
    );
    return EXIT_USAGE;
  }

  /*
    One recording prints the document it always printed; several print one per line.

    Pretty-printed objects run together are still readable by a streaming JSON parser, but
    not by anything that reads a record per line — and a batch is exactly where that is
    wanted. Emitting a batch in the single-file shape would repeat 0.2.28's mistake of
    putting two documents on one stream and leaving the caller to work out the boundary.

    null, not undefined: the serialisers default this argument to 2, and a default parameter
    takes effect for undefined, which silently gave a batch the indentation it was supposed
    to be dropping.
  */
  const jsonIndent = batch ? null : 2;

  try {
    const outOption = typeof values['out'] === 'string' ? values['out'] : undefined;
    const destinations = destinationsFor(inputs, outOption);
    assertDistinct(inputs, destinations);

    const shared = {
      channels: splitChannels(values['channels']),
      start: optionalTime(values['start'], '--start'),
      startText: typeof values['start'] === 'string' ? values['start'] : undefined,
      duration: optionalTime(values['duration'], '--duration'),
      end: optionalTime(values['end'], '--end'),
      endText: typeof values['end'] === 'string' ? values['end'] : undefined,
      decimals: optionalDecimals(values['decimals']),
      annotationsOnly: values['annotations-only'] === true,
      gzip: values['gzip'] === true,
    };

    if (values['info'] === true) {
      const failures: number[] = [];
      let warnings = 0;
      for (const [index, input] of inputs.entries()) {
        // A blank line between reports, so several tables read as one document.
        if (batch && !asJson && index > 0) process.stdout.write('\n');
        try {
          warnings += await showInfo(input as string, shared, asJson, jsonIndent);
        } catch (error) {
          failures.push(reportError(error, batch ? (input as string) : undefined));
        }
      }
      if (failures.length > 0) return worstOf(failures);
      return strict && warnings > 0 ? EXIT_ERROR : EXIT_OK;
    }

    const showProgress = !quiet && !asJson && !toStdout && process.stderr.isTTY === true;

    const failures: number[] = [];
    let warnings = 0;
    let converted = 0;

    for (const [index, input] of inputs.entries()) {
      const destination = destinations[index] as string;
      // Which recording this is, before anything it prints. Without it a batch produces a
      // stack of summaries and errors with nothing saying which file each belongs to.
      if (batch && !quiet && !asJson) {
        process.stderr.write(`[${index + 1}/${inputs.length}] ${printable(input as string)}\n`);
      }
      try {
        warnings += await convertOne(input as string, destination, {
          ...shared,
          // With one input and no --out, convert() derives the default itself, exactly as
          // it did before batches existed.
          outputDir: outOption === undefined && !batch ? undefined : destination,
          checksum: values['checksum'] === true,
          force: values['force'] === true,
          toStdout,
          quiet,
          asJson,
          showProgress,
          jsonIndent,
        });
        converted++;
      } catch (error) {
        failures.push(reportError(error, batch ? (input as string) : undefined));
        /*
          A batch keeps going. One unreadable recording among five hundred is a reason to
          report that file, not to abandon the ones already converted and refuse the rest.
          The exit code still reports the run as failed, and the closing line says how many
          of them made it, so nothing about the failure is quiet.
        */
        if (!batch) return failures[0] as number;
      }
    }

    if (batch && !quiet && !asJson) {
      process.stderr.write(
        `\nConverted ${converted} of ${inputs.length} recordings` +
          `${failures.length > 0 ? `; ${failures.length} failed` : ''}.\n`,
      );
    }

    if (failures.length > 0) return worstOf(failures);

    /*
      --strict turns any warning into a non-zero exit, for pipelines that would rather stop
      than proceed on a recording the tool had something to say about.

      The output is still written. A warning describes the recording, not a failure to
      convert it — a truncated file converts correctly for the records that are there — so
      destroying that work would be the wrong response. The exit code is the signal; what
      to do about it is the caller's decision, and they still have the files to inspect.
    */
    if (strict && warnings > 0) {
      process.stderr.write(
        `\n--strict: ${warnings} warning${warnings === 1 ? '' : 's'} raised, so this run is ` +
          `reported as a failure. The output was still written.\n`,
      );
      return EXIT_ERROR;
    }
    return EXIT_OK;
  } catch (error) {
    return reportError(error);
  }
}

/** Print one recording's `--info`, and return how many diagnostics it raised. */
async function showInfo(
  input: string,
  shared: Record<string, unknown>,
  asJson: boolean,
  jsonIndent: number | null,
): Promise<number> {
  const file = await EdfFile.open(input);
  try {
    /*
      Read the annotation channel only when the timing actually depends on it.

      --info is documented as a header-only summary that returns immediately whatever
      the file's size, but it called readAnnotations() on every EDF+/BDF+ file — a seek
      into every data record. deriveRecordStarts discards that data unless the file is
      EDF+D, where record start times are stored rather than arithmetic, so on a
      continuous recording the whole scan was thrown away. It cost 0.29 s on a 12 MB
      file and scaled with record count.

      A discontinuous file still needs the scan: without it the reported span and row
      estimate are wrong, which is a bug that has already been fixed once here.
    */
    const needsRecordStarts =
      file.header.continuity === 'EDF+D' && file.annotationSignals.length > 0;
    const annotationData = needsRecordStarts
      ? await file.readAnnotations()
      : { annotations: [], recordStarts: [], malformed: 0 };
    const timing = deriveRecordStarts(file, annotationData);
    const plan = buildPlan(
      {
        signals: file.header.signals,
        recordDuration: file.header.recordDuration,
        recordCount: file.recordCount,
        hasAnnotationChannel: file.annotationSignals.length > 0,
        recordStarts: timing.starts,
      },
      shared,
    );
    plan.diagnostics.push(...timing.diagnostics);
    process.stdout.write(
      asJson ? `${infoJson(file, plan, jsonIndent)}\n` : `${formatInfo(file, plan)}\n`,
    );

    // Under --json the warnings travel inside the document, exactly as they do for a
    // conversion, so stderr stays empty and the whole result is one parseable thing.
    const diagnostics = [...withoutFileRateWarning(file.diagnostics), ...plan.diagnostics];
    if (!asJson && diagnostics.length > 0) {
      process.stderr.write(`\n${formatDiagnostics(diagnostics)}\n`);
    }
    return diagnostics.length;
  } finally {
    await file.close();
  }
}

/** Convert one recording, and return how many diagnostics it raised. */
async function convertOne(
  input: string,
  destination: string,
  options: Record<string, unknown> & {
    quiet: boolean;
    asJson: boolean;
    showProgress: boolean;
    toStdout: boolean;
    jsonIndent: number | null;
  },
): Promise<number> {
  const { quiet, asJson, showProgress, toStdout } = options;
  let lastTick = 0;

  /*
    Interrupting a conversion leaves a CSV that stops mid-recording but is still
    perfectly well-formed, so nothing about the file itself reveals that half the
    data is missing. Saying so on the way out is the whole point of a tool that
    claims it will not go quiet when something is wrong.
  */
  const onInterrupt = (signal: NodeJS.Signals): void => {
    if (showProgress) process.stderr.write('\r\u001b[K');
    process.stderr.write(
      `\ninterrupted (${signal}): the conversion stopped part way through.\n` +
        `       Files already written to "${destination}" are incomplete and should not be used.\n`,
    );
    // 128 + signal number, the conventional exit status for dying to a signal.
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);

  try {
    const result = await convert(input, {
      ...options,
      onProgress: showProgress
        ? (progress): void => {
            const now = Date.now();
            if (now - lastTick < 100) return;
            lastTick = now;
            const percent =
              progress.recordsTotal === 0
                ? 100
                : Math.floor((progress.recordsDone / progress.recordsTotal) * 100);
            process.stderr.write(`\r  converting… ${percent}%`);
          }
        : undefined,
    });

    if (showProgress) process.stderr.write('\r\u001b[K');

    if (result.diagnostics.length > 0 && !asJson) {
      process.stderr.write(`${formatDiagnostics(result.diagnostics)}\n\n`);
    }
    if (asJson) {
      // One object per line, so a batch is JSON Lines — `jq` reads a record at a time
      // rather than waiting for the whole run to finish.
      process.stdout.write(`${summaryJson(result, options.jsonIndent as number | null)}\n`);
    } else if (!quiet) {
      // With --stdout there is no directory to summarise, and the row count is the only
      // thing worth saying — on stderr, so the CSV on stdout stays clean.
      if (toStdout) {
        const rows = result.files[0]?.rows ?? 0;
        process.stderr.write(`Wrote ${rows.toLocaleString('en-US')} rows to stdout.\n`);
      } else {
        process.stderr.write(`${formatSummary(result)}\n`);
      }
    }
    return result.diagnostics.length;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

/**
 * Where each recording's output goes.
 *
 * With one input `--out` names the output directory itself, which is what it has always
 * meant. With several it names a parent and each recording gets its own directory inside
 * it, because writing several recordings into one directory would have them overwrite each
 * other's `signals.csv` — the one thing a batch must not do quietly.
 *
 * With no `--out` at all, every recording converts beside itself exactly as it would have
 * done alone, so a glob behaves like the shell loop it replaces.
 */
function destinationsFor(inputs: readonly string[], out: string | undefined): string[] {
  if (out === undefined) return inputs.map((input) => defaultOutputDir(input));
  if (inputs.length === 1) return [out];
  return inputs.map((input) => path.join(out, stemOf(input)));
}

/** File name without its extension, keeping a leading dot: `.hidden.edf` -> `.hidden`. */
function stemOf(file: string): string {
  const base = path.basename(file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Refuse a batch in which two recordings would land in the same directory.
 *
 * Two files with the same name in different folders — `night-1/rec.edf` and
 * `night-2/rec.edf`, which is how recordings usually get organised — both resolve to
 * `<out>/rec`. Converting them in turn would leave one recording's data sitting under the
 * other's name with nothing to show it had happened, so the run stops before writing
 * anything at all.
 */
function assertDistinct(inputs: readonly string[], destinations: readonly string[]): void {
  const claimed = new Map<string, string>();
  for (const [index, destination] of destinations.entries()) {
    const key = path.resolve(destination);
    const first = claimed.get(key);
    if (first !== undefined) {
      throw new OptionError(
        `"${inputs[index]}" and "${first}" would both be converted into "${destination}", ` +
          `so one would overwrite the other.\n` +
          `Convert them separately, or rename one of them.`,
      );
    }
    claimed.set(key, inputs[index] as string);
  }
}

/**
 * The exit code for a run in which several files failed for different reasons.
 *
 * 2 means "you invoked it wrong" and 1 means "something went wrong with a file". When both
 * happened, 1 is the honest answer: the invocation cannot be the whole story once a file has
 * genuinely failed. With a single input there is only ever one code, so its exit status is
 * exactly what it always was.
 */
function worstOf(codes: readonly number[]): number {
  return codes.includes(EXIT_ERROR) ? EXIT_ERROR : EXIT_USAGE;
}

/**
 * Report an error the way this command always has, and give the exit code it implies.
 *
 * `input` names the recording while a batch is running: several failures otherwise arrive
 * as a stack of messages with nothing saying which file each belongs to.
 */
function reportError(error: unknown, input?: string): number {
  const where = input === undefined ? '' : `${printable(input)}: `;
  if (error instanceof EdfError || error instanceof ConversionError) {
    process.stderr.write(`error: ${where}${printableLines(error.message, '       ')}\n`);
    if (error.hint) process.stderr.write(`       ${error.hint}\n`);
    return EXIT_ERROR;
  }
  if (
    error instanceof ChannelSelectionError ||
    error instanceof TimeRangeError ||
    error instanceof OptionError
  ) {
    process.stderr.write(`error: ${where}${printableLines(error.message, '       ')}\n`);
    return EXIT_USAGE;
  }
  process.stderr.write(`error: ${where}${message(error, '       ')}\n`);
  return EXIT_ERROR;
}

function splitChannels(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  const terms = list.flatMap((entry) => entry.split(',')).map((t) => t.trim()).filter((t) => t !== '');
  // Returning undefined here would mean "no --channels given" and convert everything,
  // which is the opposite of what someone passing an empty list is asking for.
  if (terms.length === 0) {
    throw new OptionError('--channels was given but lists no channel names.');
  }
  return terms;
}

function optionalTime(raw: unknown, option: string): number | undefined {
  if (raw === undefined) return undefined;
  return parseTimeSpec(String(raw), option);
}

function optionalDecimals(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  // Number('') is 0, which would quietly round every physical value to a whole number.
  if (text === '') {
    throw new OptionError('--decimals needs a number, for example --decimals 3.');
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new OptionError(`--decimals must be a whole number between 0 and 20, got "${String(raw)}".`);
  }
  return value;
}

/*
  Error text is escaped for the same reason --info's table is: a fatal header error quotes
  the channel label that caused it, and that label is free text out of the file. A recording
  declaring a negative sample count under a label containing `\x1b[2J` cleared the reader's
  screen on the way out.
*/
function message(error: unknown, indent = ''): string {
  // The indent lines continuation up under an "error: " prefix. Usage problems print without
  // one, alongside the usage text, so they pass nothing and stay flush left.
  return printableLines(error instanceof Error ? error.message : String(error), indent);
}

export { defaultOutputDir };

/**
 * Whether this file was executed rather than imported.
 *
 * npm installs a bin as a symlink (node_modules/.bin/edf2csv -> ../edf2csv/dist/cli.js),
 * and that is the path `npx` runs. In that case process.argv[1] is the symlink while
 * import.meta.url is already resolved to the real file, so comparing the two directly
 * reports "imported" and the command silently does nothing. Both sides are resolved
 * through realpath before comparing.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // An unreadable or deleted entry path is not a reason to refuse to run.
    return pathToFileURL(entry).href === import.meta.url;
  }
}

const invokedDirectly = isMainModule();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`error: ${message(error)}\n`);
      process.exitCode = EXIT_ERROR;
    });
}
