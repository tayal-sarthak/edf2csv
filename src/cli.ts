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
import { existsSync, realpathSync } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { cpus } from 'node:os';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import { EdfError } from './edf/errors.js';
import { EdfFile } from './edf/reader.js';
import { buildPlan, withoutFileRateWarning } from './convert/plan.js';
import {
  ConversionError,
  USAGE_ERROR_CODES,
  auditStdout,
  convert,
  defaultOutputDir,
  durationDiagnostics,
  stdoutRefusal,
} from './convert/run.js';
import { ChannelSelectionError } from './convert/channels.js';
// Shared with the library so a bad option is the same error whichever way it arrived.
import { OptionError } from './convert/options.js';
import { TimeRangeError, parseTimeSpec } from './convert/time-range.js';
import { deriveRecordStarts } from './convert/timing.js';
import { formatDiagnostics, formatInfo, infoJson, formatSummary, printable, printableLines, summaryJson } from './cli/report.js';
import { counted, listed } from './format/list.js';
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
      --layout <kind>    wide (default): one column per channel, one file per
                         sampling rate. long: one file of time_s,channel,value,
                         every rate together, one row per sample
      --gzip             Compress every CSV, writing .csv.gz files
      --bom              Start each CSV with a UTF-8 byte order mark, so Excel
                         reads accented text and units like µV correctly
  -j, --jobs <n>         Convert this many recordings at once, or "auto" (default: 1)
  -f, --force            Overwrite the output directory if it exists
  -q, --quiet            Suppress the summary; warnings and errors still print
      --json             Print machine-readable JSON to stdout (works with --info too)
      --strict           Exit 1 if the recording raised any warning
      --stdout           Write the signal CSV to stdout instead of a directory
                         (one table only: one sampling rate, or --layout long)
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
  directory can still be read at a glance. With --bom each CSV starts with a
  UTF-8 byte order mark and metadata.json does not, since JSON.parse rejects one.
  With --layout long every channel goes into one signals.csv as time_s, channel
  and value, in time order, whatever rates the recording mixes — which is also
  the one arrangement --stdout can stream for a mixed-rate file.

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

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

/**
 * Whether this run is already shutting its children down.
 *
 * A child dying by signal is normally worth a line of its own, but not when this process is
 * the one that killed it: the interrupt handler names every abandoned directory in a single
 * message, and a per-child line underneath it would say the same thing again, once per job.
 */
let stopping = false;

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

    /*
      Anything else is a real write failure, and this used to rethrow it.

      The throw lands on a nextTick, outside whatever try/catch the conversion is running
      inside, so it became an uncaught exception: `--stdout` redirected onto a full disk
      died with a raw stack trace headed `dist/cli.js: throw error;` and lost the warning
      that the CSV it had already produced was truncated. The same failure through `--out`
      printed the ordinary message, and so did `--stdout` through the library API, which
      never registers this listener — the designed path exists and works, and this was
      preempting it.

      A second listener means the conversion's writer is watching this stream and will
      turn the failure into that ordinary message. Saying it here too would report one
      failure twice, so this only speaks when nothing else will.
    */
    if (stream.listenerCount('error') > 1) return;
    process.stderr.write(`error: Writing to ${stream === process.stdout ? 'stdout' : 'stderr'} failed: ${error.message}\n`);
    process.exitCode = EXIT_ERROR;
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
        layout: { type: 'string' },
        gzip: { type: 'boolean' },
        bom: { type: 'boolean' },
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
    process.stderr.write(`${usageMessage(error, argv)}\n\nRun edf2csv --help to see the options.\n`);
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
  let unreadable: string[];
  let namedDirectory: boolean;
  try {
    const found = await expandInputs(positionals);
    expanded = found.inputs;
    unreadable = found.unreadable;
    namedDirectory = found.namedDirectory;
  } catch (error) {
    return reportError(error);
  }

  // Reported before anything is converted, so it cannot be lost among the summaries, and
  // counted against the run so the exit code does not call a partial sweep a success.
  for (const entry of unreadable) {
    process.stderr.write(
      `error: ${printable(entry)}: could not be read, so any recordings inside it were skipped.\n`,
    );
  }

  if (expanded.length === 0) {
    /*
      "None here" and "could not look" are different answers, and so are their exit codes.

      A folder the process cannot read gave the same exit 2 and the same "No EDF or BDF
      recordings found" as an empty one — while the line above it said the folder could not
      be read. Exit 2 is this tool's code for "the command itself was wrong", so a script
      was being told to fix its arguments when what needed fixing was a permission. The
      command was fine; the filesystem refused.

      And the sentence itself claimed a fact the run is in no position to state: nothing was
      found because nothing was looked at.
    */
    if (unreadable.length > 0) {
      process.stderr.write(
        `Nothing could be converted: ${unreadable.length === 1 ? 'that path' : 'those paths'} ` +
          `could not be read, so whether ${unreadable.length === 1 ? 'it holds' : 'they hold'} ` +
          `recordings is unknown.\n`,
      );
      return EXIT_ERROR;
    }
    process.stderr.write(
      `No EDF or BDF recordings found in ${listed(positionals.map((p) => `"${p}"`))}.\n`,
    );
    return EXIT_USAGE;
  }
  const inputs = expanded.map((entry) => entry.path);
  /*
    A batch is what you asked for, not what happened to be there.

    Counting the recordings made the shape of the run depend on the contents of a folder.
    Under --json a study holding one night printed a pretty-printed object and the same study
    holding two printed two compact lines, so a script written against one of them broke on
    the other — and it broke the day a recording was added, not the day the script changed.
    An input going missing did it in reverse. This is the same count 0.4.20 took out of
    `--out` for the same reason.

    Counted from what was named, not from what survived deduplication. `edf2csv one.edf
    alias.edf --out o`, where `alias.edf` is a link to `one.edf`, is two names for one
    recording — converted once, which is right — and the count collapsing to 1 made the run
    stop being a batch: `--out` became the output directory itself, so the files landed in
    `o/` rather than `o/one/`, and `--json` printed one indented document where two
    recordings would have given JSON Lines. cli-reference says of exactly that command that
    it writes `out/one`.
  */
  const batch = positionals.length > 1 || namedDirectory;
  const quiet = values['quiet'] === true;
  const asJson = values['json'] === true;
  const strict = values['strict'] === true;
  const toStdout = values['stdout'] === true;

  // Both of these claim stdout. Allowing them together wrote the CSV and then the summary
  // object onto one stream, producing a document that is neither valid CSV nor valid
  // JSON — and silently, since each half looked right on its own.
  /*
    Not under --info, which writes no CSV for --json to collide with.

    The two claim stdout because one puts a CSV there and the other a summary. `--info` puts
    neither: it prints a description, and under --json that description *is* the JSON. So
    `--info --stdout --json` — a script asking "would --stdout work on this recording, in a
    form I can parse" — was refused for a conflict that cannot arise, which is the same shape
    as the destination guards 0.5.51 stopped applying to it. It is also the only way to see
    the STDOUT_UNSUPPORTED warning from a script.
  */
  if (toStdout && asJson && values['info'] !== true) {
    /*
      `error: ` and the seven-space continuation, like every other refusal.

      These two were written before the prefix was, and kept their own shape: every other
      usage error in this tool prints "error: <what>" with the advice indented under it, the
      documentation shows them that way, and stderr is what a script greps. A refusal that
      does not match `^error:` is invisible to that grep — and this pair is the one a script
      is most likely to hit, since both flags are things a script passes rather than a person.
    */
    process.stderr.write(
      'error: --stdout and --json both write to stdout, so they cannot be combined.\n' +
        '       Use --stdout for the CSV, or --json for the summary.\n',
    );
    return EXIT_USAGE;
  }

  /*
    One stream holds one table, for the same reason it holds one recording: concatenating
    them would give a CSV whose rows come from different files with nothing marking where
    one ends. Naming the count makes it obvious a glob was the cause — except when the count
    is one, which happens for a folder holding a single recording. That read "--stdout writes
    a single CSV, so it cannot take 1 recordings": ungrammatical, and wrong on its face, since
    one recording is exactly what it can take. What it cannot take is a folder, whose contents
    are not known until they are walked.
  */
  /*
    Asked of the recordings to stream, not of the run's shape.

    These are different questions and 0.5.40 conflated them: it made `batch` count the names
    rather than the recordings, which is right for `--out` and for `--json`, and this guard
    read `batch`. So `edf2csv one.edf one.edf --stdout` — one recording, named twice,
    converted once, perfectly streamable — was refused with the message written for a folder,
    telling the reader to "name the recording itself" and quoting the name they had just
    given twice.

    A folder is still refused however few recordings it turns out to hold, for the reason
    0.5.5 gives: what it holds is not known until it is walked.
  */
  if (toStdout && (inputs.length > 1 || namedDirectory)) {
    // Prefixed and indented like the rest; see the --json refusal above. The recording's
    // name goes through `printable` for the reason 0.5.67 gives: a path is untrusted text,
    // and this one is read straight out of a directory the caller named.
    process.stderr.write(
      inputs.length === 1
        ? `error: --stdout writes a single CSV, and a folder is converted as a batch even ` +
          `when it holds one recording.\n       Name the recording itself — ` +
          `${printable(inputs[0] as string)} — or convert to a directory instead.\n`
        : `error: --stdout writes a single CSV, so it cannot take ` +
          `${counted(inputs.length, 'recording')}.\n` +
          `       Convert them to directories instead, or run edf2csv once per file.\n`,
    );
    return EXIT_USAGE;
  }

  /*
    Flags that --stdout has nowhere to put.

    Both were accepted and dropped in silence. `--out` names a directory that is never
    created, so the run looked like it had written one. `--checksum` is worse than useless:
    the hash is computed before the first record is read, which is a second full pass over
    the input, and then the only file it is ever written to — metadata.json — is not written
    at all. A recording large enough to want a checksum is large enough to notice reading it
    twice for nothing.

    Refusing rather than ignoring is what this tool already does for `--stdout --json` and
    `--stdout --annotations-only`.
  */
  for (const [flag, given] of [
    ['--out', values['out'] !== undefined],
    ['--checksum', values['checksum'] === true],
  ] as const) {
    if (toStdout && given) {
      process.stderr.write(
        `--stdout and ${flag} cannot be combined: --stdout writes no files, and ${flag} has ` +
          `nothing to act on.\nDrop ${flag}, or drop --stdout and convert to a directory.\n`,
      );
      return EXIT_USAGE;
    }
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
    const destinations = destinationsFor(expanded, outOption, batch);
    /*
      Where the output would land is not --info's problem to refuse over. It is still
      --info's job to mention it.

      0.5.32 stopped the guards refusing `--info`, and left nothing in their place — while
      the sentence it added to cli-reference says "`--info --out` is how you would want to
      find out about them". So the one command documented as the way to learn about a
      collision said nothing at all about it. Reported as a warning now, using the guard's own
      message so there is one wording rather than two.
    */
    if (values['info'] === true) {
      try {
        assertDistinct(inputs, destinations);
      } catch (error) {
        if (!(error instanceof OptionError)) throw error;
        process.stderr.write(`warning: ${printableLines(error.message, '         ')}\n`);
      }
    }

    /*
      Where the output would land is not --info's problem, because --info has no output.

      Both guards refused it: `edf2csv study --info --out yy` on a folder holding `rec.edf`
      beside `rec/inner.edf` exited 2 with "would be converted into yy/rec/inner, which is
      inside yy/rec — where rec.edf is converted", and printed nothing about either
      recording. Two recordings whose names collide got the overwrite refusal the same way.
      Both messages assert a conversion and an overwrite that --info does not perform, and
      the identical command without --out describes both files happily.

      Which makes the refused command the useful one: `--info --out` is how you ask what a
      run would produce before committing to it, and a collision is exactly the thing you
      would want it to tell you about rather than refuse to look.
    */
    if (values['info'] !== true) assertDistinct(inputs, destinations);

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
      bom: values['bom'] === true,
      layout: optionalLayout(values['layout']),
    };

    // Validated before the --info branch, not inside the conversion path: a flag that
    // cannot be honoured is a usage error whatever mode it was given in, and accepting
    // "--jobs 0" in silence under --info is the kind of quiet that this tool avoids.
    // Parsed before it is overridden: --stdout converts one recording however many jobs
    // were asked for, but "--stdout --jobs 0" is still a request that cannot be honoured,
    // and accepting it in silence is the thing 0.4.2 fixed for --info.
    const requestedJobs = parseJobs(values['jobs'], inputs.length);
    const jobs = toStdout ? 1 : requestedJobs;

    if (values['info'] === true) {
      const failures: number[] = [];
      let warnings = 0;
      for (const [index, input] of inputs.entries()) {
        // A blank line between reports, so several tables read as one document.
        if (batch && !asJson && index > 0) process.stdout.write('\n');
        try {
          warnings += await showInfo(
            input as string,
            shared,
            asJson,
            jsonIndent,
            batch,
            values['stdout'] === true,
          );
        } catch (error) {
          failures.push(reportError(error, batch ? (input as string) : undefined));
        }
      }
      if (unreadable.length > 0) failures.push(EXIT_ERROR);
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
            batch,
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
        stopping = true;
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
          // The report says what the child actually did; the exit code says whether it
          // got there. A child that converted and warned has a report and exits 0, since
          // --strict is the parent's to apply.
          if (child.report) {
            converted += child.report.converted;
            warnings += child.report.warnings;
          } else if (child.code === 0) {
            converted++;
          }
          if (child.code !== 0) failures.push(child.code);
          // The child saw one recording, so it printed the indented document a single
          // conversion prints. A batch is one object per line.
          sink.emit('out', asJson ? compactJson(child.out) : child.out);
          /*
            The child converted a single recording, so it named no file in its errors the way
            a batch does. Naming it here keeps the two paths identical to a reader and to
            anything grepping a log, where the [n/m] header may not be alongside.

            Warnings too, under --quiet, and for exactly the reason 0.5.49 gave for the serial
            path: the `[n/m] <path>` header is what pairs a warning with the file that raised
            it, --quiet suppresses that header, and it took the attribution with it. That fix
            keyed off the child's own `batch` flag, which a forked child does not have — it
            was handed one recording and one destination, so it believes it is a single
            conversion and says nothing. Two recordings, two warnings, no way to tell which
            raised which, and under --jobs not even a stable order to guess from.

            Not when the header is printed, or every warning would carry the name twice.
          */
          sink.emit('err', named(child.err, input, quiet));
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

    /*
      A path that could not be read is a failure of this run, and the closing line has to
      count it before it prints rather than after.

      It was counted afterwards, so a folder holding one recording beside a sub-directory
      without read permission printed "Converted 1 of 1 recordings." and exited 1. The line
      agreed with itself and with nothing else — which is the failure the walk's own comment
      says was fixed, quoting that very sentence. What was fixed then was the error line and
      the exit code; the summary went on saying everything worked.

      Counted separately from the recordings, because an unreadable path is not one of them:
      how many recordings it held is the thing nobody knows.
    */
    if (unreadable.length > 0) failures.push(EXIT_ERROR);

    if (batch && !quiet && !asJson) {
      const unread =
        unreadable.length > 0
          ? `; ${unreadable.length} path${unreadable.length === 1 ? '' : 's'} could not be read`
          : '';
      const failed = converted < inputs.length ? `; ${inputs.length - converted} failed` : '';
      process.stderr.write(
        `\nConverted ${converted} of ${inputs.length} recordings${failed}${unread}.\n`,
      );
    }

    /*
      A parent that forked this process needs the counts, not just an exit status.

      An exit code cannot separate "converted, and raised warnings" from "did not convert",
      and under --strict those are the same code. The parent read it as a failure, so a
      parallel run of two recordings — one of which merely warned — reported "Converted 1 of
      2 recordings; 1 failed" for a run in which both converted, while the serial path said
      "Converted 2 of 2". `process.send` exists only when this process was forked with a
      channel, so nothing changes for an ordinary invocation.
    */
    process.send?.({ edf2csv: { converted, warnings } });

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
  batch = false,
  toStdout = false,
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
    const hasAnnotations = file.annotationSignals.length > 0;
    const needsEveryRecordStart = file.header.continuity === 'EDF+D' && hasAnnotations;
    /*
      A continuous recording needs its origin too, which is one read rather than one per
      record: 0.4.9 made its first record's timekeeping TAL the point the samples are timed
      from, and this report went on placing a requested window against zero. `--info --start 1`
      predicted 8 rows where the conversion wrote 10, on a file whose discontinuous twin —
      identical but for the reserved field — agreed with itself.
    */
    const scan =
      !needsEveryRecordStart && file.header.continuity === 'EDF+C' && hasAnnotations
        ? await file.scanOrigin()
        : null;
    const annotationData = needsEveryRecordStart
      ? await file.readAnnotations()
      : {
          annotations: [],
          recordStarts: scan ? [scan.origin] : [],
          malformed: 0,
          // Counted rather than assumed: see EdfFile.scanOrigin.
          malformedTimekeeping: scan?.malformedTimekeeping ?? 0,
        };
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
    /*
      What --stdout would do with this recording, which --info did not ask.

      `--info --stdout` on a three-rate file predicted "Would write 1,155 rows, roughly
      22.2 KB" and said the channels "are written to one file per rate" — for a command that
      refuses to run, writes nothing and names no file. --info exists to say what a
      conversion will do, and refusing is one of the things it does.

      A warning rather than a refusal, for the reason 0.5.51 gives about the destination
      guards: --info writes nothing, so a rule about the output has no business stopping it
      from describing the recording — and being told the command will not work is exactly
      what was asked. The conversion's own guard supplies the words, so there is one wording.
    */
    /*
      What the conversion would say about the durations it would write.

      Same window the conversion applies, so --info predicts the warnings rather than a
      different set. Raised here rather than in the parser because the counts have to be of
      the rows that reach annotations.csv — see durationDiagnostics.
    */
    plan.diagnostics.push(
      ...durationDiagnostics(annotationData.annotations, {
        from: plan.range.startSeconds,
        to: plan.range.endSeconds,
      }),
    );

    if (toStdout) {
      const refusal = stdoutRefusal(file, plan);
      if (refusal) {
        plan.diagnostics.push({
          code: 'STDOUT_UNSUPPORTED',
          severity: 'warning',
          message: `--stdout would refuse this recording: ${refusal.message.replace(/^--stdout /u, '')}`,
          ...(refusal.hint === undefined ? {} : { hint: refusal.hint }),
        });
      }
    }
    /*
      Checked, like a conversion's stdout is.

      This wrote and looked at nothing, so `--info > desc.txt` into a filesystem with no room
      produced a zero-byte file and exited 0. The same audit the `--stdout` path uses: it
      declines anything that is not a regular file, so a pipe or a terminal is unaffected, and
      `--info | head` keeps exiting 0.
    */
    const audit = auditStdout();
    const description = asJson
      ? `${infoJson(file, plan, jsonIndent)}\n`
      : `${formatInfo(file, plan)}\n`;
    process.stdout.write(description);
    audit?.count(Buffer.byteLength(description));
    audit?.verify();

    // Under --json the warnings travel inside the document, exactly as they do for a
    // conversion, so stderr stays empty and the whole result is one parseable thing.
    const diagnostics = [...withoutFileRateWarning(file.diagnostics), ...plan.diagnostics];
    if (!asJson && diagnostics.length > 0) {
      /*
        Named when there is more than one recording to confuse it with.

        The table goes to stdout and the warnings to stderr, which is the point of the split
        — but over a folder that left several warnings in a row on stderr with nothing saying
        which recording raised any of them. Two recordings, two warnings, and no way to pair
        them up short of running the tool again one file at a time. A batch conversion has
        named its recordings since 0.4.20; this is the same report from the same tool about
        the same files.
      */
      const where = batch ? `${printable(input)}: ` : '';
      process.stderr.write(
        `\n${formatDiagnostics(diagnostics).replace(/^(warning|note): /gmu, (m) => `${m}${where}`)}\n`,
      );
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
    batch?: boolean;
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
  /*
    Whether the destination was already there before this run touched it.

    Read once, up front, because at interrupt time it is the difference between three
    different true statements and there is no other way to tell them apart. A directory that
    exists now and did not exist then was created by this conversion; one that existed then
    holds files this conversion may never have reached.
  */
  const destinationExistedBefore = toStdout ? false : existsSync(destination);

  const onInterrupt = (signal: NodeJS.Signals): void => {
    if (showProgress) process.stderr.write('\r\u001b[K');
    /*
      Say which of the three happened, rather than the middle one every time.

      --stdout writes no directory, so there is none to warn about. Naming one anyway
      pointed at a path that was never created — the same "files that were never written"
      that 0.2.30 removed from this path's error message. The directory case had the same
      defect one step further in: `convert()` hashes the input under --checksum and scans
      the whole annotation channel for record start times *before* it claims the directory,
      so a Ctrl-C in the first second of a large EDF+ printed "Files already written to
      "oa" are incomplete and should not be used" about a directory that `ls` then reported
      did not exist. Nothing had been written, and the advice was to distrust nothing.
    */
    const wrote = !toStdout && existsSync(destination);
    process.stderr.write(
      `\ninterrupted (${signal}): the conversion stopped part way through.\n` +
        (toStdout
          ? `       The CSV on stdout stops mid-recording and should not be used.\n`
          : !wrote
            ? `       Nothing was written: "${printable(destination)}" was never created.\n`
            : destinationExistedBefore
              ? `       "${printable(destination)}" was already there, so what is in it may be this run's ` +
                `incomplete output.\n`
              : `       Files already written to "${printable(destination)}" are incomplete and should not ` +
                `be used.\n`),
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
      /*
        Named when nothing else is naming it.

        A batch prints a `[n/m] <path>` header before each recording, and that header is what
        pairs a warning with the file it came from. `--quiet` suppresses it — it is the
        summary line it is documented to suppress, and it took the attribution with it. Two
        recordings, two warnings, and no way to tell which raised which, while `error:` lines
        in the same run stay named because 0.4.20 prefixes those separately.

        Same fix 0.5.34 made for `--info` over a folder, which has no header to lose.
      */
      const where = options.batch === true && quiet ? `${printable(input)}: ` : '';
      emit(
        'err',
        `${formatDiagnostics(result.diagnostics).replace(/^(warning|note): /gmu, (m) => `${m}${where}`)}\n\n`,
      );
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
        /*
          A reader that closed the pipe did not receive a conversion, so it does not get a
          conversion's summary. `edf2csv rec.edf --stdout | head -1` announced "Wrote 52,507
          rows to stdout" — a number that is neither the recording's 102,400 nor the one row
          head took, but however many had been formatted before the close was noticed.

          Whether the *conversion* stopped early is a separate question from whether the
          reader did, and 0.5.12 answered the first with the second. A 10,000-row recording
          whose CSV outruns the pipe buffer but fits one flush is written in full and only
          then meets the closed pipe: every row formatted, every row handed over, and the
          summary said "The recording was not converted in full." The estimate's row count is
          exact, so the two cases can be told apart and told apart honestly — what reached
          the reader is not knowable from this side either way.
        */
        const expected = result.plan.estimate.rows;
        // Singular at one, like every other count. A window narrow enough to select a single
        // sample is an ordinary thing to pipe, and this said "Wrote 1 rows to stdout." — the
        // third message in this family, after 0.5.74 and 0.5.78, each found because the sweep
        // that checks for it was narrower than the set of modes that print a count.
        const written = `${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}`;
        emit(
          'err',
          !result.readerHungUp
            ? `Wrote ${written} to stdout.\n`
            : rows < expected
              ? `Stopped: the reader closed the pipe after ${rows.toLocaleString('en-US')} of ` +
                `${expected.toLocaleString('en-US')} rows had been written. The recording was ` +
                `not converted in full.\n`
              : `Wrote ${written} to stdout, but the reader closed ` +
                `the pipe before the end, so not all of them reached it.\n`,
        );
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
  /**
   * Whether this recording was found by expanding a directory rather than named directly.
   *
   * `--out` means two different things — the output directory itself, or a parent to put one
   * directory per recording inside — and this is what decides which. See `destinationsFor`.
   */
  fromDirectory: boolean;
}

/**
 * Recordings to convert, with directories expanded to what is inside them.
 *
 * A directory yields every `.edf` and `.bdf` beneath it, at any depth. Recordings arrive
 * organised into folders, and a shell has no tidy way to reach them — which is why the
 * recipes here carried a `find` incantation to do it. Passing the folder is the obvious
 * thing to try, and it used to fail with "is a directory, not an EDF file".
 */
async function expandInputs(
  positionals: readonly string[],
): Promise<{ inputs: Input[]; unreadable: string[]; namedDirectory: boolean }> {
  const found: Input[] = [];
  const unreadable: string[] = [];
  /*
    Whether a directory was NAMED, which is not the same as whether one yielded anything.

    `fromDirectory` on the inputs answers the second question, and using it for the first put
    the 0.4.20 defect back one step along: `edf2csv study named.edf --out csv` wrote
    csv/named/ while the study held recordings and csv/signals.csv once it held none, because
    the surviving input then looked like a lone file. Whether some unrelated folder happens
    to contain anything decided where a different recording's output went.
  */
  let namedDirectory = false;
  for (const given of positionals) {
    const info = await stat(given).catch(() => null);
    if (info === null || !info.isDirectory()) {
      // Anything that is not a directory is passed through untouched, so a file that does
      // not exist still reports itself rather than vanishing from the list.
      found.push({ path: given, name: path.basename(given), fromDirectory: false });
      continue;
    }
    namedDirectory = true;
    const walked = await walk(given);
    unreadable.push(...walked.unreadable);
    for (const file of walked.files) {
      found.push({ path: file, name: path.relative(given, file), fromDirectory: true });
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

    Which of the names survives is decided by the names themselves, not by the order they
    turned up in. Keeping the first arrival meant the output directory was named by argument
    order — `edf2csv data/one.edf data/alias.edf` wrote out/one and the same two swapped
    wrote out/alias — and a shell orders a glob however it likes. Inside a folder it was the
    order `readdir` returned, which differs between filesystems, so copying a study to
    another machine could rename its output. A recording that is not a link is preferred over
    a link to it, since that is the name the recording actually has; two of a kind are
    settled by the path that sorts first.
  */
  const identified: { entry: Input; identity: string; link: boolean }[] = [];
  for (const entry of found) {
    const identity = await realpath(entry.path).catch(() => `?${path.resolve(entry.path)}`);
    const own = await lstat(entry.path).catch(() => null);
    identified.push({ entry, identity, link: own?.isSymbolicLink() ?? false });
  }

  const byIdentity = new Map<string, Input>();
  const winners = new Map<string, (typeof identified)[number]>();
  for (const candidate of identified) {
    const held = winners.get(candidate.identity);
    if (held !== undefined && !outnames(candidate, held)) continue;
    winners.set(candidate.identity, candidate);
    byIdentity.set(candidate.identity, candidate.entry);
  }

  // A directory hands its entries back in whatever order the filesystem stored them.
  const unique = [...byIdentity.values()];
  unique.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  /*
    One unreadable path, however many ways it was named — the same rule the recordings above
    get, which this did not.

    Each named directory is walked separately and its findings appended, so a folder given
    twice, given relatively and absolutely, or given alongside a link to it, reported every
    path it could not read once per name. `edf2csv study study` on a study holding one locked
    sub-directory printed the error twice and closed with "Converted 1 of 1 recordings; 2
    paths could not be read" — one path, counted two — while the recordings beside it were
    correctly converted once. The count is the part that matters: it is what tells someone how
    much of their study was not looked at.

    Identity, not spelling, for the reason 0.5.64 gives: `study/locked` and `alias/locked` are
    one directory. `realpathSync` resolves it even when the directory itself cannot be opened,
    since that needs search permission on the parent rather than on the target. A path that
    cannot be resolved at all keeps its own identity, so a name that is simply not there still
    reports itself.
  */
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const entry of unreadable) {
    let identity: string;
    try {
      identity = realpathSync(entry);
    } catch {
      identity = `?${path.resolve(entry)}`;
    }
    if (seen.has(identity)) continue;
    seen.add(identity);
    // The first spelling is kept, which is the one the caller typed first.
    distinct.push(entry);
  }

  return { inputs: unique, unreadable: distinct, namedDirectory };
}

/**
 * Which of two names for one recording the output should be called after.
 *
 * A name the recording actually has beats a link pointing at it, and two of a kind are
 * settled by sort order. Both are properties of the names, so the answer does not move when
 * a shell expands a glob differently or a filesystem enumerates a folder in another order.
 */
function outnames(
  candidate: { entry: Input; link: boolean },
  held: { entry: Input; link: boolean },
): boolean {
  if (candidate.link !== held.link) return !candidate.link;
  /*
    Resolved, not as typed. `study/night-01/rec.edf` and `./study/night-01/rec.edf` are the
    same file spelled two ways, and comparing the raw strings made them two different names —
    so this returned here, on lexicographic order of the spelling, and never reached the depth
    rule below that exists for exactly this case.

    What that cost is not cosmetic. `edf2csv study study/night-01/rec.edf` converted both
    recordings and exited 0; the identical request written `edf2csv study
    ./study/night-01/rec.edf` was refused with "would both be converted into "out/rec", so one
    would overwrite the other", exit 2, nothing written. Same files, same folder, same
    intention — and a leading `./` decided whether the run happened. Without the sibling that
    collides it was quieter and no better: one spelling wrote `out/night-01/rec` and the other
    `out/rec`, so a script that started passing absolute paths moved its output.

    Through `realpathSync`, not `path.resolve`, because a lexical resolve is not enough: on
    macOS `$TMPDIR` sits under `/var`, which is a link to `/private/var`, so a folder walked
    from the name the caller gave and a recording named relative to the process's own
    directory come out with different absolute prefixes for the same file. Falls back to the
    lexical form for a path that cannot be resolved, which is the same answer as before.

    Following links here is safe: a link and its target reach this as two genuinely different
    names, and the rule above has already preferred the real one, so the only pairs left with
    one identity are two spellings or two links — and both should fall through to the depth
    rule below rather than be settled by how they were typed.
  */
  const spelled = (entry: Input): string => {
    try {
      return realpathSync(entry.path);
    } catch {
      return path.resolve(entry.path);
    }
  };
  if (spelled(candidate.entry) !== spelled(held.entry)) {
    return spelled(candidate.entry) < spelled(held.entry);
  }
  /*
    One recording, one path, two names — reached directly and through a named folder.

    `edf2csv study study/night-01/rec.edf` and the same two swapped are the same request, and
    they disagreed: the folder gives the recording its position inside the folder
    (`night-01/rec`), a direct mention gives it its bare name (`rec`), and whichever spelling
    the loop met first won. So argument order decided the output directory's name, and, once
    a second `study/rec.edf` was in play, decided whether the run happened at all — the bare
    name collides with it and the run is refused, exit 2, while the other order converts both.

    The nested name wins. It is what the folder promised — "the layout is kept: recordings in
    sub-folders come out in sub-folders" — and it is the one that does not collide, since
    collapsing a recording to its bare name is what puts it on top of a sibling.
  */
  const depth = (entry: Input): number => entry.name.split(path.sep).length;
  if (depth(candidate.entry) !== depth(held.entry)) return depth(candidate.entry) > depth(held.entry);
  return candidate.entry.name < held.entry.name;
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
async function walk(root: string): Promise<{ files: string[]; unreadable: string[] }> {
  const files: string[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  /*
    A queue, taken from the front, and each directory's children entered in a settled order.

    This was a stack popped from the back, so which of two names for one directory was
    visited first came down to the order `readdir` happened to return them — and the loser
    was then skipped as already seen, taking its name out of the run with it. A folder
    holding `aaa-real/` beside `zzz-alias -> aaa-real` converted into `<out>/zzz-alias/`: the
    link's name, chosen by a hash order that differs between filesystems. 0.4.29 settled this
    for two names of one *file* and left the directory above it deciding by accident.

    Breadth first, and each directory's sub-directories entered with real names before links
    and alphabetically within each, so the name that survives is a property of the tree: the
    shallowest, then the one that is not a link, then the first in sort order.
  */
  const queue = [root];
  let next = 0;

  while (next < queue.length) {
    const directory = queue[next++] as string;
    const real = await realpath(directory).catch(() => directory);
    if (seen.has(real)) continue;
    seen.add(real);

    /*
      A directory that cannot be listed is reported, not stepped over.

      Skipping it in silence meant a folder holding three recordings, one of them inside a
      sub-directory without read permission, converted two and said "Converted 2 of 2
      recordings" — a total that agreed with itself and with nothing else. That is the same
      failure 0.4.4 fixed for symbolic links, arriving by a different route: converting fewer
      recordings than were asked for and reporting success.
    */
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      unreadable.push(directory);
      continue;
    }

    // A real name before a link to the same thing, then alphabetically. The dirent describes
    // the entry itself rather than its target, which is exactly the question here.
    const ordered = [...entries].sort((a, b) => {
      const link = Number(a.isSymbolicLink()) - Number(b.isSymbolicLink());
      return link !== 0 ? link : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    for (const entry of ordered) {
      const full = path.join(directory, entry.name);
      // stat, not the dirent: a dirent describes the link, and what matters is its target.
      const info = await stat(full).catch(() => null);
      if (info === null) {
        /*
          Anything that cannot be inspected is reported, whatever it is called.

          This used to report only names ending in `.edf` or `.bdf`, on the reasoning that a
          broken link to something else is nobody's business. A directory carries no such
          name. A study kept as one folder per night, with one night linked to an external
          drive, converted the nights that were mounted and said nothing about the one that
          was not — and because losing that input left a single recording, `--out` stopped
          meaning "a parent to fill" and started meaning "the directory to write", so the
          survivor landed somewhere else as well. Whether a drive happened to be mounted
          changed both what was converted and where it went, in silence, exit 0.

          The walk cannot know what was behind a link it cannot follow, which is exactly the
          reason to say so rather than to guess.
        */
        unreadable.push(full);
        continue;
      }
      if (info.isDirectory()) {
        queue.push(full);
      } else if (info.isFile() && /\.(edf|bdf)$/iu.test(entry.name)) {
        // Duplicates are collapsed once for the whole list in expandInputs; this only has
        // to find them. The `seen` set here is for directory cycles.
        files.push(full);
      }
    }
  }
  return { files, unreadable };
}

/**
 * Where each recording's output goes.
 *
 * Naming one recording, `--out` is the output directory itself, which is what it has always
 * meant. Naming a folder, or several recordings, it is a parent and each recording gets its
 * own directory inside it, because writing several recordings into one directory would have
 * them overwrite each other's `signals.csv` — the one thing a batch must not do quietly.
 *
 * With no `--out` at all, every recording converts beside itself exactly as it would have
 * done alone, so a glob behaves like the shell loop it replaces.
 *
 * What a folder means is decided by the folder, not by how much is in it. Counting the
 * recordings instead meant `edf2csv study --out csv` wrote `csv/signals.csv` while the study
 * held one night and `csv/night-01/rec/signals.csv` once it held two: adding a recording
 * moved the output of a recording that had not changed. The same count made the destination
 * depend on things no one had touched either — a night on an unmounted drive, a
 * sub-directory that could not be read — so where the data landed turned on the state of the
 * machine rather than on the command.
 */
function destinationsFor(
  inputs: readonly Input[],
  out: string | undefined,
  /** True when a folder was named, or more than one recording was. See `batch` in `main`. */
  batch: boolean,
): string[] {
  if (out === undefined) return inputs.map((input) => defaultOutputDir(input.path));
  if (!batch) return [out];
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
  /*
    Two names that differ only in case are one directory on a filesystem that does not
    distinguish them, which is the default on macOS and the rule on Windows.

    `a/REC.edf` and `b/rec.edf` produce `<out>/REC` and `<out>/rec`. Compared exactly those
    are different, so both went through, and with --force the second conversion wrote into
    the directory the first had made: one directory holding one recording's `signals.csv`
    beside the other's `signals_256hz.csv`, under a single `metadata.json` naming only one
    of them. The run reported "Converted 2 of 2 recordings" and exited 0. A directory whose
    provenance file describes a recording other than the data beside it is the one outcome
    this tool exists to prevent.

    The comparison follows the platform rather than being applied everywhere, so a
    case-sensitive filesystem — where those really are two directories — keeps converting
    both. A case-sensitive volume on macOS is the exception it gets wrong, and it gets it
    wrong in the safe direction: a refusal that names both recordings, not a silent merge.
  */
  const foldsCase = process.platform === 'darwin' || process.platform === 'win32';
  /*
    macOS filesystems fold Unicode normalisation as well as case.

    HFS+ and APFS compare names in a normalised form, so `café` written as e + U+0301 and
    `café` written as U+00E9 are one directory — while remaining two different JavaScript
    strings, which is all this guard was comparing. Two recordings whose stems differ only
    that way therefore both passed the check and both converted into the same place:

      study/café.edf   (NFC)   ->  csv/café/signals.csv
      study/café.bdf   (NFD)   ->  csv/café/signals_256hz.csv, _128hz, _1hz

    one directory holding both, under a single metadata.json naming one of them, reported as
    "Converted 2 of 2 recordings" and exit 0 under --force. Without --force the second run
    happened to hit "already exists", which is the accidental save rather than the check
    doing its job — and it named the wrong problem.

    Not folded on Linux, where the two names are genuinely two directories and refusing them
    would be inventing a collision that does not exist. Windows preserves normalisation too,
    so only darwin. This is the same platform-shaped assumption the case fold above already
    makes, and it has the same limit: a network or removable volume that normalises while the
    running platform does not is not covered by either.
  */
  const identity = (destination: string): string => {
    const resolved = path.resolve(destination);
    if (!foldsCase) return resolved;
    const folded = resolved.toLowerCase();
    return process.platform === 'darwin' ? folded.normalize('NFC') : folded;
  };

  const claimed = new Map<string, string>();
  for (const [index, destination] of destinations.entries()) {
    const key = identity(destination);
    const first = claimed.get(key);
    if (first !== undefined) {
      throw new OptionError(
        `"${printable(inputs[index] as string)}" and "${printable(first)}" would both be converted into "${printable(destination)}", ` +
          `so one would overwrite the other.\n` +
          `Convert them separately, or rename one of them.`,
      );
    }
    claimed.set(key, inputs[index] as string);
  }

  /*
    And refuse one destination sitting inside another.

    A recording named `rec.edf` beside a folder named `rec` is enough: their outputs are
    `<out>/rec` and `<out>/rec/inner`, which are not equal, so the check above let both
    through. What happened next depended on which conversion got there first. Each creates
    its own directory with a single non-recursive mkdir but its parents recursively, so
    whichever started second either claimed a directory the other had already made as a
    parent — failing with "already exists" — or did not. Five runs in twenty failed that way
    under --jobs 2, converting one recording of two; the same command succeeded the other
    fifteen times.

    Sorting first puts an ancestor next to its descendant: anything sorting between them
    shares the same prefix, and would be caught as its own adjacent pair.
  */
  /*
    Each destination is checked against its own ancestors, by name.

    The first version of this sorted the resolved paths and compared neighbours, on the
    reasoning that an ancestor and its descendant end up adjacent. They do not: the
    separator is not the lowest character, so any sibling whose name begins with one of the
    thirteen printable characters below '/' lands between them. With `rec.edf`, `rec!x.edf`
    and `rec/inner.edf` in one folder, '!' sorts between `out/rec` and `out/rec/inner` and
    the pair was never compared — three recordings converted, one of them inside another's
    directory, reported as "Converted 3 of 3".

    Walking up from each destination has no such gap. Output trees are shallow, so this is a
    handful of string lookups per recording.
  */
  const byDestination = new Map<string, number>();
  for (const [index, destination] of destinations.entries()) {
    byDestination.set(identity(destination), index);
  }

  for (const [index, destination] of destinations.entries()) {
    let ancestor = path.dirname(path.resolve(destination));
    for (let parent = ''; ancestor !== parent; ancestor = path.dirname(ancestor)) {
      parent = ancestor;
      const owner = byDestination.get(identity(ancestor));
      if (owner === undefined || owner === index) continue;
      throw new OptionError(
        `"${printable(inputs[index] as string)}" would be converted into "${printable(destination)}", which is inside ` +
          `"${destinations[owner]}" — where "${inputs[owner]}" is converted.\n` +
          `One recording's output cannot sit inside another's. Convert them separately, or ` +
          `rename one of them.`,
      );
    }
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
  /*
    Anything that is not "the command line is the problem" is a failure of the run.

    This tested for `EXIT_ERROR` and fell through to `EXIT_USAGE` for everything else, on the
    assumption that a child exits 1 or 2. A child killed by a signal exits 130 or 143 — its
    own interrupt handler does that — so a `--jobs` worker stopped by SIGTERM made the batch
    exit 2, which cli-reference's table defines as "The command line is the problem" and
    warnings-and-errors as "The command was invoked incorrectly, or asked for something the
    recording can't provide". The command was fine; something killed a worker. The
    out-of-memory killer and a scheduler's time limit both arrive exactly this way, and the
    serial path reports the same event as the failure it is.

    Asking the question the other way round is also the honest one: 2 is the narrow claim,
    so it should be the one that has to be earned by every code in the list.
  */
  return codes.some((code) => code !== EXIT_USAGE) ? EXIT_ERROR : EXIT_USAGE;
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
): Promise<{
  code: number;
  out: string;
  err: string;
  report: { converted: number; warnings: number } | null;
}> {
  /*
    The recording goes last, behind `--`.

    As the first argument it was parsed as an option whenever its path began with a dash,
    which `path.join` produces from a folder given as `.` — `./-lead.edf` normalises to
    `-lead.edf`. The child then failed on a file the parent had converted happily, so the
    same command converted two recordings serially and one under --jobs.
  */
  /*
    Option values go in the `--flag=value` form, never as two arguments.

    Split across two arguments, a value beginning with a dash is another option as far as the
    child's parser is concerned: `--out ./-nightly` reached it as `--out` followed by
    `-nightly`, and the child died on "Option '--out' argument is ambiguous" while the serial
    path converted the same command without complaint. A leading dash is not exotic —
    `path.join` produces one from a folder given as `.`, and directories get named after
    dates and flags often enough. Same failure 0.4.19 fixed for the recording's own path, on
    everything that carries a value rather than on the positional.
  */
  const args = [`--out=${destination}`];
  /*
    --strict is deliberately absent: it is a verdict on the whole run, and a child converting
    one recording is not the whole run. Passing it down made each child announce "--strict: 1
    warning raised, so this run is reported as a failure" about its own single file, and exit
    1 for it, which the parent then counted as a conversion that had not happened. The parent
    applies it once, from the counts the children report.
  */
  for (const flag of ['annotations-only', 'checksum', 'gzip', 'bom', 'force', 'quiet', 'json']) {
    if (values[flag] === true) args.push(`--${flag}`);
  }
  for (const flag of ['start', 'duration', 'end', 'decimals', 'layout']) {
    if (typeof values[flag] === 'string') args.push(`--${flag}=${values[flag] as string}`);
  }
  // --channels is repeatable, and each term is passed as given so that a label containing a
  // comma survives: joining them back into one list would split it in the child.
  const channels = values['channels'];
  if (channels !== undefined) {
    for (const term of Array.isArray(channels) ? (channels as string[]) : [String(channels)]) {
      args.push(`--channels=${term}`);
    }
  }
  args.push('--', input);

  return new Promise((resolve) => {
    const child = fork(fileURLToPath(import.meta.url), args, {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    running.set(child, destination);
    let out = '';
    let err = '';
    let report: { converted: number; warnings: number } | null = null;
    child.on('message', (message: unknown) => {
      const payload = (message as { edf2csv?: { converted: number; warnings: number } })?.edf2csv;
      if (payload) report = payload;
    });
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      err += chunk;
    });
    child.on('error', (error) => {
      running.delete(child);
      resolve({ code: EXIT_ERROR, out, err: `${err}error: ${input}: ${error.message}\n`, report });
    });
    child.on('close', (code, signal) => {
      running.delete(child);
      /*
        A child that was killed says nothing on its way out, so the parent has to.

        `code` is null when a process dies by signal, which left the parent with `code ??
        EXIT_ERROR` — a failure with an empty `err`, so the run printed nothing but "Converted
        1 of 2 recordings; 1 failed." and stopped. Nothing said which recording, nothing said
        why, and nothing said that its directory held a 194 MB signals.csv cut off mid-row
        with no channels.csv beside it. That file looks exactly like a finished one to
        anything that opens it.

        The out-of-memory killer, a job scheduler's time limit and `kill` all arrive this way.
        A run stopped from the keyboard is reported by the interrupt handler instead, which
        names every directory at once rather than one line per child.
      */
      if (signal !== null && !stopping) {
        err +=
          `error: stopped by ${signal} before it finished.\n` +
          `       Incomplete, and should not be used: ${printable(destination)}\n`;
      }
      resolve({ code: code ?? EXIT_ERROR, out, err, report });
    });
  });
}

/**
 * Put the recording's name into the lines a child produced.
 *
 * Errors always: a failure has to say which recording failed, whatever else is on screen.
 * Warnings only when `alsoWarnings` — under --quiet, where the `[n/m]` header that would
 * otherwise carry the attribution is not printed. See the call site.
 */
function named(text: string, input: string, alsoWarnings = false): string {
  // A function, not a string: `$&`, `$\'`, `` $` `` and `$1` in a replacement string are
  // patterns, and a file may legitimately be called any of them. `bad$&name.edf` re-injected
  // the text it had just matched and reported itself as `baderror: name.edf`.
  const heads = alsoWarnings ? /^(error|warning|note): /gmu : /^error: /gmu;
  return text.replace(heads, (head) => `${head}${printable(input)}: `);
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
    // A request the tool cannot carry out is the command line's problem, not the file's,
    // whatever layer noticed it. See USAGE_ERROR_CODES.
    return error instanceof ConversionError && USAGE_ERROR_CODES.has(error.code)
      ? EXIT_USAGE
      : EXIT_ERROR;
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
  /*
    A whole number as written, not as `Number()` chooses to read it.

    `Number.isInteger(Number(text))` accepted `0x10`, `1e3`, ` 4 ` and
    `999999999999999999999` — the last of which is not an integer any more, only the nearest
    double to one — while refusing `4.7`. The message says "a whole number of 1 or more" and
    the refusal of 4.7 is what makes a reader believe it, so the others read as the tool
    silently reinterpreting what they typed. `--jobs` is the flag 0.4.2 hardened because
    accepting `--jobs 0` in silence "is the kind of quiet this tool avoids".
  */
  if (!/^\d+$/u.test(text)) {
    throw new OptionError(`--jobs must be a whole number of 1 or more, or "auto", got "${text}".`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1) {
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

/** `--layout`, which is one of two words and not a guess at what was meant. */
function optionalLayout(raw: unknown): 'wide' | 'long' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'wide' || raw === 'long') return raw;
  throw new OptionError(`--layout must be "wide" or "long", got "${String(raw)}".`);
}

function optionalDecimals(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const text = String(raw).trim();
  // Number('') is 0, which would quietly round every physical value to a whole number.
  if (text === '') {
    throw new OptionError('--decimals needs a number, for example --decimals 3.');
  }
  /*
    A whole number as written, not as `Number()` chooses to read it.

    `Number.isInteger(Number(text))` accepted `0x3`, `0b11`, `0o5`, `3e0`, `+3` and ` 3 `,
    while refusing `3.5` — and the refusal of `3.5` is what makes a reader believe the message
    that says "a whole number between 0 and 20". So `--decimals 0o5` wrote five decimals for
    an argument that reads as five to nobody, and `--decimals 0b11` wrote three, in silence,
    exit 0, with a CSV that looks exactly as intended.

    The same fix `--jobs` got, and the same one `--channels '#N'` got — where the comment
    records why: "Every one of them selected a channel and exited 0, so a slip did not fail —
    it quietly converted a different channel than the one asked for, which for this tool is
    the worst way to be wrong." A precision is the same kind of quiet.
  */
  const value = Number(text);
  if (!/^\d+$/u.test(text) || !Number.isInteger(value) || value < 0 || value > 20) {
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
/**
 * A `parseArgs` failure, in this tool's words where they are better than Node's.
 *
 * Node refuses `--out -nightly` with "Option '--out' argument is ambiguous. Did you forget to
 * specify the option argument for '--out'? To specify an option argument starting with a dash
 * use '--out=-XYZ'." The user did not forget anything — they gave a value — and `-XYZ` is a
 * placeholder, where every other message this tool prints quotes what was actually typed and
 * says exactly what to type instead. A destination whose name starts with a dash is not exotic,
 * and neither is a negative `--start` on a recording timed from before zero.
 *
 * 0.4.34 already fixed this message where the tool produced it internally, building child argv
 * for `--jobs` — `--out ./-nightly` reached the child as two arguments and died on it, while the
 * serial path converted the same command. The half a user can hit was left as Node wrote it.
 *
 * Only this case is reworded. Node's other three — an unknown option, a switch given a value, an
 * option missing its value — say something true in words a reader can act on, and replacing them
 * with near-identical sentences would be churn.
 */
function usageMessage(error: unknown, argv: readonly string[]): string {
  const raw = message(error);
  if ((error as { code?: unknown } | null)?.code !== 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    return raw;
  }
  const ambiguous = /^Option '(-[^']+)' argument is ambiguous/u.exec(raw);
  if (!ambiguous) return raw;

  const flag = ambiguous[1] as string;
  // The value is whatever followed the flag. Read from argv rather than from the message,
  // which does not carry it — and if it is not there after all, Node's text is still true.
  const at = argv.indexOf(flag);
  const value = at >= 0 ? argv[at + 1] : undefined;
  if (value === undefined) return raw;

  /*
    How the two shapes join, which is not the same and matters.

    A long option takes `--out=-nightly`. A short one does NOT take `-o=-nightly`: parseArgs
    reads the equals sign as the first character of the value and hands back "=-nightly", so
    that advice would have produced a directory named `=-nightly` without a word — a worse
    failure than the message it replaced, and a silent one. Short options join directly.
  */
  const joined = flag.startsWith('--') ? `${flag}=${value}` : `${flag}${value}`;
  return printableLines(
    `error: ${flag} was given "${value}", which begins with a dash and so reads as another ` +
      `flag rather than as its value.\n` +
      `       Write it as one argument instead: ${joined}`,
  );
}

function message(error: unknown, indent = ''): string {
  // The indent lines continuation up under an "error: " prefix. Usage problems print without
  // one, alongside the usage text, so they pass nothing and stay flush left.
  return printableLines(error instanceof Error ? error.message : String(error), indent);
}

// `worstOf` is exported for the test that pins the exit-code mapping. A batch's verdict is
// one of the few things a script branches on, and the mapping is easier to check directly
// than by racing a signal at a worker.
export { defaultOutputDir, worstOf };

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
