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
import { readdir, realpath, stat } from 'node:fs/promises';
import { cpus } from 'node:os';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
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
import { listed } from './format/list.js';
import { VERSION } from './version.js';

const USAGE = `edf2csv ${VERSION}
Convert EDF, EDF+ and BDF recordings to CSV

Usage
  edf2csv <recording.edf | folder> [more ...] [options]

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
  -j, --jobs <n>         Convert this many recordings at once, or "auto" (default: 1)
  -f, --force            Overwrite the output directory if it exists
  -q, --quiet            Suppress the summary; warnings and errors still print
      --json             Print machine-readable JSON to stdout (works with --info too)
      --strict           Exit 1 if the recording raised any warning
      --stdout           Write the signal CSV to stdout instead of a directory
                         (single-rate recordings only)
  -h, --help             Show this help
  -V, --version          Show the version

Several recordings
  A folder is expanded to every .edf and .bdf inside it, at any depth, and the
  layout is kept: recordings in sub-folders come out in sub-folders.
  Pass more than one and each is converted in turn. Without --out each lands
  beside itself as usual; with --out that directory becomes the parent and each
  recording gets its own inside it. A file that cannot be read is reported and
  the rest still convert, with a non-zero exit at the end. --jobs converts
  several at once, which is worth it for a folder of them.

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
  edf2csv /data/*.edf --out ./converted --jobs auto
  edf2csv /data/study --out ./converted --jobs auto
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
        jobs: { type: 'string', short: 'j' },
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

  let expanded: Input[];
  try {
    expanded = await expandInputs(positionals);
  } catch (error) {
    return reportError(error);
  }
  if (expanded.length === 0) {
    process.stderr.write(
      `No EDF or BDF recordings found in ${listed(positionals.map((p) => `"${p}"`))}.\n`,
    );
    return EXIT_USAGE;
  }
  const inputs = expanded.map((entry) => entry.path);
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
    const destinations = destinationsFor(expanded, outOption);
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

    // Validated before the --info branch, not inside the conversion path: a flag that
    // cannot be honoured is a usage error whatever mode it was given in, and accepting
    // "--jobs 0" in silence under --info is the kind of quiet that this tool avoids.
    const jobs = toStdout ? 1 : parseJobs(values['jobs'], inputs.length);

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

    // The meter redraws one line in place, which two conversions cannot share. Running them
    // at once replaces it with the completion count each file prints as it lands.
    const showProgress =
      !quiet && !asJson && !toStdout && jobs === 1 && process.stderr.isTTY === true;

    const failures: number[] = [];
    let warnings = 0;
    let converted = 0;

    /** Convert input `index`, sending its output wherever the caller wants it. */
    const runOne = async (index: number, emit: Emit): Promise<void> => {
      const input = inputs[index] as string;
      const destination = destinations[index] as string;
      // Which recording this is, before anything it prints. Without it a batch produces a
      // stack of summaries and errors with nothing saying which file each belongs to.
      if (batch && !quiet && !asJson) {
        emit('err', `[${index + 1}/${inputs.length}] ${printable(input)}\n`);
      }
      try {
        warnings += await convertOne(
          input,
          destination,
          {
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
          },
          emit,
        );
        converted++;
      } catch (error) {
        /*
          A batch keeps going. One unreadable recording among five hundred is a reason to
          report that file, not to abandon the ones already converted and refuse the rest.
          The exit code still reports the run as failed, and the closing line says how many
          of them made it, so nothing about the failure is quiet.
        */
        failures.push(reportError(error, batch ? input : undefined, emit));
      }
    };

    if (jobs === 1) {
      for (let index = 0; index < inputs.length; index++) {
        await runOne(index, writeThrough);
        // A single recording keeps the exit code it has always had rather than the batch's.
        if (!batch && failures.length > 0) return failures[0] as number;
      }
    } else {
      /*
        Real processes, not concurrent promises.

        Converting is almost entirely arithmetic and string building — 1.17 s of CPU for
        1.24 s of wall clock on a 168 MB conversion — and Node runs that on one thread. An
        in-process pool was tried first and gained 6% on eight recordings, which is the
        overlap in the file reads and nothing else. Each conversion is already a whole
        command, so each one gets its own process, which is what `xargs -P` would do by hand.

        Workers take the next recording as they free up rather than splitting the list into
        equal shares. Recordings in a folder differ wildly in length, and a fixed split
        leaves every worker but one idle behind the longest file.

        Each child's output is held until it exits, so two finishing together cannot
        interleave one's summary with the other's warnings.
      */
      const running = new Map<ChildProcess, string>();

      /*
        Ctrl-C in a terminal reaches every process in the group, so the children would stop
        anyway; a signal sent to this process alone does not, and that is how a batch gets
        run from a script or a CI job. Interrupting one left four conversions writing
        gigabytes into a directory their owner believed abandoned, and the last thing on
        screen was a successful "Done in 1.6s" from whichever recording had just landed —
        the run read as if it had finished.
      */
      const onInterrupt = (signal: NodeJS.Signals): void => {
        const abandoned = [...running.values()];
        for (const child of running.keys()) child.kill('SIGTERM');
        process.stderr.write(
          `\ninterrupted (${signal}): ${abandoned.length} conversion` +
            `${abandoned.length === 1 ? '' : 's'} stopped part way through.\n` +
            (abandoned.length > 0
              ? `       Incomplete, and should not be used: ${listed(abandoned)}\n`
              : ''),
        );
        process.exit(signal === 'SIGINT' ? 130 : 143);
      };
      process.once('SIGINT', onInterrupt);
      process.once('SIGTERM', onInterrupt);

      let next = 0;
      const worker = async (): Promise<void> => {
        for (let index = next++; index < inputs.length; index = next++) {
          const input = inputs[index] as string;
          const sink = buffered();
          if (!quiet && !asJson) {
            sink.emit('err', `[${index + 1}/${inputs.length}] ${printable(input)}\n`);
          }
          const child = await convertInChild(
            input,
            destinations[index] as string,
            values,
            running,
          );
          if (child.code === 0) converted++;
          else failures.push(child.code);
          // The child saw one recording, so it printed the indented document a single
          // conversion prints. A batch is one object per line.
          sink.emit('out', asJson ? compactJson(child.out) : child.out);
          // The child converted a single recording, so it named no file in its errors the
          // way a batch does. Naming it here keeps the two paths identical to a reader and
          // to anything grepping a log, where the [n/m] header may not be alongside.
          sink.emit('err', named(child.err, input));
          sink.flush();
        }
      };
      try {
        await Promise.all(Array.from({ length: jobs }, () => worker()));
      } finally {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
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
  emit: Emit = writeThrough,
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
      emit('err', `${formatDiagnostics(result.diagnostics)}\n\n`);
    }
    if (asJson) {
      // One object per line, so a batch is JSON Lines — `jq` reads a record at a time
      // rather than waiting for the whole run to finish.
      emit('out', `${summaryJson(result, options.jsonIndent as number | null)}\n`);
    } else if (!quiet) {
      // With --stdout there is no directory to summarise, and the row count is the only
      // thing worth saying — on stderr, so the CSV on stdout stays clean.
      if (toStdout) {
        const rows = result.files[0]?.rows ?? 0;
        emit('err', `Wrote ${rows.toLocaleString('en-US')} rows to stdout.\n`);
      } else {
        emit('err', `${formatSummary(result)}\n`);
      }
    }
    return result.diagnostics.length;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}

/** A recording to convert, and the path its output should be named after. */
interface Input {
  /** Where the recording is. */
  path: string;
  /**
   * What to call its output, relative to `--out`.
   *
   * For a file named on the command line this is just its own name. For one found by
   * expanding a directory it keeps the position it had inside that directory, so a study
   * laid out as one folder per night comes out the same shape — and, more to the point, so
   * that fifty recordings all named `rec.edf` do not all claim `<out>/rec`.
   */
  name: string;
}

/**
 * Recordings to convert, with directories expanded to what is inside them.
 *
 * A directory yields every `.edf` and `.bdf` beneath it, at any depth. Recordings arrive
 * organised into folders, and a shell has no tidy way to reach them — which is why the
 * recipes here carried a `find` incantation to do it. Passing the folder is the obvious
 * thing to try, and it used to fail with "is a directory, not an EDF file".
 */
async function expandInputs(positionals: readonly string[]): Promise<Input[]> {
  const found: Input[] = [];
  for (const given of positionals) {
    const info = await stat(given).catch(() => null);
    if (info === null || !info.isDirectory()) {
      // Anything that is not a directory is passed through untouched, so a file that does
      // not exist still reports itself rather than vanishing from the list.
      found.push({ path: given, name: path.basename(given) });
      continue;
    }
    for (const file of await walk(given)) {
      found.push({ path: file, name: path.relative(given, file) });
    }
  }
  /*
    One recording, however many ways it was named.

    The walk already does this for links inside a folder, and the two halves disagreed:
    `edf2csv study` converted a recording reached twice once, while `edf2csv a.edf a.edf`
    refused the whole run for the collision it would cause. A shell makes the second easy
    to produce by accident — `edf2csv *.edf recording.edf` — and there is nothing ambiguous
    about it: it is one recording, and converting it once is what was meant.

    A path that does not resolve keeps its own identity so that a file which is not there
    still reports itself rather than being folded into another entry.
  */
  const byIdentity = new Map<string, Input>();
  for (const entry of found) {
    const identity = await realpath(entry.path).catch(() => `?${path.resolve(entry.path)}`);
    if (!byIdentity.has(identity)) byIdentity.set(identity, entry);
  }

  // A directory hands its entries back in whatever order the filesystem stored them.
  const unique = [...byIdentity.values()];
  unique.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return unique;
}

/**
 * Every recording under a directory, following symbolic links.
 *
 * Written by hand rather than with a recursive `readdir` because that reports a symlink as
 * a symlink and never as a file, so a linked recording was skipped without a word — and the
 * closing "converted 3 of 3" then described the three it had noticed rather than what was in
 * the folder. Data organised by linking recordings into a working directory is ordinary, and
 * quietly converting fewer files than were asked for is the failure this tool exists to
 * avoid. Naming the same link on the command line always worked, which made the omission
 * harder to notice rather than easier.
 *
 * Following links means they can form a cycle, so directories are recorded by their resolved
 * identity and visited once. A link to a file already reached another way is likewise
 * converted once.
 */
async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const seen = new Set<string>();
  const queue = [root];

  while (queue.length > 0) {
    const directory = queue.pop() as string;
    const real = await realpath(directory).catch(() => directory);
    if (seen.has(real)) continue;
    seen.add(real);

    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      // stat, not the dirent: a dirent describes the link, and what matters is its target.
      const info = await stat(full).catch(() => null);
      if (info === null) continue;
      if (info.isDirectory()) {
        queue.push(full);
      } else if (info.isFile() && /\.(edf|bdf)$/iu.test(entry.name)) {
        // Duplicates are collapsed once for the whole list in expandInputs; this only has
        // to find them. The `seen` set here is for directory cycles.
        files.push(full);
      }
    }
  }
  return files;
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
function destinationsFor(inputs: readonly Input[], out: string | undefined): string[] {
  if (out === undefined) return inputs.map((input) => defaultOutputDir(input.path));
  if (inputs.length === 1) return [out];
  return inputs.map((input) => path.join(out, stemOf(input.name)));
}

/** A name without its extension, keeping a leading dot: `.hidden.edf` -> `.hidden`. */
function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  return dot > slash + 1 ? name.slice(0, dot) : name;
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
 * Convert one recording in a separate process, and collect everything it printed.
 *
 * The arguments are rebuilt from the parsed options rather than sliced out of argv, so the
 * child receives exactly the flags this run was given and nothing that only makes sense to
 * the parent: not the other recordings, not --jobs, and not --info or --stdout, neither of
 * which reaches this path.
 */
async function convertInChild(
  input: string,
  destination: string,
  values: Record<string, unknown>,
  running: Map<ChildProcess, string>,
): Promise<{ code: number; out: string; err: string }> {
  const args = [input, '--out', destination];
  for (const flag of ['annotations-only', 'checksum', 'gzip', 'force', 'quiet', 'json', 'strict']) {
    if (values[flag] === true) args.push(`--${flag}`);
  }
  for (const flag of ['start', 'duration', 'end', 'decimals']) {
    if (typeof values[flag] === 'string') args.push(`--${flag}`, values[flag] as string);
  }
  // --channels is repeatable, and each term is passed as given so that a label containing a
  // comma survives: joining them back into one list would split it in the child.
  const channels = values['channels'];
  if (channels !== undefined) {
    for (const term of Array.isArray(channels) ? (channels as string[]) : [String(channels)]) {
      args.push('--channels', term);
    }
  }

  return new Promise((resolve) => {
    const child = fork(fileURLToPath(import.meta.url), args, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    running.set(child, destination);
    let out = '';
    let err = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      err += chunk;
    });
    child.on('error', (error) => {
      running.delete(child);
      resolve({ code: EXIT_ERROR, out, err: `${err}error: ${input}: ${error.message}\n` });
    });
    child.on('close', (code) => {
      running.delete(child);
      resolve({ code: code ?? EXIT_ERROR, out, err });
    });
  });
}

/** Put the recording's name into the error lines a child produced. */
function named(text: string, input: string): string {
  return text.replace(/^error: /gmu, `error: ${printable(input)}: `);
}

/** Re-render a child's pretty-printed summary onto one line, leaving anything else alone. */
function compactJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  try {
    return `${JSON.stringify(JSON.parse(trimmed))}\n`;
  } catch {
    // Not the document expected; passing it through unchanged beats losing it.
    return text;
  }
}

/**
 * Where a conversion's output goes.
 *
 * Serial runs write straight through, which is what they have always done. Running several
 * conversions at once needs the alternative: each one's lines are collected and released in
 * a block when it finishes, so two recordings finishing together cannot interleave a summary
 * with a warning belonging to the other file.
 */
type Emit = (stream: 'out' | 'err', text: string) => void;

const writeThrough: Emit = (stream, text) => {
  (stream === 'out' ? process.stdout : process.stderr).write(text);
};

/** Collects output so it can be released in one piece when a conversion finishes. */
function buffered(): { emit: Emit; flush: () => void } {
  const parts: [('out' | 'err'), string][] = [];
  return {
    emit: (stream, text) => parts.push([stream, text]),
    flush: () => {
      for (const [stream, text] of parts) writeThrough(stream, text);
    },
  };
}

/**
 * Report an error the way this command always has, and give the exit code it implies.
 *
 * `input` names the recording while a batch is running: several failures otherwise arrive
 * as a stack of messages with nothing saying which file each belongs to.
 */
function reportError(error: unknown, input?: string, emit: Emit = writeThrough): number {
  const where = input === undefined ? '' : `${printable(input)}: `;
  if (error instanceof EdfError || error instanceof ConversionError) {
    emit('err', `error: ${where}${printableLines(error.message, '       ')}\n`);
    if (error.hint) emit('err', `       ${error.hint}\n`);
    return EXIT_ERROR;
  }
  if (
    error instanceof ChannelSelectionError ||
    error instanceof TimeRangeError ||
    error instanceof OptionError
  ) {
    emit('err', `error: ${where}${printableLines(error.message, '       ')}\n`);
    return EXIT_USAGE;
  }
  emit('err', `error: ${where}${message(error, '       ')}\n`);
  return EXIT_ERROR;
}

/**
 * How many conversions to run at once.
 *
 * `auto` is one per core, less one, so a long batch does not take the machine over. A batch
 * is the only place this means anything: a single recording is a single conversion however
 * many jobs are asked for.
 */
function parseJobs(raw: unknown, inputs: number): number {
  if (raw === undefined) return 1;
  const text = String(raw).trim();
  if (text === 'auto') return Math.max(1, Math.min(inputs, cpus().length - 1));
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) {
    throw new OptionError(`--jobs must be a whole number of 1 or more, or "auto", got "${text}".`);
  }
  return Math.min(value, Math.max(1, inputs));
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
