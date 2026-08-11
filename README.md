# edf2csv

Convert an EDF, EDF+ or BDF recording to CSV with one command.

```bash
npx edf2csv recording.edf
```

You get a `recording_csv/` folder that opens in pandas, R, MATLAB or Excel. Nothing
is uploaded, nothing is permanently installed, and the recorded values aren't
changed.

Full documentation: **[edf2csv.vercel.app](https://edf2csv.vercel.app)**

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
0.00000000,0.061,113.126,99.939
0.00390625,37.546,123.871,84.188
```

`time_s` is seconds from the start of the recording. The other columns are the
channel names as the file stores them.

## Check before you convert

An hour of 23-channel EEG produces a 159 MB CSV with 921,600 rows, which just fits
inside Excel's 1,048,576-row limit. Two hours doesn't. `--info` shows you what you'd
get without writing anything:

```bash
npx edf2csv recording.edf --info
```

To convert part of a recording instead of all of it:

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
      --layout <kind>    wide (default): one column per channel, one file per
                         sampling rate. long: one file of time_s,channel,value,
                         every rate together, one row per sample
      --gzip             Compress every CSV, writing .csv.gz files
      --bom              Start each CSV with a UTF-8 byte order mark, so Excel
                         reads accented text and units like µV correctly
  -j, --jobs <n>         Convert this many recordings at once, or "auto"
  -f, --force            Write into the output folder if it already exists
  -q, --quiet            Less output
      --json             Machine-readable JSON on stdout (works with --info too)
      --strict           Exit 1 if the recording raised any warning
      --stdout           Write the CSV to stdout (one table only: one sampling
                         rate, or --layout long)
  -h, --help             Help
  -V, --version          Version
```

Exit codes: `0` success, `1` the file couldn't be read or written, `2` the command
was wrong.

## What it doesn't change

**Sampling rates.** Some EDF files mix them: EEG at 256 Hz, temperature at 1 Hz. A
single table can't hold both rates without inventing samples, so each rate gets its
own file (`signals_256hz.csv`, `signals_1hz.csv`). A 1 Hz channel recorded for three
seconds gives you three rows.

For comparison, `mne.io.read_raw_edf` expands those same three readings into 768
interpolated values without warning. That suits MNE, which needs one uniform array
for its analysis routines, but it isn't what a converter should do.

**Units.** Microvolts stay microvolts.

**Gaps.** EDF+D recordings contain real breaks in time. They appear as a jump in
`time_s` rather than being closed up.

**Problems.** Truncated files, headers that contradict the data, duplicate channel
names and calibration that can't be applied are all reported in plain language
before you rely on the output.

## Accuracy

Values are checked against [pyEDFlib](https://github.com/holgern/pyedflib), the Python
binding around the C library written by the author of the EDF+ specification. Across the 75
generated recordings, 16,943 sample values were bit-for-bit identical: not equal to within a
tolerance, but the same 64 bits.

That check needs Python, so it is a separate command from the test suite:

```bash
pip install pyedflib
npm run crossvalidate
```

## When to use something else

edf2csv converts. For neighbouring jobs, these tools are a better fit:

- **Analysing the signal** — filtering, epoching, re-referencing, ICA, spectral
  work: [MNE-Python](https://mne.tools).
- **Reading EDF inside Python** — [pyEDFlib](https://github.com/holgern/pyedflib)
  hands you arrays directly, with no CSV in between. edf2csv is checked against it.
- **Writing EDF files** — edf2csv only reads them.
- **Viewing a recording** — [EDFbrowser](https://www.teuniz.net/edfbrowser/) is a
  purpose-built viewer.
- **Long recordings you'll analyse repeatedly** — CSV roughly quadruples an EDF's
  size and makes a poor archival format. Convert a window, or read the file directly.

edf2csv suits a spreadsheet destination, a colleague who doesn't use Python, a quick
look at part of a recording, or a pipeline that speaks CSV.

## Notes

Requires Node 20 or newer. No dependencies at all, runtime or otherwise. MIT licensed.

Reads EDF, EDF+ and BDF/BDF+ (BioSemi 24-bit). No filtering, no artifact removal, no
AI, no network calls.
