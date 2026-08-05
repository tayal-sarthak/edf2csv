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
import process from 'node:process';

import { EdfError } from './edf/errors.js';
import { EdfFile } from './edf/reader.js';
import { buildPlan } from './convert/plan.js';
import { ConversionError, convert, defaultOutputDir } from './convert/run.js';
import { ChannelSelectionError } from './convert/channels.js';
import { TimeRangeError, parseTimeSpec } from './convert/time-range.js';
import { deriveRecordStarts } from './convert/timing.js';
import { formatDiagnostics, formatInfo, formatSummary, summaryJson } from './cli/report.js';
import { VERSION } from './version.js';

const USAGE = `edf2csv ${VERSION}
Convert EDF, EDF+ and BDF recordings to CSV

Usage
  edf2csv <recording.edf> [options]

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
  -f, --force            Overwrite the output directory if it exists
  -q, --quiet            Suppress the summary; warnings and errors still print
      --json             Print a machine-readable summary to stdout
  -h, --help             Show this help
  -V, --version          Show the version

Output
  A directory containing signals.csv, channels.csv, metadata.json, and
  annotations.csv when the recording carries EDF+ annotations. Channels recorded
  at different sampling rates are written to separate files, never resampled.

Examples
  edf2csv recording.edf
  edf2csv recording.edf --info
  edf2csv recording.edf --channels "EEG Fpz-Cz,ECG" --out ./converted
  edf2csv recording.edf --start 30m --duration 5m
  edf2csv recording.edf --annotations-only
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
        force: { type: 'boolean', short: 'f' },
        quiet: { type: 'boolean', short: 'q' },
        json: { type: 'boolean' },
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
  if (positionals.length > 1) {
    process.stderr.write(
      `Expected one input file but got ${positionals.length}: ${positionals.join(', ')}\n` +
        `Convert them one at a time, or use a shell loop.\n`,
    );
    return EXIT_USAGE;
  }

  const input = positionals[0] as string;
  const quiet = values['quiet'] === true;
  const asJson = values['json'] === true;

  try {
    const channels = splitChannels(values['channels']);
    const start = optionalTime(values['start'], '--start');
    const duration = optionalTime(values['duration'], '--duration');
    const end = optionalTime(values['end'], '--end');
    const decimals = optionalDecimals(values['decimals']);

    if (values['info'] === true) {
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
          {
            channels,
            start,
            duration,
            end,
            decimals,
            annotationsOnly: values['annotations-only'] === true,
          },
        );
        plan.diagnostics.push(...timing.diagnostics);
        process.stdout.write(`${formatInfo(file, plan)}\n`);
        const diagnostics = [...file.diagnostics, ...plan.diagnostics];
        if (diagnostics.length > 0) {
          process.stderr.write(`\n${formatDiagnostics(diagnostics)}\n`);
        }
      } finally {
        await file.close();
      }
      return EXIT_OK;
    }

    const showProgress = !quiet && !asJson && process.stderr.isTTY === true;
    let lastTick = 0;

    const destination =
      typeof values['out'] === 'string' ? values['out'] : defaultOutputDir(input);

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

    const result = await convert(input, {
      outputDir: typeof values['out'] === 'string' ? values['out'] : undefined,
      channels,
      start,
      duration,
      end,
      decimals,
      annotationsOnly: values['annotations-only'] === true,
      checksum: values['checksum'] === true,
      force: values['force'] === true,
      onProgress: showProgress
        ? (progress): void => {
            const now = Date.now();
            if (now - lastTick < 100) return;
            lastTick = now;
            const percent = progress.recordsTotal === 0 ? 100 : Math.floor((progress.recordsDone / progress.recordsTotal) * 100);
            process.stderr.write(`\r  converting… ${percent}%`);
          }
        : undefined,
    });

    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);

    if (showProgress) process.stderr.write('\r\u001b[K');

    if (result.diagnostics.length > 0 && !asJson) {
      process.stderr.write(`${formatDiagnostics(result.diagnostics)}\n\n`);
    }
    if (asJson) {
      process.stdout.write(`${summaryJson(result)}\n`);
    } else if (!quiet) {
      process.stderr.write(`${formatSummary(result)}\n`);
    }
    return EXIT_OK;
  } catch (error) {
    if (error instanceof EdfError || error instanceof ConversionError) {
      process.stderr.write(`error: ${error.message}\n`);
      if (error.hint) process.stderr.write(`       ${error.hint}\n`);
      return EXIT_ERROR;
    }
    if (
      error instanceof ChannelSelectionError ||
      error instanceof TimeRangeError ||
      error instanceof OptionError
    ) {
      process.stderr.write(`error: ${error.message}\n`);
      return EXIT_USAGE;
    }
    process.stderr.write(`error: ${message(error)}\n`);
    return EXIT_ERROR;
  }
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
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new OptionError(`--decimals must be a whole number between 0 and 15, got "${String(raw)}".`);
  }
  return value;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
