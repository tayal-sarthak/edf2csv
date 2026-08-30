---
title: Mixed sampling rates
description: Why edf2csv writes one CSV per sampling rate instead of resampling, and how to work with the files it produces
order: 4
---

## EDF files routinely mix rates

EDF doesn't store one sampling rate for the whole recording. It stores a record duration in the file header, and then, for every channel separately, how many samples that channel contributes to each data record. A channel's rate is those two numbers divided:

```
sampling rate (Hz) = samples per data record / record duration in seconds
```

Because the count is per channel, one file can hold channels at very different rates, and real recordings do. A polysomnography montage might carry EEG at 256 Hz, EOG at 100 Hz, respiratory effort at 10 Hz and a rectal thermistor at 1 Hz, all in the same file. That's the format working as designed: each sensor is sampled at a rate suited to it.

## One wide CSV can't hold them without inventing samples

A CSV table has one row per time value and one column per channel. In a single table, the fastest channel decides how many rows there are.

Take three seconds of recording with EEG at 256 Hz and temperature at 1 Hz. The EEG contributes 768 samples and the temperature contributes 3. A single table with 768 rows has 768 cells in the temperature column and only 3 real numbers to put in them. The remaining 765 can be filled three ways:

1. **Repeat the last value.** The column then shows 768 readings, 765 of which the thermistor never produced. Anything that counts samples, estimates a spectrum, or computes a variance is working on fabricated data.
2. **Interpolate between readings.** Same problem, except the invented values look smoother and more plausible than the real ones.
3. **Leave the cells blank.** This is accurate, but it produces a column that's more than 99% empty, and many readers treat blanks as zero or drop the rows.

Interpolation itself isn't the problem — it's often exactly what you want. The problem is that once the numbers are in a CSV they're indistinguishable from measurements. Nothing in the file records which values came off a sensor and which came out of an algorithm.

There is a fourth way, and it is the one that gets you a single file honestly: stop insisting the table be wide. It has its own section below.

## What MNE does

Load a three-second file with one 256 Hz channel, one 128 Hz channel and one 1 Hz channel using `mne.io.read_raw_edf`, and every channel reports 768 samples. The 3 genuine temperature readings become 768 values, upsampled to the fastest channel in the file. No warning is printed.

That's a reasonable choice for MNE. MNE is an analysis library built around `Raw`, a single 2D array of shape `(n_channels, n_times)` with one shared time axis. Filtering, epoching, ICA, source localisation and the plotting routines all assume that array, and a ragged structure would break them. Given that design, expanding the slow channels is the only option, and for MNE's purposes it rarely matters.

It's a different question for a converter, whose job is to hand you the file's contents in another container. If the CSV contains 765 numbers the recording never contained, the conversion has added information and you have no way to tell which rows to distrust.

## What edf2csv writes instead

One file per distinct sampling rate. Nothing is resampled, upsampled, downsampled, interpolated or padded.

Here is the same three-second file converted:

```bash
edf2csv recording.edf --out ./converted
```

```
warning: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.

Wrote ./converted
  signals_256hz.csv  768  rows
  signals_128hz.csv  384  rows
  signals_1hz.csv      3  rows
  channels.csv         3  rows
Done in 12ms.
```

The row counts are the sample counts. The temperature file has three rows because the thermistor produced three readings:

```
time_s,Temp rectal
0.000,37.00073
1.000,37.14725
2.000,37.29377
```

Each file is a complete, self-contained CSV: a `time_s` column followed by one column per channel at that rate, with the channel's label as the column heading. The files are written in descending rate order and named after the rate they hold:

| Rate | File name |
| --- | --- |
| 256 Hz | `signals_256hz.csv` |
| 128 Hz | `signals_128hz.csv` |
| 1 Hz | `signals_1hz.csv` |
| 12.5 Hz | `signals_12_5hz.csv` |
| 0.5 Hz | `signals_0_5hz.csv` |
| 1e-7 Hz | `signals_1_000e-7hz.csv` |
| 4e+300 Hz | `signals_4e+300hz.csv` |

A fractional rate has its decimal point replaced by an underscore, so the name is a safe filename on every platform. The last two rows are the rest of that rule, and they are reachable: a rate the tool writes in exponent notation carries the exponent into the name, `e` and sign included. Nothing else is substituted, so those names hold a `-` or a `+` — both legal in a filename everywhere, and both worth knowing about before a script builds a glob. `conversion.rate_groups` in `metadata.json` names every file the run wrote, which is the way to get them without matching on a shape.

The `time_s` column is seconds from the start of the recording and means the same thing in every file. That shared clock is what makes the separate files joinable later. The number of decimal places is chosen per rate so sample times are written exactly rather than rounded: 256 Hz gets 8 places because 1/256 terminates at 8 decimal places, 128 Hz gets 7, and 1 Hz gets 3. Multiplying `time_s` by the rate gives back a whole sample index rather than something like 8191.99999. That holds for a rate whose reciprocal terminates in decimal at all, which is every rate a recording is likely to use and not every rate: 3 Hz and 39 Hz do not, so their times are rounded to enough places to keep consecutive samples distinct and `time_s * rate` lands near a whole number rather than on one. [How many decimals time_s carries](/docs/output-files#how-many-decimals-time_s-carries) gives the rule and marks which is which.

## The other shape: one row per sample

Everything above is about the wide table — a column per channel, a row per time value — because that is what a CSV of signal data usually means and what the default layout writes. The constraint it runs into is structural: one row has to hold a value for every column, and channels sampled at different rates do not have a value at the same times.

`--layout long` drops that constraint by dropping the shape. One file, three columns, one row per sample:

```bash
edf2csv recording.edf --out ./converted --layout long
```

```
time_s,channel,value
0.00000000,EEG Fpz-Cz,0.061
0.00000000,ECG,0.00122
0.00000000,Temp rectal,37.00073
0.00390625,EEG Fpz-Cz,9.096
0.00781250,EEG Fpz-Cz,18.010
0.00781250,ECG,0.12088
```

Every row is a sample the recording holds, carrying the time it was recorded at. The 1 Hz channel contributes 3 rows and the 256 Hz channel contributes 768, and neither has to account for the other — so all three rates fit one file with nothing repeated, interpolated or blank. Rows come out sorted by `time_s` — unless the recording is a discontinuous one whose records are stored in a different order than they are timed, which is rare, allowed by the format, and [warned about](/docs/warnings-and-errors#discontinuous).

This is the shape most plotting and grouping libraries want anyway:

```python
import pandas as pd
long = pd.read_csv("converted/signals.csv")
long.groupby("channel")["value"].describe()
```

And the wide form is one call away, for whichever rates you want it for:

```python
wide = long.pivot(index="time_s", columns="channel", values="value")
```

Note what that `pivot` produces for a mixed-rate file: a frame with 768 rows where the temperature column is 765 blanks. That is option 3 from the list above, arrived at deliberately, in your code, with the original file still on disk — which is the difference the whole page is about.

That call needs `time_s` and `channel` together to name one sample, and two recordings break it: one whose channels sample faster than the time column can separate, and one whose data records overlap in time. Both raise `ValueError: Index contains duplicate entries, cannot reshape` rather than quietly keeping one sample of the pair. A conversion of either warns about the shape that causes it, and the warning's advice is the answer here too — those rows are told apart by their position in the file rather than by their time.

Two costs. The file is larger, because every row repeats the time and the channel name rather than sharing one time across a row; two to three times, and `--gzip` recovers most of it. And `time_s` takes one precision for every rate — the finest any of them needs — because a single column cannot mean three things, so a 256 Hz and 1 Hz mix writes both at eight decimal places. That is the finest rate in the conversion rather than in the file: narrowing with `--channels` narrows the set, so the column can come back at a different width, carrying the same instants.

## Seeing the split before you convert

`--info` reads the header only, converts nothing, and shows which file each channel is destined for:

```bash
edf2csv recording.edf --info
```

```
Channels   3 signals

#  COLUMN       LABEL        UNIT  RATE    RANGE        OUTPUT
0  EEG Fpz-Cz   EEG Fpz-Cz   uV    256 Hz  -250 to 250  signals_256hz.csv
1  ECG          ECG          mV    128 Hz  -5 to 5      signals_128hz.csv
2  Temp rectal  Temp rectal  degC  1 Hz    34 to 40     signals_1hz.csv

Sampling rates differ, so channels are written to 3 files, one per rate. No
channel is resampled.
Would write 1,155 rows, roughly 22.2 KB.
```

Run it on an unfamiliar file before committing to a conversion.

## Where each channel ended up

Two of the sidecar files record the mapping, so you don't have to infer it from filenames.

`channels.csv` has a row per channel and an `output_file` column naming the file that channel's samples went to, plus a `converted` column that's `yes` or `no`. Channels you didn't select are still described here, marked `no`, so the sidecar documents the whole recording rather than just the part you took:

```
column,signal_index,label,unit,sampling_rate_hz,samples_per_record,...,output_file,converted
EEG Fpz-Cz,0,EEG Fpz-Cz,uV,256,256,...,signals_256hz.csv,yes
ECG,1,ECG,mV,128,128,...,signals_128hz.csv,yes
Temp rectal,2,Temp rectal,degC,1,1,...,signals_1hz.csv,yes
```

`metadata.json` records the same grouping under `conversion.rate_groups`, in a form that's easier to read from a script:

```json
"rate_groups": [
  { "file": "signals_256hz.csv", "sampling_rate_hz": 256, "channels": ["EEG Fpz-Cz"], "decimals": [3] },
  { "file": "signals_128hz.csv", "sampling_rate_hz": 128, "channels": ["ECG"], "decimals": [5] },
  { "file": "signals_1hz.csv",   "sampling_rate_hz": 1,   "channels": ["Temp rectal"], "decimals": [5] }
]
```

## Single-rate recordings get a single file

If every channel shares one rate, which is the common case for a plain EEG or ECG montage, there's one group and one file, called `signals.csv`. No rate suffix and no extra files.

The same applies when your selection happens to be uniform. Asking for a single channel out of a mixed-rate file leaves one rate in play, so you get a plain `signals.csv`:

```bash
edf2csv recording.edf --channels "Temp rectal" --out ./temperature
```

```
  signals.csv   3  rows
  channels.csv  3  rows
```

The mixed-rate warning describes the conversion rather than the recording, so narrowing to a single rate raises nothing at all — there is no split to explain. Narrowing to two of three rates reports those two. `--info` still lists every channel in the file, including the ones marked `(not selected)`, so nothing about the recording is hidden.

One consequence to watch for: if you convert a mixed-rate recording and then a single-rate one into the same directory with `--force`, the old `signals_256hz.csv` isn't deleted and will sit next to the new `signals.csv`, both looking current. edf2csv warns about the leftovers and deletes nothing. Converting into a fresh directory avoids the situation.

## Working with several rate files

The files share one time base, so joining them is a normal table operation. To attach the slow channel to the fast one, use `pandas.merge_asof`, which matches each fast row to the most recent slow reading at or before it:

```python
import pandas as pd

eeg = pd.read_csv("converted/signals_256hz.csv")
temp = pd.read_csv("converted/signals_1hz.csv")

merged = pd.merge_asof(
    eeg,             # 768 rows, one per EEG sample
    temp,            # 3 rows, one per thermistor reading
    on="time_s",
    direction="backward",
    tolerance=1.0,   # do not carry a reading forward more than one second
)
```

`merge_asof` needs both frames sorted on `time_s`, which they are for a continuous recording. The result has 768 rows, and the temperature column repeats each reading until the next one arrives. That's still interpolation in its crudest form, but it happens in your script with a `tolerance` you chose, and anyone reading the code can see that the temperature column is carried forward rather than measured 768 times.

To go the other way and summarise the fast channel at the slow channel's resolution, aggregate into bins the slow channel defines. This reduces data rather than inventing it, so it's usually the safer direction:

```python
import pandas as pd

eeg = pd.read_csv("converted/signals_256hz.csv")
temp = pd.read_csv("converted/signals_1hz.csv")

per_second = (
    eeg.assign(second=eeg["time_s"] // 1.0)
       .groupby("second")["EEG Fpz-Cz"]
       .agg(["mean", "std", "count"])
       .reset_index()
)

aligned = per_second.merge(temp, left_on="second", right_on="time_s")
```

The `count` column is a useful check: for a complete 256 Hz recording every bin should hold 256 samples, and a bin that doesn't indicates something about the recording.

A time window applies consistently across the files. Converting one second out of the middle of the same recording gives 256, 128 and 1 rows, and each file's `time_s` still carries absolute offsets from the start of the recording rather than restarting at zero:

```bash
edf2csv recording.edf --start 1s --duration 1s --out ./one-second
```

If you need wall clock times rather than offsets, `metadata.json` records the recording's start as `recording.start_datetime_local`, and adding it to `time_s` gives an absolute timestamp.

## Resampling is left to you

edf2csv doesn't resample under any flag. Upsampling temperature to 256 Hz and downsampling EEG to 1 Hz both produce a single tidy table, but they answer different questions and introduce different distortions. Downsampling without an anti-aliasing filter folds high-frequency content back into your band of interest. Upsampling inflates every sample count, which breaks anything that uses n as a denominator.

If you want a uniform grid, resample explicitly in your own code, where the choice is recorded:

```python
import pandas as pd
from scipy.signal import resample_poly

eeg = pd.read_csv("converted/signals_256hz.csv")

# 256 Hz to 128 Hz, with the anti-aliasing filter resample_poly applies for you.
downsampled = resample_poly(eeg["EEG Fpz-Cz"].to_numpy(), up=1, down=2)
time = eeg["time_s"].to_numpy()[::2]

out = pd.DataFrame({"time_s": time, "EEG Fpz-Cz": downsampled})
```

The resampled file then exists because you chose it, with a method you named, rather than as a side effect of the conversion.
