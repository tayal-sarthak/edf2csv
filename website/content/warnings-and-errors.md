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

`--info` reads the header and builds a conversion plan, so it surfaces every structural, calibration and output-shape warning without converting anything.

It reads the annotation channel too, for an EDF+ recording: the whole of it for a discontinuous file, whose record times are stored rather than arithmetic, and the first sixteen records of a continuous one — or of a file that has an annotation channel and no marker at all — to find where the recording begins. So it also raises `ANNOTATION_DECODE_FAILED` and the `DISCONTINUOUS` variants that come from inspecting record timestamps — records out of order, records overlapping, an origin too far from zero.

It raises them for what it read, which on a continuous file is however many records it took to find one stating a start time — the search stops there, so usually that is the first record and only ever at most sixteen. A timekeeping entry that cannot be read *after* that point is not seen: give the second record of a three-record continuous file a corrupt TAL and the conversion raises `ANNOTATION_DECODE_FAILED` while `--info` says nothing, even though record 1 is well inside the sixteen. An unreadable *event* further into a continuous recording is not seen either, so `two-annotation-channels.edf` raises `ANNOTATION_DECODE_FAILED` when converted and nothing under `--info`. Its byte-identical discontinuous twin raises it either way, because there the whole channel is read.

What it cannot raise is the handful that need a conversion to exist:

- `NO_ANNOTATIONS` and `STALE_OUTPUT`, which are about files being written.
- `INPUT_CHANGED`, which asks whether the recording moved while it was being converted. `--info` opens the file, reads a header and closes it, so there is no window for it to have moved during — and no output whose description of the file could have stopped being true.
- The `NO_SAMPLES` that reports a signal file *not written* — the per-channel one, about a channel carrying no samples, comes from the header and is raised.
- The EDF+C contradiction above, which is noticed while the full record-start array is built rather than while the origin is found.

`EMPTY_WINDOW` used to be on that list, and was not one of them: it is a fact about the plan, which `--info` builds.

Until 0.5.37 this section said the opposite — that `--info` touches neither the data records nor the annotation channel, and cannot raise `ANNOTATION_DECODE_FAILED` or any timestamp-derived `DISCONTINUOUS`. The `DISCONTINUOUS` section further down said "`--info` raises `DISCONTINUOUS` too, since it has to read those record times", on the same page.

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
| `UNUSABLE_PHYSICAL_RANGE` | A channel's physical span is too wide to represent, or too small — both leave it with no mapping |
| `INVERTED_PHYSICAL_RANGE` | A channel's calibration inverts its polarity: exactly one of its two bounds pairs is reversed |
| `NO_SAMPLES` | A channel declares zero samples per data record, or no signal file was written — because every channel selected carries none, or because the recording has no signal channels at all |
| `EMPTY_LABEL` | A channel has a blank label |
| `DUPLICATE_LABEL` | Two or more channels share a label, a channel's own label was taken by another's `_ch` suffix or by `time_s`, or a `--channels` term matched several |
| `DISCONTINUOUS` | The recording is marked EDF+D, or its records are out of order, overlap in time, contradict an EDF+C marking, sit too far from zero to tell apart, or have nowhere to record where they are |
| `ANNOTATION_DECODE_FAILED` | An annotation entry, a record's timestamp, or an event's duration couldn't be read — or a duration read perfectly well and states a length below zero |
| `NO_ANNOTATIONS` | `--annotations-only` was used on a file with no annotation channel |
| `MIXED_SAMPLING_RATES` | The channels being converted run at different rates, so one output file is written per rate — or one file for all of them under `--layout long` |
| `NO_SIGNAL_CHANNELS` | The file contains annotations and nothing else |
| `LARGE_OUTPUT` | An output file will be too big for a spreadsheet application |
| `STALE_OUTPUT` | Files from an earlier conversion are still sitting in the output directory |
| `NONPRINTABLE_LABEL` | A channel's label, unit, transducer or prefiltering contains control characters; the warning says which |
| `FORMULA_LABEL` | A channel's label, unit, transducer or prefiltering starts with a character a spreadsheet reads as the start of a formula |
| `EMPTY_WINDOW` | The requested window lands where the recording has no data, so the signal files hold only their headers |
| `INPUT_CHANGED` | The input changed while it was being converted |
| `TIME_RESOLUTION` | Samples arrive faster than the time column can distinguish, so consecutive rows share a `time_s` — or the rate overflowed to `Infinity` and no rows are written at all |
| `VALUE_RESOLUTION` | A channel steps by less than the decimals written can express, so consecutive samples share a value |
| `MISSING_EDF_PLUS_MARKER` | An annotation channel puts the records somewhere the missing EDF+ marker cannot honour |
| `START_TIME_UNREADABLE` | The header's start date or time is not a date or a time |
| `LEAP_SECOND_START` | The header's start time names the sixtieth second, which no calendar date has |
| `START_DATE_MISMATCH` | An EDF+ recording identification field states a different start date from the header's own |
| `STDOUT_UNSUPPORTED` | `--info --stdout` on a recording `--stdout` would refuse |

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
         They were read as decimal points. Check the values in the channel
         table.
```

**What to do.** Look at the channel table in `--info` or at `channels.csv` and confirm the physical ranges are what you expect for those channels. A range of `-250 to 250` for an EEG channel in microvolts is plausible; `-250000 to 250000` would suggest the separator was interpreted differently than the writer intended.

### INPUT_CHANGED

The recording's size or modification time moved between the moment it was opened and the moment the conversion finished.

**Cause.** Almost always a file still being written — acquisition software appending records, or a copy still in flight. Replacing the file at that path while the conversion runs does it too.

**What edf2csv does.** Finishes, and says so. The CSVs are correct for the records that were read, and `metadata.json` describes the file as it was opened, so the record and the output agree with each other. What stops being true is that they describe the file as it now stands.

```
warning: The input changed while it was being converted, so this output covers the file as it was when the conversion started, not as it is now.
         Convert again once the recording is finished to pick up the rest.
```

Under `--checksum` the hash is dropped rather than guessed at, and the hint says so instead: the bytes that were converted are no longer there to hash, so `source.sha256` in `metadata.json` is `null`. A checksum that is present therefore means the file demonstrably held still while it was read.

**What to do.** Wait for the recording to finish and convert again. If you need the checksum, that second run is the one that can produce it.

## Channel calibration and labelling

These describe individual channels. They are raised per signal, and never for the EDF+ annotations channel, which carries text rather than samples and has no meaningful calibration.

Only one of the three calibration warnings is raised per channel. The checks run in order: a degenerate digital range is reported first and suppresses the other two, then a degenerate physical range, then an inverted physical range.

### DEGENERATE_DIGITAL_RANGE

A channel declares the same value for its digital minimum and digital maximum.

**Cause.** A header field filled in with a placeholder, or a channel that was configured but never properly calibrated. It's common on unused or dummy channels that acquisition software adds to fill out a montage.

**What edf2csv does.** The digital-to-physical mapping is defined by two calibration points. With both points at the same digital value the mapping doesn't exist, so there's no physical value to compute for any sample. Those cells are written empty.

```
warning: Signal 0 ("flat") has digital minimum equal to digital maximum (0), so its values cannot be scaled.
         Its cells are left empty rather than filled with a value the header
         cannot justify.
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
         Its cells are left empty rather than filled with a value the header
         cannot justify.
```

A span can also be too *small*. The gain is the span divided by the digital range, so 2e-320
across 65,536 codes is 3e-325 — below the smallest number a double can hold, so it underflows to
zero and there is no mapping, exactly as when it overflows. Until 0.5.83 that case took the
flat-range path instead: every one of the channel's 65,536 distinct readings was written as the
same number, with no diagnostic and `--strict` exiting 0.

```
warning: Signal 0 ("MAG") declares a physical range from -1e-320 to 1e-320, whose span is too small to represent, so its values cannot be scaled.
         Its cells are left empty rather than filled with a value the header
         cannot justify.
```

A range that is genuinely flat — minimum equal to maximum — is a different thing and keeps its
constant, because that mapping is defined and every sample really is that value. It has
[`DEGENERATE_PHYSICAL_RANGE`](#degenerate_physical_range) of its own.

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
         The values are converted exactly as the header specifies, inversion
         included.
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

The same code also reports the file that was *not* written, when the conversion ends up with no signal table to make at all. Which of the two ways that happened is said explicitly, because the advice differs. Every channel selected carries no samples:

```
warning: No signal file was written: every channel selected carries zero samples per data
         record, so there is nothing to put in one.
         channels.csv still describes them. Run with --info to see which
         channels do carry samples.
```

Or the recording has no signal channels at all, holding only EDF+ annotations — in which case nothing was selected, and `channels.csv` has no rows to describe:

```
warning: No signal file was written: there is no signal data in this recording to put in one.
         annotations.csv holds whatever events it carries. channels.csv lists
         signal channels, so it has none to list.
```

Until 0.5.54 the second case got the first case's wording, which said three things about channels to a file that has none.

Note that `NO_SAMPLES` is also a fatal error code. As a warning it means one channel is empty, or that no signal file was written; as an error it means every channel is empty, which leaves nothing to convert. See the fatal errors section below.

### EMPTY_LABEL

A channel's label field is blank.

**Cause.** A writer that didn't fill the field in, or a channel that was never named in the acquisition setup.

**What edf2csv does.** Names the column `signal_<index>` using the channel's position in the file, which is stable and unambiguous.

```
warning: Signal 0 has no label. It will appear as "signal_0".
```

Unless another channel is literally labelled `signal_0`, which EDF permits — labels are free text and nothing enforces anything about them. Then the synthesised name and the real one collide and both columns are suffixed with their position, and the warning says so rather than naming a column that will not exist:

```
warning: Signal 0 has no label, so it takes the name "signal_0" — which signal 1 already
         carries as a label, so both columns are suffixed with their position instead.
```

That also covers the second channel, which loses its own column name to the collision. `DUPLICATE_LABEL` does not fire for it, because the two labels are not the same label.

**What to do.** Consult your recording notes to work out what the channel is. `channels.csv` gives you the transducer type, prefiltering string, unit and physical range for that signal, which together are often enough to identify it.

### DUPLICATE_LABEL

This code is raised in two different situations.

**From the header.** Two or more channels in the file share exactly the same label. This is common in real data: some standard EEG montages ship recordings with two channels both labelled `T8-P8`. Labels in EDF are free text and the format doesn't require them to be unique.

edf2csv preserves labels verbatim in output and only disambiguates when the file itself is ambiguous. When a label is duplicated, every channel carrying it gets a `_ch<index>` suffix on its column name, where the index is the channel's position in the file. One warning is raised per duplicated label, naming all of the positions involved.

```
warning: 2 signals share the label "T8-P8" (positions 0, 1).
         Their columns are suffixed with the signal number so they stay
         distinguishable.
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
         Column names are unique; look this channel up in channels.csv by its
         signal_index.
```

`time_s` is checked the same way, and it is the one name on that list no file supplies — the writer puts it in front of the channels. A channel labelled `time_s` moves aside for it:

```
warning: Signal 0 is labelled "time_s", which is the name of the time column every
         signals.csv starts with, so its column is "time_s_ch0".
         Column names are unique; look this channel up in channels.csv by its
         signal_index.
```

Until 0.5.113 it did not, and the header came out `time_s,time_s,ECG` with nothing said. Every read-back in these pages — `index_col="time_s"`, `pop("time_s")`, `pivot(index="time_s")` — resolves a repeated name to one of the two columns without saying which, and pandas and Python's own `csv.DictReader` resolve it opposite ways round.

No two columns in `signals.csv` ever share a name, so the `channels.csv` join always resolves.

### TIME_RESOLUTION

Sample times are written to at most fifteen decimal places, which separates everything a terminating rate can reach — every power of two through 32768 Hz, and far past it. Only a rate whose reciprocal never terminates, and whose interval is finer than fifteen places, makes the column repeat.

**Cause.** A sample interval finer than fifteen decimal places can express, and with no terminating expansion to find — 3e15 Hz, say, where 1/3e15 repeats forever. A rate that terminates gets as many places as it needs up to fifteen, so every power of two through 32768 Hz is written exactly; one that repeats gets as many as it takes to keep consecutive samples apart, to the same limit. EDF's record-duration field is 8 characters and accepts `1e-15`, so the format permits these rates; nothing that records biosignals comes within nine orders of magnitude of them.

```
warning: Channels at 3000000000000000 Hz sample faster than the time column can distinguish, so
         consecutive rows in signals.csv carry the same time_s value.
         Every sample is written, in order. Use the row number rather than
         time_s to tell them apart: the column already carries the fifteen
         places a double can hold exactly, so no option or selection separates
         them.
```

The same code covers the limit of that, where the rate is not a number at all. A sampling rate is samples per record divided by the record duration, and the record-duration field accepts values small enough that the quotient overflows a double: four samples in a 1e-308 second record is `Infinity`. Those samples cannot be placed in time, so none is written, and the warning says which of the two happened:

```
warning: Channels in signals.csv work out to a sampling rate of Infinity Hz — their samples per
         record over a record duration too small to divide into — so their samples cannot be
         placed in time and no rows are written for them.
         Check the record duration in the header. One power of ten larger and
         the same file converts, with consecutive rows carrying the same time_s.
```

Until 0.5.84 nothing was raised for it: `1 / Infinity` is zero, the check tests for a step greater than zero, and every sample was dropped in silence — under an `EMPTY_WINDOW` warning saying the records "carry no samples in range", on a run that asked for no range.

Up to 0.5.23 this section gave the bound as nine places and a gigahertz, and showed that warning at 10 GHz — a rate that in fact terminates at ten places and is written exactly. Both were true before 0.4.55 raised the search bound.

**What edf2csv does.** Writes every sample, in file order. Nothing is dropped — what stops being true is that `time_s` identifies a row, so joining or plotting on it collapses samples that are genuinely distinct.

**What to do.** Use the row number. Until 0.4.55 this went further than a repeated column: the boundary slack used when deciding which samples fall inside the requested window was a flat nanosecond, larger than the sample interval itself, and a recording of two 1 ns records holding ten samples each wrote ten of its twenty rows with no warning at all.

### VALUE_RESOLUTION

The same failure as `TIME_RESOLUTION`, one column over: the value this time rather than the time.

**Cause.** A channel whose quantization step — `|physical_max - physical_min| / (digital_max - digital_min)` — is below 1e-98. Decimals are derived per channel as `ceil(-log10(step)) + 2`, and 100 is where that stops, because 100 is the most `toFixed` will print. EDF's physical bound fields are 8 characters and `1e-99` is five of them, so the format permits such a calibration; no instrument produces one.

```
warning: gravimeter steps by less than any number of decimals this can print, so some
         consecutive samples round to the same value in signals.csv.
         Every sample is written, in order, and the physical values are computed
         at full precision either way. What is lost is only in the printed text.
```

Asked of the ceiling, not of the precision in use — so it holds whatever `--decimals` says, and it stays quiet for an ordinary channel however coarse a precision you ask for. `--decimals 2` on a channel needing 3 is a trade you made knowingly; up to 0.5.10 it raised this on every channel of an ordinary EEG, which also made `--decimals 2 --strict` impossible, since `--strict` turns any diagnostic into a non-zero exit. 0.5.10 fixed that by skipping the check whenever `--decimals` was given, and so silenced the real case too: at `--decimals 20` a channel stepping by 1e-106 printed every code it had as `0.00000000000000000000` and said nothing. 0.5.21 asks the question that actually matters — whether any precision this can print would separate consecutive codes.

**What edf2csv does.** Writes every sample, at the finest precision `toFixed` supports. The physical values are computed at full double precision whichever way — what is lost is only in the printed text, so `--json` metadata, row counts and ordering are all unaffected.

**What to do.** Nothing, for any real recording. If you are generating such a file deliberately, the digital codes are still in the EDF and reading them directly is exact.

This warning did not exist until 0.4.74, and the clamp it reports was 20 rather than 100 — set there on the stated grounds that 20 was `toFixed`'s limit, which it is not. A magnetometer channel spanning ±1e-16 T over a 16-bit converter steps by 3.05e-21 and needs 23 places; at 20 its values landed on a 1e-20 grid, about three digital codes to a printed value, and 69% of them could not be recovered from the CSV. It exited 0 and said nothing.

## Timing, continuity and annotations

These come from reading the EDF+ annotation channel and working out where each data record really sits in time. `--info` raises `DISCONTINUOUS` too, since it has to read those record times to report the span and the row estimate correctly; the other two need a conversion, which is the only thing that reads every annotation.

### DISCONTINUOUS

This code covers six related conditions, and a single file can raise more than one of them.

**The recording is marked discontinuous.** The header's reserved field says `EDF+D` (or `BDF+D`), meaning the data records aren't contiguous in time. Sleep studies with paused acquisition and long-term monitoring with interrupted telemetry both produce these.

```
warning: This is a discontinuous (EDF+D) recording: its data records are not contiguous in time.
         Each row carries its true recording time, so gaps stay visible instead
         of being closed.
```

That hint is withdrawn on a file that cannot keep it. A recording marked `EDF+D` whose record times are not recorded anywhere — no annotation channel, or none that can be read — is written as if contiguous, and the warning says so and points at the one below it. Until 0.5.106 both printed as they are, and the second denied the first.

edf2csv reads each record's true start time from its timekeeping annotation and writes that time into the `time_s` column. A gap in the recording becomes a jump in `time_s`, exactly as it should. This is the behaviour that distinguishes edf2csv from the common alternatives: `mne.io.read_raw_edf` closes these gaps silently, and pyEDFlib refuses `EDF+D` files outright.

**Marked discontinuous, but there's no annotation channel.** The record start times are stored in the annotation channel, so a file with no annotation channel has no record of where its records sit.

edf2csv falls back to timing the records as if they were contiguous and says so. Any gaps are lost, because the file doesn't contain the information needed to reconstruct them.

**Records start earlier than the record before them.** The timekeeping annotations aren't monotonically increasing.

```
warning: 1 data record starts earlier than the record before it.
         Rows are written in file order, so the time column will not increase
         monotonically.
```

Rows are written in file order, not sorted by time, so `time_s` will step backwards at those points.

**The file is marked continuous, and its own records disagree.** `EDF+C` means the records sit end to end, and each record's timekeeping annotation says where it really is. When those two disagree by more than the recording can express, the file is contradicting itself.

```
warning: This file is marked continuous (EDF+C), but 2 of its 3 data records say they start
         somewhere other than where continuity puts them.
         Times are written as if the records were contiguous, which is what
         EDF+C means. If the recording really has gaps, the file should have
         been marked EDF+D.
```

A BDF+ file gets its own spelling — `BDF+C` and `BDF+D` — the same as the discontinuous entry above. Until 0.5.105 this half of the code printed the EDF markers whatever the format, so a BDF+ recording was told about a string it does not contain and pointed at a marker BDF+ does not define.

Compared against what the file can express rather than for equality, since a recording of 0.1 s records sitting at 0.1, 0.2, 0.3 is contiguous by construction and `0.1 + 2 * 0.1` is `0.30000000000000004`. Anything below half of one sample of the fastest channel is arithmetic, not a gap.

**Records start before the record before them ends.** The timekeeping annotations increase, but not by as much as a record lasts, so consecutive records cover overlapping spans of time. A device re-sending a buffer produces this.

```
warning: 2 data records start before the record before them ends, so their samples overlap in time.
         Rows are written in file order, so the time column will not increase
         monotonically.
```

Until 0.5.25 only the strictly-backwards case above was looked for, so this went unreported: starts of 0, 0.5 and 1.0 on one-second records are increasing, and the column steps backwards anyway, because the first record's samples run to 0.75 while the second begins at 0.5.

**The stated origin is too far from zero for the file's own sample interval.** A double spaces its values further apart the larger they get: near 1e16 seconds the gap between representable numbers is two seconds, so adding a one-second sample interval leaves the number unchanged and every sample in a record lands on one instant.

```
warning: This recording's timekeeping annotations place it -10000000000000002s from its own
         start date, which is too far out for its 1s records to be told apart: at that
         magnitude adding a sample interval leaves the number unchanged.
         Sample times are written from zero instead, so every row is present and
         the column increases. Add the onsets in annotations.csv to recover
         absolute times if you need them.
```

The magnitude is what matters, not the sign — a negative origin the same distance out fails identically. Until 0.5.17 the check looked only in the positive direction, seeded from zero, so an all-negative recording never reached it: twelve rows became four, exit 0, and nothing was said, while the byte-for-byte positive mirror of the same file wrote all twelve and explained itself.

**What to do.** For the first case, nothing: gaps in `time_s` are real and your analysis should respect them. Don't assume a fixed sample interval when converting a discontinuous file. For the second case, treat all timestamps as nominal offsets rather than true recording times. For the third, the file is contradicting itself and its timestamps should be treated as suspect until you know which half is wrong. For the fourth and fifth, either sort by `time_s` in your analysis or investigate the file, since out-of-order or overlapping records usually mean the annotations were written incorrectly. For the sixth, nothing needs doing — every row is written and `time_s` is measured from the start of the recording rather than from an origin the arithmetic cannot hold — but the absolute timestamps in that file's annotation channel should be treated as unreliable, since the file is claiming a position no double can express at that resolution.

### ANNOTATION_DECODE_FAILED

This code covers five conditions, which are counted separately because they lose different things.

**Annotation entries couldn't be decoded.** The annotation channel stores text as a run of Time-stamped Annotation Lists, each beginning with an explicitly signed onset. A chunk that doesn't begin with `+` or `-`, or whose onset isn't a finite number, can't be decoded.

```
warning: 1 annotation entry was unreadable and could not be exported.
         The rest were exported normally. The file may have been written by a
         non-conforming tool.
```

edf2csv skips the bad entry and keeps going. A single malformed annotation shouldn't cost you a whole conversion, but losing it in silence would mean you never learn that an event is missing from `annotations.csv`.

**A record's timekeeping entry couldn't be decoded, in a continuous file.** The first entry of every record states where that record sits in time rather than describing an event, so it is never exported. Until 0.4.41 these were counted with the events above, which described the wrong loss twice: a file with one unreadable timekeeping entry and three good events announced that one entry "could not be exported" while exporting all three, and said nothing about the timing that had actually gone missing.

```
warning: 1 data record carries a timekeeping annotation that could not be read, so it does
         not say where in time it sits.
         No event was lost — a timekeeping annotation states a record's start
         time and is never exported. Times are derived from the records that
         could be read.
```

In a continuous recording the records sit end to end, so any record that *can* be read fixes the origin for all of them: a record stating 1.5 s in a file of one-second records puts the recording's start at 0.5 s. Only if no record at all states a time does the file fall back to being timed from zero.

A first entry may also carry events after the start time — the format allows both in the one entry, and writers use it. When one of those cannot be decoded, the events go with it, so it is counted in the entries above as well and the hint says so rather than denying it:

```
warning: 2 annotation entries were unreadable and could not be exported.
         The rest were exported normally. The file may have been written by a
         non-conforming tool.
warning: 2 data records carry a timekeeping annotation that could not be read, so they do
         not say where in time they sit.
         2 of them also carried event text, which went with them and is counted
         above. A timekeeping annotation itself states a record's start time and
         is never exported. Times are derived from the records that could be
         read.
```

Until 0.5.114 such an entry was counted only as lost timekeeping, so a file whose first entry read `+1,5` rather than `+1.5` exported two of its six events under a warning saying that none had been lost.

**Records carry no readable timekeeping annotation.** In a discontinuous file, the first annotation entry of each record must carry that record's start time. When it's missing or unreadable, that record's true position in time is unknown.

```
warning: 1 of 3 data records carries no readable timekeeping annotation (record 2), so its true position in time is unknown.
         That record is timed as if it were contiguous; treat its timestamp as
         unreliable.
```

Up to five record indices are listed by number, with the rest elided. The affected records are timed arithmetically as a fallback, and this warning exists precisely because that fallback produces a timestamp indistinguishable from a real one.

**An event's duration couldn't be read.** A TAL may state a duration after its onset, separated by `0x15`. When that text isn't a number — `abc`, or `1e400`, which overflows to infinity — the event is kept whole apart from that one field, and `duration_s` is written empty.

```
warning: 1 annotation states a duration that is not a number, so its duration_s cell is empty.
         The onset and the description were read normally. An empty duration_s
         otherwise means the file stated no duration, so these rows cannot be
         told apart from those.
```

The hint is the reason this is counted at all: an empty `duration_s` is documented as meaning the file gave no duration, so without the count these rows are indistinguishable from the ones that genuinely had none. Before 0.5.55 nothing was raised.

**An event's duration is below zero.** A duration is a length of time, and one below zero is not one. The value is written to `annotations.csv` exactly as the file gave it — a zero invented here would be a number no writer wrote — so nothing about the row looks wrong on its own.

```
warning: 1 annotation states a duration below zero, which is not a length of time.
         The value is written to annotations.csv as the file gave it. Adding it
         to onset_s ends the event before it starts, so check these rows before
         using the durations.
```

Counted apart from the condition above because that one failed to parse and lost its value, while this one parsed and kept it: what is wrong with it is arithmetic. A duration of exactly zero is not negative and raises nothing. Before 0.5.58 nothing was raised.

**What to do.** Compare the number of rows in `annotations.csv` against the number of events you expect. If entries are missing that you need, the recording may have to be re-exported by the acquisition software. For the timekeeping case, treat the timestamps of the named records as unreliable and, if the exact timing matters, exclude those records from analysis.

### STDOUT_UNSUPPORTED

Raised only by `--info --stdout`, on a recording the conversion would refuse.

**Cause.** `--stdout` writes one table, and the wide layout gives a mixed-rate recording one per rate. It also has nothing to stream for `--annotations-only`, or for a recording with no signal channels.

**What edf2csv does.** Says so, in the words the conversion itself would use, and goes on describing the recording:

```
warning: --stdout would refuse this recording: needs exactly one table, but this recording produces 3, one for each sampling rate its channels use (256 Hz, 128 Hz, 1 Hz).
         Narrow it to one rate with --channels, write --layout long to get them
         all in one table, or convert to a directory instead.
```

A warning rather than a refusal for the reason the destination guards are: `--info` writes nothing, so a rule about the output has no business stopping it from describing the recording — and being told the command will not work is exactly what was asked. Until 0.5.87 `--info` ignored `--stdout` entirely and predicted rows and named files for a command that writes neither.

**What to do.** Take the advice in the hint, or drop `--stdout`. Nothing is wrong with the recording.

### MISSING_EDF_PLUS_MARKER

The file has an annotation channel whose timekeeping says the records begin at a non-zero instant, and a reserved field with neither `EDF+C` nor `EDF+D` in it.

**Cause.** A writer that produced EDF+ content and left the marker off, or a file whose reserved field was overwritten. The marker is what makes a file EDF+; the annotation channel is found by its label.

**What edf2csv does.** Reads it as plain EDF, which is what the marker says: `time_s` counts from zero. The annotation channel is still found and its events still exported, with the onsets the file gives them — so the two files come out on clocks that differ by the origin:

```
warning: This file has an annotation channel stating that its records begin at 1000s, but its reserved field carries no EDF+C or EDF+D marker — so it is read as plain EDF, time_s counts from zero, and the two disagree by 1000s.
         annotations.csv keeps the onsets the file gives, so its events and
         signals.csv are on different clocks. Mark the file EDF+C, or subtract
         the offset from the onsets, before joining them.
```

`--info` raises it too. Until 0.7.53 it did not: it read the annotation channel only for a file that claimed to be EDF+, which is every file except the ones this warning is about — so a conversion said the two CSVs would be a thousand seconds apart and the command you run first, to find out what a conversion would say, said nothing at all.

Until 0.5.104 nothing was raised: `signals.csv` opened at `0.000`, `annotations.csv` put the event at `1000.5`, and the pages promise the opposite — "`onset_s` is on the same clock as `time_s` in the signal files".

Reported rather than repaired, because which clock is right is not knowable from inside the file. The marker says plain EDF and the annotation channel says otherwise; applying the origin would move every sample, and ignoring the onsets would move every event, each on a guess about which field was written wrongly.

**What to do.** Fix the reserved field if the recording really is EDF+, which is the likely case — the annotation channel is not something a plain EDF writer produces. Otherwise subtract the offset from the onsets before joining the two files.

### START_TIME_UNREADABLE

The header's start date and time fields do not parse as a date and a time.

**Cause.** EDF gives each of them eight characters and nothing enforces what goes in. A writer that leaves them blank, fills them with placeholders, or writes them in another order produces this.

**What edf2csv does.** Says so, and carries on — the fields are echoed raw, and `metadata.json` records `start_datetime_local` as `null`:

```
warning: The header's start date and time ("32.13.99" and "25.61.61") are not a date and a time, so the recording has no start instant.
         time_s is unaffected — it counts from the start of the recording either
         way. What cannot be done is turning it into a wall-clock instant, and
         metadata.json records start_datetime_local as null.
```

Until 0.5.101 nothing was raised: `--info` echoed the fields with "(unparseable)" beside them and a conversion said nothing at all, so a recording with no usable timestamp passed `--strict` and left a bare `null` in the archive. Every other unusable header field reports itself.

**What to do.** Nothing, unless you need wall-clock times. `time_s`, the sample values and the annotation onsets are all unaffected — they are relative to the recording's own start, which does not depend on the header's saying when that was. If you do need the instant, it has to come from outside the file.

### START_DATE_MISMATCH

The recording identification field states a start date that is not the header's start date.

**Cause.** EDF+ requires the recording identification field to begin `Startdate dd-MMM-yyyy` and requires that date to be the one in the header's own start date field. A writer that filled the two independently, or a file whose date field was edited afterwards, produces a header that contradicts itself.

**What edf2csv does.** Uses the start date field, which is the one the format defines, and says so. The four-digit year in the recording identification is what settles the century when the two *do* agree — see [the two-digit year](/docs/edf-format#start-date-and-time-and-the-two-digit-year) — so a disagreement is exactly the case where that corroboration is missing.

```
warning: The header's start date ("02.03.02") and the date its recording identification states ("05-MAR-2002") are different dates, which EDF+ does not permit.
         The start date field is used, since that is the one the format
         defines. Which of the two is right is not knowable from the file, so
         start_datetime_local may name the wrong day.
```

**What to do.** Treat the recording's date as uncertain. Nothing else is affected: `time_s`, the sample values and the annotation onsets are all relative to the recording's own start, whatever day that was.

### LEAP_SECOND_START

The header's start time names the sixtieth second of a minute.

**Cause.** UTC writes a leap second as `23.59.60`, and a recorder synchronised through one puts that in the header. It is a real instant. It is not a time a calendar date has, and it is not one JavaScript's `Date` can hold: asking for the sixtieth second rolls the value into the next minute.

**What edf2csv does.** Keeps the nearest instant a date can hold — the fifty-ninth second, one second earlier than the header says — and says so. Rolling forward instead would move it fifty-nine seconds the other way, and refusing the whole field would throw away a date that is otherwise perfectly good.

```
warning: The header's start time ("23.59.60") names the sixtieth second of a minute, which no calendar date has.
         It is recorded as the fifty-ninth second, one second earlier, since that
         is the nearest instant a date can hold. time_s is unaffected — it counts
         from the start of the recording either way.
```

Until 0.7.52 the second was dropped in silence: `--info` printed `Recorded 2020-01-01 23:59:59` and `metadata.json` recorded the same, for a header that says something else, with `--strict` exiting 0.

**What to do.** Nothing, unless a second matters to you at that instant. `time_s`, the sample values and the annotation onsets are all relative to the recording's own start and are unaffected; only `start_datetime_local` moves, and only by that second.

### NO_ANNOTATIONS

You passed `--annotations-only` but the recording has no annotation channel.

**Cause.** Plain EDF and plain BDF carry no annotations at all. Only EDF+ and BDF+ files have an `EDF Annotations` or `BDF Annotations` channel.

**What edf2csv does.** Writes `channels.csv` and `metadata.json` but no `annotations.csv` and no signal files, because you asked for annotations and there are none. The command still exits 0.

```
warning: --annotations-only was requested but this recording has no annotation channel, so there are no events to export.
         Plain EDF files carry no annotations. Convert without
         --annotations-only to get the signals.
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

**What edf2csv does.** Writes one file per rate: `signals_256hz.csv`, `signals_128hz.csv`, `signals_1hz.csv`. A fractional rate becomes something like `signals_12_5hz.csv`. No channel is resampled. Under `--layout long` they share one file instead, still without resampling, and the hint below reads "They share one table, each row carrying its own time, so no channel is resampled."

```
warning: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
```

**What to do.** Load the files you need. Each has its own `time_s` column, so joining them is a matter of aligning on time. When every channel shares a rate, a single `signals.csv` is written and this warning doesn't appear at all.

**It describes the conversion, not the file.** `--channels` is taken into account, because the warning exists to explain why the output was split. Narrowing a three-rate recording to one channel writes one file and raises nothing; narrowing it to two rates reports two, not three.

```bash
edf2csv sleep-study.edf --channels "EEG Fpz-Cz"
#   one channel, one file, so no rate warning — but this recording is eight hours
#   at 100 Hz, and the other warning it raises does not go away with it:
#   warning: At least one output file will have more than 1,048,576 rows, which is more than Excel or Numbers can open.

edf2csv sleep-study.edf --channels "EEG Fpz-Cz,Temp rectal"
#   warning: Channels use 2 different sampling rates (100 Hz, 1 Hz).
#   warning: At least one output file will have more than 1,048,576 rows, which is more than Excel or Numbers can open.
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
         Use --start and --duration to convert a section, or read the file with
         pandas or R.
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
         Delete them, or convert into a fresh directory, so the two runs do not
         get mixed up.
```

A directory that has been converted into several times can hold a great many of these — a mixed-rate recording writes one file per rate — so past eight the rest are counted rather than named, the same as every other message here that lists something the run does not control. One leftover reads as one, in the advice as well as in the sentence above it.

**What to do.** Delete the named files yourself once you've confirmed you don't need them, or convert into a fresh directory with `--out`. `metadata.json` always describes the run that wrote it, so its `conversion.files` list is the authoritative record of which files belong to the current conversion.

### EMPTY_WINDOW

The conversion had signal tables to fill and put no data rows in any of them, so `signals.csv` holds its header and nothing else.

A window can select nothing without being past the end of the recording — `--start` at or past the end is a usage error and stops the run before this. This is the narrower case: a window that lies inside the recording but lands where there is no data. Between the last sample and the nominal end of the last record:

```
warning: No samples fall inside the requested window (1.950s to 2.000s), so the signal
         files hold their headers and no data.
         The window is inside the recording but lands where there is no data —
         past the last sample, or inside a gap in a discontinuous file. Run with
         --info to see where the records actually sit.
```

Or, on a discontinuous recording whose records sit at 0s, 1s and 10s, anywhere in the eight-second gap:

```bash
edf2csv study.edf --start 2 --end 10    # asks for a span that holds no records at all
```

**What to do.** Run `--info` to see where the records really are. On an EDF+D file the gaps are the point: the row times are true recording times, so a window chosen from wall-clock arithmetic can miss the data entirely.

It is a warning rather than an error because a batch of five hundred recordings shouldn't stop for the one whose gap lines up with the window. Pass `--strict` to make it a failure.

### NONPRINTABLE_LABEL

One of a channel's four free-text header fields — label, unit, transducer or prefiltering — contains control characters. The warning names which, because what it costs is not the same: a label becomes the column name in `signals.csv`, while the other three are cells of `channels.csv` and nothing else.

**Cause.** A writer that copied a field out of another system without sanitising it, a header edited by a script, or a corrupt file whose label bytes are not text at all. EDF fields are free text and nothing enforces that they are printable.

```
warning: Signal 0's label and unit contain 2 control characters (\x1b), which will appear
         in the CSV column name and in channels.csv's unit cell exactly as the header has them.
         Address the channel by position with --channels "#0" rather than by
         name, since the name cannot be typed. Printing the CSV to a terminal
         may do more than print it.
```

When only a cell field carries them, the column name is untouched and the channel can still be selected by name — unless it has no label, or its label contains a comma, which [`--channels`](/docs/cli-reference#-c---channels) would read as two names. In both of those the position is the only way in, and the hint says that instead. Whichever branch it takes, the command it prints is one that runs. The cell is named too, since `channels.csv` has fourteen columns:

```
warning: Signal 0's unit contains 1 control character (\x07), which will appear in
         channels.csv's unit cell exactly as the header has it.
         The column name is unaffected, so --channels "ECG" still selects it.
         Printing the CSV to a terminal may do more than print it.
```

**What edf2csv does.** Passes the label through exactly as the header has it. Losing what the file says is not an improvement, and CSV quoting keeps the row parseable whatever the bytes are — the warning exists so that you know, not because anything is rewritten. `--info` is the exception: it escapes them for display, since an ANSI escape in a header could otherwise drive your terminal. The same goes for paths, which the filesystem supplies and nobody vets — a directory named with an ESC byte, or a file name holding a newline, is escaped everywhere edf2csv prints it, so a summary line stays one line and stays inert.

Until 0.5.102 only the label and the unit were checked. `transducer` and `prefiltering` are header text of exactly the same kind and land in `channels.csv` exactly as the unit does, so an ESC byte in a transducer reached the CSV with nothing said, and `cat channels.csv` would drive the terminal — the hazard this warning exists for, two columns over.

**What to do.** When the label is affected, address the channel by position (`--channels "#0"`) rather than by name. Be careful about printing the CSV to a terminal — `\x1b[2J` clears the screen, so `cat signals.csv` can hide the rest of your session's output. `head`, `less -R` off, or opening the file in an editor are all safe. A tab (`\x09`) is harmless to a terminal but still makes a column name that is hard to match reliably in a script.

Raised for every affected channel, so a file with three of them gets three warnings.

### FORMULA_LABEL

One of a channel's four free-text header fields starts with `=`, `+`, `@` or `-`. Excel, LibreOffice and Google Sheets read a cell beginning with any of those as the start of a formula rather than as text, whatever file it arrived in — so a channel labelled `=1+1` opens as a column headed `2`, one labelled `-2+3` as a column headed `1`, and one labelled `=HYPERLINK("http://...","EEG")` as a link nobody in the reading chain wrote.

**Cause.** EDF's label, unit, transducer and prefiltering fields are free text, and nothing in the format says they may not look like a formula. Usually that is a header written by a script that pasted a computed name in; it is also the shape a deliberately hostile recording would take, which is why the [security policy](https://github.com/tayal-sarthak/edf2csv/blob/main/SECURITY.md) already treats these four fields as attacker-controlled.

```
warning: Signal 0's label starts with =, which Excel, LibreOffice and Google Sheets read as
         the start of a formula rather than as text.
         The text is written exactly as the header has it, so the cell is what
         the recording says. Open the CSV with pandas or R, or import it into
         the spreadsheet as text, if you do not want it evaluated.
```

**What edf2csv does.** Writes the field exactly as the header has it, and says so. The usual mitigation is to prefix the cell with an apostrophe, and that means writing something the recording does not contain — the one thing this tool does not do. `NONPRINTABLE_LABEL` answers control bytes the same way, for the same reason.

The minus sign has two exceptions, and until 0.7.62 it was one big one — nothing with a leading `-` was flagged at all, on the reasoning that a lone `-` is a real convention for "no unit" and appears in the test recordings. That is true of a lone `-`, which every spreadsheet leaves as text, and of a field that is entirely a number, which reads as that number and so says what the header says. It is not true of anything else after the minus: `-2+3` is arithmetic and `-A1` is a name, and both are evaluated. Those are named now; the two cases the exception was written for still are not.

**What to do.** Read the CSV with pandas, R or any CSV library, none of which evaluate anything. If it has to go into a spreadsheet, use its text-import path rather than opening the file directly — in Excel that is Data → From Text/CSV with the column set to Text, and in LibreOffice the import dialog with "Evaluate formulas" off. `--channels` still selects the channel by its literal name.

Raised for every affected channel, so a file with three of them gets three warnings.

## Fatal errors: the recording can't be read

These stop the conversion and exit **1**.

Nothing is written for all but one of them: they are raised while the header is being read, before the output directory exists. The exception is a recording that changes size *during* the conversion, described at the end of this section — by then rows have been written, and the message says so.

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

The file contains a complete header but not one complete data record. There are two ways to get there and the message says which.

Nothing after the header at all:

```
error: The file contains a header and no data at all.
       The recording was probably interrupted before any data was written.
```

An acquisition that was started and stopped immediately produces exactly this. So does a transfer that copied the header and then failed.

Or data is there, but less than one record of it — which up to 0.5.86 got the message above, so a 606 KB file holding 589 KB of samples was told no data was written:

```
error: The file contains 589824 bytes of data, which is less than the 983040 its header says one data record takes.
       Either the recording was cut short part way through its first record, or
       the header describes records larger than the ones actually written. Check
       the samples-per-record fields against the file size.
```

Both numbers are there because the interesting comparison is between them: a header declaring records far larger than what was written is the other way to land here, and it is a header problem rather than a truncation.

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

The mid-conversion case works differently, and is the one place in this section where the conversion has already written something. If the file shrinks or is being rewritten while edf2csv is reading it, the read comes up short and the conversion stops rather than quietly handing back a CSV missing its tail:

```
error: Expected 2864400 bytes of data at record 24600 but only 0 bytes were available; the file appears to have changed size while it was being read.
       Make sure the recording is not still being written to, then try again.
       What was written to "out" before it failed is incomplete and should not
       be used.
```

That last sentence is the part to act on. The rows written before the read failed are on disk, in a `signals.csv` that ends on a row boundary and opens exactly like a finished one — two and a half million of them in the run above, out of 2.88 million. Nothing about the file itself reveals which it is. Delete the directory, or convert into a fresh one.

Wait for the recording to finish, or copy it somewhere stable first, then convert.

### INPUT_UNREADABLE

The reader failed *after* the conversion had started writing, so the run stopped part way through with output already on disk.

**Cause.** The same conditions as [`UNREADABLE`](#unreadable) — a recording that shrinks, a descriptor that stops returning bytes — but reached during the streaming pass rather than while opening the file.

**What edf2csv does.** Keeps the reader's own message and its advice, which name the record and the byte counts, and adds what is true of a failure at this point: some of the output exists and is incomplete. The distinction matters because the two used to be reported identically — a read failure was filed under `Writing to "<dir>" failed` with a hint about freeing disk space, which sends you to inspect the one part of the system that was working.

```
error: Expected 524288 bytes of data at record 1024 but only 131072 bytes were available; the file
       appears to have changed size while it was being read.
       Make sure the recording is not still being written to, then try again.
       What was written to "converted" before it failed is incomplete and should
       not be used.
```

**What to do.** Treat the directory as unusable and convert again once the recording has stopped moving. Through `--stdout` the same failure names stdout rather than a directory, since that path writes no files.

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

Filesystem failures are translated into plain language rather than passed through as system codes. The whole list, in the words the message uses: permission denied; the disk is full; you are over your disk quota on this filesystem; part of the path is a file, not a directory; the filesystem is read-only; the path is too long; part of the path does not exist.

### WRITE_FAILED

Writing one of the output files failed part way through, most often because the disk filled up.

```
error: Writing to "recording_csv" failed: ENOSPC: no space left on device
       The files written so far are incomplete and should not be used. The
       destination is out of space; free some up or choose another with --out.
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
| `EPIPE` | Whatever was reading the output closed it before the conversion finished |
| anything else | Check the destination and run the conversion again |

The partly written files are left on disk either way. They are truncated at an arbitrary point and must not be analysed: fix what the hint names and run the conversion again from the start.

Under `--stdout` the sentence changes, because that path writes no files and `--out` is the flag you chose not to pass:

```
error: Writing to stdout failed: ENOSPC: no space left on device, write
       What reached stdout before it failed is incomplete and should not be
       used. The destination is out of space; free some up or redirect it
       somewhere else.
```

### INPUT_OUTPUT_COLLISION

One of the files this run would write is the recording it is reading.

**Cause.** An `--out` that resolves onto the input — most easily by pointing it at the directory the recording sits in, where `channels.csv` or a `signals_<rate>hz.csv` can land on a file of that name. A hard link or a second path to the same inode reaches it too, which is why the check compares device and inode numbers rather than just the resolved paths.

**What edf2csv does.** Refuses before creating anything, and says so. `--force` does not override it: overwriting your own input is not what `--force` means, and the recording is unrecoverable once a CSV is written over it.

```
error: Output file "recordings/channels.csv" is the same file as the input recording.
       Choose a separate directory with --out. The input was not modified.
```

**What to do.** Convert into a directory of its own. The check covers every name the run would write, compressed forms included, so a `--gzip` run is refused on the same grounds.

### CALLBACK_FAILED

The `onProgress` callback a library caller passed to `convert` threw.

**Cause.** A bug in the caller's own code. The command line never raises this — its progress meter is internal — so it appears only through the [programmatic API](/docs/api).

**What edf2csv does.** Stops the conversion and reports the callback as the cause, keeping the original error as `cause` so the stack that matters survives. It is deliberately not filed as a write failure: running inside the same guard that turns a stream error into `WRITE_FAILED` meant a caller's bug came back as `Writing to "out" failed: <their message>`, advising them to check a destination that was working.

```
error: The onProgress callback threw: Cannot read properties of undefined (reading 'total')
       This is the caller's callback, not the recording or the destination.
       Whatever was written before it threw is incomplete and should not be
       used.
```

**What to do.** Fix the callback. The conversion still stops, and whatever it had written is incomplete — carrying on writing into a directory whose owner has just failed is not an improvement.

### UNSUPPORTED_REQUEST

The command cannot be carried out as written, decided after reading the header.

**Cause.** Every one of these is a `--stdout` refusal: `--stdout` with `--annotations-only`, which leaves no signal data to stream; `--stdout` on a recording whose channels use more than one sampling rate in the default wide layout, which would be more than one table; and `--stdout` on a recording with no signal channels at all.

**What edf2csv does.** Refuses and exits **2**, not 1. It is the one `ConversionErrorCode` in `USAGE_ERROR_CODES`, because the fix is to change the flags rather than the file — the hints say exactly that, and filing it under 1 sent scripts looking at the disk.

```
error: --stdout needs exactly one table, but this recording produces 3, one for each sampling
       rate its channels use (256 Hz, 128 Hz, 1 Hz).
       Narrow it to one rate with --channels, write --layout long to get them
       all in one table, or convert to a directory instead.
```

**What to do.** Take one of the three routes the hint names. `--info --stdout` reports the same refusal ahead of time as a [`STDOUT_UNSUPPORTED`](#stdout_unsupported) warning rather than an error, since `--info` writes nothing.

## Usage errors

These mean the command was invoked in a way that can't be carried out. They exit **2** rather than 1, so a script can tell "you asked for something impossible" apart from "this recording is broken".

| Situation | Example message |
| --- | --- |
| Unknown flag | Reported by the argument parser, followed by a pointer to `--help` |
| No input file | Usage text is printed |
| Two recordings that would convert into the same directory | `"n2/rec.edf" and "n1/rec.edf" would both be converted into "out/rec", so one would overwrite the other.` |
| Several recordings with `--stdout` | `--stdout writes a single CSV, so it cannot take 3 recordings.` |
| `--channels` given with no names | `--channels was given but lists no channel names.` |
| `--decimals` missing or out of range | `--decimals must be a whole number between 0 and 20` |
| A channel name that matches nothing | `No channel named "ECQ". Did you mean "ECG"?` |
| `--channels` naming the annotation channel | `"EDF Annotations" is this recording's annotation channel, not a signal` |
| `--jobs` or `--layout` given a value it cannot act on | `--layout must be "wide" or "long", got "tall"` |
| A position that doesn't exist | `No channel at position #9.` |
| An unparseable time value | `--start "banana" is not a time I understand.` |
| `--duration` and `--end` together | `Use either --duration or --end, not both.` |
| `--start` at or past the end of the recording | `--start "600s" is at or past the end of this 2s recording.` |
| A window that ends before it starts | `The requested window ends at "1s", which is not after its start at "5s".` |
| One recording's output inside another's | `"study/rec/inner.edf" would be converted into "out/rec/inner", which is inside "out/rec"` |
| `--stdout` given a folder | `--stdout writes a single CSV, and a folder is converted as a batch even when it holds one recording.` |
| `--stdout` with nothing to stream | `--stdout has no signal data to write because --annotations-only was given.` |
| `--stdout` on a mixed-rate recording | `--stdout needs exactly one table, but this recording produces 3` — see [`UNSUPPORTED_REQUEST`](#unsupported_request) |
| `--stdout` with `--json`, `--out`, `--checksum` or `--force` | `--stdout and --json both write to stdout, so they cannot be combined.` |
| A folder holding no recordings | `No EDF or BDF recordings found in "study".` A folder that could not be *read* is exit 1 instead |

A term that matches no channel is an error rather than a silent omission, and the message suggests the closest labels in the file. Quietly dropping a channel you explicitly asked for would hand you a CSV missing data you believe is in it.

The last two entries are about the recording's length but are still classed as usage errors, because the fix is to change the command rather than the file.

The reverse mistake was on this page until 0.5.65: "the recording changed size while it was being read" was listed here, and it exits **1**. It is the parser reporting that the file moved under it, which is the definition of a file error — the command was fine — and [`UNREADABLE`](#unreadable) above describes it, with the exit code it really uses. Nothing else in this table comes from the parser, and a test now holds that.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command succeeded. Warnings may still have been printed |
| `1` | The recording couldn't be read, or the output couldn't be written — or `--strict` was given and the recording raised a warning, in which case the output was written in full |
| `2` | The command was invoked incorrectly, or asked for something the recording can't provide |
| `130` | Interrupted with Ctrl-C (SIGINT). Whatever had been written is incomplete |
| `143` | Terminated by SIGTERM. Same as above |

`1` is therefore not a synonym for "nothing was written". Under `--strict` it means the opposite: every file the run
intended to write is there, and a warning is being reported as a failure because you asked for that. A pipeline that
branches on the exit code alone cannot tell the two apart — read `warnings` from `--json`, or drop `--strict`, if the
difference matters.

Piping into a consumer that exits early, such as `head`, closes stdout and would normally raise a broken pipe error. That case is treated as success, so `edf2csv recording.edf --info | head -5` exits 0.

Over a batch the codes combine: any recording that failed makes the run exit 1, and 2 only when nothing worse happened — a usage error is the narrow claim, so every recording has to have earned it. A `--jobs` worker killed from outside, by the out-of-memory killer or a scheduler's time limit, counts as a failure like any other; up to 0.5.88 it made the run exit 2, because a signalled child exits 130 or 143 and the mapping only knew about 1 and 2. The command was fine; something killed a worker.

## Checking warnings from a script

`--json` puts the whole summary, warnings included, on stdout as JSON. Warnings aren't also printed as text in this mode, so stderr stays clean.

```bash
edf2csv recording.edf --out ./converted --json > summary.json
```

The `warnings` array holds one entry per diagnostic:

```json
{
  "tool": { "name": "edf2csv", "version": "..." },
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
