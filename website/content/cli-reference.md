---
title: CLI reference
description: Every edf2csv flag, its default and its behaviour, plus exit codes and the stdout versus stderr contract
order: 2
---

`edf2csv` converts one EDF, EDF+, BDF or BDF+ recording per invocation into a directory of CSV files. There's no configuration file and no environment variables — everything is on the command line.

## Synopsis

```bash
edf2csv <recording.edf> [options]
```

At least one input is required, except with `--help` and `--version`. It can be a recording or a folder of them, and several can be given at once, so a glob does what a shell loop used to:

```bash
edf2csv /data/recordings/*.edf --out /data/csv
```

```
[1/3] night-01.edf
Wrote /data/csv/night-01
  signals.csv  8,640,000  rows
  ...
[2/3] night-02.edf
...

Converted 3 of 3 recordings.
```

With `--out` the named directory becomes the parent and each recording gets its own inside it, named after the file. Without `--out` each recording converts beside itself into `<name>_csv`, exactly as it would have done alone.

What `--out` means is decided by what you named, not by what was found. Name one recording and it is the output directory itself; name a folder — or several recordings — and it is a parent. So `edf2csv study --out csv` writes `csv/night-01/rec/` whether the study holds one night or fifty, and adding a second night never moves the first one's output.

A recording that cannot be read is reported and the rest still convert — one unreadable file in a folder of five hundred is a reason to name that file, not to discard the work already done. The closing line says how many succeeded, and the exit code is non-zero if any failed.

The same goes for anything the walk cannot look at: a sub-directory it may not list, or a link whose target is not there — a night linked to a drive that is not mounted, say. It is named on stderr and counts against the run, because the walk cannot know what was behind it and converting less than you asked for is not a success. Once each, however many ways it was reached, the same as the recordings:

```
error: study/night-02: could not be read, so any recordings inside it were skipped.
```

A recording named more than once is converted once, however it was named — twice on the command line, or once directly and once inside a folder that was also given. A shell produces that by accident easily enough (`edf2csv *.edf recording.edf`), and it is not ambiguous.

Which of the names its output is called after is decided by the names, not by the order they arrived in: a name the recording actually has beats a symbolic link pointing at it, and two links are settled by the one that sorts first. So `edf2csv data/one.edf data/alias.edf` and the same two swapped both write `out/one`, and a study copied to a machine whose filesystem enumerates the folder differently still produces the same directory names.

How a path is *spelled* decides nothing. `study/night-01/rec.edf`, `./study/night-01/rec.edf` and the absolute form are one name, so adding a `./` or switching a script to absolute paths cannot move the output or turn a run that worked into a refusal.

The same holds for a folder reached two ways. A study containing `aaa-real/` and `zzz-alias -> aaa-real` is walked through `aaa-real`, so the output keeps that name. Where several names lead to one folder, the shallowest wins, then the one that is not a link, then the first in sort order.

Two *different* recordings that would land in the same directory are refused before anything is written. This happens with the common layout of one folder per night, where `n1/rec.edf` and `n2/rec.edf` would both resolve to `<out>/rec`:

```
error: "n2/rec.edf" and "n1/rec.edf" would both be converted into "out/rec", so one would overwrite the other.
       Convert them separately, or rename one of them.
```

A folder is expanded to every `.edf` and `.bdf` inside it, at any depth, which is usually easier than getting a shell to do it:

```bash
edf2csv /data/study --out ./converted --jobs auto
```

The layout is kept — a recording at `study/night-1/rec.edf` comes out at `converted/night-1/rec` — which is also what keeps recordings apart. One folder per night with the file always called `rec.edf` is a normal way to organise a study, and flattening those onto their file names would have every one of them claim `converted/rec`.

Symbolic links are followed, both to recordings and to folders, since linking data into a working directory is a normal way to arrange it. A recording reachable two ways is converted once rather than twice, and a cycle of links terminates instead of running forever.

Which of its names the output takes is decided by the names, never by the order you typed them. A recording is preferred over a link pointing at it; a recording named both directly and through a folder keeps the position the folder gives it, since that is what the folder promised and it is the name that does not collide with a sibling.

Anything in the folder that is not a recording is skipped, and a folder holding none says so rather than converting nothing in silence:

```
No EDF or BDF recordings found in "/data/empty".
```

`--stdout` still takes a single recording, since one stream holds one recording's table.

## Flags at a glance

| Long | Short | Argument | Default | Effect |
| --- | --- | --- | --- | --- |
| `--info` | `-i` | none | off | Describe the recording and estimate the output, convert nothing |
| `--out` | `-o` | directory | `<recording>_csv` beside the input | Where the CSV files are written |
| `--channels` | `-c` | comma-separated list | all signal channels | Convert only these channels |
| `--start` | | time | start of the recording | First sample to include |
| `--duration` | | time | to the end | How much to convert, measured from `--start` |
| `--end` | | time | end of the recording | Offset to stop at, instead of `--duration` |
| `--annotations-only` | | none | off | Write only the EDF+ event list, no signal data |
| `--decimals` | | integer 0 to 20 | derived per channel | Force a fixed number of decimal places |
| `--checksum` | | none | off | Record a SHA-256 of the input in `metadata.json` |
| `--layout` | | `wide`, `long` | `wide` | `long` writes one file of `time_s,channel,value` |
| `--gzip` | | none | off | Compress every CSV, writing `.csv.gz` files |
| `--bom` | | none | off | Start each CSV with a UTF-8 byte order mark |
| `--jobs` | `-j` | integer or `auto` | 1 | Convert this many recordings at once |
| `--force` | `-f` | none | off | Write into an output directory that already exists |
| `--quiet` | `-q` | none | off | Suppress the closing summary and the progress meter |
| `--json` | | none | off | Print machine-readable JSON to stdout, for a conversion or for `--info` |
| `--strict` | | none | off | Exit 1 if the recording raised any warning |
| `--stdout` | | none | off | Write the signal CSV to stdout instead of a directory |
| `--help` | `-h` | none | | Print usage to stdout and exit 0 |
| `--version` | `-V` | none | | Print the version to stdout and exit 0 |

Short options are single letters and the version flag is a capital `V`. Unknown flags are rejected; there's no pass-through.

A value that begins with a dash has to be written as one argument, or it reads as another flag. This comes up with a destination named `-nightly`, or a negative `--start` on a recording timed from before zero. The refusal says which form to use, and the two forms differ: a long option joins with `=`, a short one joins directly.

```
error: --out was given "-nightly", which begins with a dash and so reads as another flag rather than as its value.
       Write it as one argument instead: --out=-nightly
```

So `--out=-nightly` and `-o-nightly` both work; `-o=-nightly` does not — it makes the destination `=-nightly`.

What `--info` prints is checked the same way a conversion's `--stdout` is: redirected into a filesystem with no room, it exits 1 and says so rather than leaving a short file behind and reporting success. A description is usually small, but a 900-channel recording's is 58 KB. Piping into `head` is unaffected — the check declines anything that is not a regular file.

## Input, output directory and overwriting

An input can be a recording or a folder of them, and several can be given at once. A recording that cannot be read is a file error (exit 1); a folder holding none is a usage error (exit 2), since the command as written asked for nothing:

```
No EDF or BDF recordings found in "/data/empty".
```

A folder the process cannot open is a different answer and gets a different one. "None here" is something the run can state; "could not look" is not, so it says that instead, and exits 1 rather than 2 — the command was fine, the filesystem refused:

```
error: /data/locked: could not be read, so any recordings inside it were skipped.
Nothing could be converted: that path could not be read, so whether it holds recordings is unknown.
```

When some recordings *were* found alongside it, the closing line counts the unreadable paths beside the conversions, since how many recordings they held is the thing nobody knows:

```
Converted 1 of 1 recordings; 1 path could not be read.
```

Anything that is not a directory is passed to the reader as given, so a missing path or a special file reports itself rather than being skipped.

`-o, --out <dir>` sets the destination. Without it, the output directory is the input file's name with its extension replaced by `_csv`, created next to the input: `/data/recordings/sleep-study.edf` becomes `/data/recordings/sleep-study_csv`. The directory is created if it doesn't exist, including missing parents.

If the destination already exists, the conversion stops before writing anything:

```
error: "/data/csv/sleep-study" already exists.
       Pass --force to overwrite it, or --out to choose a different directory.
```

`-f, --force` allows writing into an existing directory. It overwrites files of the same name; it doesn't empty the directory first. That matters when two runs produce different file names. Converting a mixed-rate recording writes `signals_256hz.csv` and `signals_1hz.csv`; converting a single-rate recording into the same directory afterwards writes `signals.csv` and leaves the two older files beside it, both looking current. Nothing is deleted automatically, but you're told:

```
warning: signals_128hz.csv, signals_1hz.csv, signals_256hz.csv are left over from an
         earlier conversion into this directory and were not rewritten.
         Delete them, or convert into a fresh directory, so the two runs do not get mixed up.
```

If the destination path exists but is a regular file rather than a directory, that's an error with its own message. `--force` means "replace my previous output", not "write into whatever this happens to be".

## -i, --info

Prints a description of the recording to stdout and exits without writing anything. Because it writes nothing, it is not held to the rules about where output would land: two recordings whose names would collide, or one whose output directory would sit inside another's, are both described rather than refused. Those are usage errors for a conversion — and `--info --out` is how you would want to find out about them, so it says so, as a warning on stderr rather than a refusal:

```
warning: "n2/rec.edf" and "n1/rec.edf" would both be converted into "out/rec", so one would overwrite the other.
         Convert them separately, or rename one of them.
```
 How much it reads depends on the file. A plain EDF is the header and nothing else. A continuous EDF+ is the header plus the annotation slot of at most the first sixteen records, which is what finds the offset the recording starts at — 0.4.9 made that offset the point samples are timed from, and a window placed against zero instead lands somewhere else. A discontinuous EDF+ is the header plus every record's annotation slot, because that is the only place its record times are stored, and the span and the row estimate are wrong without them. All three return in milliseconds on any ordinary recording; only the last scales with record count.

So `--info` sees an unreadable timekeeping entry in those first sixteen records and reports it, and does not see an unreadable *event* later in a continuous file, because it never looks there. [Warnings and errors](/docs/warnings-and-errors#what---info-can-and-cant-tell-you) lists what that means code by code.

```bash
edf2csv sleep-study.edf --info
```

```
File       sleep-study.edf
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

Sampling rates differ, so channels are written to 3 files, one per rate. No channel is resampled.
Would write 3,196,800 rows, roughly 108 MB.
```

Reading the table:

- The `#` column is the channel's position in the file, counted over every channel including the annotation channel — which is why the data channels above stop at `#4` in a file with six channels: `#5` is `EDF Annotations`. A recording that stores its annotation channel in the middle makes the numbering skip instead. Those `#` values are what the `#N` form of `--channels` addresses.
- `COLUMN` is the CSV column header the channel will get, and `LABEL` is the raw label from the header. They differ only when a label is duplicated or empty (see below).
- `OUTPUT` names the file the channel would land in, or `(not selected)` when `--channels` excludes it.
- The row and byte estimates honour `--channels`, `--start`, `--duration`, `--end`, `--decimals` and `--annotations-only`, so the figures describe the command you actually typed. With `--annotations-only` the signal channels read `(not selected)` and no row estimate is printed at all — the estimate describes the signal tables, and that run writes none. See [`--info --annotations-only`](#--annotations-only). Up to 0.4.51 it did print `Would write 0 rows, roughly 0 B.`, which was true of the signal tables and false of the run; this sentence went on describing that until 0.5.76.
- If the recording has a `Patient` or `Recording` identification field, it's echoed above the table. EDF headers commonly carry patient identifiers, so treat `--info` output as sensitive before pasting it into a ticket.
- Header text is free text from the file, so control bytes in it are printed as their escape (`\x1b`, `\x0d`) rather than sent to the terminal. A header carrying ANSI sequences would otherwise be able to clear your screen or repaint the output. `channels.csv` and `metadata.json` still record the field verbatim.

Warnings raised while parsing the header — mixed rates, a truncated file, a degenerate calibration — go to stderr, never into the table.

## -c, --channels

Restricts the conversion to a subset of channels. Channels that are left out still appear in `channels.csv` with `converted` set to `no`, so the output documents the whole recording.

The flag can be repeated, and each occurrence can hold a comma-separated list. These three invocations are identical:

```bash
edf2csv recording.edf --channels "EEG Fpz-Cz,ECG"
edf2csv recording.edf -c "EEG Fpz-Cz" -c ECG
edf2csv recording.edf -c "EEG Fpz-Cz, ECG"
```

Terms are trimmed, so spaces after the commas are fine, and empty terms are dropped. Passing the flag with nothing usable in it is a usage error rather than a silent "convert everything":

```
error: --channels was given but lists no channel names.
```

### Matching rules

A term matches a channel when it equals that channel's **label**, compared case-insensitively, with no partial or prefix matching and no wildcards. `ecg` matches `ECG`; `EEG Fpz` matches nothing. Labels routinely contain spaces and punctuation, so quote them in the shell.

Match against the label from the `LABEL` column of `--info`, not the `COLUMN` name. Where the two differ, the label is the one that works: in a file with two channels labelled `T8-P8`, the columns are named `T8-P8_ch0` and `T8-P8_ch1`, and passing one of those says so rather than treating it as a typo:

```
error: "T8-P8_ch1" is a column name, not a channel name: --channels matches the label, which for this channel is "T8-P8".
       Use "#1" to select just this one, or "T8-P8" for every channel sharing that label.
```

A label that merely looks like a column name is still a label, and wins: if a third channel really is called `T8_ch0`, `--channels "T8_ch0"` selects that channel and not the one whose column happens to be spelled the same way. The suffix rule cannot make a channel unreachable by its own name. A channel with no label at all has nothing to match, so `#<index>` is the only way to ask for it, and the error says that too. So is a channel whose label contains a comma. The comma separates terms and is split on wherever it appears, so `--channels "EEG Fpz-Cz, ref"` asks for two channels rather than one and exits 2 on the first of them — a label that reads perfectly well and cannot be typed as a term. `channels.csv` and the CSV header both carry such a label in full, quoted; `#<index>` is how you select it.

The EDF+ annotation channel can't be selected. It isn't a signal, it's never a column in `signals.csv`, and asking for `EDF Annotations` by name is an unknown-channel error. Annotations are exported through `annotations.csv` instead, automatically.

Selection order doesn't affect column order. Channels always appear in file order within their rate group, so `-c "ECG,EEG Fpz-Cz"` and `-c "EEG Fpz-Cz,ECG"` produce byte-identical output.

### Selecting by position with #N

`#N` selects the channel at position `N`, using the same numbering as the `#` column of `--info`:

```bash
edf2csv recording.edf --channels "#0,#3"
```

Use this to reach one specific channel when two share a label. If no channel sits at that position, the error lists the positions that do exist:

```
error: No channel at position #9. This file has signal channels at #0, #1, #2.
```

The listed positions are signal channels only, so an annotation channel's index isn't offered even though it consumes a number.

`N` has to be written in plain digits. `#2` is a position; `#0x2`, `#2.0`, `#1e0`, `# 2` and a bare `#` are not, and each is refused rather than resolved:

```
error: "#0x2" is not a channel position: a position is #0, #1, #2 and so on.
       This file has signal channels at #0, #1, #2.
```

The point is that these used to be accepted. Anything that `Number()` could read became a position, so `#0x2` reached channel 2 through hexadecimal and a bare `#` became channel 0 — a mistyped term converted a different channel and exited 0 rather than saying anything.

### Duplicated labels

EDF doesn't require labels to be unique, and real recordings break the assumption. Published scalp EEG collections routinely contain files with two separate channels both labelled `T8-P8`, and some carry a channel whose label is nothing but `-`. edf2csv handles this in two places.

In the output, duplicated labels are disambiguated by appending the channel's position: `T8-P8_ch0` and `T8-P8_ch1`. The suffix is derived from the whole file, not from your selection, so a channel gets the same column name whether you converted all channels or just that one. A channel with an empty label becomes `signal_<index>`.

In `--channels`, a term matching several channels selects **all** of them and warns:

```
warning: "T8-P8" matches 2 channels (positions #0, #1); all of them were selected.
         Use --channels "#0" to pick just one.
```

Taking the first silently would drop data you asked for, and refusing outright would make the file unconvertible by label. To get one channel, use `#N`.

### Typos

A term that matches nothing is an error rather than a quiet omission, since dropping a requested channel would produce a CSV missing data you asked for with nothing in the file recording that it happened. Close labels are offered as suggestions, up to three of them, ranked by edit distance:

```bash
edf2csv recording.edf --channels ECQ
```

```
error: No channel named "ECQ". Did you mean "ECG"?
Run with --info to list the channels in this file.
```

Suggestions appear only when a label is close enough: within an edit distance of 2, or one third of the term's length for longer terms. A term with nothing similar in the file gets the bare error and the pointer to `--info`.

### Labels that literally start with #

A channel whose label really is `#5` is reachable. When a term begins with `#`, edf2csv first checks whether any channel carries that exact label; if one does, the label wins and the positional interpretation isn't attempted. The positional form is a fallback, so no channel can be made unreachable by an unusual label.

### Interaction with --annotations-only

`--annotations-only` skips signal output entirely, so the selection has nothing to act on — but the names are still checked. A term matching no channel is a usage error in this mode too, so a typo is reported rather than silently accepted.

## Time range: --start, --duration, --end

`--start` sets the first offset to include, `--duration` says how much to take from there, and `--end` gives an absolute offset to stop at. All three are measured in seconds from the start of the recording, not wall-clock times of day.

`--duration` and `--end` are mutually exclusive. Passing both is a usage error:

```
error: Use either --duration or --end, not both.
```

Every other combination is legal. `--start` alone runs from that offset to the end. `--duration` alone takes that much from the beginning. `--end` alone runs from the beginning to that offset.

### Accepted formats

The same parser handles all three flags. Values are case-insensitive.

| Form | Examples | Meaning |
| --- | --- | --- |
| Plain number | `90`, `90.5`, `0` | Seconds |
| Clock, with hours | `00:30:00`, `1:02:03.5` | `hh:mm:ss`, fractional seconds allowed |
| Clock, without hours | `30:00` | `mm:ss` |
| Units | `30s`, `5m`, `1h`, `250ms` | A number followed immediately by its unit |
| Compound units | `1h30m`, `1h30m 15s` | Terms are summed |

Recognised units are `h`, `hr`, `hrs`, `hour`, `hours`; `m`, `min`, `mins`, `minute`, `minutes`; `s`, `sec`, `secs`, `second`, `seconds`; and `ms` for milliseconds. Note that `m` is minutes and `ms` is milliseconds.

Each unit may appear once. `1h30m20s` is fine and so is `1h30min`, but `1h1h` is rejected rather than summed to two hours — a repeated unit is a typo far more often than it is a request, and silently adding it up produces a window that is quietly the wrong length. Aliases count as the same unit, so `30m20min` is caught too.

Two details of the unit form. A number must sit directly against its unit, with no space between them: `5min` is accepted and `5 min` isn't. Space between separate terms is fine, so `1h30m 15s` works. And a number must lead with a digit: `1.5h` is accepted, `.5` isn't.

In the clock form, the minutes and seconds fields must be below 60, so `60:00` is rejected rather than read as an hour. The hours field is unbounded, which lets `100:00:00` express a long offset.

Rejections say what went wrong:

```
error: --start "5x" uses an unknown unit "x". Use h, m, s, or ms.
error: --start "1h banana" is not a time I understand. Try 30s, 5m, 1h30m, 00:30:00, or a plain number of seconds.
error: --duration is empty. Try a value like 30s, 5m, or 00:30:00.
```

### How the window is resolved

The window is half-open: a sample at exactly the start offset is included, a sample at exactly the end offset isn't. A requested end past the end of the recording is clamped silently, so `--end 999h` on a two-hour file converts to the end. A start at or past the end of the recording is an error, because the result would be an empty file that looks like a successful conversion:

```
error: --start "4h" is at or past the end of this 2h 12m 30s recording.
```

An end that isn't after the start is likewise an error. A start at the recording's exact length counts as past the end, including when the length is a product that does not land on the number it prints as — 6003 records of 0.1s is 600.3000000000001, and `--start 600.3` on it is refused rather than converting nothing.

Sample times in the output are absolute offsets into the recording, not relative to `--start`. Converting from `30m` produces a `time_s` column beginning at `1800`, so a windowed export lines up with the full one.

`annotations.csv` is filtered by the same window: events whose onset falls inside it are kept, events outside it are dropped. The annotation channel is still read in full regardless of the window, because an event that occurs inside the window can be stored in a data record outside it.

For discontinuous (EDF+D) recordings the window is resolved against real recording time, not against the amount of data present. A ten-second recording with a ninety-five-second gap in the middle ends at 105 seconds, and `--end 100s` means 100 seconds on that timeline. Every data record whose own span overlaps the window is read.

A recording does not always begin at zero. The first data record's timekeeping annotation is what `time_s` is counted from, and a file whose first record says `+1000` writes its samples from `1000.000` — so `--start` and `--end` are read on that clock too. On such a file `--start 0 --end 1` converts nothing and says why, and a start past the end names both the recording's length and where it sits, rather than calling the end of its clock its length:

```
warning: No samples fall inside the requested window (0.000s to 1.000s), so the signal files hold their headers and no data.
         This recording starts at 1000.000s, so the whole window sits before it. --start and --end are read on the recording's own clock, which --info prints as "Timed from".

error: --start "5000" is at or past the end of this 3s recording, which runs from 1000s to 1003s.
```

`--info` says where it begins whenever that is not zero, in seconds so the number can be typed straight back in:

```
Duration   3s  (3 records of 1s)
Timed from 1000.000s  (first sample; --start and --end use this clock)
```

Under `--json` the same number is `first_sample_seconds`. `duration_seconds` and `time_span_seconds` are both lengths and neither says where that length sits.

```bash
# Five minutes starting half an hour in.
edf2csv sleep-study.edf --start 30m --duration 5m

# The same window, written the other way.
edf2csv sleep-study.edf --start 00:30:00 --end 00:35:00
```

## --annotations-only

Writes the EDF+ event list and nothing else. The output directory gets `annotations.csv`, `channels.csv` and `metadata.json`, with no signal files. It's fast, since no data records are converted, and it's what you want when you need a scoring or event file out of a large recording without the samples.

`--start`, `--duration` and `--end` still filter the events. `--channels` is ignored, as described above.

`--info --annotations-only` names the files rather than estimating rows, since the estimate describes the signal tables and there are none:

```
Would write annotations.csv and channels.csv, and no signal data. How many events there
are cannot be told from the header.
```

The event count genuinely isn't knowable that cheaply — the annotation channel has to be read record by record, which is the scan `--info` exists to avoid. Until 0.4.51 this line read `Would write 0 rows, roughly 0 B.`, which was true of the signal tables and false of the run.

On a recording with no annotation channel, the conversion still succeeds and still writes `channels.csv` and `metadata.json`, with a warning:

```
warning: --annotations-only was requested but this recording has no annotation channel,
         so there are no events to export.
         Plain EDF files carry no annotations. Convert without --annotations-only to get
         the signals.
```

## --decimals

Takes a whole number from 0 to 20 and applies it to every signal column, replacing the per-channel precision edf2csv would otherwise derive.

By default the precision is chosen per channel from its calibration. A channel's smallest expressible step is its physical range divided by its digital range, and the default is two places beyond that step, so two adjacent digital codes never round to the same text and no digits are written that carry no information. An ordinary microvolt EEG channel lands at 3 or 4 decimals; a channel calibrated in volts needs more, and a magnetometer in tesla more again, which is why the derived precision runs up to 100 — the most `toFixed` will print. `--decimals` itself stops at 20, which is a bound on a number you pick by hand rather than on what the format can express.

Use `--decimals` when you want a uniform column width across channels, or when you're willing to trade precision for file size. Note what you give up: `--decimals 2` on a channel whose step is 0.0076 uV maps several genuinely different digital codes onto the same printed value.

`--decimals` doesn't affect the `time_s` column, whose precision is derived from the sampling rate so that sample times are exact rather than rounded. It doesn't affect `channels.csv`, `annotations.csv` or `metadata.json` either.

Out-of-range and non-integer values are usage errors, and so is anything that is not written in plain digits: `0x3`, `0b11`, `0o5`, `3e0` and `+3` are all numbers to JavaScript and none of them is a count of decimals anyone typed, so accepting them would mean converting at a precision the command does not say. Same rule as `--jobs` and `--channels "#N"`. An empty value is rejected explicitly rather than read as zero, since `--decimals ""` would otherwise round every physical value to a whole number:

```
error: --decimals must be a whole number between 0 and 20, got "21".
error: --decimals needs a number, for example --decimals 3.
```

## --jobs

Converts several recordings at once. It only means anything for a batch — one recording is one conversion however many jobs are asked for. The value is a plain decimal integer of 1 or more, or `auto`: `0x10`, `1e3` and `+4` are refused rather than read as 16, 1000 and 4, the way `Number()` would have them.

```bash
edf2csv /data/recordings/*.edf --out /data/csv --jobs 4
```

Eight recordings of 19 MB, each converting to 168 MB of CSV, on an eight-core machine:

| | wall clock |
| --- | --- |
| `--jobs 1` | 9.7 s |
| `--jobs 2` | 5.6 s |
| `--jobs 4` | 3.3 s |
| `--jobs auto` | 3.8 s |

`auto` is one job per core less one, so a long batch leaves the machine usable. It is not always the fastest setting: past a point the conversions compete for disk rather than CPU, which is why `auto` lands slightly behind `4` above. Start with `auto` and try a smaller number if the disk is the limit.

Each conversion runs in its own process, because converting is almost entirely arithmetic and string building — 1.17 s of CPU for 1.24 s of wall clock — and Node runs that on a single thread. Doing it with concurrent promises inside one process was tried and gained 6%, which is the overlap in the file reads and nothing more.

Output is held until a recording finishes and then released in one piece, so two conversions ending together cannot interleave one's summary with the other's warnings. Recordings therefore appear in the order they finish rather than the order given, and each is announced by the `[n/m]` line naming it. The converted files are byte-identical to a serial run.

Interrupting a parallel batch stops every conversion in flight and names the directories left half-written:

```
interrupted (SIGINT): 3 conversions stopped part way through.
       Incomplete, and should not be used: out/r5, out/r6, out/r7
```

A single conversion killed on its own — by the out-of-memory killer, by a scheduler's time limit, by `kill` — is reported the same way, since it also leaves a `signals.csv` that ends mid-row and opens like a whole one:

```
error: study/night-02.edf: stopped by SIGKILL before it finished.
       Incomplete, and should not be used: out/night-02
```

The rest of the batch carries on, and the closing count and exit code report it as a failure.

`--stdout` ignores it, since that path takes a single recording anyway.

Interrupting one conversion — Ctrl-C on a single file rather than a batch — exits 130 and says which of three things happened, because they call for different responses. A conversion writes nothing for the first part of its run: under `--checksum` it hashes the input first, and an EDF+ file has its whole annotation channel scanned for record start times before the output directory is claimed, which on a long recording is seconds. Interrupted in that window there is nothing to distrust and nothing to delete:

```
interrupted (SIGINT): the conversion stopped part way through.
       Nothing was written: "night-02_csv" was never created.
```

Interrupted after the directory was claimed, the files in it stop mid-recording while still parsing as whole CSVs, which is the case worth warning about:

```
interrupted (SIGINT): the conversion stopped part way through.
       Files already written to "night-02_csv" are incomplete and should not be used.
```

And with `--force` over a directory that was already there, what is in it may be the previous run's output or this one's, and the message says so rather than guessing. Under `--stdout` there is no directory to name, so it warns about the stream instead.

## --layout

How the samples are arranged in the CSV. `wide`, the default, or `long`.

`wide` is a column per channel and a file per sampling rate, which is what every earlier version wrote and what most analysis expects.

`long` is one file, three columns, one row per sample:

```bash
edf2csv sleep-study.edf --out ./converted --layout long
```

```
time_s,channel,value
0.000,EEG Fpz-Cz,0.061
0.000,EEG Pz-Oz,0.061
0.000,EOG horizontal,0.061
0.000,Resp oro-nasal,0.000244
0.000,Temp rectal,37.00073
0.010,EEG Fpz-Cz,1.648
```

The reason it exists is the mixed-rate recording. A 100 Hz channel and a 1 Hz channel share no rows, so a wide table holding both means either ninety-nine empty cells in every hundred or inventing the samples to fill them — which is why `wide` splits them across files instead. In the long layout each sample carries its own time and nothing has to line up, so every rate goes in one table with nothing invented. Rows come out sorted by `time_s`, and within one time in the order the file declares its channels. Records are written in file order, and each record's samples all fall inside that record's span, which is what makes the whole file sorted. Two things a discontinuous recording is allowed to do break that, and edf2csv warns about both.

Its records may be *stored* in a different order than they are *timed*:

```
warning: 2 data records start earlier than the record before them.
         Rows are written in file order, so the time column will not increase monotonically.
```

Or they may overlap: each starting after the one before it, but before that one *ends*, so a record's samples run past the start of the record after it. The starts increase, and the column steps backwards anyway — records of one second at 0 s and 0.25 s, two samples each, write 0.000, 0.500, 0.250, 0.750.

```
warning: 1 data record starts before the record before it ends, so its samples overlap in time.
         Rows are written in file order, so the time column will not increase monotonically.
```

Every sample is still written, once, in file order. Sort on `time_s` yourself if you need it and either warning appeared.

That also makes it the one layout `--stdout` can stream for a mixed-rate recording, since there is only ever one table:

```bash
edf2csv sleep-study.edf --stdout --layout long | head -20
```

It is the shape most plotting and grouping libraries want directly:

```python
import pandas as pd
long = pd.read_csv('converted/signals.csv')
long.groupby('channel')['value'].describe()
```

And it converts back to the wide form in one call, for the rates that share a time base:

```python
wide = long.pivot(index='time_s', columns='channel', values='value')
```

The cost is size. A wide row carries one time for every channel; a long row repeats the time and the channel name on every sample, so the same recording is roughly two to three times larger. `--info` reports the long figure when `--layout long` is given, so the estimate always describes the command you typed. `--gzip` recovers most of the difference, since a repeated channel name is exactly what compression is good at.

The `time_s` precision is shared across rates in the long layout — the finest any of them needs — because one column cannot mean three things. A recording mixing 256 Hz and 1 Hz writes both at eight decimal places.

## --bom

Starts each CSV with a UTF-8 byte order mark — the three bytes `EF BB BF`. Off by default.

It exists for one reader. Excel on Windows opens a CSV with no mark in the system code page rather than UTF-8, so anything outside ASCII arrives wrong. `µV` is the common case: EDF headers are Latin-1 in practice and exporters write the micro sign as a single byte, which UTF-8 stores as two, and Excel shows as `Âµ`. Annotation text in French, German or Japanese goes the same way. The mark tells Excel the file is UTF-8 and the text comes through as written:

```bash
edf2csv recording.edf --out ./converted --bom
```

It applies to `signals.csv`, `channels.csv` and `annotations.csv`, and to their `.csv.gz` forms — the mark goes inside the compressed stream, so decompressing gives a marked CSV. `metadata.json` never gets one: `JSON.parse` rejects a leading U+FEFF, so a mark there would break every reader of the file to help a program that will not open it anyway.

The reason it is not the default is that the mark is not invisible to everything. pandas strips it on the way in, either engine. Python's own `csv` module over a plain `open()` does not, and neither does Node's `fs.readFileSync(path, 'utf8')` — the first column name comes back as `\ufefftime_s` and a lookup of `time_s` misses. Readers that want it gone ask for it by name:

```python
import csv
with open('converted/signals.csv', newline='', encoding='utf-8-sig') as handle:
    header = next(csv.reader(handle))   # ['time_s', 'EEG Fpz-Cz', ...]
```

So: `--bom` if the destination is Excel, plain if the destination is a script.

## --gzip

Compresses every CSV on the way out. Each one gains a `.gz` extension:

```
recording_csv/
  signals.csv.gz
  annotations.csv.gz
  channels.csv.gz
  metadata.json
```

CSV of sampled signal data compresses well — long runs of similar values in a fixed-width decimal format — so the saving is large. An hour of 100 Hz EEG that converts to 168 MB of CSV writes 26 MB with `--gzip`, about six times smaller, and the compression adds roughly a second per hundred megabytes.

`metadata.json` is left as plain text. It is small, and it is the file you read to find out what the directory contains, which is awkward if reading it requires decompressing it first.

The contents are byte-for-byte what an uncompressed run produces, so anything that reads gzip reads the output directly:

```bash
edf2csv recording.edf --out ./converted --gzip
gunzip -c ./converted/signals.csv.gz | head -5
```

pandas takes it without any decompression step, inferring the codec from the extension:

```python
import pandas as pd
signals = pd.read_csv('converted/signals.csv.gz')
```

R's `read.csv` and `readr::read_csv` do the same. DuckDB reads it with `read_csv('converted/signals.csv.gz')`.

`--gzip` combines with `--stdout` to compress the stream:

```bash
edf2csv recording.edf --stdout --gzip > signals.csv.gz
```

`--info` reports the estimate as the size **before** compression, since what compression achieves depends on the data:

```
Would write 10,000,000 rows, roughly 160.1 MB before compression.
```

## --checksum

Computes a SHA-256 of the input file and records it in `metadata.json` under `source.sha256`. Without the flag that field is `null`.

This costs one extra full read of the input. It's useful when the CSV outlives the source and you need to establish later which file it came from. The rest of `source` — resolved path, byte size, modification time — is recorded either way.

## --stdout

Writes the signal CSV to stdout and creates no directory, for feeding a conversion straight into
something else:

```bash
edf2csv recording.edf --stdout | duckdb -c "SELECT count(*) FROM read_csv('/dev/stdin')"
```

Only the samples are written — no `channels.csv`, `annotations.csv` or `metadata.json`, since a
stream holds one table. For the same reason it needs the recording to produce exactly one, and
refuses a mixed-rate file rather than merging tables that have different row counts:

```
error: --stdout needs exactly one table, but this recording produces 3, one for each sampling rate its channels use (256 Hz, 128 Hz, 1 Hz).
       Narrow it to one rate with --channels, write --layout long to get them all in one table, or convert to a directory instead.
```

Two answers, and which one fits depends on what you want out of the stream. `--channels` narrows
the selection until one rate is left, and gives you the wide table for that rate. [`--layout long`](#--layout)
keeps every channel and puts them in one table by giving each sample its own row, which is the one
arrangement a mixed-rate recording can take without inventing anything:

```bash
edf2csv sleep-study.edf --stdout --layout long | head -20
```

The row count still goes to stderr either way, so stdout carries nothing but CSV, and the progress
meter is never drawn in this mode.

`--stdout` and `--json` cannot be combined: both write to stdout, and together they would produce a
document that is neither valid CSV nor valid JSON. Passing both is a usage error (exit 2):

```
error: --stdout and --json both write to stdout, so they cannot be combined.
       Use --stdout for the CSV, or --json for the summary.
```

Every refusal takes that shape — `error:` on the first line, the advice indented under it — so
stderr can be grepped for `^error:` and find all of them. The two `--stdout` refusals printed
flush left with no prefix until 0.5.79.

With `--info` they combine: `--info` writes no CSV for the summary to collide with, and under `--json` the description *is* the JSON — so `edf2csv rec.edf --info --stdout --json` is how a script asks whether `--stdout` would work on a recording. It answers with a `STDOUT_UNSUPPORTED` warning when it would not.

So are `--stdout --out`, `--stdout --checksum` (exit 2 since 0.5.5) and `--stdout --force` (since 0.5.100): `--force` means "write into a directory that already exists", and there is no directory. `--jobs` is not refused — a job count is a property of the run rather than a request about this file's output, and `--stdout` converts one recording whatever it is set to. Both were accepted and
dropped in silence before that. `--out` named a directory that was never created, so a run that
wrote nowhere looked like it had written somewhere; `--checksum` computed a SHA-256 of the input —
a second full pass over the file, before the first record is read — and then discarded it, since
the only file it is ever written to is the `metadata.json` that `--stdout` does not write.

A folder is refused too, even one holding a single recording, because what a folder holds is not
known until it is walked. The message names the recording inside it so you can run that instead.

And a recording with no signal table at all — one holding only EDF+ annotations, or a `--channels`
selection that leaves nothing carrying samples — is refused rather than streamed as an empty
result:

```
error: --stdout has no signal data to write: this recording has no signal channels, only EDF+ annotations.
       Convert to a directory to get its annotations.csv, or drop --stdout.
```

Up to 0.5.14 the wide layout answered that with "--stdout needs exactly one table, but this
recording produces 0, one for each sampling rate its channels use ()" and pointed at
`--layout long`, which wrote zero bytes, no header row, and exited 0.

### Redirecting to a file that will not fit

When stdout is redirected to a regular file, `edf2csv` checks at the end that the descriptor grew by as many bytes as it was handed, and fails if it did not:

```
error: Writing to stdout failed: 150904 of 2063736 bytes did not reach the destination,
       which stopped accepting them part way through.
       What is there ends mid-row and should not be used. The destination is almost
       certainly out of space — a short write is how a filesystem reports filling up
       mid-write, and nothing after it raised an error because there was nothing after it.
```

A reader that stops reading is a different thing, and gets a different line. `edf2csv recording.edf --stdout | head -1` is an ordinary thing to type and not a failure, but it is not a conversion either, so it does not get a conversion's summary:

```
Stopped: the reader closed the pipe after 52,507 of 102,400 rows had been written. The recording was not converted in full.
```

Up to 0.5.11 that read "Wrote 52,507 rows to stdout" — a number that is neither the recording's 102,400 nor the one row `head` took, but however many had been formatted before the closed pipe was noticed. How many reached the reader is not knowable from this side; that it stopped early is.

The check exists because this is the one path that has no second file to trip over. `write` returns a short count rather than an error when the filesystem fills partway through a single call, and only the *next* write raises `ENOSPC` — `--out` always has a next write, since `channels.csv` and `metadata.json` come after the samples. Until 0.4.39 a `--stdout` conversion that lost its tail this way exited 0 and announced the full row count.

It applies to a regular file only. A pipe, a terminal or a socket has no size to compare, and cannot lose a write this way without reporting it. Appending with `>>` is fine: the starting size is taken before anything is written.

## -q, --quiet

Suppresses the closing summary and the progress meter. It doesn't suppress warnings or errors: a conversion that raises a warning about mixed sampling rates or a truncated file still says so on stderr under `--quiet`, because those describe your data rather than the tool's own status. A clean conversion under `--quiet` prints nothing at all and exits 0.

In a batch it also suppresses the `[n/m] <path>` header, which is what pairs each warning with the recording that raised it — so under `--quiet` the warnings carry that name themselves. Without `--quiet` they do not, because the header above them already says it. This holds under `--jobs` too, where it matters most: conversions finish in whatever order they finish, so there is no position to infer the attribution from.

The progress meter is separate from the summary. It's drawn only when `--quiet` is off, `--json` is off, and stderr is a terminal. In a script, in a pipeline, or under `nohup`, it never appears, so log files don't fill with carriage returns. It updates at most ten times a second and erases itself when the conversion finishes.

## --json

Prints a summary object to stdout as JSON and suppresses the human-readable summary. Warnings that would otherwise go to stderr are carried inside the object instead, so with `--json` the whole result of a successful run is on stdout and stderr stays empty.

Naming one recording gives one indented document. Naming a folder, or several recordings, gives [JSON Lines](https://jsonlines.org) instead — one compact object per line, written as each recording finishes rather than held until the run ends, so a batch of five hundred can be consumed while it is still running:

```bash
edf2csv ./study --out ./converted --json | jq -r 'select(.warnings != []) | .output_dir'
```

`jq` reads that stream a record at a time. `json.load` does not: use `json.loads` per line, or `pandas.read_json(path, lines=True)`. Which of the two shapes you get is decided by what you named and never by what was found there, so a folder that gains a recording does not change the shape of the output.

Here's a complete run over a short three-second, three-channel recording with an annotation channel:

```bash
edf2csv recording.edf --out ./converted --json
```

```json
{
  "output_dir": "./converted",
  "files": [
    { "name": "signals_256hz.csv", "rows": 768 },
    { "name": "signals_128hz.csv", "rows": 384 },
    { "name": "signals_1hz.csv", "rows": 3 },
    { "name": "annotations.csv", "rows": 12 },
    { "name": "channels.csv", "rows": 3 }
  ],
  "annotations": 12,
  "duration_seconds": 3,
  "records": 3,
  "elapsed_ms": 38,
  "warnings": [
    {
      "code": "MIXED_SAMPLING_RATES",
      "severity": "warning",
      "message": "Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz)."
    }
  ]
}
```

Field by field:

| Field | Meaning |
| --- | --- |
| `output_dir` | The directory that was written, exactly as it will be found on disk |
| `files` | Every CSV written, in the order it was produced, with its data-row count excluding the header line. `metadata.json` isn't listed |
| `annotations` | Number of events written to `annotations.csv`, after time-window filtering. `0` when the recording has no annotation channel |
| `duration_seconds` | Duration of the whole recording, not of the converted window |
| `records` | Number of data records the file actually contains, which can differ from the count its header declares |
| `elapsed_ms` | Wall-clock time for the conversion |
| `warnings` | One entry per diagnostic, each with a stable `code`, a `severity` of `"warning"` or `"info"`, and a human-readable `message`. Empty array when there's nothing to report |

The `code` values are stable identifiers meant for programmatic checks: `MIXED_SAMPLING_RATES`, `DISCONTINUOUS`, `RECORD_COUNT_MISMATCH`, `RECORD_COUNT_UNKNOWN`, `TRAILING_BYTES`, `DUPLICATE_LABEL`, `EMPTY_LABEL`, `LARGE_OUTPUT`, `STALE_OUTPUT`, `ANNOTATION_DECODE_FAILED`, `DEGENERATE_DIGITAL_RANGE`, `DEGENERATE_PHYSICAL_RANGE`, `UNUSABLE_PHYSICAL_RANGE`, `INVERTED_PHYSICAL_RANGE`, `COMMA_DECIMAL`, `NO_ANNOTATIONS`, `NO_SIGNAL_CHANNELS`, `NO_SAMPLES`, `INPUT_CHANGED`, `EMPTY_WINDOW`, `NONPRINTABLE_LABEL`, `TIME_RESOLUTION`, `VALUE_RESOLUTION`, `STDOUT_UNSUPPORTED`, `START_TIME_UNREADABLE`, `MISSING_EDF_PLUS_MARKER` and `HEADER_BYTES_MISMATCH`. Match on `code`, not on `message`.

`--json` applies to both. On a conversion it prints the summary object below; with `--info` it prints the recording's description as JSON instead of the table — the same fields, shaped for surveying a directory of recordings from a script. In both cases warnings travel inside the document and stderr stays empty. On failure, nothing is printed to stdout for that recording, so a parse failure and a non-zero exit code always coincide. Over a folder, both are JSON Lines: one object per recording, and a recording that failed contributes no line.

To fail a batch job on any warning, use `--strict`:

```bash
edf2csv recording.edf --out ./converted --strict
```

`--json` is still the way to react to a *particular* warning rather than to any of them:

```bash
edf2csv recording.edf --out ./converted --json > result.json || exit 1
if jq -e '[.warnings[].code] | index("RECORD_COUNT_MISMATCH")' result.json >/dev/null; then
  echo "recording is incomplete" >&2
  exit 1
fi
```

## -h, --help and -V, --version

`-h, --help` prints the usage text to stdout and exits 0. `-V, --version` prints the version on its own line and exits 0. Both are handled before any other argument checking, so `edf2csv --help` works with no input file and `edf2csv --version` works even alongside an invalid one.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success. The requested output was written, or `--info` or `--help` or `--version` printed |
| `1` | The file or the destination is the problem |
| `2` | The command line is the problem |

**Exit 2** covers anything decided before touching data:

- An unrecognised flag, a flag missing its argument, or a value where none is expected. The message is followed by `Run edf2csv --help to see the options.`
- No input file at all. (Several are fine: that is a batch.)
- An unparseable `--start`, `--duration` or `--end`, and passing `--duration` together with `--end`.
- A time window that can't apply: a start at or past the end of the recording, or an end at or before the start.
- A `--channels` term that matches no channel, a `#N` position that doesn't exist, or `--channels` given with an empty list.
- A `--decimals` value that's empty, not an integer, or outside 0 to 20.
- `--stdout` with nothing to write to it: given together with `--annotations-only`, or on a recording whose channels use more than one sampling rate in the default wide layout, which would produce more than one table. `--layout long` produces one table whatever the rates are, so it is accepted.

The last three categories require reading the file's header first, so exit 2 doesn't mean the file was never opened. It means the command as written can't be carried out.

**Exit 1** covers everything else that stops the run:

- The input can't be read: it doesn't exist, permission is denied, or it isn't a regular file. (A directory is not in this list: a directory is expanded to the recordings inside it. A folder holding none is exit 2.)
- The file isn't usable as EDF: smaller than a 256-byte header, a header field that isn't a number, zero or negative signal count, a non-positive record duration, no complete data record, or no channel carrying any samples.
- The file changes size mid-read, which happens when a recording is still being written.
- The output directory already exists and `--force` wasn't given, or the destination path is a regular file, or it can't be created.
- A write fails partway through, for example because the disk fills. The message says explicitly that the files written so far are incomplete and must not be used.

Warnings never change the exit code by default. A conversion that reports a truncated recording, mixed sampling rates or a discontinuous file still exits 0, because the output it produced is correct and complete for the data that was there.

Pass `--strict` to turn any warning into exit 1:

```bash
edf2csv recording.edf --strict || echo "check the warnings before using this"
```

The output is still written. A warning describes the recording rather than a failure to convert it, so discarding the work would be the wrong response — the exit code is the signal, and the files are there to inspect. `--strict` works with `--info` too, which makes it a cheap way to screen a directory for recordings that need a closer look before anyone converts them.

Errors are printed as a single `error:` line plus an optional indented hint. Node stack traces are never printed for any of the conditions above.

## stdout and stderr

**stdout carries the result you asked for; stderr carries everything else.**

| Stream | Contents |
| --- | --- |
| stdout | The `--info` table, the `--json` summary, the `--help` usage text, the `--version` string |
| stderr | Warnings, the progress meter, the closing "Wrote ..." summary, all error messages |

That's why a normal conversion prints nothing to stdout. The result of a conversion is a directory of files rather than text, so there's nothing to put there. The summary goes to stderr:

```
Wrote /data/csv/sleep-study
  signals_256hz.csv  7,564,800  rows
  signals_128hz.csv  3,782,400  rows
  signals_1hz.csv       29,550  rows
  annotations.csv           12  rows
  channels.csv               3  rows
Done in 2.3s.
```

The split keeps stdout parseable. You can pipe `--info` or `--json` straight into another program without warnings landing in the middle of it, and still see the warnings on your terminal:

```bash
# The channel table goes into the file; the mixed-rate warning still reaches the terminal.
edf2csv sleep-study.edf --info > channels.txt

# Feed the summary to jq while warnings stay visible.
edf2csv sleep-study.edf --json | jq -r '.files[] | "\(.name)\t\(.rows)"'
```

Output is plain text with no colour codes and no terminal escapes, in both streams, so redirecting to a file or a log gives exactly what appeared on screen. The one exception is the progress meter, which uses carriage returns and only draws when stderr is an interactive terminal.

Closing stdout early isn't treated as a failure. `edf2csv recording.edf --info | head -5` exits 0 rather than reporting a broken pipe, which is what a shell pipeline expects.
