---
title: Getting started
description: Convert an EDF, EDF+ or BDF recording to CSV with one command, and know exactly what comes back
order: 1
---

## What edf2csv is

edf2csv is a command-line tool that reads an EDF, EDF+ or BDF/BDF+ biosignal recording (EEG, sleep, ECG, EMG) and writes it out as CSV, together with a channel table, the EDF+ events, and a metadata file describing exactly what was converted. It runs entirely on your own machine, it does not alter the recorded values, and it never resamples a channel to make the output table look tidier.

## Requirements

Node 20 or newer, and nothing else. edf2csv has zero runtime dependencies, makes no network calls, and is MIT licensed. Check what you have:

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

After a global install the command is just `edf2csv`. The rest of this page uses that form; put `npx` in front of every command if you skipped the install.

## Your first conversion

Point it at a file and stop there. No flags are required.

```bash
edf2csv recording.edf
```

For a small EDF+ file holding one 100 Hz EEG channel and three events, this is the whole of what appears:

```text
Wrote recording_csv
  signals.csv      300  rows
  annotations.csv    3  rows
  channels.csv       1  rows
Done in 0.0s.
```

A few things worth knowing about that:

- The output directory defaults to the input filename with `_csv` appended, created next to the input file. Use `-o` or `--out` to put it somewhere else.
- If that directory already exists, edf2csv refuses to touch it and exits with status 1. Pass `--force` to overwrite, or `--out` to write elsewhere. It will not silently mix a new conversion into an old one.
- The summary, any warnings, and the live `converting… 42%` progress line all go to stderr. Only `--info` and `--json` write to stdout, so you can pipe results into another program without the chatter contaminating them.
- Exit status is 0 on success, 1 when a file could not be read or written, and 2 when the command itself was wrong (an unknown flag, a channel name that does not exist).
- `--quiet` suppresses the summary. Warnings and errors still print, because those are the ones you need.

Conversion is streamed rather than loaded into memory. A 40 MB EDF that expands into a 159 MB CSV converts in roughly 1.4 seconds with the Node heap capped at 48 MB, so file size is a disk question, not a RAM question.

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

The number of decimals in `time_s` is chosen so the sample interval is written exactly rather than rounded. At 100 Hz that is three places, as above. At 256 Hz it is eight, so a row reads `0.00390625` and multiplying `time_s` by the rate gives back a whole number instead of something like 8191.999999.

If two channels in the file share a label, both column names get a `_ch` suffix carrying the channel's position (`T8-P8_ch0`, `T8-P8_ch1`), because position is the only thing that reliably tells them apart.

If the recording mixes sampling rates, there is no single `signals.csv`. You get `signals_256hz.csv`, `signals_1hz.csv` and so on, one file per rate, with nothing interpolated. See Sampling rates for why.

### channels.csv

One row per signal channel, whether or not it was converted. The columns are `column`, `signal_index`, `label`, `unit`, `sampling_rate_hz`, `samples_per_record`, `physical_min`, `physical_max`, `digital_min`, `digital_max`, `transducer`, `prefiltering`, `output_file`, `converted`. The `column` field is the name that channel has in the signal CSV, `output_file` says which file it landed in, and `converted` is `yes` or `no`, so a channel you filtered out with `--channels` is still documented rather than vanishing.

### annotations.csv

Present only for EDF+ and BDF+ recordings that carry an annotation channel. Plain EDF files have no events to export.

```csv
onset_s,duration_s,description,record_index
0.5,1,Sleep stage W,0
1.25,,Lights off,1
2,0.5,Seizure onset,2
```

`onset_s` is on the same clock as `time_s` in the signal files. `duration_s` is empty for an event that has no stated duration. `record_index` is the data record the event was stored in.

### metadata.json

Machine-readable provenance: the tool version, the source path, size and modification time, the recording's format, start time, record count and duration, the exact window converted, the row count of every file written, and the full list of warnings. Add `--checksum` to record a SHA-256 of the input file alongside it.

## Check a file before you convert it

`--info` reads the header only and writes nothing. It returns immediately whatever the file's size, which is why it is the right first move on a long recording.

```bash
edf2csv sleep-study.edf --info
```

```text
File       sleep-study.edf
Format     EDF
Recorded   1985-01-01 00:00:00 UTC
Duration   3s  (3 records of 1s)
Size       3.3 KB
Patient    X X X X
Recording  Startdate X X X X

Channels   3 signals

#  COLUMN       LABEL        UNIT  RATE    RANGE        OUTPUT
0  EEG Fpz-Cz   EEG Fpz-Cz   uV    256 Hz  -250 to 250  signals_256hz.csv
1  ECG          ECG          mV    128 Hz  -5 to 5      signals_128hz.csv
2  Temp rectal  Temp rectal  degC  1 Hz    34 to 40     signals_1hz.csv

Sampling rates differ, so channels are written to 3 files, one per rate. No channel is resampled.
Would write 1,155 rows, roughly 27.4 KB.
```

Anything the tool noticed is printed after the table, on stderr:

```text
warning: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
```

On a real overnight study this matters for four reasons. You learn the row count and approximate size before spending the disk. You get the exact channel labels to hand to `--channels`, spelled the way the file spells them. You find out whether the recording is discontinuous or mixed-rate before you build an analysis on the assumption that it is neither. And you see any header problem (a truncated file, a record count that disagrees with the data, a channel whose calibration cannot be applied) while it is still cheap to react.

Because the table goes to stdout and the warnings go to stderr, `edf2csv sleep-study.edf --info > structure.txt` saves the table on its own.

## Convert a slice instead of the whole recording

Give a start, then either a duration or an end.

```bash
edf2csv sleep-study.edf --start 30m --duration 5m
```

```bash
edf2csv sleep-study.edf --start 1h --end 1h05m
```

Times can be a plain number of seconds (`90`), a unit form (`90s`, `5m`, `1h30m`, `250ms`), or a clock form (`00:30:00`, `30:00`). All offsets are measured from the start of the recording, not from the wall clock in the header. `--duration` and `--end` together is an error, since they answer the same question.

Combine a window with a channel filter and a destination:

```bash
edf2csv sleep-study.edf --start 1h --duration 5m \
  --channels "EEG Fpz-Cz,ECG" --out ./epoch-42
```

Channel names must match the `LABEL` column from `--info`, though matching is case-insensitive. A name that matches nothing is an error rather than a silent omission, so you never get a CSV that is quietly missing a channel you asked for. When two channels share a label, address one by position with `#N`, for example `--channels "#0"`.

Two details to expect from a slice. The `time_s` column is not rebased: a window starting at one hour begins at `3600.000`, so rows stay comparable with the full recording and with the events. And `annotations.csv` is filtered to the same window, so the events you get are the events inside the slice.

## Opening the result

### pandas

```python
import pandas as pd

signals = pd.read_csv("recording_csv/signals.csv")
eeg = signals["EEG Fpz-Cz"]

channels = pd.read_csv("recording_csv/channels.csv")
print(channels[["column", "unit", "sampling_rate_hz"]])
```

Pass `index_col="time_s"` to `read_csv` if you would rather have time as the index than as a column.

### R

```r
signals <- read.csv("recording_csv/signals.csv", check.names = FALSE)
eeg <- signals[["EEG Fpz-Cz"]]
plot(signals$time_s, eeg, type = "l", xlab = "time (s)", ylab = "uV")
```

`check.names = FALSE` is the part that matters. Without it R rewrites `EEG Fpz-Cz` into `EEG.Fpz.Cz`, and your column names no longer match the ones in `channels.csv` or in the original file.

### Excel and Numbers

Open `signals.csv` directly; it is plain UTF-8 CSV with a header row and needs no import wizard. The limit is the row count. Spreadsheets stop at 1,048,576 rows including the header, which is about 68 minutes of a single 256 Hz channel. edf2csv warns you before writing when any output file would exceed that:

```text
warning: At least one output file will have more than 1,048,576 rows, which is more than Excel or Numbers can open.
         Use --start and --duration to convert a section, or read the file with pandas or R.
```

`channels.csv`, `annotations.csv` and short slices open in a spreadsheet without trouble. Full-length signal files usually do not, and that is a spreadsheet limit rather than a conversion problem.

## Where to go next

- **Output files** describes every column of every file the conversion writes, including the whole of `metadata.json`.
- **CLI reference** lists every flag, the exit codes, and the `--json` summary for scripting.
- **Sampling rates** explains why a mixed-rate recording becomes several files, and what other tools do instead.
