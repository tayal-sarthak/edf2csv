---
title: Recipes
description: Short, tested snippets for loading, scripting and querying the CSV that edf2csv writes
order: 8
---

Every snippet below is written against the files edf2csv actually produces. File names are examples; substitute your own.

## What a conversion leaves on disk

```bash
edf2csv sleep-study.edf --out ./sleep_csv
ls ./sleep_csv
```

```text
channels.csv
metadata.json
signals_1hz.csv
signals_256hz.csv
```

Four kinds of file can appear, and knowing their columns is most of what the rest of this page needs:

- `signals.csv` holds the sample data. Its first column is `time_s`, seconds from the start of the recording, followed by one column per channel named after the channel's EDF label (`EEG Fpz-Cz`, `ECG`, `Temp rectal`). If the recording mixes sampling rates there is no `signals.csv`; instead you get `signals_256hz.csv`, `signals_1hz.csv` and so on, one file per rate, never resampled.
- `annotations.csv` appears for EDF+ and BDF+ recordings. Columns: `onset_s`, `duration_s`, `description`, `record_index`. `duration_s` is empty for events that carry no duration.
- `channels.csv` always appears. Columns: `column`, `signal_index`, `label`, `unit`, `sampling_rate_hz`, `samples_per_record`, `physical_min`, `physical_max`, `digital_min`, `digital_max`, `transducer`, `prefiltering`, `output_file`, `converted`.
- `metadata.json` always appears, and records what was converted: the source path and size, the recording's start time and record layout, the exact time window converted, the rate groups, and every warning raised.

## Load signals.csv into pandas with time as the index

```python
import pandas as pd

signals = pd.read_csv("sleep_csv/signals_256hz.csv", index_col="time_s")

signals.columns.tolist()   # ['EEG Fpz-Cz', 'EEG Pz-Oz', 'ECG']
signals.loc[3600:3630]     # the 30 seconds starting one hour in
signals["EEG Fpz-Cz"].describe()
```

EDF labels routinely contain spaces and hyphens, so columns are addressed with brackets rather than attribute access: `signals["EEG Fpz-Cz"]`, not `signals.EEG`. `time_s` is an ordinary float index in seconds, which makes `.loc[start:stop]` a plain numeric slice.

If you converted a window with `--start` and `--duration`, `time_s` still counts from the beginning of the whole recording, not from the beginning of the excerpt. A conversion started at 286.5 s begins its first row at `286.50000000`, so the numbers keep meaning the same thing whichever slice you converted.

## Give the rows a wall-clock timestamp

```python
import json
import pandas as pd

meta = json.load(open("sleep_csv/metadata.json"))
start = pd.Timestamp(meta["recording"]["start_datetime"]).tz_localize(None)

signals = pd.read_csv("sleep_csv/signals_256hz.csv")
signals.index = start + pd.to_timedelta(signals.pop("time_s"), unit="s")
signals.index.name = "clock"
signals.head(2)
```

```text
                               EEG Fpz-Cz  EEG Pz-Oz      ECG
clock
2002-03-02 22:15:00.000000000       0.061      0.061  0.00122
2002-03-02 22:15:00.003906250      29.731     23.871  0.06227
```

EDF stores no time zone. `start_datetime` is written with a `Z` suffix because it has to be written in some form, but the value is the recorder's own clock. `tz_localize(None)` drops the misleading UTC marker and keeps the fields as recorded. If the header's date is unreadable, `start_datetime` is `null` and the raw fields survive as `start_date_raw` and `start_time_raw`.

## Load signals.csv into R

```r
signals <- read.csv("sleep_csv/signals_256hz.csv", check.names = FALSE)
names(signals)
#> [1] "time_s"     "EEG Fpz-Cz" "EEG Pz-Oz"  "ECG"

signals[["EEG Fpz-Cz"]][1:5]
```

`check.names = FALSE` is the important part. Without it R rewrites `EEG Fpz-Cz` into `EEG.Fpz.Cz`, and your column names no longer match the labels in `channels.csv`.

To index by time rather than row number, use zoo:

```r
library(zoo)

eeg <- zoo(as.matrix(signals[, -1, drop = FALSE]), order.by = signals$time_s)
excerpt <- window(eeg, start = 3600, end = 3630)
plot(excerpt)
```

`read.csv` is slow on files of a few hundred megabytes. For those, `data.table::fread` reads the same file in a fraction of the time and preserves the column names by default:

```r
library(data.table)

signals <- fread("sleep_csv/signals_256hz.csv")
setkey(signals, time_s)
signals[time_s %between% c(3600, 3630), .(time_s, `EEG Fpz-Cz`)]
```

## Load signals.csv into MATLAB

```matlab
signals = readtable("sleep_csv/signals_256hz.csv", "VariableNamingRule", "preserve");
signals.time_s = seconds(signals.time_s);
tt = table2timetable(signals, "RowTimes", "time_s");

eeg = tt.("EEG Fpz-Cz");
excerpt = tt(timerange(seconds(3600), seconds(3630)), :);
stackedplot(excerpt)
```

`"VariableNamingRule", "preserve"` keeps `EEG Fpz-Cz` intact; without it MATLAB renames the column to a valid identifier and it stops matching `channels.csv`. Converting `time_s` to a `duration` first is what lets `table2timetable` and `timerange` work in seconds.

For a file too large to load at once, read it in blocks with a datastore. Note that `tabularTextDatastore` renames columns that are not valid MATLAB identifiers, so check `ds.VariableNames` before referring to them:

```matlab
ds = tabularTextDatastore("sleep_csv/signals_256hz.csv");
ds.ReadSize = 500000;
disp(ds.VariableNames)

peak = 0;
while hasdata(ds)
    chunk = read(ds);
    peak = max(peak, max(abs(chunk{:, 2})));
end
```

## Check the output size before converting a long recording

```bash
edf2csv sleep-study.edf --info
```

```text
File       ./sleep-study.edf
Format     EDF
Recorded   2002-03-02 22:15:00 UTC
Duration   8h 00m 0s  (28800 records of 1s)
Size       42.2 MB
Patient    X X X X
Recording  Startdate X X X X

Channels   4 signals

#  COLUMN       LABEL        UNIT  RATE    RANGE        OUTPUT
0  EEG Fpz-Cz   EEG Fpz-Cz   uV    256 Hz  -250 to 250  signals_256hz.csv
1  EEG Pz-Oz    EEG Pz-Oz    uV    256 Hz  -250 to 250  signals_256hz.csv
2  ECG          ECG          mV    256 Hz  -5 to 5      signals_256hz.csv
3  Temp rectal  Temp rectal  degC  1 Hz    34 to 40     signals_1hz.csv

Sampling rates differ, so channels are written to 2 files, one per rate. No channel is resampled.
Would write 7,401,600 rows, roughly 310 MB.
```

`--info` reads the header only, so it returns in milliseconds even for a multi-gigabyte file, and it writes nothing. CSV is roughly seven times the size of the EDF it came from, so the estimate is worth reading before you start.

The estimate line goes to stdout and the warnings go to stderr, which makes each of them easy to pick out on its own:

```bash
edf2csv sleep-study.edf --info 2>/dev/null | grep '^Would write'
edf2csv sleep-study.edf --info 2>&1 >/dev/null | grep '^warning:'
```

If the estimate is larger than you want, narrow the conversion rather than converting and then deleting. Any combination of these works:

```bash
edf2csv sleep-study.edf --channels "EEG Fpz-Cz,ECG" --info
edf2csv sleep-study.edf --start 1h --duration 20m --info
edf2csv sleep-study.edf --decimals 2 --info
```

## Convert a whole folder of recordings

```bash
mkdir -p converted

for f in /data/recordings/*.edf; do
  name=$(basename "$f" .edf)
  if edf2csv "$f" --out "converted/$name" --quiet; then
    echo "ok   $name"
  else
    echo "FAIL $name (exit $?)" >&2
  fi
done
```

edf2csv takes one input file per run, so batching is a shell loop. `--quiet` suppresses the per-file summary but still prints warnings, so a truncated or discontinuous file does not pass silently. Exit code 0 means the conversion completed, 1 means a problem with the file or the output directory, and 2 means a problem with the command line.

Add `--force` if you are re-running over a folder you have already converted; without it an existing output directory is an error rather than something to be overwritten by accident.

To pick up BDF files in the same pass, and to survive spaces in file names, use `find`:

```bash
find /data/recordings -type f \( -name '*.edf' -o -name '*.bdf' \) -print0 |
while IFS= read -r -d '' f; do
  name=$(basename "$f")
  edf2csv "$f" --out "converted/${name%.*}" --force --quiet 2>>convert.log
done
```

## Script over the summary with --json and jq

```bash
edf2csv recording.edf --out ./out --json
```

```json
{
  "output_dir": "./out",
  "files": [
    { "name": "signals_256hz.csv", "rows": 768 },
    { "name": "signals_128hz.csv", "rows": 384 },
    { "name": "signals_1hz.csv", "rows": 3 },
    { "name": "channels.csv", "rows": 3 }
  ],
  "annotations": 0,
  "duration_seconds": 3,
  "records": 3,
  "elapsed_ms": 8,
  "warnings": [
    {
      "code": "MIXED_SAMPLING_RATES",
      "severity": "warning",
      "message": "Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz)."
    }
  ]
}
```

`--json` puts the whole summary on stdout and nothing else, warnings included, so nothing needs to be scraped out of the human-readable text. Count the data rows actually written:

```bash
edf2csv recording.edf --out ./out --force --json |
  jq '[.files[] | select(.name | startswith("signals")) | .rows] | add'
```

Turn a folder into a one-line-per-recording table. `jq -s` collects the separate summary documents into an array:

```bash
for f in /data/recordings/*.edf; do
  edf2csv "$f" --out "converted/$(basename "$f" .edf)" --force --quiet --json
done | jq -s -r '
  .[] | [ .output_dir,
          .duration_seconds,
          .annotations,
          ([.files[] | select(.name | startswith("signals")) | .rows] | add),
          ([.warnings[].code] | join(";")) ] | @tsv'
```

```text
converted/night-01	3	3	300
converted/night-02	3	0	1155	MIXED_SAMPLING_RATES
```

Make a pipeline stop on any warning by testing the array with `jq -e`, which exits non-zero when the expression is false:

```bash
edf2csv recording.edf --out ./out --force --json |
  jq -e '.warnings | length == 0' >/dev/null ||
  echo "conversion raised warnings, check them before using the output" >&2
```

## Extract only the annotations from a set of recordings

```bash
mkdir -p events

for f in /data/recordings/*.edf; do
  name=$(basename "$f" .edf)
  edf2csv "$f" --annotations-only --out "events/$name" --force --quiet
done
```

`--annotations-only` skips the signal data entirely, so this runs in about the time it takes to read the annotation channel. Each output directory gets `annotations.csv`, `channels.csv` and `metadata.json`, and no signal files. A plain EDF has no annotation channel, so it produces no `annotations.csv` at all and warns that there was nothing to export:

```text
warning: --annotations-only was requested but this recording has no annotation channel, so there are no events to export.
         Plain EDF files carry no annotations. Convert without --annotations-only to get the signals.
```

Because that warning goes to stderr, the loop above keeps going and the folder that comes out has one directory per recording either way. The `glob` below simply finds nothing for the files that had no events.

Stack them into one table, keeping track of which recording each event came from:

```python
import pathlib
import pandas as pd

frames = []
for path in sorted(pathlib.Path("events").glob("*/annotations.csv")):
    events = pd.read_csv(path)
    events.insert(0, "recording", path.parent.name)
    frames.append(events)

all_events = pd.concat(frames, ignore_index=True)
all_events.to_csv("all-events.csv", index=False)

all_events.groupby("description").size().sort_values(ascending=False)
```

```text
description
Lights off       2
Seizure onset    2
Sleep stage W    2
```

## Pull a 30 second window around a marked event

```bash
edf2csv overnight-eeg.edf --annotations-only --out ./events --force --quiet

onset=$(python3 -c "
import csv
with open('events/annotations.csv', newline='') as f:
    for row in csv.DictReader(f):
        if row['description'] == 'Seizure onset':
            print(row['onset_s'])
            break
")

start=$(python3 -c "print(max(0.0, $onset - 15))")

edf2csv overnight-eeg.edf --start "$start" --duration 30 --out ./seizure-window
```

```text
Wrote ./seizure-window
  signals.csv      7,680  rows
  annotations.csv      1  rows
  channels.csv         1  rows
Done in 0.0s.
```

Two things make this work. `--start` accepts a plain number as seconds (as well as `30s`, `5m`, `1h30m` and `00:30:00`), so an onset read straight out of `annotations.csv` can be handed to it unchanged. And the window's `annotations.csv` is filtered to events whose onset falls inside the window, so the excerpt arrives with its own event list already attached.

Reading the onset with Python's `csv` module rather than `cut -d,` matters because descriptions are free text and are quoted when they contain a comma.

Finding the event in the resulting CSV is then just arithmetic on `time_s`, which is still measured from the start of the whole recording:

```python
import pandas as pd

signals = pd.read_csv("seizure-window/signals.csv", index_col="time_s")
events = pd.read_csv("seizure-window/annotations.csv")

onset = events.loc[events["description"] == "Seizure onset", "onset_s"].iloc[0]
signals.loc[onset - 2 : onset + 2]
```

## Align two rate groups with pandas merge_asof

```python
import pandas as pd

fast = pd.read_csv("sleep_csv/signals_256hz.csv")
slow = pd.read_csv("sleep_csv/signals_1hz.csv")

aligned = pd.merge_asof(fast, slow, on="time_s", direction="backward")
aligned.head(3)
```

```text
     time_s  EEG Fpz-Cz  EEG Pz-Oz      ECG  Temp rectal
0  0.000000       0.061      0.061  0.00122     37.00073
1  0.003906      29.731     23.871  0.06227     37.00073
2  0.007812      57.570     46.825  0.12088     37.00073
```

Both frames must be sorted on the join key, which they already are. `direction="backward"` carries the most recent slow reading forward, `"nearest"` picks the closer of the two neighbours, and `tolerance` leaves `NaN` where no reading is close enough:

```python
aligned = pd.merge_asof(fast, slow, on="time_s", direction="nearest", tolerance=0.5)
aligned["Temp rectal"].isna().sum()
```

This is the step edf2csv deliberately does not do for you. Once the temperature column has 7,372,800 entries, only 28,800 of which came off a sensor, nothing in the file distinguishes the measurements from the fill. Doing it here means the choice of `direction` and `tolerance` is yours, it is recorded in your analysis code, and the files on disk still contain only recorded values.

## Read a very large signals.csv in chunks

```python
import pandas as pd

peak = 0.0
rows = 0

for chunk in pd.read_csv(
    "sleep_csv/signals_256hz.csv",
    chunksize=500_000,
    usecols=["time_s", "EEG Fpz-Cz"],
):
    peak = max(peak, chunk["EEG Fpz-Cz"].abs().max())
    rows += len(chunk)

print(rows, peak)   # 7372800 122.161
```

`chunksize` makes `read_csv` return an iterator of frames instead of one frame, so memory stays flat regardless of file size. `usecols` is the bigger win on a wide montage: naming the two columns you need means the other twenty are never parsed.

For work that needs all the columns, `dtype` halves the memory a chunk occupies, at a cost in precision you should think about first:

```python
reader = pd.read_csv(
    "sleep_csv/signals_256hz.csv",
    chunksize=500_000,
    dtype={"EEG Fpz-Cz": "float32", "EEG Pz-Oz": "float32", "ECG": "float32"},
)
```

Keep `time_s` as float64. A 256 Hz recording eight hours long reaches times near 28,800 s, and float32 cannot hold that with 8 decimal places.

## Query the CSV directly with DuckDB

```bash
duckdb -c "SELECT count(*) AS rows, min(time_s), max(time_s) FROM 'sleep_csv/signals_256hz.csv'"
```

DuckDB reads the CSV where it lies and streams it, so a 286 MB `signals_256hz.csv` can be aggregated without a 286 MB frame in memory and without an import step. Column names containing spaces are quoted with double quotes, exactly as SQL requires:

```bash
duckdb -c "
  SELECT floor(time_s / 30) * 30 AS epoch_start,
         avg(\"EEG Fpz-Cz\")      AS mean_uv,
         max(abs(\"EEG Fpz-Cz\")) AS peak_uv
  FROM 'sleep_csv/signals_256hz.csv'
  GROUP BY 1
  ORDER BY 1
  LIMIT 5"
```

Cutting an excerpt back out to CSV is one statement:

```bash
duckdb -c "
  COPY (
    SELECT time_s, \"EEG Fpz-Cz\"
    FROM 'sleep_csv/signals_256hz.csv'
    WHERE time_s BETWEEN 3600 AND 3630
  ) TO 'excerpt.csv' (HEADER, DELIMITER ',')"
```

Rate groups can be joined the same way pandas does it, with `ASOF JOIN` (DuckDB 0.9 or newer):

```sql
SELECT f.time_s, f."EEG Fpz-Cz", s."Temp rectal"
FROM 'sleep_csv/signals_256hz.csv' AS f
ASOF JOIN 'sleep_csv/signals_1hz.csv' AS s
  ON f.time_s >= s.time_s;
```

The same queries work from Python without the shell quoting:

```python
import duckdb

duckdb.sql("""
    SELECT avg("ECG") FROM 'sleep_csv/signals_256hz.csv'
    WHERE time_s BETWEEN 3600 AND 3630
""").df()
```

## Attach units and calibration from channels.csv

```python
import pandas as pd

channels = pd.read_csv("sleep_csv/channels.csv").set_index("column")
channels[["label", "unit", "sampling_rate_hz", "output_file", "converted"]]
```

```text
                   label  unit  sampling_rate_hz        output_file converted
column
EEG Fpz-Cz    EEG Fpz-Cz    uV               256  signals_256hz.csv       yes
EEG Pz-Oz      EEG Pz-Oz    uV               256  signals_256hz.csv       yes
ECG                  ECG    mV               256  signals_256hz.csv       yes
Temp rectal  Temp rectal  degC                 1    signals_1hz.csv       yes
```

`channels.csv` lists every signal channel in the file, including ones you excluded with `--channels`; the `converted` column says which made it into a CSV, and `output_file` says which one. The `column` values are exactly the column headers used in the signal files, so this table is the lookup for labelling a plot axis or checking a unit:

```python
units = channels["unit"].to_dict()
ax.set_ylabel(f"EEG Fpz-Cz ({units['EEG Fpz-Cz']})")
```

The `physical_min`, `physical_max`, `digital_min` and `digital_max` columns are the header's calibration as recorded. They are what edf2csv used to convert the samples, so they let anyone reproduce the arithmetic from the digital values.

## Record a checksum so a conversion can be reproduced

```bash
edf2csv recording.edf --out ./out --checksum
jq -r '.source | "\(.bytes) bytes  \(.sha256)"' ./out/metadata.json
```

```text
1548 bytes  2e07d98230275974...
```

`--checksum` costs one extra read of the input and writes a SHA-256 into `metadata.json`, where it sits alongside the tool version, the source path and modification time, the exact converted window, and every warning raised. Without the flag the field is `null`.

That makes the output directory self-describing: months later, `metadata.json` still answers which file this came from, which version produced it, which seconds of the recording it covers, and whether anything looked wrong at the time.

```bash
jq '{tool: .tool.version, window: [.conversion.start_seconds, .conversion.end_seconds], notes: [.notes[].code]}' ./out/metadata.json
```
