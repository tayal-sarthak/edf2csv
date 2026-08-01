---
title: Questions and troubleshooting
description: Answers to the questions that come up most often, from several signals files to patient data in metadata.json
order: 11
---

## Why did I get several signals files instead of one?

Because the channels in your recording were not all sampled at the same rate. When every channel
shares one rate you get a single `signals.csv`. When they do not, you get one file per rate,
named after that rate:

```
sleep-study_csv/
  signals_256hz.csv    EEG Fpz-Cz, EEG Pz-Oz
  signals_128hz.csv    ECG
  signals_1hz.csv      Temp rectal
```

A single wide table cannot hold two rates without inventing rows. To put a 1 Hz temperature
channel next to a 256 Hz EEG channel in one table, something has to fill 255 out of every 256
temperature cells with values that were never measured. edf2csv will not do that, so it splits the
table instead. Nothing is resampled, interpolated or padded, and every number in every output file
is a number that came off the recorder.

`channels.csv` has an `output_file` column telling you where each channel went, and
`--info` shows the same mapping before you convert anything.

## Why is my CSV so much larger than the EDF file?

Because EDF stores each sample as 2 raw bytes (3 for BDF) and CSV stores it as human-readable
text. A sample stored as two bytes becomes something like `-114.258`, which is eight characters
plus a comma. A factor of four is normal, and a factor of five or six happens on channels that
need more decimal places.

The size is not padding. The decimal places are chosen per channel from its calibration so that no
two distinct digital codes ever round to the same text, and no further digits than that are
written. Nothing is gained by trimming them except lost resolution.

If the size is a problem, convert less rather than converting coarser:

```bash
edf2csv sleep-study.edf --channels "EEG Fpz-Cz,ECG" --start 1h --duration 20m
```

Run `--info` first and it will tell you the row count and approximate byte size before you commit
to writing anything. Compressing the result afterwards works well, since CSV of this kind is very
repetitive: `gzip signals.csv` typically gets most of the size back.

## Can I open the output in Excel?

Sometimes. Excel and Numbers stop at 1,048,576 rows including the header. One hour of a single
256 Hz channel is 921,600 rows, so it just fits. Two hours does not. When any output file will
exceed the limit, edf2csv warns you before it becomes a problem:

```text
warning: At least one output file will have more than 1,048,576 rows, which is more than Excel or Numbers can open.
         Use --start and --duration to convert a section, or read the file with pandas or R.
```

`channels.csv` and `annotations.csv` are small and open in a spreadsheet without trouble. For the
signal files you have two reasonable options.

Convert a window small enough to open:

```bash
edf2csv sleep-study.edf --start 22m --duration 30s --out ./excerpt
```

Or read the full file with something that has no row limit. All the output uses plain RFC 4180
CSV with a single header row, so no dialect arguments are needed:

```python
import pandas as pd
signals = pd.read_csv("sleep-study_csv/signals_256hz.csv")
```

```r
signals <- readr::read_csv("sleep-study_csv/signals_256hz.csv")
```

Note that a spreadsheet may also reformat what it displays. A time column of `0.00390625` can be
shown as `0.004`, and a label such as `1-2` can be read as a date. The file on disk is unaffected,
but do not trust a spreadsheet's rendering when you are checking values.

## Why does it refuse to write into a directory that already exists?

To stop a second conversion from quietly mixing itself into the results of a first one. If the
output directory exists, the conversion stops before writing anything:

```text
error: "sleep-study_csv" already exists.
       Pass --force to overwrite it, or --out to choose a different directory.
```

That is exit code 1, and nothing on disk has changed. Pick one:

```bash
edf2csv sleep-study.edf --force            # overwrite the previous output
edf2csv sleep-study.edf --out ./run-2      # write somewhere else
```

The check exists because the output is a set of files that only make sense together.
`metadata.json` describes the run that produced the CSVs beside it, and half-replacing that set
would leave you with a metadata file describing one conversion and signal files from another.

## Why is there a leftover signals_256hz.csv next to my new signals.csv?

`--force` overwrites the files a run produces, but it does not empty the directory first. Convert
a mixed-rate recording into a directory, then convert a single-rate one into the same directory,
and the rate-named files from the first run are still sitting there looking current. edf2csv spots
this and tells you:

```text
warning: signals_128hz.csv, signals_1hz.csv are left over from an earlier conversion into this
         directory and were not rewritten.
         Delete them, or convert into a fresh directory, so the two runs do not get mixed up.
```

Nothing is deleted for you. Deleting the stale files or converting into a fresh directory both
resolve it. `metadata.json` always lists the files the current run actually wrote, under
`conversion.files`, so that is the authoritative list if you are unsure which is which.

## I asked for a channel and it says there is no channel with that name

`--channels` matches the channel's label exactly, ignoring case only. It does not do substring or
prefix matching, because a partial match would silently pull in channels you did not ask for. A
term that matches nothing is an error rather than a quiet omission:

```text
error: No channel named "EKG". Did you mean "ECG"?
Run with --info to list the channels in this file.
```

The usual causes are a label with different spacing or punctuation than you expected (`EEG Fpz-Cz`
rather than `EEG-Fpz-Cz`), or trailing spaces in the file's own header. Run `--info` and copy the
label out of the `LABEL` column exactly as printed. Labels with spaces need quoting in the shell:

```bash
edf2csv sleep-study.edf --info
edf2csv sleep-study.edf --channels "EEG Fpz-Cz,ECG"
```

If the label is genuinely awkward, or two channels share it, address the channel by its position
in the file instead. The `#` column in `--info` is that position:

```bash
edf2csv sleep-study.edf --channels "#0,#3"
```

A real label always takes priority over the `#N` form, so a channel actually labelled `#3` stays
reachable by name.

## Why did --channels give me two columns when I asked for one?

Because two channels in the file share that label. EDF does not require labels to be unique, and
recordings with two channels both labelled `T8-P8` are common enough that this is normal rather
than corruption. Both are selected, and you are told why:

```text
warning: "T8-P8" matches 2 channels (positions #0, #1); all of them were selected.
         Use --channels "#0" to pick just one.
```

In the output the columns are suffixed with the signal position so they stay distinct:
`T8-P8_ch0` and `T8-P8_ch1`. The suffix is derived from the whole file, not from your selection,
so a given channel always produces the same column name no matter which channels you asked for.

## The times in my file jump. Is that a bug?

Almost certainly not. Check `metadata.json` for `"format": "EDF+ (discontinuous)"`. A discontinuous
recording (EDF+D or BDF+D) has real gaps in it: the amplifier was paused, or a review tool exported
only the interesting segments. Each data record then carries its own true start time, and edf2csv
writes that time, so a gap appears in the `time_s` column exactly where the recording had one:

```
time_s,EEG Fpz-Cz
1.700,-12.451
1.800,-11.230
1.900,-10.107
10.000,3.418
10.100,4.639
```

That file has no data between 1.9 s and 10.0 s because none was recorded. You are warned at
conversion time:

```text
warning: This is a discontinuous (EDF+D) recording: its data records are not contiguous in time.
         Each row carries its true recording time, so gaps stay visible instead of being closed.
```

This is worth stressing because the alternatives are worse. `mne.io.read_raw_edf` closes EDF+D
gaps silently, which shifts every sample after the gap to a time it was not recorded at.
pyEDFlib refuses EDF+D files outright. Keeping the gap visible means `time_s` is always the real
recording time, and it means you have to handle the gap yourself instead of it handling you.

Two other causes of odd times, both reported as warnings when they occur: records whose
timekeeping annotation is missing get a fallback timestamp computed as if they were contiguous,
and a file whose records are stored out of order produces a `time_s` column that does not increase
monotonically. Both are named explicitly in the warnings and in `metadata.json` under `notes`.

## There is no annotations.csv in my output directory

`annotations.csv` is written only when the recording has an EDF+ or BDF+ annotation channel. Plain
EDF has nowhere to store events, so no file is written rather than an empty one that implies the
events were checked for and found to be absent.

Run `--info`. If the channel count line does not mention an annotation channel, the file has none:

```text
Channels   4 signals + 1 annotation channel
```

When the channel exists but holds no events beyond the per-record timekeeping entries, the file is
written with its header row and no data rows, and `metadata.json` records
`"annotations_written": 0`.

## Does edf2csv send my data anywhere?

No. It runs entirely on your machine. There are no network calls of any kind in the code: no
upload, no download, no update check, no crash reporting, no telemetry, no usage counter. The tool
reads the file you point it at and writes files into the output directory, and that is the whole
of its interaction with the outside world.

It also has zero runtime dependencies, so there is no third-party package running in the same
process that could do any of the above. The only thing that touches the network is `npm` or `npx`
when you install the tool, which happens once and is the package manager's doing rather than the
tool's.

This is deliberate. Clinical and research recordings frequently cannot leave the machine or the
network they are on, and a converter is not worth the paperwork if it phones home.

## Is patient information preserved in the output?

Yes, and you should treat `metadata.json` accordingly.

EDF headers carry two free-text identification fields, and edf2csv copies both into
`metadata.json` verbatim, under `recording.patient_id` and `recording.recording_id`. In an EDF+
file the patient field is structured as a patient code, sex, birth date and name, and the
recording field holds the start date plus a hospital administration code, the technician and the
equipment. In practice these fields contain whatever the recording software put there, which is
sometimes a study code and sometimes a person's actual name and date of birth.

Concretely, `metadata.json` contains:

| Field | What it holds |
| --- | --- |
| `recording.patient_id` | The 80-character patient identification field, exactly as written in the header |
| `recording.recording_id` | The 80-character recording identification field, exactly as written |
| `recording.start_datetime` | Recording start as an ISO timestamp, when the header's date and time parse |
| `recording.start_date_raw` | The raw `dd.mm.yy` date field from the header |
| `recording.start_time_raw` | The raw `hh.mm.ss` time field from the header |
| `source.path` | The absolute path of the input file on the machine that ran the conversion |
| `source.bytes`, `source.modified` | Size and modification time of the input |
| `source.sha256` | Checksum of the input, only when `--checksum` was passed, otherwise `null` |

Two of those are easy to overlook. A recording date and time is itself identifying when combined
with a clinic and a date of admission, so `start_datetime` is not neutral. And `source.path` is the
resolved absolute path, which often embeds a subject folder name.

The fields are copied rather than stripped because a conversion that loses provenance is not
reproducible, and because a tool that silently decided what counts as identifying would be making
that judgement on your behalf. The judgement is yours, so:

- Do not attach `metadata.json` to an issue report, a public repository or a shared drive without
  reading it first.
- If you need to publish a conversion, edit or remove the `recording.patient_id`,
  `recording.recording_id`, `source.path` and start-time fields before you do.
- Anonymise the EDF header before conversion if you want the whole pipeline clean, since the
  metadata is only a faithful copy of what the header already says.

Two other files deserve a look. `--info` prints `Patient` and `Recording` lines to stdout, so
terminal transcripts and CI logs pick them up. And `annotations.csv` holds annotation text exactly
as recorded, which is free text a technician typed and can contain names or clinical notes.

`signals.csv` and `channels.csv` contain no patient identification. `channels.csv` does include
the transducer and prefiltering strings, which can identify a site's equipment but not a person.

## Can I get the raw digital values instead of physical units?

The CSV output is always physical units. There is no flag for raw digital codes, and `--decimals 0`
rounds physical values to whole numbers rather than giving you the underlying integers.

You have two routes. The first is to recover the digital code from the physical value, which is
exact because the mapping is linear and the calibration constants are in `channels.csv`:

```python
import pandas as pd

channels = pd.read_csv("sleep-study_csv/channels.csv").set_index("column")
row = channels.loc["EEG Fpz-Cz"]

gain = (row.physical_max - row.physical_min) / (row.digital_max - row.digital_min)
offset = row.physical_max / gain - row.digital_max

signals = pd.read_csv("sleep-study_csv/signals.csv")
digital = (signals["EEG Fpz-Cz"] / gain - offset).round().astype("int64")
```

The rounding recovers the original integer exactly, because the written decimals are always fine
enough to keep adjacent digital codes distinct.

The second route is the programmatic API, which hands you the integers directly and never builds a
CSV at all:

```javascript
import { EdfFile } from "edf2csv";

const file = await EdfFile.open("sleep-study.edf");
const signal = file.dataSignals[0];
const digital = [];

for await (const batch of file.readRecords()) {
  for (let record = 0; record < batch.recordCount; record++) {
    for (let sample = 0; sample < signal.samplesPerRecord; sample++) {
      digital.push(file.sampleAt(batch, record, signal, sample));
    }
  }
}

await file.close();
console.log(signal.label, digital.slice(0, 8));
```

`sampleAt` returns the raw two's complement integer, sign-extended from 24 bits for BDF. The batch
buffer is reused between iterations, so copy anything you need to keep past the current loop turn.

## Why does one channel have three decimals and another five?

Because the number of decimals is derived from each channel's own calibration, not fixed globally.
The smallest physical step a channel can express is its physical range divided by its digital
range, and edf2csv writes two places past that step. An EEG channel spanning plus or minus 250 uV
across a 12-bit converter has a step of about 0.12 uV, so three decimals are enough for every
distinct sample to have a distinct text. A temperature channel spanning 34 to 40 degC over the same
converter has a step near 0.0015, so it gets five.

The effect is that no resolution is lost and no meaningless digits are written. The per-channel
choice is recorded in `metadata.json` under `conversion.rate_groups[].decimals`, so you can see
exactly what was applied.

If you need a fixed width across channels, for a downstream tool that insists on it, override it:

```bash
edf2csv sleep-study.edf --decimals 6
```

`--decimals` accepts a whole number from 0 to 15 and applies to every channel. Setting it below
what a channel needs discards resolution, which is a real decision and the reason it is not the
default.

## Does it support BDF and BioSemi files?

Yes. BDF and BDF+ are read natively. BioSemi's format is EDF with 24-bit samples instead of 16-bit
and its own version marker, and edf2csv handles both: samples are decoded as 24-bit little-endian
two's complement, and `BDF Annotations` is recognised alongside `EDF Annotations` as the events
channel. `BDF+C` and `BDF+D` are treated exactly as `EDF+C` and `EDF+D`.

The format is reported in `--info` and in `metadata.json`:

```text
Format     BDF+ (discontinuous)
```

Nothing else about the workflow changes. The same flags, the same output files, the same rules
about sampling rates and gaps.

## Does it do filtering, detrending or artifact removal?

No, and it will not. edf2csv applies exactly one transformation: the digital-to-physical scaling
that the file's own header specifies. No filtering, no notch, no detrending, no re-referencing, no
artifact rejection, no resampling, no unit conversion, no scaling to a common range.

This is the point of the tool rather than a missing feature. Preprocessing choices belong to your
analysis, where they are visible, documented and reviewable, not buried in a format conversion
where nobody can see what was done. A converter that filtered on the way out would make the CSV
disagree with the EDF for reasons that no longer appear anywhere.

Two consequences worth knowing. Prefiltering that the recording hardware already applied is
described in the `prefiltering` column of `channels.csv`, so you can see what was done before the
file existed. And a channel whose header declares its physical minimum above its physical maximum
is converted with that inversion intact, since correcting it would mean overriding what the file
says:

```text
warning: Signal 3 ("inverted") declares physical minimum 100 above physical maximum -100, which inverts its polarity.
         The values are converted exactly as the header specifies, inversion included.
```

## What happens with a truncated recording, or one that is still being written?

A truncated file converts. edf2csv derives the number of data records from the actual file size
rather than trusting the header, converts every complete record that is present, and warns about
the discrepancy:

```text
warning: The header declares 10 data records but the file contains 4. Converting the 4 records that are present.
         The recording looks truncated - it may have been cut short or copied incompletely.
```

If bytes are left over after the last complete record, they are ignored and reported separately as
a `TRAILING_BYTES` warning. Both warnings are also written into `metadata.json` under `notes`, so
the conversion carries its own caveat with it. If there is not even one complete data record, the
conversion fails with exit code 1 rather than producing a file with a header row and nothing in it.

A recording still in progress often declares `-1` data records, which the spec permits. That is
handled the same way:

```text
warning: The header does not say how many data records the file has (-1), which the spec allows
         for recordings still in progress. Using the 4 records the file actually contains.
```

Converting a file that is actively being appended to is workable but has one catch: the file size
is read once when the file is opened, so records written after that point are not included. You
get a clean conversion of the recording as it stood at that instant. If the file instead becomes
shorter while it is being read, which happens when a writer rewrites it in place, the conversion
fails rather than handing you a silently short result:

```text
error: Expected 524288 bytes of data at record 1024 but only 131072 were available; the file
       appears to have changed size while it was being read.
       Make sure the recording is not still being written to, then try again.
```

## The values do not match what another tool gave me

Check the low-order digits before assuming a bug. edf2csv computes each physical value as
`gain * (offset + digital)`, which is the arrangement EDFlib uses, and the results are bit-for-bit
identical to pyEDFlib on the recordings used for testing.

The specification writes the same mapping as `(digital - digitalMin) * gain + physicalMin`. That
form is algebraically equivalent but numerically worse: on a channel spanning plus or minus
800 uV it computes a value near 800 and then subtracts 800, and the cancellation throws away
low-order bits. Digital code 0 comes out as `0.19536019536019467` when the correctly rounded value
is `0.19536019536019536`. A tool using the literal ordering will differ from edf2csv in the last
few digits, and edf2csv is the one that is right.

Larger disagreements usually have a structural cause rather than an arithmetic one. If another
tool gave you more rows than edf2csv did, it probably upsampled the slow channels to a common
rate. If it gave you a continuous time axis for a file edf2csv split with a gap, it closed an
EDF+D discontinuity. Compare against `channels.csv` and `metadata.json`, which state the rate and
row count of every file that was written.

## How do I convert a whole directory of recordings?

One file at a time, in a shell loop. edf2csv takes exactly one input file, and passing more than
one is a usage error with exit code 2:

```bash
for f in /data/recordings/*.edf; do
  edf2csv "$f" --out "/data/converted/$(basename "${f%.edf}")"
done
```

Add `--force` if you expect to rerun the loop over the same destinations, and `--quiet` to keep the
per-file summaries out of the log while still seeing warnings and errors. To stop the whole loop on
the first failure, check the exit code:

```bash
set -e
for f in /data/recordings/*.edf; do
  edf2csv "$f" --out "/data/converted/$(basename "${f%.edf}")" --quiet
done
```

## How much memory does a large file need?

Very little, and it does not scale with the length of the recording. Conversion is streamed:
records are read in batches of about 8 MB, converted, and written out, so a 4 GB recording uses
the same working set as a 4 MB one. A 40 MB EDF producing a 165 MB CSV converts in about 1.4
seconds with the Node heap capped at 48 MB.

All the output files are written in the same single pass over the data, so a recording that
produces three rate-split files is still read exactly once.

One thing does scale with the recording: the EDF+ annotation list is collected in memory before it
is written, because annotations have to be sorted by onset and a writer is free to store an event
in a record other than the one its onset falls in. A recording with hundreds of thousands of
events uses memory in proportion to the event count. Signal data never does.

## How do I check whether a conversion had problems from a script?

Use the exit code for pass or fail, and `--json` for the detail. The exit codes are: 0 for success,
1 for a problem with the file or the output directory, 2 for a problem with how the command was
invoked.

```bash
edf2csv sleep-study.edf --out ./converted --json > result.json
```

`--json` writes a summary to stdout and nothing else, so it can be piped or parsed directly:

```json
{
  "output_dir": "./converted",
  "files": [
    { "name": "signals.csv", "rows": 921600 },
    { "name": "annotations.csv", "rows": 3 },
    { "name": "channels.csv", "rows": 1 }
  ],
  "annotations": 3,
  "duration_seconds": 3600,
  "records": 3600,
  "elapsed_ms": 1412,
  "warnings": []
}
```

Every warning the run raised appears in the `warnings` array with a stable `code`, so a script can
react to a specific condition rather than matching on message text:

```bash
edf2csv sleep-study.edf --json \
  | node -e 'process.stdin.toArray().then(c => {
      const codes = JSON.parse(c.join("")).warnings.map(w => w.code);
      if (codes.includes("RECORD_COUNT_MISMATCH")) process.exit(1);
    })'
```

Note that under `--json` the warnings go into the JSON on stdout instead of being printed to
stderr, so you will not see them twice. Without `--json`, warnings and the summary go to stderr and
only `--info` output goes to stdout, which means a conversion can run inside a pipeline without its
chatter contaminating the data.

## How do I cite edf2csv, or pin a version?

Pin the version wherever the tool is invoked, so a rerun a year from now produces the same bytes:

```bash
npx edf2csv@0.1.0 sleep-study.edf
npm install -g edf2csv@0.1.0
```

Every conversion already records which version produced it. `metadata.json` opens with:

```json
{
  "tool": {
    "name": "edf2csv",
    "version": "0.1.0"
  }
}
```

Add `--checksum` and the SHA-256 of the input file is recorded alongside it, under
`source.sha256`, which pins the input as firmly as the version pins the tool:

```bash
edf2csv sleep-study.edf --checksum
```

For a methods section, name the tool, the version and the repository, and state the one
non-obvious thing the conversion did:

> EDF recordings were converted to CSV with edf2csv 0.1.0
> (https://github.com/tayal-sarthak/edf2csv). Channels recorded at different sampling rates were
> written to separate files and were not resampled.

edf2csv is MIT licensed, so it can be redistributed, vendored into a pipeline or included in
supplementary material without restriction. `edf2csv --version` prints the version of whatever
copy you are running.
