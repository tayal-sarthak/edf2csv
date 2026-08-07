---
title: Output files
description: Every file a conversion writes, column by column, including time semantics, column naming and value precision
order: 3
---

## What a conversion writes

A conversion writes a directory, not a single file. Given `sleep-study.edf` and no `--out`, the
directory is `sleep-study_csv` beside the input: the file's name with its extension removed and
`_csv` appended.

```bash
edf2csv sleep-study.edf
```

```
sleep-study_csv/
  signals.csv      the samples
  channels.csv     one row describing each channel in the recording
  annotations.csv  the EDF+ event list, when the recording has one
  metadata.json    what was converted, from what, and what was unusual about it
```

Which of these appear is governed by four rules:

- `signals.csv` is written unless you pass `--annotations-only`, or unless every channel you selected carries zero samples per data record — a file with nothing to put in it is not written, and the run says so:

  ```
  warning: No signal file was written: every channel selected carries zero samples per data
           record, so there is nothing to put in one.
  ```
- When channels were recorded at more than one sampling rate, `signals.csv` is replaced by one
  `signals_<rate>hz.csv` per rate. See [one file per sampling rate](#one-file-per-sampling-rate).
- `annotations.csv` is written only when the recording has an EDF+ or BDF+ annotation channel. A
  plain EDF file has nowhere to store events, so no file is written rather than an empty one. When
  the channel exists but holds no events, the file is written with its header row and nothing else.
- `channels.csv` and `metadata.json` are always written, including under `--annotations-only`.

If the output directory already exists, the conversion stops with exit code 1 and writes nothing.
Pass `--force` to overwrite, or `--out` to choose somewhere else.

## The CSV dialect

All three CSV files use the same conventional dialect:

| Property | Value |
| --- | --- |
| Encoding | UTF-8, no byte order mark |
| Line ending | LF (`\n`), including a final newline at end of file |
| Delimiter | Comma |
| Header | Exactly one row, always present |
| Quoting | RFC 4180, minimal |
| Missing value | Empty field, never `NA` or `null` |

Minimal quoting means a field is wrapped in double quotes only when it contains a comma, a double
quote, a carriage return or a line feed. Embedded double quotes are doubled. Nothing else is
quoted, so numeric columns are never quoted and a label like `EEG Fpz-Cz` is written as it stands.
This is what `pandas.read_csv`, `readr::read_csv` and `csv.reader` assume by default, so no dialect
arguments are needed on the reading side.

The header row isn't a comment and isn't preceded by any preamble. Row one is column names, row
two is data.

## signals.csv

One row per sample instant, one column per converted channel, plus a leading time column.

```
time_s,EEG Fpz-Cz,EOG horizontal,ECG
0.000,0.061,-12.454,0.30273
0.010,15.324,-12.332,0.31494
0.020,30.281,-12.210,0.32715
```

Columns appear in the order the channels appear in the file, which is the same order as
`signal_index` in `channels.csv`. Every value in the file was recorded. Nothing is interpolated,
smoothed, resampled or filled.

### The time_s column

`time_s` is seconds elapsed since the start of the recording. Zero is the first sample of the first
data record. It isn't a wall clock and isn't a Unix timestamp. To get an absolute instant, add
`time_s` to `recording.start_datetime_local` in `metadata.json`.

Three properties of the column:

**It stays absolute when you convert a window.** `--start 30m --duration 5m` produces a file whose
first row reads `1800.000`, not `0.000`. Times refer to positions in the recording, so a section
converted on its own lines up with the full conversion, with the annotation onsets, and with any
other section.

**Window edges are half-open.** A row is written when `time_s >= start` and `time_s < end`, so
`--start 0 --end 30` and `--start 30 --end 60` together produce every row exactly once, with none
repeated at the seam.

**On a discontinuous recording it jumps.** In an EDF+D file each data record carries its own start
time in a timekeeping annotation, and `edf2csv` uses that time rather than assuming records sit end
to end. A recording that pauses for eight seconds after two seconds of data produces this:

```
1.800,2.259
1.900,2.381
10.000,2.503
10.100,2.625
```

Rows are written in file order, so if a file's records are stored out of chronological order the
column won't increase monotonically, and a `DISCONTINUOUS` warning says so. If a record's
timekeeping annotation is missing or unreadable, that record is timed as if it were contiguous and
an `ANNOTATION_DECODE_FAILED` warning names the affected records.

### How many decimals time_s carries

Sample times are written with a fixed number of decimals chosen from the sampling rate, with a
minimum of three.

The interval between samples is `1 / rate`. That fraction has a terminating decimal expansion of
`d` places exactly when `10^d` divides evenly by the rate. `edf2csv` searches for the smallest such
`d` up to nine places and uses it, so sample times are written exactly rather than rounded, and
`time_s * rate` comes back as a whole row number instead of `8191.999999`.

| Sampling rate | 1 / rate | Decimals in `time_s` | Exact? |
| --- | --- | --- | --- |
| 1 Hz | 1 | 3 | yes |
| 100 Hz | 0.01 | 3 | yes |
| 250 Hz | 0.004 | 3 | yes |
| 256 Hz | 0.00390625 | 8 | yes |
| 500 Hz | 0.002 | 3 | yes |
| 512 Hz | 0.001953125 | 9 | yes |
| 1000 Hz | 0.001 | 3 | yes |
| 1024 Hz | 0.0009765625 | 7 | rounded |
| 3 Hz | 0.333... | 4 | rounded |

256 Hz is the case that comes up most in practice. Written with three decimals, sample 1 of a
256 Hz channel would be `0.004`, and dividing that back by the sample period wouldn't return 1.
Written with eight, it's `0.00390625`, the exact value, and `time_s * 256` is an integer for every
row in the file.

Two kinds of rate fall outside this. A rate whose reciprocal doesn't terminate at all, such as
3 Hz, gets enough places to keep consecutive samples distinct and no more. A rate needing more than
nine places, such as 1024 Hz, is capped and the times are rounded. In both cases the column is
marked "rounded" above: the times are accurate to within a fraction of a sample period, but
multiplying them by the rate won't land on exact integers.

`--decimals` doesn't affect this column. It sets the precision of the signal values only.

### Column names

A channel's column is its EDF label, copied verbatim. `EEG Fpz-Cz` stays `EEG Fpz-Cz`, spaces,
hyphens, case and all. Nothing is slugified, lowercased or stripped, since the label is how you
recognise the channel and rewriting it would break the correspondence with the recording's own
documentation.

Two exceptions:

- **Empty label.** A channel with a blank label becomes `signal_<index>`, for example `signal_4`.
  An `EMPTY_LABEL` warning is raised.
- **Duplicated label.** When two or more channels share a label, every one of them gets a
  `_ch<index>` suffix naming its position in the file. Two channels both labelled `T8-P8` at
  positions 0 and 1 become `T8-P8_ch0` and `T8-P8_ch1`. This happens in real clinical archives, and
  position is the only thing that reliably tells the channels apart. A `DUPLICATE_LABEL` warning is
  raised.

Names are derived from the whole file, not from your selection. A channel produces the same column
name whether you convert everything or ask for it alone with `--channels`, so files from different
runs can be joined without renaming anything. The mapping from column name back to signal position
is recorded in `channels.csv`.

Column names go through the same minimal quoting as any other field, so a label containing a comma
is quoted and a label containing a double quote has it doubled.

### How many decimals each value carries

Precision is chosen per channel from that channel's own calibration, not fixed globally.

An EDF sample is an integer from the analog-to-digital converter, and the header says which physical
range that integer range spans. The smallest physical difference the channel can express is one
digital step:

```
step = |physical_max - physical_min| / (digital_max - digital_min)
```

`edf2csv` writes `ceil(-log10(step)) + 2` decimals, clamped to the range 0 to 20. The two extra
places put rounding error well below the resolution the hardware recorded, so no two distinct
digital codes round to the same text, without padding the file with digits that carry no
information.

| Channel | Physical range | Digital range | Step | Decimals |
| --- | --- | --- | --- | --- |
| EEG Fpz-Cz | -250 to 250 uV | -2048 to 2047 | 0.1221 uV | 3 |
| ECG | -5 to 5 mV | -2048 to 2047 | 0.002442 mV | 5 |
| Temp rectal | 34 to 40 degC | -2048 to 2047 | 0.001465 degC | 5 |
| A1 (24-bit BDF) | -262144 to 262144 uV | -8388608 to 8388607 | 0.03125 uV | 4 |

The upper clamp is 20 because a channel calibrated in volts rather than microvolts has a step near
1e-7, and a magnetometer channel smaller still. A lower cap would round genuinely different samples
to the same text.

Two details of the formatting:

- Values are written with a fixed number of decimals, so `0.061` and `15.324` line up and a column
  never mixes `1e-5` notation with plain decimals.
- A value that scales to a very small negative number is written as `0.000`, not `-0.000`. Negative
  zero isn't a distinct measurement.

Pass `--decimals <n>` to override the derived precision and use the same number of places on every
channel. That's useful for diffing two conversions or for shrinking a file, but it can round
distinct samples together, which is why it isn't the default.

The value itself is computed as `gain * (offset + digital)`, EDFlib's arrangement of the EDF
calibration formula rather than the specification's literal ordering. The two are algebraically
equal but not numerically equal: the literal form computes a large intermediate and then subtracts
a large constant, and the cancellation drops low bits. The arrangement used here returns the
correctly rounded result, and it's bit-for-bit identical to pyEDFlib and EDFbrowser, which share
the same arithmetic.

## One file per sampling rate

Recordings often mix rates. A sleep study may hold EEG at 256 Hz, ECG at 128 Hz and rectal
temperature at 1 Hz. These can't share one table without inventing values for the slow channels, so
each distinct rate gets its own file:

```bash
edf2csv sleep-study.edf --out ./converted
```

```
converted/
  signals_256hz.csv   time_s, EEG Fpz-Cz
  signals_128hz.csv   time_s, ECG
  signals_1hz.csv     time_s, Temp rectal
  channels.csv
  metadata.json
```

Each file has its own `time_s` column with its own decimal precision, and every row in every file
is a sample that was recorded. A `MIXED_SAMPLING_RATES` warning tells you this happened.

The filename is `signals_<rate>hz.csv`, where a fractional rate has its decimal point replaced by an
underscore so the name is safe on every filesystem: 12.5 Hz becomes `signals_12_5hz.csv` and 0.5 Hz
becomes `signals_0_5hz.csv`.

When every converted channel shares one rate, there's one group and the file is called
`signals.csv`. This means the filename depends on the recording and, if you use `--channels`, on
your selection: selecting only the 256 Hz channels out of a mixed-rate file yields a plain
`signals.csv`. Read `conversion.rate_groups` in `metadata.json` if a script needs to know the names
without guessing.

Joining the rates means deciding what to do about the mismatch. Merging on `time_s` with a nearest
or backward-fill strategy is one answer, and it's a decision to make in your own code with the
original sample times in front of you.

## channels.csv

One row per signal channel in the recording, whether or not it was converted. The EDF+ annotation
channel isn't a signal and isn't listed.

```
column,signal_index,label,unit,sampling_rate_hz,samples_per_record,physical_min,physical_max,digital_min,digital_max,transducer,prefiltering,output_file,converted
EEG Fpz-Cz,0,EEG Fpz-Cz,uV,256,256,-250,250,-2048,2047,,,signals_256hz.csv,yes
ECG,1,ECG,mV,128,128,-5,5,-2048,2047,,,signals_128hz.csv,yes
Temp rectal,2,Temp rectal,degC,1,1,34,40,-2048,2047,,,signals_1hz.csv,yes
```

| Column | Meaning |
| --- | --- |
| `column` | The column name this channel uses in the signals file, after the empty-label and duplicate-label rules. Join on this to attach units to a signals column. |
| `signal_index` | Position of the channel in the file, counting from 0 and counting the annotation channel if present. This is the identifier `--channels "#2"` addresses, and the only stable one when labels collide. |
| `label` | The label exactly as stored in the EDF header, with no disambiguating suffix. Where two rows share a `label` they'll differ in `column`. |
| `unit` | The physical dimension from the header, verbatim: `uV`, `mV`, `degC`, `%`. Files vary in spelling and some leave it blank. Nothing is normalised. |
| `sampling_rate_hz` | `samples_per_record / record_duration_seconds`. This decides which output file the channel lands in. |
| `samples_per_record` | Samples this channel stores in each EDF data record, straight from the header. |
| `physical_min`, `physical_max` | Calibration range in the unit above, as declared. |
| `digital_min`, `digital_max` | Calibration range in raw converter counts, as declared. |
| `transducer` | Free-text electrode or sensor description from the header, often blank. |
| `prefiltering` | Free-text filter description from the header, for example `HP:0.1Hz LP:75Hz N:50Hz`. Often blank. Read it before you filter the data again. |
| `output_file` | Name of the CSV holding this channel's samples, or empty when the channel wasn't converted. |
| `converted` | `yes` or `no`. |

The four calibration columns are written as they appear in the header, so `physical_min` above
`physical_max` — an inverted channel — survives into the file rather than being corrected. The
values in `signals.csv` are converted exactly as the header specifies, inversion included, and an
`INVERTED_PHYSICAL_RANGE` warning points at the channel.

`converted` is `no` in three situations: you used `--channels` and didn't ask for this one, you
used `--annotations-only` so nothing was converted, or the channel declares zero samples per record
and therefore holds no data. In every case the row is still present, so `channels.csv` describes
the whole recording and not only what you exported.

## annotations.csv

Written whenever the recording has an EDF+ or BDF+ annotation channel. One row per event.

```
onset_s,duration_s,description,record_index
0.5,1,Sleep stage W,0
1.25,,Lights off,1
2,0.5,Seizure onset,2
```

| Column | Meaning |
| --- | --- |
| `onset_s` | Seconds from the start of the recording, on the same scale as `time_s` in the signals files, so the two join directly. |
| `duration_s` | Length of the event in seconds, or empty when the event carries no duration. |
| `description` | The annotation text, decoded as UTF-8 and copied verbatim. Quoted per the CSV rules when it contains a comma, a quote or a newline. |
| `record_index` | The data record the annotation was stored in, counting from 0. Useful for tracing an event back to its position in the source file. |

An absent duration is written as an empty field, never as `0`. The distinction is real: EDF+ lets
an annotation mark an instant with no extent, and writing that as a zero-second event would be a
claim the file doesn't make. In pandas the column reads as `NaN` with no extra arguments; treat
`NaN` as "instantaneous or unspecified" rather than "zero length".

Rows are sorted by `onset_s`, with ties broken by `record_index`. `onset_s` and `duration_s` are
written in their natural numeric form, so `0.5`, `1.25` and `2` all appear as such, without padding
to a fixed decimal count.

Two things don't appear as rows. The timekeeping annotation that starts each data record carries
the record's position in time and no text, so it's used for timing and not exported as an event.
And annotations whose onset falls outside a requested `--start` / `--end` window are excluded, on
the same half-open rule as the signal rows. The bounds are the ones you asked for rather than the
window after it was clamped to the recording, so an end you did not give stays unbounded: `--end 999h`
and `--start 0` both keep an event sitting at or past the last sample, exactly as a run with no time
options does. The whole annotation channel is read even when a window
was requested, because an event inside the window may be stored in a record outside it.

If an annotation is malformed, it's skipped rather than aborting the conversion, and an
`ANNOTATION_DECODE_FAILED` warning reports how many were lost.

## metadata.json

A record of what was converted, from what, when, and what was unusual about it. This is what makes
a conversion reproducible six months later.

```json
{
  "tool": {
    "name": "edf2csv",
    "version": "0.2.0"
  },
  "source": {
    "path": "/data/recordings/sleep-study.edf",
    "bytes": 41236992,
    "modified": "2026-03-14T09:12:44.000Z",
    "sha256": "9f2c7a1d4b6e8035c1af92be7d40e5a13c8f66b0d29e47ab5c1e0f83d76a2b41"
  },
  "recording": {
    "format": "EDF+ (continuous)",
    "version": "0",
    "patient_id": "X X X X",
    "recording_id": "Startdate X X X X",
    "start_datetime_local": "2026-03-13T22:04:00",
    "start_date_raw": "13.03.26",
    "start_time_raw": "22.04.00",
    "data_records": 28800,
    "data_records_declared": 28800,
    "record_duration_seconds": 1,
    "duration_seconds": 28800,
    "signal_count": 4,
    "annotation_channels": 1
  },
  "conversion": {
    "converted_at": "2026-03-20T11:35:02.418Z",
    "start_seconds": 0,
    "end_seconds": 28800,
    "whole_recording": true,
    "records_converted": [0, 28800],
    "annotations_written": 412,
    "files": [
      { "name": "signals_256hz.csv", "rows": 7372800 },
      { "name": "signals_128hz.csv", "rows": 3686400 },
      { "name": "signals_1hz.csv", "rows": 28800 },
      { "name": "annotations.csv", "rows": 412 },
      { "name": "channels.csv", "rows": 3 }
    ],
    "rate_groups": [
      {
        "file": "signals_256hz.csv",
        "sampling_rate_hz": 256,
        "channels": ["EEG Fpz-Cz"],
        "decimals": [3]
      },
      {
        "file": "signals_128hz.csv",
        "sampling_rate_hz": 128,
        "channels": ["ECG"],
        "decimals": [5]
      },
      {
        "file": "signals_1hz.csv",
        "sampling_rate_hz": 1,
        "channels": ["Temp rectal"],
        "decimals": [5]
      }
    ]
  },
  "notes": [
    {
      "code": "MIXED_SAMPLING_RATES",
      "severity": "warning",
      "message": "Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz)."
    }
  ]
}
```

The file is UTF-8, indented with two spaces, and ends with a newline.

### tool and source: where the data came from

`tool.name` and `tool.version` identify the converter. Quote the version in a methods section; a
future version that changes any formatting rule will say so here.

`source.path` is the absolute path of the input as resolved at conversion time. `source.bytes` and
`source.modified` describe the file as it was when the conversion opened it — the same size every
record count and window below was derived from — rather than whatever is at that path when the run
finishes.

`source.sha256` is `null` unless you passed `--checksum`, which reads the input a second time to
hash it. With a hash recorded, anyone holding the original can establish that the CSVs came from
that exact file, and you can detect a re-export or a partial copy that kept the same size and name.
It costs one extra read of the input, which is worth it for anything you intend to publish or
archive.

The hash is taken before any record is read, and published only if the file held still for the
whole conversion. If the size or the modification time moved at any point, `sha256` comes back
`null` and the run raises `INPUT_CHANGED`: a file overwritten in place keeps its inode, so the bytes
that were converted are simply gone by then, and a plausible hash of the wrong bytes is worse than
no hash at all. The CSVs and the rest of `metadata.json` are still correct for the data that was
read. This is the ordinary outcome of converting a recording that is still being written; convert
again once it is finished.

```
warning: The input changed while it was being converted, so this output covers the file as it
         was when the conversion started, not as it is now.
         No checksum was recorded: the bytes that were converted are no longer there to hash.
         Convert again once the recording is finished.
```

### recording: what the header said

- `format` is one of `EDF`, `BDF`, or `EDF+`/`BDF+` with `(continuous)` or `(discontinuous)`.
- `version` is the header's version field: `0` for EDF, `BIOSEMI` for BDF.
- `patient_id` and `recording_id` are the header's two identification fields, copied verbatim. In
  research files these are usually anonymised placeholders, but the EDF format allows real names,
  dates of birth and hospital numbers, and some files carry them. Check these two fields before
  sharing a converted directory.
- `start_datetime_local` is the recording start as a zone-less wall clock, resolved from the
  header's date and time fields. It's `null` when those fields are unusable, which is not rare.
  `start_date_raw` and `start_time_raw` preserve the original `dd.mm.yy` and `hh.mm.ss` text either
  way, so nothing is lost to the interpretation.
- `data_records` is how many complete data records the file actually contains, derived from its
  size. `data_records_declared` is what the header claims, and is `-1` when the header doesn't say,
  which the specification permits for a recording still in progress. When the two disagree, the real
  count wins and a `RECORD_COUNT_MISMATCH` note appears; a truncated file is the usual cause.
- `duration_seconds` is `data_records * record_duration_seconds`, so for a discontinuous recording
  it's the amount of data, not the span of time the recording covers.
- `signal_count` counts every channel in the header, annotation channels included.
  `annotation_channels` says how many of those were annotation channels.

### conversion: what this run did

- `converted_at` is when this run finished, as an ISO 8601 instant in UTC.
- `start_seconds` and `end_seconds` are the resolved time window, in seconds from the start of the
  recording, half-open. `whole_recording` is `true` when the window covers everything, which saves
  a script from comparing floats.
- `records_converted` is the half-open range of data record indexes that were read, `[first, last)`.
- `annotations_written` is the number of rows in `annotations.csv`, excluding its header.
- `files` lists every CSV written with its data row count, again excluding the header row. Add one
  per file if you're checking line counts on disk. `metadata.json` describes the run and isn't
  listed among the files the run produced.
- `rate_groups` records the grouping decision: for each output file, its sampling rate, the columns
  it contains in order, and the decimal precision used for each of those columns. This is the
  machine-readable answer to "which file holds which channel", and it's the field to read if a
  pipeline needs to locate the output without knowing in advance whether the recording was
  single-rate or mixed.

### notes: every diagnostic, in the archive

`notes` carries every diagnostic the conversion raised, each with a `code`, a `severity` and a
`message`. These are the same warnings printed to standard error during the run, preserved so they
stay attached to the data rather than scrolling out of a terminal. An empty array means the
recording parsed cleanly.

Read the diagnostics before you analyse the data. `MIXED_SAMPLING_RATES` explains why you have
three signal files. `RECORD_COUNT_MISMATCH` says the recording is shorter than its header promised.
`DEGENERATE_DIGITAL_RANGE` says a channel's calibration is self-contradictory, which is why that
column is empty. `DISCONTINUOUS` says the gaps in the time column are real.

## Leftovers from an earlier run

`--force` overwrites the files a conversion writes, but it doesn't empty the directory first.
Converting a mixed-rate recording into a directory and then converting a single-rate one into the
same place leaves `signals_256hz.csv` sitting next to a fresh `signals.csv`, with only one of them
current.

`edf2csv` detects this and warns with `STALE_OUTPUT`, naming the files that weren't rewritten. It
deletes nothing, since which of the two conversions you meant to keep isn't something the converter
can determine. Delete them yourself, or convert into a fresh directory.
