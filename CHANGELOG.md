# Changelog

Notable changes to edf2csv. Versions follow [semantic versioning](https://semver.org); while the
major version is 0, a minor bump may contain breaking changes.

## 0.2.33

## 0.2.33

### Fixed: `--stdout | head` ran out of heap on a large recording

0.2.30 stopped `edf2csv big.edf --stdout | head -1` from failing with `EPIPE`, and on a small
recording it did. On a large one it replaced a spurious error with a worse fault.

When the reader hung up, `flush()` returned immediately — before the two lines every other path
runs, which empty the buffer. Nothing else drained it, so the conversion carried on formatting
rows and appending them for the rest of the file. A 19 MB recording converting to 165 MB of CSV
grew a 1.3 GB working set, and under a 256 MB heap limit it aborted:

```
node --max-old-space-size=256 edf2csv huge.edf --stdout | head -1
→ FATAL ERROR: JavaScript heap out of memory
```

Two changes. `flush()` now discards the buffer when the reader has hung up. And the conversion
stops reading once every destination has hung up, rather than converting the rest of a recording
nobody is listening to. On that same file: peak memory falls from 1.3 GB to 85 MB, and the note on
stderr reports 71,200 rows instead of 10,000,000 — rows that reached the reader, not rows formatted
into a buffer that was thrown away.

The `--stdout` tests added in 0.2.27 could not have caught this. Their fixtures convert to a few
hundred bytes, which fits in the pipe buffer: every write lands, no hang-up ever happens, and the
bug is unreachable. A fixture that converts to 2 MB now covers it, and it fails against the 0.2.30
code as written.

## 0.2.32

### Fixed: two paths where a header could still reach the terminal raw

0.2.21 escaped control bytes in the `--info` table and in warnings, but two routes out of the tool
were left carrying them:

- **An unparseable start date.** When the date and time fields cannot be read, `--info` echoes them
  verbatim and marks them `(unparseable)` — so a file whose date field held `\x1b[2J\x1b[H` cleared
  the reader's screen while reporting that it could not read the date.
- **Fatal header errors.** These quote the channel label that caused them. A recording declaring a
  negative sample count under a label containing escapes cleared the screen on the way out, on
  stderr, at exit 1.

Both now go through the same escaping. Verified across `--info` and a conversion: zero raw control
bytes on either stream.

### Docs

Two claims in the API reference had drifted from the code: `decimalsForSignal`'s `max` was documented
as defaulting to 15 (raised to 20 in 0.2.13), and `describeFormat` was listed as returning four
strings when it returns six — a BDF+ file reports `"BDF+ (continuous)"` or `"BDF+ (discontinuous)"`,
its own spelling, even though `continuity` normalises to the `EDF+` form.

## 0.2.31

### Fixed: asking for more of a recording returned fewer annotations

0.2.4 stopped a plain conversion from dropping events that sit at or past the last sample — an
end-of-recording marker lives at exactly `duration`. But the filter used the window *after* it was
clamped to the recording, so any request that extended past the data collapsed back onto `[0, duration)`:

```
edf2csv edges.edf                 ->  2.5, 3, 3.5     (all three)
edf2csv edges.edf --end 999h      ->  2.5             two lost
edf2csv edges.edf --start 0       ->  2.5             two lost
```

Both of those mean "everything", and both returned less than asking for nothing at all.

Annotations are now filtered against the bounds actually given. An end the caller did not supply is
unbounded rather than "the end of the data", so `--end 999h` and `--start 0` behave like a bare run.
An explicit bound is unchanged: `--end 3` still keeps only the event at 2.5, because 3 is outside a
half-open `[.., 3)`.

## 0.2.30

### Fixed: `--stdout` piped into `head` reported a write failure

The most ordinary thing you would do with `--stdout` broke it:

```
$ edf2csv big.edf --stdout | head -1
time_s,ch1
error: Writing to stdout failed: write EPIPE
       The files written so far are incomplete and should not be used. Free up space or
       choose another destination with --out, then run the conversion again.
exit 1
```

Three things wrong at once — exit 1 for a routine shell idiom, a claim about files that were never
written, and advice about disk space and `--out` that had nothing to do with it.

`EPIPE` is the reader hanging up, not a write failure, and a file stream cannot raise it. The
buffered writer now treats it as a clean end: writing stops, the run exits 0, and whatever the reader
did take is intact. Genuine write failures — a full disk, an unwritable path — are unaffected and
still exit 1 with their message.

It needed handling in two places. The writer's `error` listener catches a pipe that closes during a
write; a separate listener, registered only while waiting for `drain`, sees one that closes while the
consumer is behind. Only the first was obvious, and a long conversion is precisely the case that
reaches the second.

## 0.2.29

### Docs: the scripting advice caught up with `--strict`, `--info --json` and `--stdout`

The CLI reference and recipes still told people to shell out to `jq` for things the last four
versions made single flags. Both now show the direct form first and keep `--json` for what it is
still the right tool for — reacting to a *particular* warning rather than to any of them:

```bash
edf2csv recording.edf --out ./converted --strict          # was: --json | jq '.warnings | length'
```

Two new recipes, both run against the real CLI before being written down:

- **Survey a directory without converting anything**, using `--info --json` piped through `jq -s` to
  get one row per recording — format, duration, channel count, distinct rates, estimated rows and
  warning codes. Nothing past the header is read for plain EDF and continuous EDF+, so it stays fast
  over multi-gigabyte files.
- **Pipe a conversion into another tool** with `--stdout`, including why a mixed-rate recording is
  refused and how `--channels` resolves it.

`ConvertOptions` in the API reference gained the `toStdout`, `startText` and `endText` fields it has
actually accepted since 0.2.18.

## 0.2.28

### Fixed: `--stdout --json` wrote two documents onto one stream

Both flags claim stdout, and 0.2.27 let them be combined. The result was the CSV immediately followed
by the summary object:

```
time_s,ch1,ch2
0.000,0.000,0.00000
...
{
  "output_dir": "-",
  "files": [ { "name": "signals.csv", "rows": 20 } ],
```

Parseable as neither, and silently so — each half looked correct on its own, so a pipeline reading
either one would fail somewhere further downstream with no obvious cause.

Passing both is now a usage error (exit 2) naming the conflict. Each flag alone is unchanged.

## 0.2.27

### Added: `--stdout` streams the CSV into a pipeline

The README has always named "a pipeline that speaks CSV" as a use case, but getting there meant
converting to a directory and then reading the file back out.

```bash
edf2csv recording.edf --stdout | duckdb -c "SELECT count(*) FROM read_csv('/dev/stdin')"
```

Only the samples are written — no `channels.csv`, `annotations.csv` or `metadata.json`, because a
stream holds one table. For the same reason the recording has to produce exactly one, and a
mixed-rate file is refused rather than merged:

```
error: --stdout needs exactly one table, but this recording produces 3 (its channels use 3 different sampling rates).
       Narrow it to one rate with --channels, or convert to a directory instead.
```

Merging them would mean inventing rows for the slower channels, which is the one thing this tool
exists not to do. Selecting channels that share a rate leaves one table and works.

Row count and warnings go to stderr, so stdout carries nothing but CSV, and the progress meter is
never drawn in this mode.

## 0.2.26

### Fixed: the README's option list had fallen behind the CLI

The README keeps its own, shorter option list rather than repeating `--help` verbatim, and nothing
checked the two against each other. `--strict` and the reworded `--json` both shipped in the last two
versions without it, and `--version` had never been listed at all.

All three are there now, and a test asserts that every flag `--help` accepts appears in the README.
It compares the *set of flags*, not the wording, so the README can stay friendlier than the help text
while a newly added flag can no longer be forgotten. Adding that test is what turned up the missing
`--version`.

## 0.2.25

### Added: `--strict` makes warnings fatal

Warnings describe the recording rather than a failure to convert it, so they have never changed the
exit code. That is the right default, but a pipeline that wants to stop on a truncated or
discontinuous file had to run with `--json` and parse the `warnings` array — which the documentation
said in as many words.

```bash
edf2csv recording.edf --strict || echo "check the warnings before using this"
```

Any warning now exits 1. **The output is still written**: a truncated file converts correctly for the
records that are there, and destroying that work would be the wrong response to a warning. The exit
code is the signal; the files are there to inspect.

It works with `--info` too, which makes it a cheap way to screen a directory for recordings that
need a closer look before anyone converts them.

## 0.2.24

### Added: `--info --json` describes a recording as JSON

`--info` answers "what is in this recording and what would converting it cost" — which is exactly
the question you want to ask across a directory of hundreds of recordings, and the aligned text table
is the wrong shape for that. `--json` previously applied only to conversions, so a script either
parsed the columns or converted files just to learn what was in them.

```bash
for f in /data/recordings/*.edf; do edf2csv "$f" --info --json; done \
  | jq -r '[.path, .duration_seconds, (.channels|length), .estimate.rows] | @tsv'
```

The document carries the format, start time, record layout, every channel with its calibration and
destination file, the row and size estimate, and the warnings. Field names match `metadata.json`
where the two describe the same thing, so a survey and a conversion can be read by the same code.

Warnings travel inside the document and stderr stays empty, matching how `--json` already behaved for
conversions. Plain `--info` is unchanged, warnings still on stderr.

## 0.2.23

### Fixed: a fractional record index read samples from the middle of a record

`readRecords({ startRecord })` computed its file position as `headerBytes + record * recordBytes`
without checking that the index was a whole record. A caller passing `1.5` therefore began reading
half a record in, and every sample after it was decoded from the wrong offset.

On the two-channel test fixture that returned channel 2's values under channel 1's signal — silently
wrong data through the public API, with the batch count coming back as `0.5` records:

```js
for await (const b of file.readRecords({ startRecord: 1 }))    // [10,11,12,...]  correct
for await (const b of file.readRecords({ startRecord: 1.5 }))  // [-10,-11,...]   channel 2's samples
```

`startRecord` and `endRecord` must now be whole numbers. Clamping silently would be no better: a
caller asking for record 1.5 has a bug worth naming rather than papering over. Whole-number bounds
outside the file are still clamped as before, so `startRecord: -5` and `endRecord: 99999` keep
working.

## 0.2.22

### One invariant now covers a whole class of bug

A test asserts that what a run *reports* matches what is actually on disk, across every generated
fixture in three modes: each reported row count against the real file, each `rate_groups` entry
against the real CSV header and decimal count, and `annotations_written` against `annotations.csv`.

Pieces of this have gone wrong before — two rate groups claiming one filename in 0.2.1, annotations
counted but not written in 0.2.4 — and each was caught only because someone looked at that particular
file. Checking the agreement directly means the next such disagreement fails the suite instead of
reaching a release. 96 tests now.

### Docs

The `--info` reference now states that control bytes in header text are printed as escapes rather
than sent to the terminal, and that `channels.csv` and `metadata.json` still record the field
verbatim — the behaviour introduced in 0.2.21.

## 0.2.21

### Fixed: a recording's header could drive your terminal

EDF identification fields and channel labels are free text copied verbatim out of the file, and
`--info` printed them straight to stdout. A header carrying ANSI escapes therefore reached the
terminal as escapes:

```
Patient    <ESC>[31m<ESC>[2J<ESC>[H OWNED <ESC>[0m
```

`\x1b[2J\x1b[H` clears the screen and homes the cursor, which is enough to hide the rest of the
output or repaint it as something else. Nobody writes an EDF header that way by accident, which is
precisely why a file that does should not be trusted with the terminal.

Control bytes are now shown as their escape (`\x1b[31m`) in the `--info` table, the `Patient` and
`Recording` lines, and any warning that quotes a label — so a corrupt field stays diagnosable rather
than being silently swallowed.

This is display only. `channels.csv` and `metadata.json` still copy the field verbatim, as documented,
and CSV quoting already made that safe: a label containing a carriage return was correctly quoted and
parsed as one column all along.

## 0.2.20

### Improved: the `--info` size estimate is closer, and never promises less than it writes

`--info` prints an estimated output size, which is the number people use to decide whether a
conversion is worth starting. Every cell was budgeted at `decimals + 6` bytes regardless of the
channel — six characters for a sign, integer digits and a decimal point, whatever the channel
actually held. Across the fixture set that ran 30–55% high, and on one file it ran 15% *low*, which
is the worse direction: the estimate promised less than the conversion wrote.

Cell width is now derived from the channel's own declared physical range, and the row includes its
real commas, newline and header. Across the same fixtures the worst deviation drops from 55% to 40%,
typical files land within 5–25%, and nothing under-estimates any more.

It still reads slightly high, because most samples sit well below their channel's maximum and print
shorter than the bound allows. For a size estimate that is the right direction to err in.

## 0.2.19

### Fixed: the window error quoted parsed seconds for `--end` too

0.2.18 made the past-the-end error quote `--start` as typed but left the other half of the same
message converting values back to seconds:

```
$ edf2csv recording.edf --start 00:00:05 --end 00:00:02
before:  error: The requested window ends at 2s, which is not after its start at 5s.
after:   error: The requested window ends at 00:00:02, which is not after its start at 00:00:05.
```

Both ends of the window are now quoted as given. `--duration` is deliberately excluded: the end is
computed from it rather than typed, so there is no original text to quote and the arithmetic result
is the honest thing to show.

## 0.2.18

### Fixed: a rejected `--start` was quoted back as a value you never typed

The past-the-end error reported the parsed offset in seconds rather than the text given:

```
$ edf2csv recording.edf --start 4h
before:  error: --start 14400s is at or past the end of this 2s recording.
after:   error: --start 4h is at or past the end of this 2s recording.
```

`14400s` is correct arithmetic and a confusing thing to read, because it is not what was on the
command line — the reader has to convert it back to check the tool understood them. Clock and
compound forms were worse: `--start 00:45:00` came back as `2700s`.

The message now quotes the value exactly as typed, for every accepted form. This also makes the
example in the CLI reference true, which had shown `--start 4h` all along.

## 0.2.17

### Fixed: a confusing error when the output path runs through a file

Creating the output directory reports the obstacle rather than the errno when a parent of the
requested path is a regular file:

```
before:  error: Cannot create "notes.txt/out": EEXIST: file already exists, mkdir 'notes.txt'
after:   error: Cannot create "notes.txt/out": "notes.txt" is a file, not a directory.
                Choose a destination whose parent directories are directories, with --out.
```

The old message named the parent under an `EEXIST`, which reads as "your destination already exists"
— the opposite of the actual problem, and a nudge toward `--force`, which would not have helped. This
came in with 0.2.6, where creating parents was split out from claiming the directory.

## 0.2.16

### Fixed: leftover output went unreported for two of the filename shapes this tool produces

`STALE_OUTPUT` warns when files from an earlier conversion are still sitting in the output directory
that this run did not rewrite — the guard against two runs being mistaken for one. It decides what
counts as its own output by matching filenames, and that pattern had fallen behind two recent
changes:

| filename | added in | recognised before |
| --- | --- | --- |
| `signals_256hz.csv` | — | yes |
| `signals_12_5hz.csv` | — | yes |
| `signals_0hz_2.csv` | 0.2.1 collision suffix | **no** |
| `signals_1_000e-7hz.csv` | 0.2.2 exponent rates | **no** |

`-` is not a word character and the collision suffix falls after the `hz`, so both fell outside
`[\w.]+hz`. Leftovers of exactly those two kinds — the ones produced by unusual recordings, where
mixing two runs together is hardest to notice — were the ones that went unreported.

The pattern now covers every shape the tool can produce, including a suffixed exponent rate. It still
requires a digit after the underscore, so a file of your own named `signals_notes.csv` is left alone.

## 0.2.15

### Fixed: a physical range too wide to represent was converted silently

EDF's physical range fields are eight ASCII characters and accept exponent form, so a header may
declare `-1e308` to `1e308`. The span of that range overflows a double, leaving no gain to compute —
but the scaler treated a non-finite gain the same as a flat one and returned the physical minimum,
so every distinct sample in the channel came out as the same 300-digit constant. No diagnostic was
raised, in `--info` or in `metadata.json`.

This is the same undefined-mapping case as `digitalMin === digitalMax`, and it now behaves the same
way: the cells are left empty and a new `UNUSABLE_PHYSICAL_RANGE` warning names the channel. A
genuinely flat range (`physicalMin === physicalMax`) is still a defined mapping and still writes its
constant.

## 0.2.14

### Changed: a repeated unit in a time value is now an error

`--start 1h1h` was accepted and summed to two hours. A repeated unit is a typo far more often than a
request, and summing it silently turned a slip into a plausible window of the wrong length — the sort
of quiet wrong answer this tool tries hard not to give.

Each unit may now appear once. `1h30m20s` and `1h30min` are unaffected; `1h1h`, `5m5m` and
`30s10sec` are rejected with a message saying so. Aliases collapse to the same unit, so `30m20min` is
caught as well.

## 0.2.13

### Fixed: the precision ceiling collapsed distinct samples on the finest channels

Decimal places are derived per channel so that two adjacent digital codes never round to the same
text — that is the invariant the whole precision rule exists to hold. The ceiling was 15, which the
comment beside it justified by pointing at channels calibrated in volts and tesla.

Tesla was in fact fine. Femtotesla was not, which is the unit MEG is actually recorded in: a channel
spanning ±1e-12 T over a 16-bit converter has a step near 3e-17 and needs 19 places, so at 15 it
printed **96 of every 100 adjacent codes identically**. Distinct measurements became the same string,
silently — exactly the outcome the rule is meant to prevent.

The ceiling is now 20, and `--decimals` accepts 0–20 to match. Adjacent codes stay distinct from
microvolts down to attotesla. Ordinary channels are untouched: a µV EEG channel still derives 3
places and a volt-scale channel still derives 9.

## 0.2.12

### Fixed: annotation channels were never pluralised

A file carrying more than one `EDF Annotations` channel — which EDF+ permits — reported
`2 annotation channel` in `--info`. The signal count beside it had been pluralised all along.

### Docs: five claims that no longer matched the tool

Corrected against the actual output rather than reworded:

- Four `--info` examples showed `Recorded 2019-11-04 22:15:00 UTC`. The tool prints no ` UTC`, and
  it should not: EDF stores a zone-less local wall clock, so labelling it UTC shifts it by the
  reader's own offset. That is the same bug fixed in `metadata.json` when the field was renamed to
  `start_datetime_local`; the `--info` examples and one paragraph of `edf-format.md` still carried
  the old claim.
- `--info ignores --annotations-only` was wrong in the other direction — it reflects the flag, so
  the estimate describes the command you actually typed. The docs now say so.
- The "reads the header only, returns in milliseconds" claims are now qualified: true for plain EDF
  and continuous EDF+, with EDF+D named as the exception where the annotation channel must be
  scanned to get the span right.
- `INPUT_OUTPUT_COLLISION` is a live `ConversionError` code and was missing from the API reference's
  enumeration.

## 0.2.11

### Fixed: `--info` read the annotation channel of every record

`--info` is documented as a header-only summary that returns immediately whatever the file's size.
It did read only the header for plain EDF — but on any EDF+/BDF+ file it also called
`readAnnotations()`, seeking into every data record in the file.

That work was then discarded. Record start times have to be read from the annotation channel only in
a discontinuous (EDF+D) recording; in a continuous one, record `n` starts at `n * recordDuration` and
the scan's result is thrown away. On a 12 MB, 20,000-record EDF+C it cost 0.29 s, scaling with record
count.

The scan now happens only for EDF+D files, where the span and row estimate genuinely depend on it —
that same file now reports in 0.059 s. Discontinuous recordings are unaffected and still report their
true span including gaps. This also matches the documented diagnostics table, which already stated
that `--info` cannot raise `ANNOTATION_DECODE_FAILED`.

## 0.2.10

### Fixed: very large values were written in exponent notation

`toFixed` switches to exponent form at 1e21, so a physical value at or above that landed in the CSV
as `1e+21` while every other cell in the column was plain fixed-decimal. A reader parsing that column
as decimal text has no reason to expect it.

It is reachable: EDF's physical range fields are eight ASCII characters and accept exponent form, so
a header may legitimately declare `1e30`. Such values are now expanded in full. Above 2^53 a double
carries no fractional part, so the expansion is exact rather than an approximation.

## 0.2.9

### Fixed: durations could print a time that cannot exist

`formatDuration` split the value into hours, minutes and seconds first and rounded the leftover
seconds afterwards, so a remainder just under a minute rounded up to a full 60 in place:

```
3599.9996 s  ->  "59m 60s"
86399.9999 s ->  "23h 59m 60s"
```

Rounding now happens to the printed precision before the split, so the extra second carries into the
minute where it belongs — `1h 00m 0s` and `24h 00m 0s`. A sweep of 400,000 durations produces no
impossible output. This affects the `Duration` line in `--info` and the recording length quoted in
error messages.

## 0.2.8

### Changed: a mistyped channel name is now an error under `--annotations-only` too

Channel selection was skipped entirely when `--annotations-only` was given, since the selection has
nothing to act on in that mode. The effect was that `--channels TYPO --annotations-only` exited 0 in
silence, while the same typo without the flag was a usage error — and `--channels ""` stayed an error
in both. A mistyped name was the one form of bad input the tool accepted quietly.

The names are now validated in both modes. Everywhere else in the tool a term matching nothing is
reported rather than ignored, and a flag that happens not to apply is a poor reason to make an
exception. Valid selections behave exactly as before, and `--annotations-only` output is unchanged.

## 0.2.7

### Fixed: a failed sidecar write reported a raw filesystem error

`channels.csv`, `annotations.csv` and `metadata.json` were written with a bare `writeFile`, so a
failure escaped as whatever the filesystem said and nothing else:

```
error: EISDIR: illegal operation on a directory, open '/path/out/channels.csv'
```

No hint, and — more importantly — no mention that the signal files had already been written, so the
output directory was left half-complete with nothing saying so. The signal writer has always
reported this properly; the three sidecars did not.

They now go through the same path, naming the file that failed and stating that what is on disk is
incomplete and should not be used.

## 0.2.6

### Fixed: two conversions into the same directory both succeeded and corrupted the output

The output directory was claimed by asking whether it existed and then creating it. Between those
two steps sat a window in which a second conversion also saw "not there" — so both proceeded, both
opened write streams on the same `signals.csv`, and both exited 0 having written one file between
them. Nothing reported a problem. The check that is supposed to stop a second run from mixing into
the first only worked when the two runs did not actually overlap.

The directory is now claimed with a single non-recursive `mkdir`, which the filesystem makes atomic:
exactly one caller creates it and every other gets `EEXIST` and takes the already-exists path. With
eight simultaneous runs, one succeeds and seven exit 1 with the usual message. Parent directories are
still created recursively, so `--out ./a/b/c` works as before, and `--force` is unaffected.

## 0.2.5

### Fixed: dense recordings ran out of memory before writing a row

The per-channel cache that maps a digital code to its formatted text allocated 65,536 slots
regardless of how wide the channel's declared digital range actually was — 512 KB of pointers each.
A 400-channel montage therefore needed over 200 MB of cache alone and died with a V8 out-of-memory
fatal error before producing any output.

The cache is now sized to the channel's declared digital range, which is 4,096 entries for the
ordinary 12-bit case: 32 KB instead of 512 KB, and roughly 13 MB instead of 205 MB across 400
channels. That same 400-channel file now converts under a 96 MB heap cap.

Samples outside the declared range still occur in non-conforming files. They miss the cache and are
formatted directly, producing identical text — every generated fixture converts byte-for-byte
identically to 0.2.4.

### Fixed: an empty channel made a single-rate recording look mixed

A channel declaring zero samples per record has a nominal rate of 0 Hz. It was counted alongside the
real rates, so a recording with one rate and one unused channel warned:

```
warning: Channels use 2 different sampling rates (4 Hz, 0 Hz).
```

claiming it was splitting output that it never split — only `signals.csv` was ever written. Channels
with no samples are now left out of the comparison. They are still reported separately as
`NO_SAMPLES`, and genuinely mixed recordings still warn.

## 0.2.4

Two silent data bugs in EDF+ annotation handling.

### Fixed: annotations outside the recorded span were dropped from whole-file conversions

EDF+ does not oblige an annotation's onset to fall inside the data. A marker for the end of a
recording sits at exactly `duration`, and files carry markers ahead of the first record. Because a
whole-file conversion resolves to the window `[0, duration)`, and annotations were filtered by that
window unconditionally, those events were dropped from a plain `edf2csv recording.edf` with no time
options given — and no flag could ask for them back. On a three-second test file carrying events at
2.5 s, 3.0 s and 3.5 s, only the first survived.

Annotations are now filtered only when a window was actually requested. Note the test is whether
`--start`, `--end` or `--duration` was passed, not whether the resolved window happens to cover
everything: `--end 3` on a three-second recording covers the whole file but is still an explicit
request for `[0, 3)`, so an event at exactly 3 stays outside it.

### Fixed: an unreadable timekeeping annotation could shift every sample in a record

The first TAL of each data record carries that record's start time. The decoder treated the first
TAL that successfully *parsed* as the timekeeping one, rather than the one in first *position* — so
when a record's timekeeping TAL could not be decoded, the next ordinary annotation was promoted in
its place and its onset became the record's start time.

In the test fixture that moved a record from 1.0 s to 1.5 s, shifting every sample in it by half a
second, with the only clue a generic "unreadable annotation entry" warning. The record now falls
back to contiguous timing and raises the existing warning naming it, which is what the rest of the
code already expected. The annotation is still exported as an event.

## 0.2.3

### Fixed: a closing pipe could report success for a failed run

The `EPIPE` handler set `process.exitCode = 0` unconditionally. Swallowing the error is right —
`edf2csv recording.edf --info | head -5` is not a failure — but forcing the code to zero meant that
if the pipe closed after the run had already failed, the failure was erased and the command reported
success for a conversion that never happened. The handler now swallows the error without touching
the exit code, so a real failure survives. Node still exits 0 on its own when nothing sets a code.

### Fixed: polarity inversion was detected by the wrong test

A channel's polarity is inverted when its gain is negative, and the gain is
`(physicalMax - physicalMin) / (digitalMax - digitalMin)` — so it depends on the sign of both spans,
not the physical pair alone. The check only looked at `physicalMax < physicalMin`, which was wrong in
both directions:

| digital | physical | gain | inverted | before | now |
| --- | --- | --- | --- | --- | --- |
| `-1000..1000` | `-100..100` | `+0.1` | no | silent | silent |
| `1000..-1000` | `-100..100` | `-0.1` | **yes** | **silent** | warns |
| `-1000..1000` | `100..-100` | `-0.1` | yes | warns | warns |
| `1000..-1000` | `100..-100` | `+0.1` | **no** | **warns** | silent |

A recording with its digital bounds reversed came back sign-flipped with no diagnostic at all, and
one with both pairs reversed drew a warning saying its polarity was inverted when it wasn't. The
test is now the sign of the gain, and the message names whichever pair is actually reversed. Sample
values are unchanged in every case — only the diagnostic was wrong.

### Docs

`correctness.md` claimed 83 tests (32/31/20) against an actual 88 (33/33/22).

## 0.2.2

### Fixed: very low sampling rates were reported as "0 Hz"

`formatRate` rounded to six decimal places, so any rate below 5e-7 Hz printed as `0`. That reads as
"this channel has no sampling rate", and it made the mixed-rate warning contradict itself — it
announced two different rates and then printed both as `0 Hz`:

```
warning: Channels use 2 different sampling rates (0 Hz, 0 Hz).
```

Rates that would round away are now shown in exponent form (`1.000e-7 Hz`), in the warning, in the
`--info` channel table, and in output filenames. Rates that already formatted sensibly are
untouched: `256`, `0.5`, `12.5` and `0.333333` all render exactly as before, and every generated
fixture except the pathological one converts byte-for-byte identically to 0.2.1.

## 0.2.1

### Fixed: two sampling rates could overwrite each other's output

Output filenames are derived from the sampling rate rounded to six decimal places, so two distinct
rates could resolve to the same name. Nothing checked for that, and both rate groups opened a write
stream on the same path — the resulting CSV held interleaved rows from both channels under a header
naming only one of them. Silent data loss.

Distinct rates now always get distinct files; a collision falls back to `signals_<rate>hz_2.csv`.
Ordinary recordings are unaffected and keep exactly the filenames they had.

Reaching this needs a record duration over about eleven days, since rates come from
`samplesPerRecord / recordDuration` and every channel shares that duration, so two rates can be no
closer than `1 / recordDuration`. Absurd, but the header format permits it, and the failure mode was
corruption rather than an error.

## 0.2.0

Two breaking changes, both about not putting things in front of users that they did not ask for.

### The package now has no dependencies

`@types/node` moved from `dependencies` to `devDependencies`, and every Node-only type was removed
from the published declarations. Raw bytes are typed `Uint8Array` instead of `Buffer`.

`npx edf2csv` downloads **424 KB instead of 3.1 MB**, and installs one package instead of three.

This also fixes type checking rather than only shrinking the install. Under `skipLibCheck: false`,
0.1.0 failed with four `Cannot find name 'Buffer'` errors *even when `@types/node` was installed*,
because the declarations referred to a global the consumer's own configuration had to supply.
A TypeScript project can now compile against edf2csv with no `@types` package at all.

**If you use the programmatic API:** `RecordBatch.data`, `annotationBytes()`,
`decodeRecordAnnotations()` and `parseHeader()` are typed `Uint8Array` now. `Buffer` extends
`Uint8Array`, and a `Buffer` is still what arrives at runtime, so existing code keeps working — but
if you called a Buffer-only method on one of those values, TypeScript will now tell you.

One trap worth naming: use `new Uint8Array(batch.data)` to copy a batch, not `batch.data.slice()`.
The declared type says `Uint8Array`, where those are the same, but the runtime object is a `Buffer`,
whose `slice()` is an alias for `subarray()` and returns another view of the same memory.

Internally, `Buffer.toString('latin1')`, `Buffer.toString('utf8')` and `Buffer.readInt16LE()` were
replaced by standalone implementations in `src/edf/bytes.ts`. These were verified exhaustively
against the Buffer methods they replace — all 65,536 byte pairs for the 16-bit read, all 256 values
for latin1 — and every generated fixture converts byte-for-byte identically to 0.1.0. No converted
value changed.

### A channel with no calibration is written as empty cells

When a header declares `digitalMin === digitalMax`, it has given the same calibration point twice,
so there is no digital-to-physical mapping and no physical value for any sample on that channel.

Those cells were previously written as the channel's physical minimum. A column of repeated numbers
is indistinguishable from a genuinely flat recording once the CSV is opened somewhere else, which is
the kind of invented data this tool exists to avoid. They are now written empty, which is the same
convention `annotations.csv` already uses for an absent duration, and reads back as `NaN` in pandas
and `NA` in R.

A `DEGENERATE_DIGITAL_RANGE` warning is still raised, and its wording now matches what happens.

**This is deliberately narrow.** `DEGENERATE_PHYSICAL_RANGE` — where `physicalMin === physicalMax`
over a valid digital range — is a different case: the mapping exists and is merely flat, so its
value is a real reading and is still written as a number. The `degenerate-range.edf` fixture now
carries both defects side by side so a single converted file shows the distinction.

## 0.1.0

First release. Converts EDF, EDF+ and BDF/BDF+ recordings to CSV, with a channel table, the EDF+
event list and a metadata file describing the run.

Channels recorded at different sampling rates are written to one file per rate rather than resampled
onto a shared grid, units are never converted, discontinuous (EDF+D) recordings keep their real
timing so gaps stay visible, and malformed files are reported rather than quietly producing
plausible output. Physical values are bit-for-bit identical to pyEDFlib.
