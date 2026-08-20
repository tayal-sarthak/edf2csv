---
title: The EDF format
description: How EDF, EDF+ and BDF store a recording on disk: the header fields, the record layout, the calibration, and the quirks real files have
order: 10
---

## Why this page exists

You don't need to know any of this to run `edf2csv`. You need it when something looks wrong: a
channel that reads a thousand times too large, a recording dated 2085, two columns with the same
name, a warning you want to understand rather than dismiss. Every diagnostic the tool prints comes
from a specific field in a specific place, and knowing which field it was usually tells you what
happened.

EDF (European Data Format) was published in 1992 and is deliberately simple. A file is ASCII text
for the metadata followed by raw binary integers for the samples. There's no compression, no
index, and no length prefix on anything. Every position in the file can be computed with
arithmetic, which is why a converter can stream a 40 MB recording without loading it.

EDF+ (2003) added annotations, a way to mark a recording as discontinuous, and conventions for the
identification fields. It didn't change the layout. BDF is BioSemi's 24-bit variant and changes
exactly two things. All three are handled by the same parser.

## The 256 byte fixed header

The first 256 bytes of every EDF, EDF+ and BDF file have this layout. All fields are ASCII,
left-justified and padded with spaces to their full width.

| Offset | Bytes | Field | What it means |
| --- | --- | --- | --- |
| 0 | 8 | version | `0` for EDF and EDF+. Byte 255 followed by `BIOSEMI` for BDF |
| 8 | 80 | patient identification | Who was recorded. EDF+ standardises this into subfields |
| 88 | 80 | recording identification | Which recording this is. EDF+ starts it with `Startdate` |
| 168 | 8 | start date | `dd.mm.yy`, two-digit year |
| 176 | 8 | start time | `hh.mm.ss` |
| 184 | 8 | header bytes | Size of the whole header, which is `256 * (1 + ns)` |
| 192 | 44 | reserved | Where `EDF+C` and `EDF+D` live |
| 236 | 8 | number of data records | Or `-1` when the writer didn't know |
| 244 | 8 | duration of a data record | Seconds, may be fractional |
| 252 | 4 | number of signals (ns) | Including any annotations channel |

That's the entire fixed header. Everything after byte 256 is per-signal header, and everything
after that's data.

### Version

For EDF and EDF+ this field is the single character `0` padded with seven spaces. It carries no
information: there has only ever been one version.

BDF uses it as a magic number instead. Byte 0 is `0xFF` (255, not a printable character) and bytes
1 to 7 spell `BIOSEMI`. That's the only reliable way to tell a BDF file from an EDF file, and it
matters, because the two differ in how many bytes a sample takes. A parser that skips this check
will read a BDF file as EDF and produce complete nonsense rather than an error.

### Patient and recording identification

Two free-text fields of 80 bytes each. In plain EDF they're whatever the recording software felt
like writing. EDF+ specifies a structure for both: the patient field becomes a hospital code, sex,
birth date and name separated by spaces, and the recording field starts with the literal word
`Startdate` followed by the start date in `dd-MMM-yyyy` form.

These fields routinely contain direct identifiers. If you're sharing converted data, look at what
your files actually have in them. `--info` prints both fields, and they're copied verbatim into
`metadata.json` as `patient_id` and `recording_id`.

```bash
edf2csv telemetry-psg.edf --info
```

```
File       telemetry-psg.edf
Format     EDF+ (continuous)
Recorded   2002-03-02 22:15:00
Duration   3s  (3 records of 1s)
Size       1.5 KB
Patient    MCH-0234567 F 02-MAY-1951 Haagse_Harry
Recording  Startdate 02-MAR-2002 PSG-1234/2002 NN Telemetry03
```

Those two lines are the EDF+ specification's own example header, which is why they read as a real
patient rather than as placeholders. `sleep-study.edf` — the recording the rest of this site
converts — has `X X X X` in both fields, so it cannot show you what this section is about.

### Start date and time, and the two-digit year

The date field holds `dd.mm.yy`. Two digits for the year, which needed a rule the moment the format
outlived the 1990s, and EDF has one: **85 to 99 mean 1985 to 1999, and 00 to 84 mean 2000 to 2084**.
The format can't express a date outside 1985 to 2084 at all: on the date field alone, a file
written in 2085 reads as 1985 and one written in 1984 reads as 2084.

EDF+ writes the year again in full. Its recording identification field begins
`Startdate dd-MMM-yyyy`, which the specification requires to agree with the date field, and four
digits say what two cannot — so where that field is present and agrees about the day, the month
and the last two digits of the year, `edf2csv` takes the century from it. A 1984 sleep study
digitised into EDF+ reads as 1984 rather than 2084. A `Startdate` that contradicts the date
field settles nothing, and the rule above is used instead.

So `01.01.85` is 1 January 1985, and `02.03.02` is 2 March 2002. Note also that the date is
day-first: `05.06.09` is 5 June 2009, not 6 May.

```
05.06.09  ->  2009-06-05
02.03.02  ->  2002-03-02
01.01.85  ->  1985-01-01
```

There's no time zone. The instant is whatever local clock the recording hardware had, so `edf2csv`
reports it without one — as a bare wall clock in `--info` and as `start_datetime_local` in
`metadata.json`. Labelling it UTC would shift it by the reader's own offset. The raw text of both
fields survives as `start_date_raw` and `start_time_raw` so nothing is lost to interpretation.

A few practical details. The spec writes the separator as a dot, but real files use `-` and `/` in
dates and `:` and `-` in times, and all of those are accepted. A seconds value of 60 (a leap
second) is accepted and read as 59. An impossible date such as `31.02.02` is rejected outright
rather than silently rolled forward into March, and then `--info` prints the raw fields marked
`(unparseable)`.

### The reserved field, where EDF+C and EDF+D live

44 bytes at offset 192. In plain EDF they're blank. EDF+ puts one of two markers here, and this
single field is what separates a plain EDF file from an EDF+ file:

- `EDF+C` means **continuous**. Data records follow each other without gaps, so record `n` starts at
  `n * recordDuration` seconds.
- `EDF+D` means **discontinuous**. Records aren't contiguous in time. Where each record actually
  sits must be read from the annotations channel.

BDF+ writes `BDF+C` and `BDF+D` for the same two meanings. `edf2csv` treats the pairs as
equivalent. BioSemi also writes `24BIT` in this field on plain BDF files, which isn't a continuity
marker and is ignored.

A file with `EDF+D` gets a warning, because a converter that ignores this field will hand you a
time axis that's quietly wrong.

```
warning: This is a discontinuous (EDF+D) recording: its data records are not contiguous in time.
         Each row carries its true recording time, so gaps stay visible instead
         of being closed.
```

### Record count, record duration, and signal count

These three numbers determine the shape of everything that follows.

**Number of data records** at offset 236 is how many records the writer intended to store. It may
be `-1`, which the spec permits for a recording still in progress. It's also often wrong, because
a recording that was interrupted leaves this field at the value the writer set when it started.
`edf2csv` never trusts it. The record count it uses is derived from the actual file size:

```
dataBytes   = fileSize - 256 * (1 + ns)
recordBytes = sum(samplesPerRecord) * bytesPerSample
recordCount = floor(dataBytes / recordBytes)
```

The declared value is still reported (as `data_records_declared` in `metadata.json`) and any
disagreement produces a warning.

**Duration of a data record** at offset 244 is in seconds and may be fractional. One second is by
far the most common, but 0.1 s and 10 s both occur. This is the only field that turns sample counts
into a sampling rate.

**Number of signals** at offset 252 is four bytes, so at most 9999 channels. It counts the
annotations channel if there's one, which is why a file reported as "1 signal + 1 annotation
channel" has `ns` of 2.

## The per-signal header is field-major

This is the part people get wrong. After the fixed 256 bytes comes `ns * 256` more bytes of
per-signal header, and it's **not** stored as one 256-byte block per signal. It's stored
field-major: all `ns` labels, then all `ns` transducer strings, then all `ns` physical dimensions,
and so on to the end.

```
offset 256          ns * 16 bytes    label
       +ns*16       ns * 80 bytes    transducer type
       +ns*96       ns *  8 bytes    physical dimension (the unit)
       +ns*104      ns *  8 bytes    physical minimum
       +ns*112      ns *  8 bytes    physical maximum
       +ns*120      ns *  8 bytes    digital minimum
       +ns*128      ns *  8 bytes    digital maximum
       +ns*136      ns * 80 bytes    prefiltering
       +ns*216      ns *  8 bytes    number of samples in each data record
       +ns*224      ns * 32 bytes    reserved
```

So the label of signal `i` is at `256 + i * 16`, and its physical minimum is at
`256 + ns * 104 + i * 8`. There's no run of bytes anywhere in the file that contains one signal's
complete header.

This matters because signal-major is the intuitive guess, and with one signal the two layouts are
byte-for-byte identical. A hand-written parser tested on a single-channel file passes, then reads a
two-channel file and gets a label where it expected a transducer string.

Here are the first 64 bytes after the fixed header in a two-channel file:

```
"ch1             ch2                                             "
 |<-- 16 bytes -->|<-- 16 bytes -->|<--- transducer of ch1 ... --->
```

Two 16-byte labels back to back, and then the transducer field starts. Signal-major parsing would
have looked for the transducer of `ch1` at byte 16, and found `ch2`.

### What the per-signal fields mean

- **label**, 16 bytes. Free text. EDF+ recommends `<type> <electrodes>` such as `EEG Fpz-Cz`, and
  reserves the exact label `EDF Annotations` (`BDF Annotations` in BDF+) for the annotations
  channel. Nothing enforces uniqueness.
- **transducer type**, 80 bytes. What the electrode was, e.g. `AgAgCl electrode`. Usually blank.
- **physical dimension**, 8 bytes. The unit. `uV`, `mV`, `degC`, `bpm`. Eight bytes isn't enough
  room for anything careful, so this is where you find `uV` meaning microvolt in one file and
  `µV` in the next.
- **physical minimum / maximum**, 8 bytes each. The two ends of the calibration, explained below.
- **digital minimum / maximum**, 8 bytes each. The two ends of the ADC range, as integers.
- **prefiltering**, 80 bytes. What analogue filtering was applied, e.g. `HP:0.1Hz LP:75Hz N:50Hz`.
  Free text, so it's documentation, not something a program can act on.
- **number of samples in each data record**, 8 bytes. Divided by the record duration, this is the
  channel's sampling rate.

All of these are carried through into `channels.csv`, one row per channel, so you never have to
open the binary to see them.

## Data records and 2-byte little-endian samples

Data starts immediately after the header, at byte `256 * (1 + ns)`, and runs to the end of the file
as a plain sequence of data records with nothing between them.

Within one record, each signal contributes its `samplesPerRecord` samples, in header order, back to
back. A record is therefore always the same size:

```
recordBytes = sum over all signals of (samplesPerRecord * bytesPerSample)
```

Take a file with two channels at 10 samples per 1-second record. Each record is
`(10 + 10) * 2 = 40` bytes, and the file looks like this:

```
byte 0     fixed header, 256 bytes
byte 256   signal header, 2 * 256 = 512 bytes
byte 768   record 0:  ch1 sample 0..9   (20 bytes)  ch2 sample 0..9   (20 bytes)
byte 808   record 1:  ch1 sample 10..19 (20 bytes)  ch2 sample 10..19 (20 bytes)
```

Samples are **2-byte signed little-endian two's complement integers**, so the range is -32768 to
32767. Little-endian means the low byte comes first: the first ten samples of `ch1` above, counting
0 to 9, are stored as

```
0000 0100 0200 0300 0400 0500 0600 0700 0800 0900
```

which is `0, 1, 2, 3, ...` and not `0, 256, 512`.

Because every offset is computable, reading one channel out of forty doesn't require reading the
other thirty-nine. The sample at record `r`, signal `s`, index `k` sits at

```
256 * (1 + ns) + r * recordBytes + byteOffsetOf(s) + k * bytesPerSample
```

This is also why sampling rate is a property of the record structure rather than a stored number.
A channel with 256 samples in a 1-second record is 256 Hz; a channel with 25 samples in a 0.1-second
record is 250 Hz. A rate that can't be written as an integer sample count over the file's single
record duration can't be expressed in EDF at all.

## Digital to physical calibration

The integers in the data records are raw ADC codes. They mean nothing until they're mapped onto
physical units, and the four calibration fields in the signal header are that map.

The mapping is a straight line through two points: `digitalMin` maps to `physicalMin`, and
`digitalMax` maps to `physicalMax`. That's the whole model. There's no offset field, no per-record
gain, nothing else.

```
gain     = (physicalMax - physicalMin) / (digitalMax - digitalMin)
offset   = physicalMax / gain - digitalMax
physical = gain * (offset + digital)
```

The second and third lines are EDFlib's arrangement of the same line, and `edf2csv` uses it because
it's more accurate than the spec's literal `(digital - digitalMin) * gain + physicalMin`. Written
that way, a channel spanning plus or minus 800 uV computes a value near 800 and then subtracts 800,
and the cancellation throws away low-order bits: digital 0 yields `0.19536019536019467` when the
exact answer is `0.19536019536019536`. Keeping the intermediate small returns the correctly rounded
result, and makes the output bit-for-bit identical to pyEDFlib and EDFbrowser, which share the same
arithmetic.

Worked through on a real channel with `physicalMin -800`, `physicalMax 800`, `digitalMin -2048`,
`digitalMax 2047`:

```
gain   = 1600 / 4095 = 0.39072039072039073
offset = 800 / gain - 2047 = 2047.5 - 2047 = 0.5

digital 0  ->  0.39072039072039073 * 0.5 = 0.19536019536019536
digital 1  ->  0.39072039072039073 * 1.5 = 0.5860805860805861
```

### What physical minimum and maximum actually mean

They are the ends of the calibration, **not** the extremes of the recorded data. `physicalMin -800`
doesn't promise that the file contains a sample at -800 uV, and it doesn't promise that no sample
goes below it either. It states only which physical value corresponds to `digitalMin`.

Two things follow. First, `|physicalMax - physicalMin| / |digitalMax - digitalMin|` is the
smallest physical step the channel can express, and `edf2csv` uses exactly that to choose how many
decimal places to write, so two adjacent ADC codes never collapse to the same text. Both
differences are magnitudes, because either pair may be written the wrong way round and a step is a
size: an inverted channel needs the same precision as the upright one it inverts. Second, a
digital value outside the declared digital range converts to a physical value outside the declared
physical range. `edf2csv` applies the line and doesn't clamp, because clamping would fabricate
data that isn't in the file.

The pair can also be degenerate or inverted, and both happen in the wild:

- `digitalMin == digitalMax` makes the line undefined, so there's nothing to compute. `edf2csv`
  leaves those cells empty and warns (`DEGENERATE_DIGITAL_RANGE`), rather than filling the column
  with a stand-in number that would read as ordinary data.
- `physicalMin == physicalMax` makes every sample the same value. Warned as
  `DEGENERATE_PHYSICAL_RANGE`.
- A negative gain inverts the polarity of the channel. That is what `physicalMin > physicalMax`
  usually means — but only usually: reversing `digitalMin` and `digitalMax` instead does the same
  thing, and reversing both pairs cancels out and leaves an ordinary channel. It is the sign of
  the fraction that decides. A negative gain is a legal line, it's just probably a mistake by the
  recording software. `edf2csv` converts exactly what the header says, inversion included, and
  warns (`INVERTED_PHYSICAL_RANGE`) so you can decide whether to trust it.

## BDF, the 24-bit variant

BioSemi's BDF is EDF with a wider ADC. Everything on this page applies, with two changes.

1. The version field is byte 255 followed by `BIOSEMI` instead of `0`.
2. Samples are **3 bytes**, not 2, still signed little-endian two's complement. The digital range
   widens from -32768..32767 to -8388608..8388607.

Nothing else moves. The fixed header is still 256 bytes, the signal header is still field-major and
still `ns * 256` bytes, and the record layout is identical. Only `bytesPerSample` changes, which
changes every byte offset into the data.

Decoding a 24-bit sample needs sign extension, which most languages won't do for you. The
trick is to load the three bytes into the top of a 32-bit word and shift back down:

```
value = ((b0 << 8) | (b1 << 16) | (b2 << 24)) >> 8
```

For example the bytes `c0 bd f0` decode to -1000000, and on a channel calibrated
-262144..262144 uV over the full 24-bit range that converts to -31249.9862 uV.

BDF+ exists too and works exactly like EDF+, except that its markers are spelled `BDF+C` and
`BDF+D` and its annotations channel is labelled `BDF Annotations`.

## EDF+ annotations and the TAL structure

EDF+ needed somewhere to put text events without changing the file layout, so it put them in a
signal. A channel labelled `EDF Annotations` occupies the same slot in every data record as any
other channel, has a `samplesPerRecord` like any other channel, and reserves
`samplesPerRecord * bytesPerSample` bytes per record. Those bytes aren't samples. They are UTF-8
text — or latin1, when the writer's idea of text was not UTF-8, which
[the annotations page](/docs/edf-plus-annotations#the-annotations-channel) goes into.

The text is a run of **Time-stamped Annotation Lists**, each terminated by a NUL byte, with the
remainder of the channel NUL-padded to fill the slot. One TAL looks like this:

```
+<onset>[<0x15><duration>]<0x14><text>[<0x14><text>...]<0x14><0x00>
```

Three control bytes do all the work:

| Byte | Name | Role |
| --- | --- | --- |
| `0x15` | duration separator | Separates the onset from an optional duration |
| `0x14` | text separator | Separates the timing from the text, and text from text |
| `0x00` | TAL terminator | Ends one TAL, and pads the rest of the channel |

The spec pads the remainder of the slot with `0x00`. Writers pad with spaces instead often enough that edf2csv treats a chunk of nothing but whitespace as padding rather than as an entry it failed to read — up to 0.5.93 a space-padded file holding one readable event was told two entries were lost, one per record. A chunk of anything else that does not parse is still counted and reported.

Onsets and durations are seconds relative to the start of the recording, written as decimal text.
The onset **must** carry an explicit sign, `+` or `-`. That isn't decoration: it's how a reader
tells a TAL from padding, and `edf2csv` rejects any chunk that doesn't start with one. A negative
onset is legal and means an event before the recording's nominal start.

The first TAL in every data record is special. It carries that record's own start time and no text,
and that's how an `EDF+D` file states where each record actually sits in time. In an `EDF+C` file
it's redundant but still required.

### A byte-level example

Here are the 60 bytes of the annotations channel in the first data record of a real EDF+ file:

```
2b 30 14 14 00
2b 30 2e 35 15 31 14 53 6c 65 65 70 20 73 74 61 67 65 20 57 14 00
00 00 00 ... (NUL padding to the end of the slot)
```

Reading it left to right:

```
2b 30                    "+0"            onset 0 seconds
14                       0x14            text separator
14                       0x14            second separator, so the text is empty
00                       0x00            end of TAL
                                         -> a timekeeping TAL: this record starts at 0 s

2b 30 2e 35              "+0.5"          onset 0.5 seconds
15                       0x15            duration separator follows
31                       "1"             duration 1 second
14                       0x14            text separator
53 6c 65 ... 20 57       "Sleep stage W" the annotation text
14                       0x14            text separator, ends the text list
00                       0x00            end of TAL

00 00 00 ...                             padding, not data
```

Which decodes to one record start of 0 s and one annotation: onset 0.5, duration 1, text
`Sleep stage W`.

A TAL with no `0x15` has no duration, and the duration is genuinely absent rather than zero. In a
different record of the same file the bytes `2b 31 2e 32 35 14 4c 69 67 68 74 73 20 6f 66 66 14 00`
read as `+1.25` then `Lights off` with no duration at all.

A TAL may also carry several texts after one onset, by repeating `<text><0x14>`. All of them share
that onset and duration. `edf2csv` emits one row per text.

Two behaviours are worth knowing. A malformed TAL is skipped rather than thrown, and the number
skipped is reported, because one bad annotation shouldn't cost you an entire conversion. And the
annotations channel is always read across the **whole** file, even when you asked for a time
window, because nothing in the spec obliges a writer to store an event in the record its onset falls
in and some tools put every annotation in the first record.

## Quirks worth knowing about

Real files break the spec in a small number of recurring ways. None of these are hypothetical; each
one has a fixture in the test suite because it was found in a public dataset first.

**Duplicate channel labels.** Labels are free text with no uniqueness rule, and public EEG datasets
ship recordings with two channels both labelled `T8-P8`. They are different electrodes; the label is
just wrong. `edf2csv` keeps both, disambiguates the columns with a `_ch<index>` suffix pointing at
the channel's position in the file, and tells you:

```
warning: 2 signals share the label "T8-P8" (positions 0, 1).
         Their columns are suffixed with the signal number so they stay
         distinguishable.
```

The two columns then appear as `T8-P8_ch0` and `T8-P8_ch1`. When you want one specifically,
`--channels` accepts `#0` and `#1` to address a channel by position rather than by name.

**A channel labelled with a single hyphen.** Some recordings contain a channel whose entire label is
`-`, usually a spare or disconnected input. It's a legal label, so it's preserved verbatim and the
column is called `-`. A completely empty label is different: it gets an `EMPTY_LABEL` warning and
becomes `signal_<index>`, since a nameless column is worse than an ugly one.

**A record count of -1.** The spec allows it for a recording still being written. The count is
derived from the file size instead, and you're told:

```
warning: The header does not say how many data records the file has (-1), which the spec allows
         for recordings still in progress. Using the 4 records the file actually contains.
```

**Truncated files.** A recording cut short leaves the declared record count at its original value
while the file holds fewer records. Because the count in use always comes from the file size, this
converts cleanly and you get a `RECORD_COUNT_MISMATCH` warning naming both numbers. If the file ends
part-way through a record, the incomplete tail is dropped and reported as `TRAILING_BYTES` rather
than being read as a short record full of garbage.

**Comma decimal separators.** Software built in a locale that writes `0,5` sometimes writes header
numbers that way, which the spec doesn't allow. A field with a comma and no dot is read as a
decimal point, and the file raises `COMMA_DECIMAL` so you can sanity-check the affected values in
`channels.csv`.

**NUL padding instead of space padding.** EDF says pad with spaces. Some writers pad with NUL bytes,
which ordinary whitespace trimming doesn't remove, and a parser that only trims whitespace ends up
unable to read the signal count of a perfectly good file. Both are trimmed here.

**Anything else in a numeric field.** A sign, digits, an optional fractional part and an optional
exponent are what these fields hold — the last of those because eight characters is not enough for a
magnetometer's range any other way, so `1e-16` is a physical bound real headers write. Nothing else
is read as a number, and that is narrower than most languages' own conversion: JavaScript's reads
`0x64` as 100, `0b1100100` as 100 and `0o144` as 100, which up to 0.7.43 meant a physical maximum of
`0x64` printed as `-100 to 100`, went into `channels.csv` as `physical_max,100`, and set the gain
every sample on that channel was scaled by. Those bytes are a byte-shifted or damaged header, and
they now raise `BAD_HEADER_FIELD` naming the field and quoting what was found.

**A header-bytes field that disagrees with the signal count.** Offset 184 should equal
`256 * (1 + ns)`. When it doesn't, the computed value wins (it's the one the layout actually
implies) and `HEADER_BYTES_MISMATCH` is raised.
