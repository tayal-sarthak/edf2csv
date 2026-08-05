---
title: CLI reference
description: Every edf2csv flag, its default and its behaviour, plus exit codes and the stdout versus stderr contract
order: 2
---

`edf2csv` converts one EDF, EDF+, BDF or BDF+ recording per invocation into a directory of CSV files. There's no configuration file and no environment variables — everything is on the command line.

## Synopsis

```bash
edf2csv <recording.edf> [options]
```

Exactly one input file is required, except with `--help` and `--version`. Two or more positional arguments are refused rather than converting the first one. To convert a folder, use a shell loop:

```bash
for f in /data/recordings/*.edf; do
  edf2csv "$f" --out "/data/csv/$(basename "${f%.edf}")"
done
```

## Flags at a glance

| Long | Short | Argument | Default | Effect |
| --- | --- | --- | --- | --- |
| `--info` | `-i` | none | off | Describe the recording and estimate the output, convert nothing |
| `--out` | `-o` | directory | `<recording>_csv` beside the input | Where the CSV files are written |
| `--channels` | `-c` | comma-separated list | all signal channels | Convert only these channels |
| `--start` | | time | start of the recording | First sample to include |
| `--duration` | | time | to the end | How much to convert, measured from `--start` |
| `--end` | | time | end of the recording | Offset to stop at, instead of `--duration` |
| `--annotations-only` | | none | off | Write only the EDF+ event list, no signal data |
| `--decimals` | | integer 0 to 20 | derived per channel | Force a fixed number of decimal places |
| `--checksum` | | none | off | Record a SHA-256 of the input in `metadata.json` |
| `--force` | `-f` | none | off | Write into an output directory that already exists |
| `--quiet` | `-q` | none | off | Suppress the closing summary and the progress meter |
| `--json` | | none | off | Print machine-readable JSON to stdout, for a conversion or for `--info` |
| `--strict` | | none | off | Exit 1 if the recording raised any warning |
| `--stdout` | | none | off | Write the signal CSV to stdout instead of a directory |
| `--help` | `-h` | none | | Print usage to stdout and exit 0 |
| `--version` | `-V` | none | | Print the version to stdout and exit 0 |

Short options are single letters and the version flag is a capital `V`. Unknown flags are rejected; there's no pass-through.

## Input, output directory and overwriting

The input path must be a regular file that can be read. A directory, a missing path or a special file is a file error (exit 1), not a usage error.

`-o, --out <dir>` sets the destination. Without it, the output directory is the input file's name with its extension replaced by `_csv`, created next to the input: `/data/recordings/sleep-study.edf` becomes `/data/recordings/sleep-study_csv`. The directory is created if it doesn't exist, including missing parents.

If the destination already exists, the conversion stops before writing anything:

```
error: "/data/csv/sleep-study" already exists.
       Pass --force to overwrite it, or --out to choose a different directory.
```

`-f, --force` allows writing into an existing directory. It overwrites files of the same name; it doesn't empty the directory first. That matters when two runs produce different file names. Converting a mixed-rate recording writes `signals_256hz.csv` and `signals_1hz.csv`; converting a single-rate recording into the same directory afterwards writes `signals.csv` and leaves the two older files beside it, both looking current. Nothing is deleted automatically, but you're told:

```
warning: signals_128hz.csv, signals_1hz.csv, signals_256hz.csv are left over from an
         earlier conversion into this directory and were not rewritten.
         Delete them, or convert into a fresh directory, so the two runs do not get mixed up.
```

If the destination path exists but is a regular file rather than a directory, that's an error with its own message. `--force` means "replace my previous output", not "write into whatever this happens to be".

## -i, --info

Prints a description of the recording to stdout and exits without writing anything. `--info` reads only the header for plain EDF and continuous EDF+, so it returns in milliseconds whatever the file's size. A discontinuous (EDF+D) recording is the exception: where each record sits in time is stored in the annotation channel, so that channel is scanned to get the span and the row estimate right.

```bash
edf2csv sleep-study.edf --info
```

```
File       sleep-study.edf
Format     EDF+ (continuous)
Recorded   2019-11-04 22:15:00
Duration   8h 12m 30s  (29550 records of 1s)
Size       25.1 MB

Channels   3 signals + 1 annotation channel

#  COLUMN       LABEL        UNIT  RATE    RANGE        OUTPUT
0  EEG Fpz-Cz   EEG Fpz-Cz   uV    256 Hz  -250 to 250  signals_256hz.csv
1  ECG          ECG          mV    128 Hz  -5 to 5      signals_128hz.csv
3  Temp rectal  Temp rectal  degC  1 Hz    34 to 40     signals_1hz.csv

Sampling rates differ, so channels are written to 3 files, one per rate. No channel is resampled.
Would write 11,376,750 rows, roughly 282 MB.
```

Reading the table:

- The `#` column is the channel's position in the file, counted over every channel including the annotation channel. That's why the numbering can skip, as it does above where channel 2 is `EDF Annotations`. Those `#` values are what the `#N` form of `--channels` addresses.
- `COLUMN` is the CSV column header the channel will get, and `LABEL` is the raw label from the header. They differ only when a label is duplicated or empty (see below).
- `OUTPUT` names the file the channel would land in, or `(not selected)` when `--channels` excludes it.
- The row and byte estimates honour `--channels`, `--start`, `--duration`, `--end`, `--decimals` and `--annotations-only`, so the figures describe the command you actually typed. With `--annotations-only` the signal channels read `(not selected)` and the estimate is 0 rows, because that run would write no signal data.
- If the recording has a `Patient` or `Recording` identification field, it's echoed above the table. EDF headers commonly carry patient identifiers, so treat `--info` output as sensitive before pasting it into a ticket.
- Header text is free text from the file, so control bytes in it are printed as their escape (`\x1b`, `\x0d`) rather than sent to the terminal. A header carrying ANSI sequences would otherwise be able to clear your screen or repaint the output. `channels.csv` and `metadata.json` still record the field verbatim.

Warnings raised while parsing the header — mixed rates, a truncated file, a degenerate calibration — go to stderr, never into the table.

## -c, --channels

Restricts the conversion to a subset of channels. Channels that are left out still appear in `channels.csv` with `converted` set to `no`, so the output documents the whole recording.

The flag can be repeated, and each occurrence can hold a comma-separated list. These three invocations are identical:

```bash
edf2csv recording.edf --channels "EEG Fpz-Cz,ECG"
edf2csv recording.edf -c "EEG Fpz-Cz" -c ECG
edf2csv recording.edf -c "EEG Fpz-Cz, ECG"
```

Terms are trimmed, so spaces after the commas are fine, and empty terms are dropped. Passing the flag with nothing usable in it is a usage error rather than a silent "convert everything":

```
error: --channels was given but lists no channel names.
```

### Matching rules

A term matches a channel when it equals that channel's **label**, compared case-insensitively, with no partial or prefix matching and no wildcards. `ecg` matches `ECG`; `EEG Fpz` matches nothing. Labels routinely contain spaces and punctuation, so quote them in the shell.

Match against the label from the `LABEL` column of `--info`, not the `COLUMN` name. Where the two differ, the label is the one that works: in a file with two channels labelled `T8-P8`, the columns are named `T8-P8_ch0` and `T8-P8_ch1`, but `--channels "T8-P8_ch0"` matches nothing and errors out.

The EDF+ annotation channel can't be selected. It isn't a signal, it's never a column in `signals.csv`, and asking for `EDF Annotations` by name is an unknown-channel error. Annotations are exported through `annotations.csv` instead, automatically.

Selection order doesn't affect column order. Channels always appear in file order within their rate group, so `-c "ECG,EEG Fpz-Cz"` and `-c "EEG Fpz-Cz,ECG"` produce byte-identical output.

### Selecting by position with #N

`#N` selects the channel at position `N`, using the same numbering as the `#` column of `--info`:

```bash
edf2csv recording.edf --channels "#0,#3"
```

Use this to reach one specific channel when two share a label. If no channel sits at that position, the error lists the positions that do exist:

```
error: No channel at position #9. This file has signal channels at #0, #1, #2.
```

The listed positions are signal channels only, so an annotation channel's index isn't offered even though it consumes a number.

### Duplicated labels

EDF doesn't require labels to be unique, and real recordings break the assumption. Published scalp EEG collections routinely contain files with two separate channels both labelled `T8-P8`, and some carry a channel whose label is nothing but `-`. edf2csv handles this in two places.

In the output, duplicated labels are disambiguated by appending the channel's position: `T8-P8_ch0` and `T8-P8_ch1`. The suffix is derived from the whole file, not from your selection, so a channel gets the same column name whether you converted all channels or just that one. A channel with an empty label becomes `signal_<index>`.

In `--channels`, a term matching several channels selects **all** of them and warns:

```
warning: "T8-P8" matches 2 channels (positions #0, #1); all of them were selected.
         Use --channels "#0" to pick just one.
```

Taking the first silently would drop data you asked for, and refusing outright would make the file unconvertible by label. To get one channel, use `#N`.

### Typos

A term that matches nothing is an error rather than a quiet omission, since dropping a requested channel would produce a CSV missing data you asked for with nothing in the file recording that it happened. Close labels are offered as suggestions, up to three of them, ranked by edit distance:

```bash
edf2csv recording.edf --channels ECQ
```

```
error: No channel named "ECQ". Did you mean "ECG"?
Run with --info to list the channels in this file.
```

Suggestions appear only when a label is close enough: within an edit distance of 2, or one third of the term's length for longer terms. A term with nothing similar in the file gets the bare error and the pointer to `--info`.

### Labels that literally start with #

A channel whose label really is `#5` is reachable. When a term begins with `#`, edf2csv first checks whether any channel carries that exact label; if one does, the label wins and the positional interpretation isn't attempted. The positional form is a fallback, so no channel can be made unreachable by an unusual label.

### Interaction with --annotations-only

`--annotations-only` skips signal output entirely, so the selection has nothing to act on — but the names are still checked. A term matching no channel is a usage error in this mode too, so a typo is reported rather than silently accepted.

## Time range: --start, --duration, --end

`--start` sets the first offset to include, `--duration` says how much to take from there, and `--end` gives an absolute offset to stop at. All three are measured in seconds from the start of the recording, not wall-clock times of day.

`--duration` and `--end` are mutually exclusive. Passing both is a usage error:

```
error: Use either --duration or --end, not both.
```

Every other combination is legal. `--start` alone runs from that offset to the end. `--duration` alone takes that much from the beginning. `--end` alone runs from the beginning to that offset.

### Accepted formats

The same parser handles all three flags. Values are case-insensitive.

| Form | Examples | Meaning |
| --- | --- | --- |
| Plain number | `90`, `90.5`, `0` | Seconds |
| Clock, with hours | `00:30:00`, `1:02:03.5` | `hh:mm:ss`, fractional seconds allowed |
| Clock, without hours | `30:00` | `mm:ss` |
| Units | `30s`, `5m`, `1h`, `250ms` | A number followed immediately by its unit |
| Compound units | `1h30m`, `1h30m 15s` | Terms are summed |

Recognised units are `h`, `hr`, `hrs`, `hour`, `hours`; `m`, `min`, `mins`, `minute`, `minutes`; `s`, `sec`, `secs`, `second`, `seconds`; and `ms` for milliseconds. Note that `m` is minutes and `ms` is milliseconds.

Each unit may appear once. `1h30m20s` is fine and so is `1h30min`, but `1h1h` is rejected rather than summed to two hours — a repeated unit is a typo far more often than it is a request, and silently adding it up produces a window that is quietly the wrong length. Aliases count as the same unit, so `30m20min` is caught too.

Two details of the unit form. A number must sit directly against its unit, with no space between them: `5min` is accepted and `5 min` isn't. Space between separate terms is fine, so `1h30m 15s` works. And a number must lead with a digit: `1.5h` is accepted, `.5` isn't.

In the clock form, the minutes and seconds fields must be below 60, so `60:00` is rejected rather than read as an hour. The hours field is unbounded, which lets `100:00:00` express a long offset.

Rejections say what went wrong:

```
error: --start "5x" uses an unknown unit "x". Use h, m, s, or ms.
error: --start "1h banana" is not a time I understand. Try 30s, 5m, 1h30m, 00:30:00, or a plain number of seconds.
error: --duration is empty. Try a value like 30s, 5m, or 00:30:00.
```

### How the window is resolved

The window is half-open: a sample at exactly the start offset is included, a sample at exactly the end offset isn't. A requested end past the end of the recording is clamped silently, so `--end 999h` on a two-hour file converts to the end. A start at or past the end of the recording is an error, because the result would be an empty file that looks like a successful conversion:

```
error: --start 4h is at or past the end of this 2h 12m 30s recording.
```

An end that isn't after the start is likewise an error.

Sample times in the output are absolute offsets into the recording, not relative to `--start`. Converting from `30m` produces a `time_s` column beginning at `1800`, so a windowed export lines up with the full one.

`annotations.csv` is filtered by the same window: events whose onset falls inside it are kept, events outside it are dropped. The annotation channel is still read in full regardless of the window, because an event that occurs inside the window can be stored in a data record outside it.

For discontinuous (EDF+D) recordings the window is resolved against real recording time, not against the amount of data present. A ten-second recording with a ninety-five-second gap in the middle ends at 105 seconds, and `--end 100s` means 100 seconds on that timeline. Every data record whose own span overlaps the window is read.

```bash
# Five minutes starting half an hour in.
edf2csv sleep-study.edf --start 30m --duration 5m

# The same window, written the other way.
edf2csv sleep-study.edf --start 00:30:00 --end 00:35:00
```

## --annotations-only

Writes the EDF+ event list and nothing else. The output directory gets `annotations.csv`, `channels.csv` and `metadata.json`, with no signal files. It's fast, since no data records are converted, and it's what you want when you need a scoring or event file out of a large recording without the samples.

`--start`, `--duration` and `--end` still filter the events. `--channels` is ignored, as described above.

On a recording with no annotation channel, the conversion still succeeds and still writes `channels.csv` and `metadata.json`, with a warning:

```
warning: --annotations-only was requested but this recording has no annotation channel,
         so there are no events to export.
         Plain EDF files carry no annotations. Convert without --annotations-only to get
         the signals.
```

## --decimals

Takes a whole number from 0 to 20 and applies it to every signal column, replacing the per-channel precision edf2csv would otherwise derive.

By default the precision is chosen per channel from its calibration. A channel's smallest expressible step is its physical range divided by its digital range, and the default is two places beyond that step, so two adjacent digital codes never round to the same text and no digits are written that carry no information. An ordinary microvolt EEG channel lands at 3 or 4 decimals; a channel calibrated in volts needs more, which is why the ceiling is 20.

Use `--decimals` when you want a uniform column width across channels, or when you're willing to trade precision for file size. Note what you give up: `--decimals 2` on a channel whose step is 0.0076 uV maps several genuinely different digital codes onto the same printed value.

`--decimals` doesn't affect the `time_s` column, whose precision is derived from the sampling rate so that sample times are exact rather than rounded. It doesn't affect `channels.csv`, `annotations.csv` or `metadata.json` either.

Out-of-range and non-integer values are usage errors. An empty value is rejected explicitly rather than read as zero, since `--decimals ""` would otherwise round every physical value to a whole number:

```
error: --decimals must be a whole number between 0 and 20, got "16".
error: --decimals needs a number, for example --decimals 3.
```

## --checksum

Computes a SHA-256 of the input file and records it in `metadata.json` under `source.sha256`. Without the flag that field is `null`.

This costs one extra full read of the input. It's useful when the CSV outlives the source and you need to establish later which file it came from. The rest of `source` — resolved path, byte size, modification time — is recorded either way.

## --stdout

Writes the signal CSV to stdout and creates no directory, for feeding a conversion straight into
something else:

```bash
edf2csv recording.edf --stdout | duckdb -c "SELECT count(*) FROM read_csv('/dev/stdin')"
```

Only the samples are written — no `channels.csv`, `annotations.csv` or `metadata.json`, since a
stream holds one table. For the same reason it needs the recording to produce exactly one, and
refuses a mixed-rate file rather than merging tables that have different row counts:

```
error: --stdout needs exactly one table, but this recording produces 3 (its channels use 3 different sampling rates).
       Narrow it to one rate with --channels, or convert to a directory instead.
```

`--channels` is usually the answer, since selecting channels that share a rate leaves one table. The
row count still goes to stderr, so stdout carries nothing but CSV, and the progress meter is never
drawn in this mode.

`--stdout` and `--json` cannot be combined: both write to stdout, and together they would produce a
document that is neither valid CSV nor valid JSON. Passing both is a usage error (exit 2).

## -q, --quiet

Suppresses the closing summary and the progress meter. It doesn't suppress warnings or errors: a conversion that raises a warning about mixed sampling rates or a truncated file still says so on stderr under `--quiet`, because those describe your data rather than the tool's own status. A clean conversion under `--quiet` prints nothing at all and exits 0.

The progress meter is separate from the summary. It's drawn only when `--quiet` is off, `--json` is off, and stderr is a terminal. In a script, in a pipeline, or under `nohup`, it never appears, so log files don't fill with carriage returns. It updates at most ten times a second and erases itself when the conversion finishes.

## --json

Prints a summary object to stdout as JSON and suppresses the human-readable summary. Warnings that would otherwise go to stderr are carried inside the object instead, so with `--json` the whole result of a successful run is one parseable document on stdout and stderr stays empty.

Here's a complete run over a short three-second, three-channel recording with an annotation channel:

```bash
edf2csv recording.edf --out ./converted --json
```

```json
{
  "output_dir": "./converted",
  "files": [
    { "name": "signals_256hz.csv", "rows": 768 },
    { "name": "signals_128hz.csv", "rows": 384 },
    { "name": "signals_1hz.csv", "rows": 3 },
    { "name": "annotations.csv", "rows": 12 },
    { "name": "channels.csv", "rows": 3 }
  ],
  "annotations": 12,
  "duration_seconds": 3,
  "records": 3,
  "elapsed_ms": 38,
  "warnings": [
    {
      "code": "MIXED_SAMPLING_RATES",
      "severity": "warning",
      "message": "Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz)."
    }
  ]
}
```

Field by field:

| Field | Meaning |
| --- | --- |
| `output_dir` | The directory that was written, exactly as it will be found on disk |
| `files` | Every CSV written, in the order it was produced, with its data-row count excluding the header line. `metadata.json` isn't listed |
| `annotations` | Number of events written to `annotations.csv`, after time-window filtering. `0` when the recording has no annotation channel |
| `duration_seconds` | Duration of the whole recording, not of the converted window |
| `records` | Number of data records the file actually contains, which can differ from the count its header declares |
| `elapsed_ms` | Wall-clock time for the conversion |
| `warnings` | One entry per diagnostic, each with a stable `code`, a `severity` of `"warning"` or `"info"`, and a human-readable `message`. Empty array when there's nothing to report |

The `code` values are stable identifiers meant for programmatic checks: `MIXED_SAMPLING_RATES`, `DISCONTINUOUS`, `RECORD_COUNT_MISMATCH`, `RECORD_COUNT_UNKNOWN`, `TRAILING_BYTES`, `DUPLICATE_LABEL`, `EMPTY_LABEL`, `LARGE_OUTPUT`, `STALE_OUTPUT`, `ANNOTATION_DECODE_FAILED`, `DEGENERATE_DIGITAL_RANGE`, `DEGENERATE_PHYSICAL_RANGE`, `UNUSABLE_PHYSICAL_RANGE`, `INVERTED_PHYSICAL_RANGE`, `COMMA_DECIMAL`, `NO_ANNOTATIONS`, `NO_SIGNAL_CHANNELS`, `NO_SAMPLES` and `HEADER_BYTES_MISMATCH`. Match on `code`, not on `message`.

`--json` applies to both. On a conversion it prints the summary object below; with `--info` it prints the recording's description as JSON instead of the table — the same fields, shaped for surveying a directory of recordings from a script. In both cases warnings travel inside the document and stderr stays empty. On failure, nothing is printed to stdout at all, so a parse failure and a non-zero exit code always coincide.

To fail a batch job on any warning:

```bash
edf2csv recording.edf --out ./converted --json > result.json || exit 1
if [ "$(jq '.warnings | length' result.json)" -gt 0 ]; then
  jq -r '.warnings[] | "\(.code): \(.message)"' result.json
  exit 1
fi
```

## -h, --help and -V, --version

`-h, --help` prints the usage text to stdout and exits 0. `-V, --version` prints the version on its own line and exits 0. Both are handled before any other argument checking, so `edf2csv --help` works with no input file and `edf2csv --version` works even alongside an invalid one.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. The requested output was written, or `--info` or `--help` or `--version` printed |
| `1` | The file or the destination is the problem |
| `2` | The command line is the problem |

**Exit 2** covers anything decided before touching data:

- An unrecognised flag, a flag missing its argument, or a value where none is expected. The message is followed by `Run edf2csv --help to see the options.`
- No input file, or more than one input file.
- An unparseable `--start`, `--duration` or `--end`, and passing `--duration` together with `--end`.
- A time window that can't apply: a start at or past the end of the recording, or an end at or before the start.
- A `--channels` term that matches no channel, a `#N` position that doesn't exist, or `--channels` given with an empty list.
- A `--decimals` value that's empty, not an integer, or outside 0 to 20.

The last two categories require reading the file's header first, so exit 2 doesn't mean the file was never opened. It means the command as written can't be carried out.

**Exit 1** covers everything else that stops the run:

- The input can't be read: it doesn't exist, permission is denied, it's a directory, or it isn't a regular file.
- The file isn't usable as EDF: smaller than a 256-byte header, a header field that isn't a number, zero or negative signal count, a non-positive record duration, no complete data record, or no channel carrying any samples.
- The file changes size mid-read, which happens when a recording is still being written.
- The output directory already exists and `--force` wasn't given, or the destination path is a regular file, or it can't be created.
- A write fails partway through, for example because the disk fills. The message says explicitly that the files written so far are incomplete and must not be used.

Warnings never change the exit code by default. A conversion that reports a truncated recording, mixed sampling rates or a discontinuous file still exits 0, because the output it produced is correct and complete for the data that was there.

Pass `--strict` to turn any warning into exit 1:

```bash
edf2csv recording.edf --strict || echo "check the warnings before using this"
```

The output is still written. A warning describes the recording rather than a failure to convert it, so discarding the work would be the wrong response — the exit code is the signal, and the files are there to inspect. `--strict` works with `--info` too, which makes it a cheap way to screen a directory for recordings that need a closer look before anyone converts them.

Errors are printed as a single `error:` line plus an optional indented hint. Node stack traces are never printed for any of the conditions above.

## stdout and stderr

**stdout carries the result you asked for; stderr carries everything else.**

| Stream | Contents |
| --- | --- |
| stdout | The `--info` table, the `--json` summary, the `--help` usage text, the `--version` string |
| stderr | Warnings, the progress meter, the closing "Wrote ..." summary, all error messages |

That's why a normal conversion prints nothing to stdout. The result of a conversion is a directory of files rather than text, so there's nothing to put there. The summary goes to stderr:

```
Wrote /data/csv/sleep-study
  signals_256hz.csv  7,564,800  rows
  signals_128hz.csv  3,782,400  rows
  signals_1hz.csv       29,550  rows
  annotations.csv           12  rows
  channels.csv               3  rows
Done in 2.3s.
```

The split keeps stdout parseable. You can pipe `--info` or `--json` straight into another program without warnings landing in the middle of it, and still see the warnings on your terminal:

```bash
# The channel table goes into the file; the mixed-rate warning still reaches the terminal.
edf2csv sleep-study.edf --info > channels.txt

# Feed the summary to jq while warnings stay visible.
edf2csv sleep-study.edf --json | jq -r '.files[] | "\(.name)\t\(.rows)"'
```

Output is plain text with no colour codes and no terminal escapes, in both streams, so redirecting to a file or a log gives exactly what appeared on screen. The one exception is the progress meter, which uses carriage returns and only draws when stderr is an interactive terminal.

Closing stdout early isn't treated as a failure. `edf2csv recording.edf --info | head -5` exits 0 rather than reporting a broken pipe, which is what a shell pipeline expects.
