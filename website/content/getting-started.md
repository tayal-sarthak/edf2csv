---
title: Getting started
description: Install edf2csv, convert your first recording, and understand each of the files it writes
order: 1
---

## What edf2csv is

edf2csv is a command-line tool that reads an EDF, EDF+ or BDF/BDF+ biosignal recording — EEG, sleep, ECG, EMG — and writes it out as CSV. Alongside the data it writes a channel table, the EDF+ events, and a metadata file describing what was converted.

It runs entirely on your own machine, it doesn't alter the recorded values, and it never resamples a channel to make the output table tidier.

## Requirements

Node 20 or newer, and nothing else. edf2csv installs no dependencies at all, makes no network calls, and is MIT licensed. To check what you have:

```bash
node --version
```

## Running it

The quickest route is `npx`, which fetches the tool on demand and leaves nothing installed:

```bash
npx edf2csv recording.edf
```

If you convert files regularly, install it once:

```bash
npm install -g edf2csv
```

After a global install the command is just `edf2csv`. The rest of this page uses that form; add `npx` in front of every command if you skipped the install.

## Your first conversion

Point it at a file. No flags are required.

```bash
edf2csv recording.edf
```

For a small EDF+ file holding one 100 Hz EEG channel and three events, the output is:

```text
Wrote recording_csv
  signals.csv      300  rows
  annotations.csv    3  rows
  channels.csv       1  row
Done in 0.0s.
```

Some notes on that:

- The output directory defaults to the input filename with its extension replaced by `_csv` — `recording.edf` becomes `recording_csv` — created next to the input file. Use `-o` or `--out` to put it somewhere else.
- If that directory already exists, edf2csv leaves it alone and exits with status 1. Pass `--force` to overwrite it, or `--out` to write elsewhere, so a new conversion never mixes into an old one.
- The summary, any warnings, and the live `converting… 42%` progress line all go to stderr. Only `--info` and `--json` write to stdout — along with `--stdout`, which puts the signal CSV itself there, and `--help` and `--version`, which print and exit — so you can pipe results straight into another program.
- Exit status is 0 on success, 1 when a file couldn't be read or written — or when `--strict` was given and the recording raised a warning, where the output is written anyway — and 2 when the command itself was wrong: an unknown flag, or a channel name that doesn't exist. An interrupted run exits 130 for Ctrl-C, or 143 when something sends SIGTERM.
- `--quiet` suppresses the summary. Warnings and errors still print.

Conversion is streamed rather than loaded into memory. A 40 MB EDF that expands into a 159 MB CSV converts in roughly 1.4 seconds with the Node heap capped at 48 MB, so file size affects disk space rather than memory.

## What is in the output directory

```text
recording_csv/
  signals.csv       the data: one row per sample time, one column per channel
  channels.csv      one row per channel in the recording, with its calibration
  annotations.csv   EDF+ events, written only when the file has an annotation channel
  metadata.json     what was read, what was written, and every warning raised
```

### signals.csv

The first column is `time_s`, seconds elapsed from the start of the recording. Every other column is a channel, named with the label exactly as the file stores it, spaces and punctuation included.

```csv
time_s,EEG Fpz-Cz
0.000,0.061
0.010,15.324
0.020,30.464
```

The number of decimals in `time_s` is chosen so the sample interval is written exactly rather than rounded. At 100 Hz that's three places, as above. At 256 Hz it's eight, so a row reads `0.00390625` and multiplying `time_s` by the rate gives back a whole number instead of something like 8191.999999. That works whenever `1 / rate` terminates in decimal, which covers every rate a recording is likely to use; a rate whose reciprocal does not terminate, such as 3 Hz, is rounded instead, and [Output files](/docs/output-files#how-many-decimals-time_s-carries) says which rates those are.

If two channels in the file share a label, both column names get a `_ch` suffix carrying the channel's position — `T8-P8_ch0`, `T8-P8_ch1` — since position is the only thing that reliably tells them apart.

If the recording mixes sampling rates, there's no single `signals.csv`. You get `signals_256hz.csv`, `signals_1hz.csv` and so on, one file per rate, with nothing interpolated — or one file of `time_s,channel,value` if you pass [`--layout long`](/docs/cli-reference#--layout). See [Mixed sampling rates](/docs/sampling-rates) for the details.

### channels.csv

One row per signal channel, whether or not it was converted. The columns are `column`, `signal_index`, `label`, `unit`, `sampling_rate_hz`, `samples_per_record`, `physical_min`, `physical_max`, `digital_min`, `digital_max`, `transducer`, `prefiltering`, `output_file` and `converted`.

`column` is the name that channel has in the signal CSV, `output_file` says which file it landed in, and `converted` is `yes` or `no`. A channel you filtered out with `--channels` is still listed here rather than disappearing.

### annotations.csv

Written only for EDF+ and BDF+ recordings that carry an annotation channel. Plain EDF files have no events to export.

```csv
onset_s,duration_s,description,record_index
0.5,1,Sleep stage W,0
1.25,,Lights off,1
2,0.5,Seizure onset,2
```

`onset_s` is on the same clock as `time_s` in the signal files. `duration_s` is empty for an event that has no stated duration, and also for one whose stated duration is not a number — the run warns when that happens. `record_index` is the data record the event was stored in.

### metadata.json

Machine-readable provenance: the tool version, the source path, size and modification time, the recording's format, start time, record count and duration, the exact window converted, the row count of every file written, and the full list of warnings. Add `--checksum` to record a SHA-256 of the input file alongside it.

## Check a file before you convert it

`--info` reads the header, and on an EDF+ recording a little of the annotation channel: at most sixteen records of a continuous file to find where it begins, stopping at the first that says, and the whole channel for a discontinuous one, whose record times are stored rather than arithmetic. It returns in milliseconds whatever the file's size either way, and writes nothing. [What it can and cannot tell you](/docs/warnings-and-errors#how-edf2csv-reports-problems) sets out which warnings follow from that.

```bash
edf2csv sleep-study.edf --info
```

```text
File       sleep-study.edf
Format     EDF+ (continuous)
Recorded   2002-03-02 23:10:00
Duration   8h 00m 0s  (28800 records of 1s)
Size       18.7 MB
Patient    X X X X
Recording  Startdate 02-MAR-2002 X X X

Channels   5 signals + 1 annotation channel

#  COLUMN          LABEL           UNIT  RATE    RANGE        OUTPUT
0  EEG Fpz-Cz      EEG Fpz-Cz      uV    100 Hz  -250 to 250  signals_100hz.csv
1  EEG Pz-Oz       EEG Pz-Oz       uV    100 Hz  -250 to 250  signals_100hz.csv
2  EOG horizontal  EOG horizontal  uV    100 Hz  -250 to 250  signals_100hz.csv
3  Resp oro-nasal  Resp oro-nasal  V     10 Hz   -1 to 1      signals_10hz.csv
4  Temp rectal     Temp rectal     degC  1 Hz    34 to 40     signals_1hz.csv

Sampling rates differ, so channels are written to 3 files, one per rate. No
channel is resampled.
Would write 3,196,800 rows, roughly 108 MB.
```

Anything the tool noticed is printed after the table, on stderr — for this recording, two things:

```text
warning: Channels use 3 different sampling rates (100 Hz, 10 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
warning: At least one output file will have more than 1,048,576 rows, which is more than Excel or Numbers can open.
         Use --start and --duration to convert a section, or read the file with
         pandas or R.
```

The second is the spreadsheet limit, which [Can I open the output in Excel?](/docs/faq#can-i-open-the-output-in-excel) goes into.

On a long recording, `--info` tells you four things before you spend any disk:

- The row count and approximate output size.
- The exact channel labels to pass to `--channels`, spelled the way the file spells them.
- Whether the recording is discontinuous or mixed-rate.
- Any header problem — a truncated file, a record count that disagrees with the data, a channel whose calibration can't be applied.

Because the table goes to stdout and the warnings go to stderr, `edf2csv sleep-study.edf --info > structure.txt` saves the table on its own. Over a folder each warning carries the recording it came from, the way a batch conversion does — several warnings in a row are otherwise unattributable, since the tables they belong to went to the other stream.

## Convert a slice instead of the whole recording

Give a start, then either a duration or an end.

```bash
edf2csv sleep-study.edf --start 30m --duration 5m
```

```bash
edf2csv sleep-study.edf --start 1h --end 1h05m
```

Times can be a plain number of seconds (`90`), a unit form (`90s`, `5m`, `1h30m`, `250ms`), or a clock form (`00:30:00`, `30:00`). All offsets are measured from the start of the recording, not from the wall clock in the header. Passing `--duration` and `--end` together is an error, since they answer the same question.

Combine a window with a channel filter and a destination:

```bash
edf2csv sleep-study.edf --start 1h --duration 5m \
  --channels "EEG Fpz-Cz,EOG horizontal" --out ./epoch-42
```

Channel names must match the `LABEL` column from `--info`, though matching is case-insensitive. A name that matches nothing is an error rather than a silent omission. When two channels share a label, address one by position with `#N`, for example `--channels "#0"`.

Two things to expect from a slice:

- `time_s` isn't rebased. A window starting at one hour begins at `3600.000`, so rows stay comparable with the full recording and with the events.
- `annotations.csv` is filtered to the same window, so you get the events inside the slice.

## Opening the result

### pandas

```python
import pandas as pd

signals = pd.read_csv("recording_csv/signals.csv")
eeg = signals["EEG Fpz-Cz"]

channels = pd.read_csv("recording_csv/channels.csv")
print(channels[["column", "unit", "sampling_rate_hz"]])
```

Pass `index_col="time_s"` to `read_csv` to get time as the index rather than as a column.

### R

```r
signals <- read.csv("recording_csv/signals.csv", check.names = FALSE)
eeg <- signals[["EEG Fpz-Cz"]]
plot(signals$time_s, eeg, type = "l", xlab = "time (s)", ylab = "uV")
```

Without `check.names = FALSE`, R rewrites `EEG Fpz-Cz` into `EEG.Fpz.Cz` and the column names no longer match the ones in `channels.csv` or in the original file.

### Excel and Numbers

Open `signals.csv` directly. It's plain UTF-8 CSV with a header row and needs no import wizard. The limit is the row count: spreadsheets stop at 1,048,576 rows including the header, which is about 68 minutes of a single 256 Hz channel. edf2csv warns you before writing when any output file would exceed that:

```text
warning: At least one output file will have more than 1,048,576 rows, which is more than Excel or Numbers can open.
         Use --start and --duration to convert a section, or read the file with
         pandas or R.
```

`channels.csv`, `annotations.csv` and short slices open in a spreadsheet without trouble. Full-length signal files usually don't.

Two things are worth knowing before you double-click the file, and this page used to mention
neither.

Excel on Windows reads a CSV with no byte order mark in the system code page rather than as UTF-8,
so `µV` — one character, two bytes of UTF-8 — arrives as `Âµ` in the unit column and in any accented
patient or channel text. [`--bom`](/docs/cli-reference#--bom) writes the mark that tells it
otherwise:

```bash
edf2csv recording.edf --bom
```

It is off by default because it is not free: `csv.reader` over a plain `open()` in Python, and
`fs.readFileSync(path, 'utf8')` in Node, both hand back the first column name as `\ufefftime_s`,
so a lookup of `time_s` misses. pandas strips it either way. Use it when the destination is Excel,
leave it off when the destination is code.

And if the conversion raised [`FORMULA_LABEL`](/docs/warnings-and-errors#formula_label), a channel's
label or unit starts with `=`, `+` or `@`, which a spreadsheet runs as a formula rather than showing
as text. Open that one through the import path instead — Data → From Text/CSV in Excel with the
column set to Text — or read it with pandas or R, which evaluate nothing.

## Where to go next

- [Output files](/docs/output-files) describes every column of every file the conversion writes, including the whole of `metadata.json`.
- [CLI reference](/docs/cli-reference) lists every flag, the exit codes, and the `--json` summary for scripting.
- [Mixed sampling rates](/docs/sampling-rates) explains why a mixed-rate recording becomes several files, and what other tools do instead.
