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
annotations.csv
channels.csv
metadata.json
signals_100hz.csv
signals_10hz.csv
signals_1hz.csv
```

Four kinds of file can appear:

- `signals.csv` holds the sample data. Its first column is `time_s`, seconds from the start of the recording, followed by one column per channel named after the channel's EDF label (`EEG Fpz-Cz`, `EOG horizontal`, `Temp rectal`). If the recording mixes sampling rates there's no `signals.csv`; instead you get `signals_100hz.csv`, `signals_1hz.csv` and so on, one file per rate, never resampled.
- `annotations.csv` appears for EDF+ and BDF+ recordings. Columns: `onset_s`, `duration_s`, `description`, `record_index`. `duration_s` is empty for events that carry no duration, and also for events whose stated duration is not a number — the run warns when that happens, since the cell cannot tell the two apart.
- `channels.csv` always appears. Columns: `column`, `signal_index`, `label`, `unit`, `sampling_rate_hz`, `samples_per_record`, `physical_min`, `physical_max`, `digital_min`, `digital_max`, `transducer`, `prefiltering`, `output_file`, `converted`.
- `metadata.json` always appears, and records what was converted: the source path and size, the recording's start time and record layout, the exact time window converted, the rate groups, and every warning raised.

## Load signals.csv into pandas with time as the index

```python
import pandas as pd

signals = pd.read_csv("sleep_csv/signals_100hz.csv", index_col="time_s")

signals.columns.tolist()   # ['EEG Fpz-Cz', 'EEG Pz-Oz', 'EOG horizontal']
signals.loc[3600:3630]     # the 30 seconds starting one hour in
signals["EEG Fpz-Cz"].describe()
```

EDF labels routinely contain spaces and hyphens, so columns are addressed with brackets rather than attribute access: `signals["EEG Fpz-Cz"]`, not `signals.EEG`. `time_s` is an ordinary float index in seconds, which makes `.loc[start:stop]` a plain numeric slice.

That slice asks for a label range, so it needs `time_s` to increase down the file. Two recordings break that, and a conversion of either warns about the shape that does it: data records stored out of chronological order, and data records that overlap in time. Both make the column decrease somewhere, and the slice then raises `KeyError: Cannot get right slice bound for non-monotonic index` — or, where the bound is one of the instants an overlap wrote twice, `Cannot get left slice bound for non-unique label`. Which of the two, and whether it raises at all, depends on where the bounds fall, so a slice that worked yesterday is not evidence that the file is in order. `df.sort_values("time_s")` is the fix for either, and the join further down needs the same.

A repeated time on its own is not a problem here. A channel sampling faster than the time column can separate writes several rows at one instant, in order, and the slice returns all of them — which is the right answer, since all of them were recorded. On everything else, which is nearly every recording, the slice is the plain numeric one it looks like.

If you converted a window with `--start` and `--duration`, `time_s` still counts from the beginning of the whole recording, not from the beginning of the excerpt. A conversion started at 286.5 s begins its first row at `286.500`, so the numbers keep meaning the same thing whichever slice you converted. The decimal count comes from the rate — three places at 100 Hz, eight at 256 Hz — so the same window written from a faster channel reads `286.50000000`.

## Give the rows a wall-clock timestamp

```python
import json
import pandas as pd

meta = json.load(open("sleep_csv/metadata.json"))
start = pd.Timestamp(meta["recording"]["start_datetime_local"])

signals = pd.read_csv("sleep_csv/signals_100hz.csv")
signals.index = start + pd.to_timedelta(signals.pop("time_s"), unit="s")
signals.index.name = "clock"
signals.head(2)
```

```text
                        EEG Fpz-Cz  EEG Pz-Oz  EOG horizontal
clock
2002-03-02 23:10:00.000      0.061      0.061           0.061
2002-03-02 23:10:00.010      1.648      1.404           0.916
```

EDF stores no time zone, so `start_datetime_local` is written without one: it's the recorder's own wall clock, exactly as the header spelled it. Nothing needs to be stripped before use. If the header's date is unreadable the field is `null`, and the raw fields survive as `start_date_raw` and `start_time_raw`.

## Load signals.csv into R

```r
signals <- read.csv("sleep_csv/signals_100hz.csv", check.names = FALSE)
names(signals)
#> [1] "time_s"        "EEG Fpz-Cz"    "EEG Pz-Oz"     "EOG horizontal"

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

signals <- fread("sleep_csv/signals_100hz.csv")
setkey(signals, time_s)
signals[time_s %between% c(3600, 3630), .(time_s, `EEG Fpz-Cz`)]
```

## Load signals.csv into MATLAB

```matlab
signals = readtable("sleep_csv/signals_100hz.csv", "VariableNamingRule", "preserve");
signals.time_s = seconds(signals.time_s);
tt = table2timetable(signals, "RowTimes", "time_s");

eeg = tt.("EEG Fpz-Cz");
excerpt = tt(timerange(seconds(3600), seconds(3630)), :);
stackedplot(excerpt)
```

`"VariableNamingRule", "preserve"` keeps `EEG Fpz-Cz` intact; without it MATLAB renames the column to a valid identifier and it stops matching `channels.csv`. Converting `time_s` to a `duration` first is what lets `table2timetable` and `timerange` work in seconds.

For a file too large to load at once, read it in blocks with a datastore. Note that `tabularTextDatastore` renames columns that aren't valid MATLAB identifiers, so check `ds.VariableNames` before referring to them:

```matlab
ds = tabularTextDatastore("sleep_csv/signals_100hz.csv");
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

`--info` reads the header, and on an EDF+ recording a little of the annotation channel: at most sixteen records of a continuous file to find where it begins, stopping at the first that says, and the whole channel for a discontinuous one, whose record times are stored rather than arithmetic. It returns in milliseconds whatever the file's size either way, and writes nothing. [What it can and cannot tell you](/docs/warnings-and-errors#how-edf2csv-reports-problems) sets out which warnings follow from that. CSV runs several times the size of the EDF — about five times here, and higher for a recording with few channels, since every row carries a `time_s` cell however many channels share it — so the estimate is worth reading before you start. It reads high on purpose: this conversion writes 94 MB against the 108 MB predicted, because a cell is budgeted at the width its channel's declared physical range allows and most samples sit well inside it.

The estimate line goes to stdout and the warnings go to stderr, which makes each of them easy to pick out on its own:

```bash
edf2csv sleep-study.edf --info 2>/dev/null | grep '^Would write'
edf2csv sleep-study.edf --info 2>&1 >/dev/null | grep '^warning:'
```

If the estimate is larger than you want, narrow the conversion rather than converting and then deleting. Any combination of these works:

```bash
edf2csv sleep-study.edf --channels "EEG Fpz-Cz,EOG horizontal" --info
edf2csv sleep-study.edf --start 1h --duration 20m --info
edf2csv sleep-study.edf --decimals 2 --info
```

## Survey a directory without converting anything

`--info --json` describes a recording as JSON, so a whole folder can be summarised in one pass
without writing a byte:

```bash
for f in /data/recordings/*.edf; do
  edf2csv "$f" --info --json
done | jq -s -r '
  .[] | [ (.path | split("/") | last),
          .format,
          .duration_seconds,
          (.channels | length),
          (.channels | map(.sampling_rate_hz) | unique | join("/")),
          .estimate.rows,
          ([.warnings[].code] | join(";")) ] | @tsv'
```

```text
night-01.edf	EDF+ (continuous)	28800	5	1/10/100	3196800	MIXED_SAMPLING_RATES;LARGE_OUTPUT
night-02.edf	EDF	2	2	10	20
```

Nothing is read past the header for plain EDF, and at most sixteen records' annotation slots for
a continuous EDF+, so this stays fast over a directory of multi-gigabyte recordings. Find the ones that need attention before converting:

```bash
for f in /data/recordings/*.edf; do
  edf2csv "$f" --info --strict >/dev/null 2>&1 || echo "needs a look: $f"
done
```

## Pipe a conversion straight into another tool

`--stdout` writes the signal CSV to stdout and creates no directory:

```bash
edf2csv sleep-study.edf --stdout --channels "EEG Fpz-Cz" |
  duckdb -c "SELECT count(*), avg(\"EEG Fpz-Cz\") FROM read_csv('/dev/stdin')"
```

A stream holds one table, so this needs the recording to produce exactly one. A mixed-rate file is
refused rather than merged, and the refusal names three ways out: narrow to a single rate with
`--channels`, add `--layout long` to put every rate in one table of `time_s,channel,value`, or
convert to a directory instead. The row count goes to stderr, so stdout carries nothing but CSV.

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

The loop above is worth keeping when you want to act on each file as it finishes. When you only want the conversions, one command does it:

```bash
edf2csv /data/recordings/*.edf --out converted --quiet
```

`--quiet` suppresses the per-file summary but still prints warnings, so a truncated or discontinuous file doesn't pass silently. Exit code 0 means every recording converted, 1 means at least one had a problem with the file or the output directory, and 2 means a problem with the command line.

Add `--force` if you're re-running over a folder you've already converted; without it an existing output directory is an error rather than something to be overwritten by accident.

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
  "tool": { "name": "edf2csv", "version": "..." },
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

Make a pipeline stop on any warning with `--strict`, which exits 1 when the recording raised one. The output is still written, so you can look at what triggered it:

```bash
edf2csv recording.edf --out ./out --force --strict ||
  echo "conversion raised warnings, check them before using the output" >&2
```

Reach for `--json` when you care about a specific warning rather than any of them:

```bash
edf2csv recording.edf --out ./out --force --json |
  jq -e '[.warnings[].code] | index("DISCONTINUOUS") | not' >/dev/null ||
  echo "this recording has gaps" >&2
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
         Plain EDF files carry no annotations. Convert without
         --annotations-only to get the signals.
```

Because that warning goes to stderr, the loop above keeps going and the folder that comes out has one directory per recording either way. The `glob` below finds nothing for the files that had no events.

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
  annotations.csv      1  row
  channels.csv         1  row
Done in 0.4s.
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

That is the same label slice as above, so the same two recordings break it in the same two ways.

## Align two rate groups with pandas merge_asof

```python
import pandas as pd

fast = pd.read_csv("sleep_csv/signals_100hz.csv")
slow = pd.read_csv("sleep_csv/signals_1hz.csv")

aligned = pd.merge_asof(fast, slow, on="time_s", direction="backward")
aligned.head(3)
```

```text
   time_s  EEG Fpz-Cz  EEG Pz-Oz  EOG horizontal  Temp rectal
0    0.00       0.061      0.061           0.061     37.00073
1    0.01       1.648      1.404           0.916     37.00073
2    0.02       3.236      2.747           1.770     37.00073
```

Both frames must be sorted on the join key, which for an ordinary recording they already are. One kind of file breaks that: an EDF+D recording whose data records are stored out of chronological order writes its rows in file order, so `time_s` does not increase monotonically and `merge_asof` raises `ValueError: left keys must be sorted`. The conversion says so — "1 data record starts earlier than the record before it" — and `df.sort_values("time_s")` before the join is the fix. [The time_s column](/docs/output-files#the-time_s-column) sets out when that happens. `direction="backward"` carries the most recent slow reading forward, `"nearest"` picks the closer of the two neighbours, and `tolerance` leaves `NaN` where no reading is close enough:

```python
aligned = pd.merge_asof(fast, slow, on="time_s", direction="nearest", tolerance=0.5)
aligned["Temp rectal"].isna().sum()
```

This is the step edf2csv leaves to you. Once the temperature column has 2,880,000 entries, only 28,800 of which came off a sensor, nothing in the file distinguishes the measurements from the fill. Doing it here keeps the choice of `direction` and `tolerance` in your analysis code, and leaves the files on disk holding only recorded values.

## Read a very large signals.csv in chunks

```python
import pandas as pd

peak = 0.0
rows = 0

for chunk in pd.read_csv(
    "sleep_csv/signals_100hz.csv",
    chunksize=500_000,
    usecols=["time_s", "EEG Fpz-Cz"],
):
    peak = max(peak, chunk["EEG Fpz-Cz"].abs().max())
    rows += len(chunk)

print(rows, peak)   # 2880000 250.0
```

`chunksize` makes `read_csv` return an iterator of frames instead of one frame, so memory stays flat regardless of file size. `usecols` is the bigger win on a wide montage: naming the two columns you need means the other twenty are never parsed.

For work that needs all the columns, `dtype` halves the memory a chunk occupies, at a cost in precision you should think about first:

```python
reader = pd.read_csv(
    "sleep_csv/signals_100hz.csv",
    chunksize=500_000,
    dtype={"EEG Fpz-Cz": "float32", "EEG Pz-Oz": "float32", "EOG horizontal": "float32"},
)
```

Keep `time_s` as float64. A recording eight hours long reaches times near 28,800 s, and float32 can't hold that with 8 decimal places.

## Query the CSV directly with DuckDB

```bash
duckdb -c "SELECT count(*) AS rows, min(time_s), max(time_s) FROM 'sleep_csv/signals_100hz.csv'"
```

DuckDB reads the CSV where it lies and streams it, so the 89 MB `signals_100hz.csv` this recording produces can be aggregated without an 89 MB frame in memory and without an import step. Column names containing spaces are quoted with double quotes, exactly as SQL requires:

```bash
duckdb -c "
  SELECT floor(time_s / 30) * 30 AS epoch_start,
         avg(\"EEG Fpz-Cz\")      AS mean_uv,
         max(abs(\"EEG Fpz-Cz\")) AS peak_uv
  FROM 'sleep_csv/signals_100hz.csv'
  GROUP BY 1
  ORDER BY 1
  LIMIT 5"
```

Cutting an excerpt back out to CSV is one statement:

```bash
duckdb -c "
  COPY (
    SELECT time_s, \"EEG Fpz-Cz\"
    FROM 'sleep_csv/signals_100hz.csv'
    WHERE time_s BETWEEN 3600 AND 3630
  ) TO 'excerpt.csv' (HEADER, DELIMITER ',')"
```

Rate groups can be joined the same way pandas does it, with `ASOF JOIN` (DuckDB 0.9 or newer):

```sql
SELECT f.time_s, f."EEG Fpz-Cz", s."Temp rectal"
FROM 'sleep_csv/signals_100hz.csv' AS f
ASOF JOIN 'sleep_csv/signals_1hz.csv' AS s
  ON f.time_s >= s.time_s;
```

The same queries work from Python without the shell quoting:

```python
import duckdb

duckdb.sql("""
    SELECT avg("EOG horizontal") FROM 'sleep_csv/signals_100hz.csv'
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
EEG Fpz-Cz          EEG Fpz-Cz    uV               100  signals_100hz.csv       yes
EEG Pz-Oz            EEG Pz-Oz    uV               100  signals_100hz.csv       yes
EOG horizontal  EOG horizontal    uV               100  signals_100hz.csv       yes
Resp oro-nasal  Resp oro-nasal     V                10   signals_10hz.csv       yes
Temp rectal        Temp rectal  degC                 1    signals_1hz.csv       yes
```

`channels.csv` lists every signal channel in the file, including ones you excluded with `--channels`; the `converted` column says which made it into a CSV, and `output_file` says which one. The `column` values are exactly the column headers used in the signal files, so this table is the lookup for labelling a plot axis or checking a unit:

```python
units = channels["unit"].to_dict()
ax.set_ylabel(f"EEG Fpz-Cz ({units['EEG Fpz-Cz']})")
```

The `physical_min`, `physical_max`, `digital_min` and `digital_max` columns are the header's calibration as recorded. They're what edf2csv used to convert the samples, so they let anyone reproduce the arithmetic from the digital values.

## Record a checksum so a conversion can be reproduced

```bash
edf2csv recording.edf --out ./out --checksum
jq -r '.source | "\(.bytes) bytes  \(.sha256)"' ./out/metadata.json
```

```text
1548 bytes  2e07d98230275974...
```

`--checksum` costs one extra read of the input and writes a SHA-256 into `metadata.json`, where it sits alongside the tool version, the source path and modification time, the exact converted window, and every warning raised. Without the flag the field is `null`.

That makes the output directory self-describing. Months later, `metadata.json` still records which file this came from, which version produced it, which seconds of the recording it covers, and what was flagged at the time.

```bash
jq '{tool: .tool.version, window: [.conversion.start_seconds, .conversion.end_seconds], notes: [.notes[].code]}' ./out/metadata.json
```
