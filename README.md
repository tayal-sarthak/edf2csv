# edf2csv

Turn an EDF or EDF+ recording into CSV with one command.

```bash
npx edf2csv recording.edf
```

That's it. You get a `recording_csv/` folder you can open in pandas, R, MATLAB, or
Excel. Nothing is uploaded, nothing is installed permanently, and the numbers are
not altered on the way through.

## What you get

```text
recording_csv/
├── signals.csv       the data, one row per time point
├── channels.csv      each channel's unit, sampling rate and range
├── annotations.csv   EDF+ events            (only if the file has them)
└── metadata.json     recording details
```

```csv
time_s,FP1-F7,F7-T7,T7-P7
0.000000,-17.778,39.267,-3.712
0.003906,0.195,0.195,0.195
```

`time_s` is seconds from the start. Columns are the channel names from the file.

## Check before you convert

An hour of 23-channel EEG makes a 165 MB CSV — too many rows for Excel. `--info`
shows you what you'd get, without writing anything:

```bash
npx edf2csv recording.edf --info
```

Want a piece instead of the whole thing:

```bash
npx edf2csv recording.edf --start 30m --duration 5m
```

## Options

```text
  -i, --info             Show what's in the file, convert nothing
  -o, --out <dir>        Where to write it
  -c, --channels <list>  Only these channels, e.g. "EEG Fpz-Cz,ECG"
      --start <time>     Start here (30s, 5m, 1h30m, 00:30:00)
      --duration <time>  How much to convert
      --end <time>       Or stop here instead
      --annotations-only Just the EDF+ events
      --decimals <n>     Force a number of decimal places
      --checksum         Put a SHA-256 of the input in metadata.json
  -f, --force            Overwrite the output folder
  -q, --quiet            Less output
      --json             Machine-readable summary on stdout
  -h, --help             Help
```

Exit codes: `0` fine, `1` couldn't read or write the file, `2` bad command.

## What it won't do to your data

**It won't resample.** Some EDF files mix rates — EEG at 256 Hz, temperature at
1 Hz. Squeezing those into one table means inventing samples, so each rate gets its
own file (`signals_256hz.csv`, `signals_1hz.csv`). A 1 Hz channel over 3 seconds
gets 3 rows, because that's how many readings exist.

For comparison, `mne.io.read_raw_edf` turns those same 3 readings into 768
interpolated values with no warning. That's the right call for MNE, which needs one
uniform array to run its analysis. It's the wrong call for a converter.

**It won't convert units.** Microvolts stay microvolts.

**It won't hide gaps.** EDF+D recordings have real breaks in time. They show up as
a jump in `time_s` rather than being closed up.

**It won't stay quiet about problems.** Truncated files, headers that contradict
the data, duplicate channel names, calibration that can't be applied — you get told,
in plain words, before you rely on the output.

## Is it right?

Values are checked against [pyEDFlib](https://github.com/holgern/pyedflib). On the
recordings used for testing, 129,536 sample values came out **bit-for-bit
identical** — not close, identical.

```bash
npm test
```

## Notes

Needs Node 20+. No dependencies. MIT licensed.

Doesn't read BDF (BioSemi 24-bit) yet — it says so clearly rather than guessing.
No filtering, no artifact removal, no AI, no network calls. It reads a file and
writes files.
