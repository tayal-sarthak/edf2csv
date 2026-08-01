---
title: Mixed sampling rates
description: Why edf2csv writes one CSV per sampling rate and never resamples, and how to work with the files it produces
order: 4
---

## EDF files routinely mix rates

EDF does not store one sampling rate for the whole recording. It stores a record duration in the file header, and then, for every channel separately, how many samples that channel contributes to each data record. A channel's rate is those two numbers divided:

```
sampling rate (Hz) = samples per data record / record duration in seconds
```

Because the count is per channel, nothing stops one file from holding channels at wildly different rates, and real recordings do exactly that. A polysomnography montage might carry EEG at 256 Hz, EOG at 100 Hz, respiratory effort at 10 Hz and a rectal thermistor at 1 Hz, all in one file. That is not a malformed file. It is the format working as designed: you sample each sensor at the rate that sensor deserves, and temperature does not deserve 256 Hz.

## One wide CSV cannot hold them without inventing samples

A CSV table has one row per time value and one column per channel. If you want a single table, the fastest channel decides how many rows there are. Take three seconds of recording with EEG at 256 Hz and temperature at 1 Hz. The EEG contributes 768 samples. The temperature contributes 3. A single table with 768 rows has 768 cells in the temperature column and only 3 real numbers to put in them.

There are three ways to fill the other 765 cells, and all of them are worse than not filling them:

1. Repeat the last value. The column now shows 768 readings, 765 of which the thermistor never produced. Anything that counts samples, estimates a spectrum, or computes a variance is now working on fabricated data.
2. Interpolate between readings. Same problem, with the added twist that the invented values look smoother and more plausible than the real ones.
3. Leave the cells blank. This is honest, but it makes a file that is more than 99% empty for that column, and many readers will silently treat the blanks as zero or drop the rows.

The trouble with options 1 and 2 is not that interpolation is wrong. Interpolation is often exactly what you want. The trouble is that once the numbers are in a CSV they are indistinguishable from measurements. Nothing in the file records which values came off a sensor and which came out of an algorithm.

## What MNE does, and why it is right for MNE

Load a three second file with one 256 Hz channel, one 128 Hz channel and one 1 Hz channel using `mne.io.read_raw_edf`, and every channel reports 768 samples. The 3 genuine temperature readings become 768 values, upsampled to the fastest channel in the file. No warning is printed.

This is a deliberate and defensible choice for MNE. MNE is an analysis library built around `Raw`, a single 2D array of shape `(n_channels, n_times)` with one shared time axis. Filtering, epoching, ICA, source localisation and every plotting routine assume that array. A ragged structure would break all of it. Given that design, expanding the slow channels is the only thing MNE can do, and for the work MNE is for it usually does not matter: nobody runs ICA on a thermistor.

It is the wrong choice for a converter. A converter's whole job is to hand you the file's contents in a different container. If the CSV that comes out contains 765 numbers the recording never contained, the conversion has added information, and you have no way of knowing which rows to distrust. The failure mode is quiet: your analysis runs, produces a number, and the number is partly about the interpolator.

## What edf2csv writes instead

One file per distinct sampling rate. Nothing is resampled, upsampled, downsampled, interpolated or padded. Every number in every output file is a number that was in the recording.

Here is the same three second file converted:

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
Done in 0.0s.
```

768, 384 and 3. The row counts are the sample counts. The temperature file has three rows because the thermistor produced three readings:

```
time_s,Temp rectal
0.000,37.00073
1.000,37.14725
2.000,37.29377
```

Each file is a complete, self-contained CSV: a `time_s` column followed by one column per channel at that rate, with the channel's label as the column heading. The files are written in descending rate order, and named after the rate they hold:

| Rate | File name |
| --- | --- |
| 256 Hz | `signals_256hz.csv` |
| 128 Hz | `signals_128hz.csv` |
| 1 Hz | `signals_1hz.csv` |
| 12.5 Hz | `signals_12_5hz.csv` |
| 0.5 Hz | `signals_0_5hz.csv` |

A fractional rate has its decimal point replaced by an underscore, so the name is safe as a filename on every platform.

The `time_s` column is seconds from the start of the recording, and it means the same thing in every file. That shared clock is what makes the separate files joinable later. The number of decimal places is chosen per rate so that sample times are written exactly rather than rounded: 256 Hz gets 8 places because 1/256 terminates at 8 decimal places, 128 Hz gets 7, and 1 Hz gets 3. Multiplying `time_s` by the rate gives back a whole sample index rather than something like 8191.99999.

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

Sampling rates differ, so channels are written to 3 files, one per rate. No channel is resampled.
Would write 1,155 rows, roughly 27.4 KB.
```

This is the cheapest way to find out what you are dealing with, and it is worth running on an unfamiliar file before you commit to a conversion.

## Where each channel ended up

Two of the sidecar files record the mapping, so you never have to infer it from filenames.

`channels.csv` has a row per channel and an `output_file` column naming the file that channel's samples went to, plus a `converted` column that is `yes` or `no`. Channels you did not select are still described here, marked `no`, so the sidecar always documents the whole recording rather than just the part you took:

```
column,signal_index,label,unit,sampling_rate_hz,samples_per_record,...,output_file,converted
EEG Fpz-Cz,0,EEG Fpz-Cz,uV,256,256,...,signals_256hz.csv,yes
ECG,1,ECG,mV,128,128,...,signals_128hz.csv,yes
Temp rectal,2,Temp rectal,degC,1,1,...,signals_1hz.csv,yes
```

`metadata.json` records the same grouping under `conversion.rate_groups`, in a form that is easier to read from a script:

```json
"rate_groups": [
  { "file": "signals_256hz.csv", "sampling_rate_hz": 256, "channels": ["EEG Fpz-Cz"], "decimals": [3] },
  { "file": "signals_128hz.csv", "sampling_rate_hz": 128, "channels": ["ECG"], "decimals": [5] },
  { "file": "signals_1hz.csv",   "sampling_rate_hz": 1,   "channels": ["Temp rectal"], "decimals": [5] }
]
```

## When there is nothing to split, nothing is split

If every channel in the recording shares one rate, which is the common case for a plain EEG or ECG montage, there is one group and one file, called `signals.csv`. No rate suffix, no extra files, no decisions to make. The honest behaviour costs you nothing when there is nothing to be honest about.

The same collapse happens when your selection happens to be uniform. Asking for a single channel out of a mixed-rate file leaves one rate in play, so you get a plain `signals.csv`:

```bash
edf2csv recording.edf --channels "Temp rectal" --out ./temperature
```

```
  signals.csv   3  rows
  channels.csv  3  rows
```

The mixed-rate warning still prints, because it describes the recording rather than your selection. That is intentional: it tells you the file contains channels at other rates that you are not looking at.

One consequence worth knowing. If you convert a mixed-rate recording and then a single-rate one into the same directory with `--force`, the old `signals_256hz.csv` is not deleted and will sit next to the new `signals.csv`, both looking current. edf2csv notices and warns about the leftovers, and deletes nothing. Converting into a fresh directory avoids the question entirely.

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

`merge_asof` needs both frames sorted on `time_s`, which they are for a continuous recording. The result has 768 rows, and the temperature column repeats each reading until the next one arrives. That is still interpolation, in the crudest form, but now it is yours: it happened in your script, on a line you can see, with a `tolerance` you chose, and anyone reading the code knows the temperature column is carried forward rather than measured 768 times.

To go the other way and summarise the fast channel at the slow channel's resolution, aggregate into bins the slow channel defines. This reduces data rather than inventing it, so it is usually the safer direction:

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

The `count` column is a useful check: for a complete 256 Hz recording every bin should hold 256 samples, and a bin that does not is telling you something about the recording.

A time window applies consistently across the files. Converting one second out of the middle of the same recording gives 256, 128 and 1 rows, and each file's `time_s` still carries absolute offsets from the start of the recording rather than restarting at zero:

```bash
edf2csv recording.edf --start 1s --duration 1s --out ./one-second
```

If you need wall clock times rather than offsets, `metadata.json` records the recording's start instant as `recording.start_datetime`, and adding it to `time_s` gives an absolute timestamp.

## Resampling is an analyst decision

edf2csv will not resample for you, under any flag, because the choice has real consequences that depend on your analysis and cannot be made by a converter that knows nothing about it. Upsampling temperature to 256 Hz and downsampling EEG to 1 Hz both produce a single tidy table, and they answer different questions with different distortions. Downsampling without an anti-aliasing filter folds high frequency content back into your band of interest. Upsampling inflates every sample count, which quietly breaks anything that uses n as a denominator.

If you do want a uniform grid, do it explicitly and in your own code, where the choice is recorded:

```python
import pandas as pd
from scipy.signal import resample_poly

eeg = pd.read_csv("converted/signals_256hz.csv")

# 256 Hz to 128 Hz, with the anti-aliasing filter resample_poly applies for you.
downsampled = resample_poly(eeg["EEG Fpz-Cz"].to_numpy(), up=1, down=2)
time = eeg["time_s"].to_numpy()[::2]

out = pd.DataFrame({"time_s": time, "EEG Fpz-Cz": downsampled})
```

The point is not that this is hard. It is that the resampled file now exists because you decided it should, with a method you named, rather than because a converter quietly assumed it on your behalf.
