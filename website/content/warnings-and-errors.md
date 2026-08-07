---
title: Warnings and errors
description: Every diagnostic and error code edf2csv can raise, what causes it in a real recording, and what to do about it
order: 6
---

edf2csv makes a sharp distinction between two things. A **warning** means the conversion succeeded but something about the recording is worth knowing before you analyse the numbers. A **fatal error** means the file can't be read into trustworthy output, so nothing is converted at all.

Warnings never change the exit code. A recording can produce six warnings and still exit 0, because the CSV it produced is correct: the warnings describe the recording, not a failure of the tool.

## How edf2csv reports problems

Every diagnostic has a stable machine-readable code (`MIXED_SAMPLING_RATES`, `TRAILING_BYTES`, and so on), a severity, a message, and often a hint on the line below telling you what you can do.

Warnings and errors go to **stderr**. Requested data (`--info`'s channel table, `--json`'s summary) goes to **stdout**. The separation lets you pipe a conversion summary into another program without warning text mixed into it.

```
warning: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
```

The severity field can be `warning` or `info`. A `warning` prints with a `warning:` prefix; an `info` would print with a `note:` prefix. Every diagnostic the current code raises is a warning, so `note:` lines don't appear in practice.

Four places show you the same diagnostics in different forms.

| Where | Behaviour |
| --- | --- |
| Terminal, default | Printed to stderr before the conversion summary, hint included |
| `--quiet` | Suppresses the summary only. Warnings and errors still print |
| `--json` | Diagnostics aren't printed as text. They appear in the `warnings` array on stdout, each with `code`, `severity` and `message`. Hints aren't included |
| `metadata.json` | The `notes` array records `code`, `severity` and `message` for every diagnostic raised while reading the header and planning the conversion |

There's one exception. `STALE_OUTPUT` is detected after `metadata.json` has already been written, so it appears on the terminal and in `--json` output but never in `metadata.json`.

### What `--info` can and can't tell you

`--info` reads the header and builds a conversion plan without touching the data records or the annotation channel. It therefore surfaces every structural, calibration and output-shape warning, but it can't raise the ones that only become visible while converting: `ANNOTATION_DECODE_FAILED`, `NO_ANNOTATIONS`, `STALE_OUTPUT`, and the two `DISCONTINUOUS` variants that come from inspecting record timestamps.

```bash
edf2csv sleep-study.edf --info
```

If you want to know about a file before committing to a conversion, `--info` is the cheapest way to see most of what edf2csv would say.

## Warnings at a glance

| Code | One line |
| --- | --- |
| `HEADER_BYTES_MISMATCH` | The header's own declared size disagrees with the signal count |
| `RECORD_COUNT_UNKNOWN` | The header says `-1` records instead of a number |
| `RECORD_COUNT_MISMATCH` | The file holds a different number of records than the header claims |
| `TRAILING_BYTES` | Bytes after the last complete data record were ignored |
| `COMMA_DECIMAL` | A header number used a comma as its decimal separator |
| `DEGENERATE_DIGITAL_RANGE` | A channel's digital minimum equals its digital maximum |
| `DEGENERATE_PHYSICAL_RANGE` | A channel's physical minimum equals its physical maximum |
| `UNUSABLE_PHYSICAL_RANGE` | A channel's physical range is too wide to represent |
| `INVERTED_PHYSICAL_RANGE` | A channel's calibration inverts its polarity: exactly one of its two bounds pairs is reversed |
| `NO_SAMPLES` | A channel declares zero samples per data record |
| `EMPTY_LABEL` | A channel has a blank label |
| `DUPLICATE_LABEL` | Two or more channels share a label, or a `--channels` term matched several |
| `DISCONTINUOUS` | The recording has gaps in time, or its records are out of order |
| `ANNOTATION_DECODE_FAILED` | Annotation text couldn't be decoded, or a record's timestamp is missing |
| `NO_ANNOTATIONS` | `--annotations-only` was used on a file with no annotation channel |
| `MIXED_SAMPLING_RATES` | The channels being converted run at different rates, so several output files are written |
| `NO_SIGNAL_CHANNELS` | The file contains annotations and nothing else |
| `LARGE_OUTPUT` | An output file will be too big for a spreadsheet application |
| `STALE_OUTPUT` | Files from an earlier conversion are still sitting in the output directory |
| `NONPRINTABLE_LABEL` | A channel's label or unit contains control characters |
| `EMPTY_WINDOW` | The requested window lands where the recording has no data, so the signal files hold only their headers |
| `INPUT_CHANGED` | The input changed while it was being converted |
| `TIME_RESOLUTION` | Samples arrive faster than the time column can distinguish, so consecutive rows share a `time_s` |

## File structure and integrity

These come from parsing the header and comparing it against the file's actual size. They tell you whether the file on disk matches what it says about itself.

### HEADER_BYTES_MISMATCH

The header contains a field stating its own length in bytes. This warning fires when that number disagrees with the length implied by the signal count, which is always 256 bytes for the fixed header plus 256 bytes per signal.

**Cause.** Almost always a writer that filled in the field carelessly, or a file that was edited by hand or by a script that changed the signal list without updating the length.

**What edf2csv does.** Ignores the declared value and uses the computed one. Every data record offset is derived from the computed length, so the samples land where they should.

```
warning: Header says it is 99 bytes, but 2 signals require 768 bytes. Using the value computed from the signal count.
```

**What to do.** Nothing, if the rest of the conversion looks right. Check the `--info` channel table: if the labels and units are readable text and the sampling rates are plausible, the header was parsed correctly and only the length field was wrong. Garbled labels alongside this warning point at a genuinely damaged file.

### RECORD_COUNT_UNKNOWN

The header declares `-1` data records rather than a count.

**Cause.** The EDF specification permits `-1` for a recording still in progress: the writer doesn't know the final count until it stops. Some acquisition software leaves the placeholder in place even after the recording ends.

**What edf2csv does.** Derives the count from the file size and converts every complete record present.

```
warning: The header does not say how many data records the file has (-1), which the spec allows for recordings still in progress. Using the 4 records the file actually contains.
```

**What to do.** Confirm the recording is finished and not still being written to. Converting a file that's actively growing risks a mid-read failure (see `UNREADABLE` below). If the file is closed, the derived count is the right one.

### RECORD_COUNT_MISMATCH

The header declares a specific number of data records and the file contains a different number.

**Cause.** When the file is shorter than declared, the usual causes are an interrupted recording, a copy that didn't finish, or a transfer that was cut off. When the file is longer than declared, the writer under-reported, or something was appended.

**What edf2csv does.** Trusts the file over the header and converts every complete record that's actually there. The hint changes depending on the direction: a short file gets a note that the recording may have been cut short, and a long file gets a note that the file exceeds its own claim.

```
warning: The header declares 10 data records but the file contains 4. Converting the 4 records that are present.
```

**What to do.** If the file is short, decide whether the missing tail matters for your analysis, and check whether a complete copy exists elsewhere. The duration reported by `--info` reflects the records actually present, not the declared ones, so it's safe to reason from. `metadata.json` records both numbers as `data_records` and `data_records_declared`.

### TRAILING_BYTES

Some bytes sit after the last complete data record, too few to form another record.

**Cause.** A recording stopped part way through writing its final record, or a file transfer was truncated mid-record.

**What edf2csv does.** Ignores them. A partial record can't be decoded into a full set of samples across every channel, and guessing at it would invent data.

```
warning: 7 bytes after the last complete data record were ignored.
```

**What to do.** Usually nothing. A handful of ignored bytes at the end of a long recording is a fraction of a second. If the count is large relative to one record's size, that's a sign of a more serious problem and is worth investigating alongside `RECORD_COUNT_MISMATCH`.

### COMMA_DECIMAL

At least one numeric field in the header used a comma as its decimal separator, which the EDF specification doesn't allow.

**Cause.** Software written in a locale where the comma is the decimal separator, formatting numbers without forcing a neutral locale. It shows up in physical minimum and maximum fields most often, and in the record duration.

**What edf2csv does.** Reads a comma as a decimal point, but only when the field contains no dot at all, and raises this warning once for the whole file no matter how many fields were affected. The fields covered are the header length, record count, record duration, signal count, and each signal's physical minimum, physical maximum, digital minimum, digital maximum and samples per record.

```
warning: Some header numbers use a comma decimal separator, which the EDF spec does not allow.
         They were read as decimal points. Check the values in the channel table.
```

**What to do.** Look at the channel table in `--info` or at `channels.csv` and confirm the physical ranges are what you expect for those channels. A range of `-250 to 250` for an EEG channel in microvolts is plausible; `-250000 to 250000` would suggest the separator was interpreted differently than the writer intended.

## Channel calibration and labelling

These describe individual channels. They are raised per signal, and never for the EDF+ annotations channel, which carries text rather than samples and has no meaningful calibration.

Only one of the three calibration warnings is raised per channel. The checks run in order: a degenerate digital range is reported first and suppresses the other two, then a degenerate physical range, then an inverted physical range.

### DEGENERATE_DIGITAL_RANGE

A channel declares the same value for its digital minimum and digital maximum.

**Cause.** A header field filled in with a placeholder, or a channel that was configured but never properly calibrated. It's common on unused or dummy channels that acquisition software adds to fill out a montage.

**What edf2csv does.** The digital-to-physical mapping is defined by two calibration points. With both points at the same digital value the mapping doesn't exist, so there's no physical value to compute for any sample. Those cells are written empty.

```
warning: Signal 0 ("flat") has digital minimum equal to digital maximum (0), so its values cannot be scaled.
         Its cells are left empty rather than filled with a value the header cannot justify.
```

An empty field is the same convention `annotations.csv` uses for an absent duration, and it reads back as `NaN` in pandas and `NA` in R. Earlier versions wrote the channel's physical minimum instead; a column of repeated numbers is indistinguishable from a genuinely flat recording once the CSV is opened somewhere else, which is the sort of invented data this tool exists to avoid. Channels either side of the degenerate one are unaffected.

**What to do.** Don't analyse that channel. If it matters to you, go back to the acquisition system for a correctly calibrated export. Otherwise exclude it with `--channels` and convert the rest:

```bash
edf2csv recording.edf --channels "EEG Fpz-Cz,ECG"
```

### DEGENERATE_PHYSICAL_RANGE

A channel declares the same value for its physical minimum and physical maximum, while its digital range is valid.

**Cause.** Same family of causes as above: an uncalibrated or placeholder channel, or a writer that left both physical fields at zero.

**What edf2csv does.** The mapping is well defined but flat, so every digital code converts to the same physical number. The channel is converted normally and produces a constant column.

Note the difference from `DEGENERATE_DIGITAL_RANGE` above. There the mapping doesn't exist and the cells are left empty; here it exists and simply has no slope, so the value it gives is a real reading and is written as one.

**What to do.** Treat the column as carrying no information. Distinct digital codes were recorded, but the header says they all mean the same physical value, so the distinction can't be recovered from the CSV. If you need the raw codes, the header calibration in `channels.csv` gives you `digital_min`, `digital_max`, `physical_min` and `physical_max` to work from.

### UNUSABLE_PHYSICAL_RANGE

The distance between a channel's physical minimum and maximum overflows a double, so no gain can be
computed from it.

**Cause.** EDF's physical range fields are eight ASCII characters and accept exponent form, so a
header can legitimately say `-1e308` to `1e308`. Real hardware does not, but generated or corrupted
headers do.

**What edf2csv does.** Treats it as an undefined mapping and leaves those cells empty, the same as
`DEGENERATE_DIGITAL_RANGE`. Earlier versions wrote the physical minimum instead, which filled the
column with one enormous constant — every distinct sample rendered as the same 300-digit number —
and raised no diagnostic at all.

```
warning: Signal 0 ("huge") declares a physical range from -1e+308 to 1e+308, whose span is too large to represent, so its values cannot be scaled.
         Its cells are left empty rather than filled with a value the header cannot justify.
```

**What to do.** Treat the channel as unreadable and check where the header came from. Channels
either side of it are unaffected.

### INVERTED_PHYSICAL_RANGE

A channel's calibration inverts its polarity.

The gain is `(physical_max - physical_min) / (digital_max - digital_min)`, so what makes a channel inverted is the sign of that fraction, not the physical pair on its own. Reversing exactly one of the two pairs makes it negative; reversing both leaves it positive, and such a channel is not inverted at all:

| physical bounds | digital bounds | gain | raised |
| --- | --- | --- | --- |
| reversed | normal | negative | yes |
| normal | reversed | negative | yes |
| reversed | reversed | positive | no |

**Cause.** This is sometimes a mistake and sometimes deliberate. Some hardware records a channel with inverted polarity and expresses that by swapping one pair of bounds, which is a legitimate reading of the specification. Others simply wrote the fields in the wrong order.

**What edf2csv does.** Converts exactly as the header specifies, inversion included. Overriding the header would silently flip the sign of real data.

```
warning: Signal 3 ("inverted") declares physical minimum 100 above physical maximum -100, which inverts its polarity.
         The values are converted exactly as the header specifies, inversion included.
```

The message names whichever pair is reversed, so a file with its digital bounds the wrong way round says so rather than reporting the physical ones.

**What to do.** Check the sign of a feature you can recognise, for example the direction of the R wave on an ECG channel or the polarity of a known artefact. If the polarity is wrong for your purposes, negate the column in your analysis. Don't assume edf2csv corrected it.

### NO_SAMPLES

A channel declares zero samples per data record, so it carries no data anywhere in the file.

**Cause.** A channel that was defined in the montage but never recorded, or one that was disabled after the header was laid out.

**What edf2csv does.** Describes the channel in `channels.csv` with `converted` set to `no`, and leaves it out of the signal files entirely. There's no empty column and no zero-hertz output file.

```
warning: Signal 0 ("ch1") carries no samples at all (0 per data record).
         It is described in channels.csv but left out of the converted data.
```

**What to do.** Nothing, unless you expected data on that channel. A zero-sample channel is left out of the sampling-rate comparison entirely, so it can't make a single-rate recording look mixed — up to 0.2.4 its nominal 0 Hz was counted as a rate, and a file with one real rate warned that it used "2 different sampling rates (4 Hz, 0 Hz)".

Note that `NO_SAMPLES` is also a fatal error code. As a warning it means one channel is empty; as an error it means every channel is, which leaves nothing to convert. See the fatal errors section below.

### EMPTY_LABEL

A channel's label field is blank.

**Cause.** A writer that didn't fill the field in, or a channel that was never named in the acquisition setup.

**What edf2csv does.** Names the column `signal_<index>` using the channel's position in the file, which is stable and unambiguous.

```
warning: Signal 0 has no label. It will appear as "signal_0".
```

**What to do.** Consult your recording notes to work out what the channel is. `channels.csv` gives you the transducer type, prefiltering string, unit and physical range for that signal, which together are often enough to identify it.

### DUPLICATE_LABEL

This code is raised in two different situations.

**From the header.** Two or more channels in the file share exactly the same label. This is common in real data: some standard EEG montages ship recordings with two channels both labelled `T8-P8`. Labels in EDF are free text and the format doesn't require them to be unique.

edf2csv preserves labels verbatim in output and only disambiguates when the file itself is ambiguous. When a label is duplicated, every channel carrying it gets a `_ch<index>` suffix on its column name, where the index is the channel's position in the file. One warning is raised per duplicated label, naming all of the positions involved.

```
warning: 2 signals share the label "T8-P8" (positions 0, 1).
         Their columns are suffixed with the signal number so they stay distinguishable.
```

**From channel selection.** A `--channels` term matched more than one channel. Matching is case-insensitive on the whole label, so a term that names a duplicated label selects all of them.

```
warning: "T8-P8" matches 2 channels (positions #0, #1); all of them were selected.
         Use --channels "#0" to pick just one.
```

**What to do.** If you only want one of the duplicates, address it by position with `#N`:

```bash
edf2csv recording.edf --channels "#0,ECG"
```

Column names are derived from the whole file, not from your selection, so a given channel always produces the same column name whether you convert one channel or all of them. That means `T8-P8_ch0` is stable across runs and safe to reference in downstream scripts.

The suffix is checked against every other label in the file, not just against the one it disambiguates. A file that carries `T8`, `T8` and a third channel genuinely labelled `T8_ch0` would otherwise produce two columns called `T8_ch0`; instead the two that collide take their own positions as well, and the channel that lost its own label is named:

```
warning: Signal 2 is labelled "T8_ch0", which is also the column name another channel's
         "_ch" suffix produces, so its column is "T8_ch0_ch2".
         Column names are unique; look this channel up in channels.csv by its signal_index.
```

No two columns in `signals.csv` ever share a name, so the `channels.csv` join always resolves.

### TIME_RESOLUTION

Sample times are written to at most nine decimal places, which separates everything up to a gigahertz. Faster than that and the column repeats.

**Cause.** A sample interval finer than fifteen decimal places can express, and with no terminating expansion to find — 3e15 Hz, say, where 1/3e15 repeats forever. A rate that terminates gets as many places as it needs up to fifteen, so every power of two through 32768 Hz is written exactly; one that repeats gets as many as it takes to keep consecutive samples apart, to the same limit. EDF's record-duration field is 8 characters and accepts `1e-15`, so the format permits these rates; nothing that records biosignals comes within nine orders of magnitude of them.

```
warning: Channels at 10000000000 Hz sample faster than the time column can distinguish, so
         consecutive rows in signals.csv carry the same time_s value.
         Every sample is written, in order. Use the row number rather than time_s to tell
         them apart, or convert one rate at a time with --channels.
```

**What edf2csv does.** Writes every sample, in file order. Nothing is dropped — what stops being true is that `time_s` identifies a row, so joining or plotting on it collapses samples that are genuinely distinct.

**What to do.** Use the row number. Until 0.4.55 this went further than a repeated column: the boundary slack used when deciding which samples fall inside the requested window was a flat nanosecond, larger than the sample interval itself, and a recording of two 1 ns records holding ten samples each wrote ten of its twenty rows with no warning at all.

## Timing, continuity and annotations

These come from reading the EDF+ annotation channel and working out where each data record really sits in time. `--info` raises `DISCONTINUOUS` too, since it has to read those record times to report the span and the row estimate correctly; the other two need a conversion, which is the only thing that reads every annotation.

### DISCONTINUOUS

This code covers three related conditions, and a single file can raise more than one of them.

**The recording is marked discontinuous.** The header's reserved field says `EDF+D` (or `BDF+D`), meaning the data records aren't contiguous in time. Sleep studies with paused acquisition and long-term monitoring with interrupted telemetry both produce these.

```
warning: This is a discontinuous (EDF+D) recording: its data records are not contiguous in time.
         Each row carries its true recording time, so gaps stay visible instead of being closed.
```

edf2csv reads each record's true start time from its timekeeping annotation and writes that time into the `time_s` column. A gap in the recording becomes a jump in `time_s`, exactly as it should. This is the behaviour that distinguishes edf2csv from the common alternatives: `mne.io.read_raw_edf` closes these gaps silently, and pyEDFlib refuses `EDF+D` files outright.

**Marked discontinuous, but there's no annotation channel.** The record start times are stored in the annotation channel, so a file with no annotation channel has no record of where its records sit.

edf2csv falls back to timing the records as if they were contiguous and says so. Any gaps are lost, because the file doesn't contain the information needed to reconstruct them.

**Records start earlier than the record before them.** The timekeeping annotations aren't monotonically increasing.

```
warning: 1 data record start earlier than the record before it.
         Rows are written in file order, so the time column will not increase monotonically.
```

Rows are written in file order, not sorted by time, so `time_s` will step backwards at those points.

**What to do.** For the first case, nothing: gaps in `time_s` are real and your analysis should respect them. Don't assume a fixed sample interval when converting a discontinuous file. For the second case, treat all timestamps as nominal offsets rather than true recording times. For the third case, either sort by `time_s` in your analysis or investigate the file, since out-of-order records usually mean the annotations were written incorrectly.

### ANNOTATION_DECODE_FAILED

This code covers three conditions, which are counted separately because they lose different things.

**Annotation entries couldn't be decoded.** The annotation channel stores text as a run of Time-stamped Annotation Lists, each beginning with an explicitly signed onset. A chunk that doesn't begin with `+` or `-`, or whose onset isn't a finite number, can't be decoded.

```
warning: 1 annotation entry was unreadable and could not be exported.
         The rest were exported normally. The file may have been written by a non-conforming tool.
```

edf2csv skips the bad entry and keeps going. A single malformed annotation shouldn't cost you a whole conversion, but losing it in silence would mean you never learn that an event is missing from `annotations.csv`.

**A record's timekeeping entry couldn't be decoded, in a continuous file.** The first entry of every record states where that record sits in time rather than describing an event, so it is never exported. Until 0.4.41 these were counted with the events above, which described the wrong loss twice: a file with one unreadable timekeeping entry and three good events announced that one entry "could not be exported" while exporting all three, and said nothing about the timing that had actually gone missing.

```
warning: 1 data record carries a timekeeping annotation that could not be read, so it does
         not say where in time it sits.
         No event was lost — a timekeeping annotation states a record's start time and is
         never exported. Times are derived from the records that could be read.
```

In a continuous recording the records sit end to end, so any record that *can* be read fixes the origin for all of them: a record stating 1.5 s in a file of one-second records puts the recording's start at 0.5 s. Only if no record at all states a time does the file fall back to being timed from zero.

**Records carry no readable timekeeping annotation.** In a discontinuous file, the first annotation entry of each record must carry that record's start time. When it's missing or unreadable, that record's true position in time is unknown.

```
warning: 1 of 3 data records carry no readable timekeeping annotation (record 2), so their true position in time is unknown.
         Those records are timed as if they were contiguous; treat their timestamps as unreliable.
```

Up to five record indices are listed by number, with the rest elided. The affected records are timed arithmetically as a fallback, and this warning exists precisely because that fallback produces a timestamp indistinguishable from a real one.

**What to do.** Compare the number of rows in `annotations.csv` against the number of events you expect. If entries are missing that you need, the recording may have to be re-exported by the acquisition software. For the timekeeping case, treat the timestamps of the named records as unreliable and, if the exact timing matters, exclude those records from analysis.

### NO_ANNOTATIONS

You passed `--annotations-only` but the recording has no annotation channel.

**Cause.** Plain EDF and plain BDF carry no annotations at all. Only EDF+ and BDF+ files have an `EDF Annotations` or `BDF Annotations` channel.

**What edf2csv does.** Writes `channels.csv` and `metadata.json` but no `annotations.csv` and no signal files, because you asked for annotations and there are none. The command still exits 0.

```
warning: --annotations-only was requested but this recording has no annotation channel, so there are no events to export.
         Plain EDF files carry no annotations. Convert without --annotations-only to get the signals.
```

**What to do.** Run `--info` and look at the `Format` line. If it says `EDF` rather than `EDF+`, there were never any events to extract. Convert without `--annotations-only` to get the signal data:

```bash
edf2csv recording.edf
```

## Output shape

These describe what the conversion is about to produce, rather than a problem with the recording.

### MIXED_SAMPLING_RATES

The recording's channels don't all run at the same sampling rate.

**Cause.** Normal and extremely common. A sleep study typically records EEG at 256 Hz, ECG at 128 Hz and a rectal temperature probe at 1 Hz, all in one file.

**What edf2csv does.** Writes one file per rate: `signals_256hz.csv`, `signals_128hz.csv`, `signals_1hz.csv`. A fractional rate becomes something like `signals_12_5hz.csv`. No channel is resampled.

```
warning: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
```

**What to do.** Load the files you need. Each has its own `time_s` column, so joining them is a matter of aligning on time. When every channel shares a rate, a single `signals.csv` is written and this warning doesn't appear at all.

**It describes the conversion, not the file.** `--channels` is taken into account, because the warning exists to explain why the output was split. Narrowing a three-rate recording to one channel writes one file and raises nothing; narrowing it to two rates reports two, not three.

```bash
edf2csv sleep-study.edf --channels ECG          # one file, no warning
edf2csv sleep-study.edf --channels "EEG Fpz-Cz,ECG"
#   warning: Channels use 2 different sampling rates (256 Hz, 128 Hz).
```

`parseHeader` is the exception, and deliberately: it reports what the header says, having no conversion to describe.

### NO_SIGNAL_CHANNELS

The file has no signal channels: it contains only an EDF+ annotations channel.

**Cause.** Some systems export events into a separate companion file alongside the recording proper.

**What edf2csv does.** Writes `annotations.csv`, `metadata.json`, and a `channels.csv` containing only its header row. No signal files are written, because there are no signals.

**What to do.** Nothing, if you were after the events. If you expected signal data, you're converting the wrong file of the pair.

### LARGE_OUTPUT

At least one output file will have more than 1,048,576 rows, which is the limit for Excel and most other spreadsheet applications.

**Cause.** Recording length. A single channel at 256 Hz crosses the limit after about 68 minutes.

**What edf2csv does.** Nothing differently. The file is written in full and is a valid CSV. The warning exists so you aren't surprised when a spreadsheet opens it and shows only the first million rows.

```
warning: At least one output file will have more than 1,048,576 rows, which is more than Excel or Numbers can open.
         Use --start and --duration to convert a section, or read the file with pandas or R.
```

`--info` reports the estimate before you convert anything:

```
Would write 1,075,200 rows, roughly 24.6 MB.
```

**What to do.** Either read the file with a tool that has no row limit (pandas, R, DuckDB, awk), or convert only the section you need:

```bash
edf2csv sleep-study.edf --start 2h --duration 30m
```

### STALE_OUTPUT

The output directory contains files that edf2csv produced on an earlier run and didn't rewrite on this one.

**Cause.** `--force` overwrites files but doesn't empty the directory. Converting a mixed-rate recording and then a single-rate one into the same place leaves `signals_256hz.csv` sitting next to a fresh `signals.csv`, and both look current.

**What edf2csv does.** Names the leftover files and deletes nothing. Only files matching the names edf2csv itself produces are considered: `signals.csv`, `signals_<rate>hz.csv`, `annotations.csv`, `channels.csv` and `metadata.json`. Your own files in that directory are never reported and never touched.

```
warning: signals_128hz.csv, signals_1hz.csv, signals_256hz.csv are left over from an earlier conversion into this directory and were not rewritten.
         Delete them, or convert into a fresh directory, so the two runs do not get mixed up.
```

**What to do.** Delete the named files yourself once you've confirmed you don't need them, or convert into a fresh directory with `--out`. `metadata.json` always describes the run that wrote it, so its `conversion.files` list is the authoritative record of which files belong to the current conversion.

### EMPTY_WINDOW

The conversion had signal tables to fill and put no data rows in any of them, so `signals.csv` holds its header and nothing else.

A window can select nothing without being past the end of the recording — `--start` at or past the end is a usage error and stops the run before this. This is the narrower case: a window that lies inside the recording but lands where there is no data. Between the last sample and the nominal end of the last record:

```
warning: No samples fall inside the requested window (1.950s to 2.000s), so the signal
         files hold their headers and no data.
         The window is inside the recording but lands where there is no data — past the
         last sample, or inside a gap in a discontinuous file. Run with --info to see
         where the records actually sit.
```

Or, on a discontinuous recording whose records sit at 0s, 1s and 10s, anywhere in the eight-second gap:

```bash
edf2csv study.edf --start 2 --end 10    # asks for a span that holds no records at all
```

**What to do.** Run `--info` to see where the records really are. On an EDF+D file the gaps are the point: the row times are true recording times, so a window chosen from wall-clock arithmetic can miss the data entirely.

It is a warning rather than an error because a batch of five hundred recordings shouldn't stop for the one whose gap lines up with the window. Pass `--strict` to make it a failure.

### NONPRINTABLE_LABEL

A channel's label or unit contains control characters, which become part of the column name in `signals.csv`.

**Cause.** A writer that copied a field out of another system without sanitising it, a header edited by a script, or a corrupt file whose label bytes are not text at all. EDF fields are free text and nothing enforces that they are printable.

```
warning: Signal 0's label or unit contains 2 control characters (\x1b), which will appear
         in the CSV column name exactly as the header has them.
         Address the channel by position with --channels "#0" rather than by name, since
         the name cannot be typed. Printing the CSV to a terminal may do more than print it.
```

**What edf2csv does.** Passes the label through exactly as the header has it. Losing what the file says is not an improvement, and CSV quoting keeps the row parseable whatever the bytes are — the warning exists so that you know, not because anything is rewritten. `--info` is the exception: it escapes them for display, since an ANSI escape in a header could otherwise drive your terminal.

**What to do.** Address the channel by position (`--channels "#0"`) rather than by name. Be careful about printing the CSV to a terminal — `\x1b[2J` clears the screen, so `cat signals.csv` can hide the rest of your session's output. `head`, `less -R` off, or opening the file in an editor are all safe. A tab (`\x09`) is harmless to a terminal but still makes a column name that is hard to match reliably in a script.

Raised for every affected channel, so a file with three of them gets three warnings.

## Fatal errors: the recording can't be read

These stop the conversion. Nothing is written. All of them exit **1**.

### FILE_TOO_SMALL

The file isn't large enough to hold what it declares. Raised in three situations: the file is under 256 bytes and so can't hold even the fixed header; the file is too short to hold the 256 bytes per signal that its declared signal count requires; or the file is smaller than the header size computed from that count.

```
error: File is 100 bytes; an EDF header alone needs at least 256.
```

This is a truncated download, an incomplete copy, or a file that isn't EDF at all. Check the file size against the original.

### BAD_HEADER_FIELD

A field that should contain a number doesn't. Raised when a numeric field is empty, when its contents don't parse as a finite number, when a field that must be a whole number is fractional, or when a signal declares a negative sample count.

```
error: Header field "number of header bytes" is not a number (found "adding p").
       The file may be truncated, byte-shifted, or not an EDF file at all.
```

This is the error you get when pointing edf2csv at something that isn't an EDF file. It also appears when a file is byte-shifted, so that fields are being read from the wrong offsets.

### INVALID_SIGNAL_COUNT

The header declares zero or fewer signals.

```
error: Header declares 0 signals; expected at least 1.
```

A recording with no channels can't be converted. This usually means a corrupt header rather than a genuinely empty recording.

### INVALID_RECORD_DURATION

The header declares a data record duration that isn't a positive number.

```
error: Header declares a data record duration of 0s; expected a positive number.
```

Record duration is the divisor that turns samples per record into a sampling rate, so a zero or negative value makes every rate in the file undefined.

### NO_SAMPLES

Every channel in the file declares zero samples per data record, so the file has no data to convert.

```
error: No signal in this file carries any samples (every channel declares 0 samples per record).
```

The same code appears as a warning when a single channel is empty. As an error it means all of them are.

### NO_DATA_RECORDS

The file contains a complete header but not one complete data record.

```
error: The file contains a header but no complete data record.
       The recording was probably interrupted before any data was written.
```

An acquisition that was started and stopped immediately produces exactly this. So does a transfer that copied the header and then failed.

### UNREADABLE

The file can't be opened or read. Raised when the path doesn't exist, when permission is denied, when it isn't a regular file, and when a read during conversion returns fewer bytes than expected.

```
error: Cannot read "recording.edf": no such file
```

There is one more form of this error that the command line no longer reaches:

```
error: "/data/recordings" is a directory, not an EDF file.
```

`EdfFile.open` still raises it, since the library takes one recording and a directory is not one. The CLI expands a directory into the recordings inside it instead, so from the command line a folder is an input rather than a mistake — see [the CLI reference](/docs/cli-reference).

The mid-conversion case works differently. If the file shrinks or is being rewritten while edf2csv is reading it, the read comes up short and the conversion stops rather than quietly handing back a CSV missing its tail:

```
error: Expected 524288 bytes of data at record 4096 but only 131072 were available; the file appears to have changed size while it was being read.
       Make sure the recording is not still being written to, then try again.
```

Wait for the recording to finish, or copy it somewhere stable first, then convert.

## Fatal errors: the output can't be written

These also exit **1**.

### OUTPUT_EXISTS

The output directory already exists and `--force` wasn't given.

```
error: "recording_csv" already exists.
       Pass --force to overwrite it, or --out to choose a different directory.
```

This is a guard, not a failure. Refusing by default means a second run can't quietly destroy the first one's results.

```bash
edf2csv recording.edf --force
edf2csv recording.edf --out ./converted-v2
```

### OUTPUT_UNWRITABLE

The destination can't be used. Raised when the path given to `--out` is an existing regular file rather than a directory, and when creating the directory fails.

```
error: "notes.txt" is a file, but the converted data needs a directory.
       Choose a directory with --out.
```

Filesystem failures are translated into plain language rather than passed through as system codes: permission denied, the disk is full, part of the path is a file rather than a directory, the filesystem is read-only, or the path is too long.

### WRITE_FAILED

Writing one of the output files failed part way through, most often because the disk filled up.

```
error: Writing to "recording_csv" failed: ENOSPC: no space left on device
       The files written so far are incomplete and should not be used. The destination is out of space; free some up or choose another with --out.
```

The hint is chosen from what actually failed. Until 0.4.36 every write failure carried the disk-space advice, which fits exactly one errno — a directory sitting where `signals.csv` belongs, a read-only volume, a permission denial and a path too long for the filesystem all came back telling you to free up space. Wrong advice is worse than none: it sends you to check `df` on a disk that is fine while the real cause stays unexamined.

| Cause | What the hint says |
| --- | --- |
| `ENOSPC` | The destination is out of space |
| `EDQUOT` | You are over your disk quota on this filesystem |
| `EACCES`, `EPERM` | You do not have permission to write there |
| `EROFS` | That filesystem is mounted read-only |
| `EISDIR` | A directory is sitting where that file belongs |
| `ENOENT` | Part of that path no longer exists — something is removing it while the conversion runs |
| `ENAMETOOLONG` | That path is longer than the filesystem allows |
| `EMFILE`, `ENFILE` | Too many files are open; a recording with many sampling rates opens one output file per rate, so `--channels` narrows it |
| anything else | Check the destination and run the conversion again |

The partly written files are left on disk either way. They are truncated at an arbitrary point and must not be analysed: fix what the hint names and run the conversion again from the start.

Under `--stdout` the sentence changes, because that path writes no files and `--out` is the flag you chose not to pass:

```
error: Writing to stdout failed: ENOSPC: no space left on device, write
       What reached stdout before it failed is incomplete and should not be used. The
       destination is out of space; free some up or redirect it somewhere else.
```

## Usage errors

These mean the command was invoked in a way that can't be carried out. They exit **2** rather than 1, so a script can tell "you asked for something impossible" apart from "this recording is broken".

| Situation | Example message |
| --- | --- |
| Unknown flag | Reported by the argument parser, followed by a pointer to `--help` |
| No input file | Usage text is printed |
| The recording changed size while it was being read | `Expected 8388600 bytes of data at record 41943 but only 0 were available; the file appears to have changed size while it was being read.` |
| Two recordings that would convert into the same directory | `"n2/rec.edf" and "n1/rec.edf" would both be converted into "out/rec", so one would overwrite the other.` |
| Several recordings with `--stdout` | `--stdout writes a single CSV, so it cannot take 3 recordings.` |
| `--channels` given with no names | `--channels was given but lists no channel names.` |
| `--decimals` missing or out of range | `--decimals must be a whole number between 0 and 20` |
| A channel name that matches nothing | `No channel named "ECQ". Did you mean "ECG"?` |
| A position that doesn't exist | `No channel at position #9.` |
| An unparseable time value | `--start "banana" is not a time I understand.` |
| `--duration` and `--end` together | `Use either --duration or --end, not both.` |
| `--start` at or past the end of the recording | `--start "600s" is at or past the end of this 2s recording.` |
| A window that ends before it starts | `The requested window ends at "1s", which is not after its start at "5s".` |

A term that matches no channel is an error rather than a silent omission, and the message suggests the closest labels in the file. Quietly dropping a channel you explicitly asked for would hand you a CSV missing data you believe is in it.

The last two entries are about the recording's length but are still classed as usage errors, because the fix is to change the command rather than the file.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command succeeded. Warnings may still have been printed |
| `1` | The recording couldn't be read, or the output couldn't be written |
| `2` | The command was invoked incorrectly, or asked for something the recording can't provide |

Piping into a consumer that exits early, such as `head`, closes stdout and would normally raise a broken pipe error. That case is treated as success, so `edf2csv recording.edf --info | head -5` exits 0.

## Checking warnings from a script

`--json` puts the whole summary, warnings included, on stdout as JSON. Warnings aren't also printed as text in this mode, so stderr stays clean.

```bash
edf2csv recording.edf --out ./converted --json > summary.json
```

The `warnings` array holds one entry per diagnostic:

```json
{
  "output_dir": "./converted",
  "files": [
    { "name": "signals_256hz.csv", "rows": 768 },
    { "name": "signals_128hz.csv", "rows": 384 },
    { "name": "signals_1hz.csv", "rows": 3 },
    { "name": "channels.csv", "rows": 3 }
  ],
  "annotations": 0,
  "duration_seconds": 3,
  "records": 3,
  "elapsed_ms": 12,
  "warnings": [
    {
      "code": "MIXED_SAMPLING_RATES",
      "severity": "warning",
      "message": "Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz)."
    }
  ]
}
```

To fail a pipeline on a specific code, test for it:

```bash
edf2csv recording.edf --out ./converted --json > summary.json
if grep -q '"RECORD_COUNT_MISMATCH"' summary.json; then
  echo "recording is incomplete" >&2
  exit 1
fi
```

The same list, minus `STALE_OUTPUT`, is stored permanently in the `notes` array of `metadata.json` inside the output directory, so a conversion carries its own warnings with it. Six months later you can still see what the tool said about the recording without rerunning anything.
