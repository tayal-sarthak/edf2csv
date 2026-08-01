---
title: EDF+ annotations and gaps
description: How edf2csv reads the EDF+ annotations channel, exports events, and keeps discontinuous recordings honest about time
order: 5
---

Plain EDF stores nothing but numbers. EDF+ adds a way to store text alongside the
signals: sleep stages, stimulus markers, technician notes, seizure onsets, and the
timestamps that tell you where in the recording each data record actually sits.
edf2csv reads that channel in full and writes it to `annotations.csv`, and it uses
the same information to make sure the `time_s` column in `signals.csv` reflects
when the data was really measured.

## The annotations channel

An EDF+ file declares one or more channels with the reserved label
`EDF Annotations`. BDF+ files, produced by BioSemi hardware, spell the same thing
`BDF Annotations`. edf2csv recognises both.

These channels occupy space in every data record exactly like a signal does, but
the bytes are UTF-8 text rather than samples. That is why the annotations channel
never appears in the channel table, never gets a column in `signals.csv`, and is
never listed in `channels.csv`. `--info` reports it separately:

```bash
edf2csv sleep-study.edf --info
```

```
Channels   1 signal + 1 annotation channel
```

The text is stored as a run of Time-stamped Annotation Lists (TALs). Each TAL
begins with a signed onset, optionally followed by a duration, then zero or more
text strings, and is terminated by a NUL byte. The separators are control
characters: `0x15` between onset and duration, `0x14` before and after each text
string. Written out with the control bytes made visible, one TAL looks like this:

```
+1.25<0x15>0.5<0x14>Seizure onset<0x14><0x00>
```

That says: at 1.25 seconds from the start of the recording, an event lasting 0.5
seconds, described as `Seizure onset`.

## What an annotation carries

Three things, and only three things:

| Field | Meaning |
| --- | --- |
| onset | Seconds from the start of the recording. Always present. |
| duration | Seconds. Optional. A TAL may omit it entirely. |
| text | The description. A single TAL may carry several. |

`annotations.csv` has one row per annotation, with a fourth column recording
which data record the annotation was physically stored in:

```
onset_s,duration_s,description,record_index
0.5,1,Sleep stage W,0
1.25,,Lights off,1
2,0.5,Seizure onset,2
```

An omitted duration is written as an empty cell, not as `0`. This matters. A
duration of zero is a claim that the event was instantaneous; an empty cell is an
admission that the file did not say. Collapsing the two would invent information.
In pandas the empty cell reads back as `NaN`, which is the correct thing for a
value that was never recorded.

Descriptions are escaped by normal CSV rules, so an annotation containing a comma,
a quote, or a newline is quoted rather than allowed to break the column count.

A single TAL can carry several text strings sharing one onset and duration. Each
becomes its own row, all with the same `onset_s` and `duration_s`.

## EDF+C and EDF+D

Bytes 192 to 235 of the header hold a reserved field. EDF+ files write one of two
markers there:

- **EDF+C**, continuous. Every data record follows the one before it with no gap.
  Record `n` starts at `n * record_duration` seconds, and always will.
- **EDF+D**, discontinuous. The records are still in file order, but they are not
  adjacent in time. There are holes between them.

BDF+ writes `BDF+C` and `BDF+D` for the same two states. edf2csv normalises both
spellings to one internal marker, so a BioSemi discontinuous file behaves exactly
like an EDF+D one.

Discontinuity is not an exotic case. It is what you get when an ambulatory
recorder is paused and resumed, when a system drops out and reconnects, when a
long recording is segmented and the segments are concatenated, or when a vendor
tool exports only the annotated epochs of a much longer study.

The important consequence: in an EDF+D file, the arithmetic `record_index *
record_duration` is no longer the record's position in time. It is only a count of
how much data came before. The real position is stored in the first TAL of every
data record, the mandatory timekeeping annotation, which carries an onset and no
text. That TAL is the only place a discontinuous file records where its data sits.

`--info` names the format directly:

```
Format     EDF+ (discontinuous)
```

and conversion warns before it starts:

```
warning: This is a discontinuous (EDF+D) recording: its data records are not contiguous in time.
         Each row carries its true recording time, so gaps stay visible instead of being closed.
```

## Gaps stay visible

edf2csv reads the timekeeping TAL of every record and uses it as the base time for
every sample in that record. Sample `i` of a record that declares itself at
`t` seconds is written at `t + i / sampling_rate`. Nothing is inserted to bridge a
gap, and nothing is shifted to close one. A gap therefore appears in the output as
exactly what it is: a jump in `time_s` between two consecutive rows.

The test fixture `discontinuous.edf` demonstrates this in miniature. It holds
three one-second records of a single 10 Hz channel, and its timekeeping TALs place
those records at 0 s, 1 s and 10 s. The first two are adjacent; the third sits
after a nine-second hole.

```bash
edf2csv discontinuous.edf --out ./converted
head -1 ./converted/signals.csv
sed -n '20,23p' ./converted/signals.csv
```

If the gap were ignored and the records were laid end to end, the output would run
0.0 s to 2.9 s with nothing to indicate that anything was missing. What edf2csv
actually writes is:

```
time_s,EEG Fpz-Cz
...
1.800,2.259
1.900,2.381
10.000,2.503
10.100,2.625
...
```

Thirty rows, one per real sample, none invented. The jump from `1.900` to `10.000`
is the gap. Anything that computes a sampling interval by differencing `time_s`
will see the discontinuity rather than a smooth ramp that quietly misplaces every
sample after the hole by nine seconds.

Three practical consequences follow.

**The recording's span is not the amount of data it holds.** This file contains
three seconds of samples but covers eleven seconds of wall time. Time windows are
resolved against the real span, so a window can legitimately reach past where the
data would have ended if it were contiguous:

```bash
edf2csv discontinuous.edf --start 5 --out ./converted
```

That is not an error, and the record at 10 s is not clipped away. It writes the ten
samples from `10.000` to `10.900`. The same window against a naively flattened
version of this file would have been rejected as starting past the end.

**`--info` reports the amount of data, not the span.** For this file it prints
`Duration 3s (3 records of 1s)`, because that is how many seconds of signal exist.
The gap is reported separately, by the EDF+D warning.

**Rows are written in file order.** If a file's timekeeping TALs are themselves out
of order, so that a record claims to start before the one preceding it, edf2csv
writes the rows anyway and warns that `time_s` will not increase monotonically. It
does not silently reorder your data.

## The whole annotation channel is always read

When you request a time window, edf2csv still scans the annotation channel of the
entire file, from the first record to the last.

This is deliberate. Nothing in the EDF+ specification obliges a writer to store an
annotation in the data record whose time span contains its onset. Some tools write
every annotation in the file into the first record. Others batch them. Reading only
the records that fall inside the requested window would silently drop events that
belong in that window but happen to be stored elsewhere, and the resulting
`annotations.csv` would look complete.

The fixture `annotations-front-loaded.edf` is exactly this shape: ten one-second
records, with all three annotations stored in record 0, at onsets 0.5 s, 5.5 s and
8.5 s. Asking for the window from 5 s to 7 s produces the event that belongs there:

```bash
edf2csv annotations-front-loaded.edf --start 5 --duration 2 --out ./converted
cat ./converted/annotations.csv
```

```
onset_s,duration_s,description,record_index
5.5,,middle,0
```

Note `record_index` is `0` while `onset_s` is `5.5`. That column exists precisely
so you can see when a writer has done this.

The scan is cheap. edf2csv seeks straight to the annotation channel's byte range
inside each record rather than reading whole records through memory, so on a
multi-gigabyte recording the cost is a few kilobytes of I/O rather than all of it.

Annotations are filtered to the requested window by their onset, using the
half-open interval `[start, end)`. An annotation whose onset falls inside a gap in
a discontinuous file is still exported, because the window covers the recording's
real span rather than only the parts that contain samples.

## Exporting only the events

Some analyses need the event list and nothing else: building a hypnogram, counting
stimulus markers, checking that a scoring pass covers the whole night. Converting
an eight-hour 256 Hz study to get a few hundred rows of text is wasteful.

```bash
edf2csv sleep-study.edf --annotations-only --out ./events
```

This skips signal conversion entirely. No `signals.csv` is written and no samples
are read. The output directory contains `annotations.csv`, `channels.csv`
describing the channels that were not converted, and `metadata.json`.

`--start`, `--duration` and `--end` still apply, so you can pull the events from a
single hour.

Asking for annotations from a file that has no annotation channel is not an error,
but it does not pass silently either:

```
warning: --annotations-only was requested but this recording has no annotation channel, so there are no events to export.
         Plain EDF files carry no annotations. Convert without --annotations-only to get the signals.
```

A file whose only content is annotations, with no signal channels at all, converts
fine. It produces `annotations.csv` and an empty `channels.csv`, plus a warning
saying the file carries no signal channels.

## When timekeeping is missing or unreadable

The timekeeping TAL is the only record of where a discontinuous file's data sits.
When it is absent or cannot be parsed, that position is simply not knowable from
the file.

edf2csv does not stop, and it does not guess quietly. The affected record is timed
as if it were contiguous with the start of the recording, at `index *
record_duration`, and the substitution is reported by name:

```
warning: 1 of 3 data records carry no readable timekeeping annotation (record 1), so their true position in time is unknown.
         Those records are timed as if they were contiguous; treat their timestamps as unreliable.
```

Up to five record indices are listed, with an ellipsis when there are more. The
same warning appears in `metadata.json` under `notes`, and in the `warnings` array
of `--json` output, so a scripted pipeline can detect it without parsing stderr.

Two related cases get their own warnings.

A file marked EDF+D that has no annotation channel at all is self-contradictory: it
claims gaps and provides nowhere to record them. Times are written as if the
records were contiguous, and edf2csv says so plainly, noting that any gaps are
lost.

Individual TALs that cannot be decoded are skipped rather than aborting the
conversion, and the count is reported:

```
warning: 2 annotation entries were unreadable and could not be exported.
         The rest were exported normally. The file may have been written by a non-conforming tool.
```

Losing one malformed annotation should not cost you an entire conversion, but
losing it in silence would leave you with an event list you had no reason to
distrust.

## How other tools handle this

Discontinuity is where readers diverge most sharply, and it is worth knowing what
your existing tooling does.

**pyEDFlib** refuses EDF+D files outright. It raises rather than returning data.
This is a defensible choice: it never gives you wrong timestamps. It also means
that if your recordings are discontinuous, pyEDFlib gives you nothing at all, and
converting with edf2csv first is one way to get the data into a form you can work
with.

**mne.io.read_raw_edf** reads EDF+D files and presents them as continuous. The
gaps are closed. Samples from either side of a hole end up adjacent in the array,
and the returned time vector counts uniformly from zero as though no interruption
occurred. Downstream, every sample after the first gap carries a timestamp that is
wrong by the accumulated gap length, and nothing in the object marks which samples
those are. Annotations are read from the file with their original onsets, so on a
discontinuous recording the event times and the sample times refer to different
clocks.

edf2csv takes the third position: read the file, keep the real times, and say out
loud what the file's structure is. If a gap is a problem for your analysis, you
should be the one who decides what to do about it, and you cannot decide about
something you were never shown.

## Reading the output

Loading the two files together in pandas is enough to line events up against
signal:

```python
import pandas as pd

signals = pd.read_csv("converted/signals.csv")
events = pd.read_csv("converted/annotations.csv")

# Find gaps: any interval larger than the sampling period.
dt = signals["time_s"].diff()
gaps = signals.loc[dt > dt.median() * 1.5, "time_s"]

# Samples covered by one annotation.
event = events.iloc[0]
end = event.onset_s + (event.duration_s if pd.notna(event.duration_s) else 0)
window = signals[(signals.time_s >= event.onset_s) & (signals.time_s < end)]
```

Because `time_s` carries the true recording time in both files, the comparison is
valid across a gap. `duration_s` is `NaN` wherever the file gave no duration, which
is why the check above is explicit rather than assuming zero.

## Programmatic access

The annotation decoder is exported, so you can read events without producing CSV
at all:

```javascript
import { EdfFile } from 'edf2csv';

const file = await EdfFile.open('sleep-study.edf');
const { annotations, recordStarts, malformed } = await file.readAnnotations();

for (const a of annotations) {
  console.log(a.onset, a.duration, a.text, a.recordIndex);
}

// recordStarts[i] is the declared start of record i, or null when the
// timekeeping annotation was missing or unreadable.
console.log(recordStarts[0], recordStarts.at(-1), malformed);

await file.close();
```

`readAnnotations` returns annotations sorted by onset, then by record index for
ties. `recordStarts` has one entry per data record actually present in the file.
`decodeRecordAnnotations` is also exported for decoding a single record's
annotation bytes directly.
