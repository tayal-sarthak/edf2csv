# Changelog

Notable changes to edf2csv. Versions follow [semantic versioning](https://semver.org); while the
major version is 0, a minor bump may contain breaking changes.

## 0.4.70

### Fixed: the website README described a base path the build does not use

It said the build writes `dist/` "with a relative base path, so it can be served from a
domain root or from a subpath such as GitHub Pages without changes." The base is `/`, and
`vite.config.js` says why in a comment right above it: documentation is prerendered into
`/docs/<slug>/`, and a relative base would send those pages looking for
`/docs/<slug>/assets/...` instead. Serving the build under `/edf2csv/` returns 404 for the
stylesheet and both scripts, so the page renders blank — which is a poor way to find out.

The README now describes the absolute base, the reason for it, and what deploying to a
subpath actually requires. A test reads the base out of `vite.config.js` and holds the two
in agreement, so changing one without the other fails.

## 0.4.69

### Added: `formatWallClock` is documented, and every export is checked to be

It was exported and mentioned nowhere, which matters more than a missing line. It is the
function that writes a recording's start time without a timezone, and the trap it exists to
avoid is one a caller falls into precisely because they did not know there was an
alternative: `startDateTime` is a UTC `Date` carrying the file's wall-clock digits so they
round-trip unshifted, and `toISOString()` on it appends a `Z` that asserts UTC. A reader
converting that to local time moves the recording by their own offset — 13:43:04 in the file
becomes 08:43:04 in New York.

A test now compares every name `dist/index.js` exports against api.md. Twenty-eight exports,
one of them undocumented, and nothing had been reading the list.

## 0.4.68

### Fixed: the landing page showed a timezone the format does not have

Its `--info` block read `Recorded 2002-03-02 23:10:00 UTC`. The tool prints no timezone,
deliberately — EDF stores local wall-clock digits and no zone at all, which is why the
metadata key is `start_datetime_local` and why the reader keeps `startDateRaw` beside the
parsed instant. A UTC suffix on the page arguing the tool is careful about exactly that was
the worst place to put one.

The comment above the block says every terminal and CSV sample on the page is real output
and nothing is a mock-up. Two of the three CSV samples had drifted from any recording that
exists, so the claim was half true. The recording is now described in that comment — five
signals plus annotations, 28800 records, the rates and ranges — and every block on the page
is the output of running the tool against it, regenerable by anyone who reads the recipe.

## 0.4.67

### Fixed: a documentation link pointed at a page the site does not serve

The site serves its pages under `/docs/`, and one link in warnings-and-errors.md — added in
0.4.42 — pointed at `/cli-reference#synopsis`. Every other internal link on the site uses the
prefix. The markdown rendered, the sentence read sensibly, and only a click found out.

The landing page also still showed 129,536 as the number of sample values checked against
pyEDFlib. 0.4.44 corrected that figure to 16,943 on the correctness page and nowhere else, so
the two pages disagreed by 7.6x about the tool's headline claim.

A test now walks every internal link in the content, checking the prefix, the page and the
heading it names, since a heading can be renamed without the links to it moving.

## 0.4.66

### Fixed: the source maps in the published package pointed at nothing

Every `.js.map` named `../src/cli.ts` and its siblings as their sources, and `src` is not in
package.json's `files`. So the maps shipped — 38 of them, 137 kB — and resolved to nothing
once installed: a stack frame inside edf2csv followed a map to a file that is not there and
fell back to the compiled output.

`inlineSources` puts the TypeScript into the map itself, which a debugger prefers over
fetching the path, so a frame now lands on the line that produced it. It costs 92 kB packed,
186.5 kB to 278.3 kB. A test walks every emitted map and fails if one names sources the
package neither ships nor carries.

## 0.4.65

### Fixed: the changelog stopped forty-five versions ago

This file records what each version changed, and its newest entry was 0.4.19 while the
package was at 0.4.64. Every release since had notes on GitHub and nothing here — in the one
place the repository presents as the record, and the one a reader without a browser has.

The forty-five entries are written from the commit messages, which were composed in this
file's voice and carry the same reproductions. Nothing is reconstructed from memory: each
entry says what its commit said.

A test now compares the newest heading here against the version in `package.json`, so the
file can fall behind by the release being prepared and no further. Two of the numbers on the
correctness page had drifted the same way and were caught the same way, twice; the difference
between a number that stays true and one that rots is whether something reads it.

## 0.4.64

### Fixed: the correctness page says how long its own suite takes

```
`npm test` ... runs the three test files ... It finishes in about a second on a laptop
```

There are six files and it takes about twenty seconds. Both halves drifted while the page's
test counts were being corrected twice, because those were the numbers a test was watching
and these were not.

Twenty seconds is not a regression, and saying so is the point: almost all of it sits in
three files that do expensive things on purpose. cli.test.js spawns the built binary as a
subprocess for every case and interrupts a thirty-file batch to watch it stop. large.test.js
builds and reads multi-gigabyte recordings. stdout-audit.test.js creates and mounts a disk
image so it can fill it up. The parser, the planning, the CSV contents and the documentation
checks together still run in about a second, which is the number the old sentence was
describing before those three arrived.

The file count is now checked, spelled out in words the way the sentence reads. The duration
is not: it is a property of the machine, and a test asserting a wall-clock figure fails on a
slow CI box for no reason anyone can act on.

## 0.4.63

### Added: the promise that the digital codes are recoverable is now checked

The FAQ says "the rounding recovers the original integer exactly, because the written
decimals are always fine enough to keep adjacent digital codes distinct", and prints the
arithmetic. It is the reason the tool offers no raw-digital output mode: the claim is that
you do not need one. Nothing checked it.

`npm run roundtrip` does — 12,096 cells over 756 combinations of digital and physical bounds,
EDF and BDF, each converted and then recovered with exactly the arithmetic the page prints.
Every one comes back as the code the file holds. Narrowing the derived precision by two places
makes it fail, so it is a check rather than a demonstration.

It also found two conditions the page did not state, both of which will bite someone.

Take the gain from channels.csv, not from what you believe the range to be. EDF's physical
bound fields are 8 characters, so a header asked for -0.000001 stores -0. The first version of
this harness computed the gain from the values it had passed to the writer and reported 620
failures, every one of them its own — the tool was right and the test was measuring its own
intent.

And leave --decimals alone. The promise is about the precision derived per channel; force a
coarser one and the codes stop being recoverable with nothing to indicate it. --decimals 0 on
a 256 Hz EEG channel gets 645 of 768 samples wrong. The page warned that flag would not give
you integers; it did not say it silently breaks the recipe printed below it.

## 0.4.62

### Fixed: the fallback for an inexact rate reaches far enough to do its job

A rate whose sample interval has no terminating decimal expansion falls back to, in the
comment's own words, "enough places to keep consecutive samples distinct". It stopped at
nine. At 3e10 Hz the interval is 3.3e-11, so nine places rounded every sample in a record to
the same timestamp — a column that cannot tell two samples apart is not keeping them
distinct, which is the one thing that branch exists to do.

Both halves of the function now reach fifteen: the search for an exact expansion, since
0.4.59, and the fallback. 3e10 Hz gets fourteen places and six distinct timestamps where it
had three.

TIME_RESOLUTION keeps a trigger, because a bound that nothing reaches is a warning nobody
maintains. It now takes a rate whose interval is finer than fifteen places can express —
3e15 Hz — which is nine orders of magnitude past anything that records biosignals, and the
fixture moved there so the warning still has something that raises it.

## 0.4.61

### Fixed: three things the FAQ told people that its own examples contradict

The digital-recovery snippet reads sleep-study_csv/signals.csv, from the recording the same
page opens by showing as a mixed-rate file whose 256 Hz channels land in signals_256hz.csv.
Two earlier snippets on the page read that name correctly. This one, the only snippet doing
arithmetic worth checking, pointed at a file that recording does not produce, so pasting it
gets a FileNotFoundError. It now reads the right table and says why, and running it against
mixed-rates.edf recovers the digital codes exactly — [0, 74, 147, 219, 290], which is what
the file holds.

The leftover-files section is headed "Why is there a leftover signals_256hz.csv next to my
new signals.csv?" and its example warning lists signals_128hz.csv and signals_1hz.csv. The
one file the reader came to that section about was missing from the message. The tool names
all three; so does the example now.

And the CSV size factor was given as four here and seven in recipes.md. Neither is a
constant: every row carries one time_s cell however many channels share it, so a 23-channel
256 Hz montage measures 4.3x while a single-channel recording of the same length is 10x.
Both pages now say that, and say what it turns on, rather than picking a number.

## 0.4.60

### Fixed: one recording's length stops being rendered two ways in one session

```
$ edf2csv rec.edf --info
Duration   6m 40s  (400 records of 1s)
```

```
$ edf2csv rec.edf --start 10m --out csv
error: --start "10m" is at or past the end of this 400s recording.
```

The message whose job is to say how long the recording actually is gave a bare number of
seconds, while --info gave the humanised form for the same file. On an overnight recording it
read "7950s recording", leaving the reader to divide by 3600 to judge whether their --start
was reasonable — which is the one question the message exists to answer. cli-reference.md has
documented it humanised since it was written ("2h 12m 30s"), a form no input could produce.

It now uses the same formatter --info does. The typed value keeps its quotation marks, since
that is the user's own text and should come back exactly as written, and a recording short
enough that the two renderings coincide is unchanged — which is the case the reference's
other example uses.

The neighbouring row in the usage-error table was stale in the other direction. Quoting the
window values was deliberate, added along with the quoting for --start, and only one of the
two adjacent rows was updated at the time. The table is maintained as exact strings, so the
row now carries the quotation marks the tool emits.

## 0.4.59

### Fixed: the time column is exact at 1024 Hz and 2048 Hz, which is what a BioSemi records

timeDecimals looks for the number of decimal places in which 1/rate terminates, so sample
times are written exactly and `time_s * rate` comes back a whole number. The search stopped
at nine places, and the comment beside it said "every rate in common use clears this — 256 Hz
needs 8 places, 512 Hz needs 9".

The next two powers of two do not. 1/1024 is 0.0009765625, which needs ten; 1/2048 needs
eleven. Both fell through to the rounding fallback and were written as 0.0009766 and
0.0004883 — precisely the behaviour the function exists to avoid, on the rates an ActiveTwo
records at by default.

The search now goes to fifteen places, which covers every power of two through 32768 Hz.
Fifteen and not more because the test has to stay exact: 10^16 is past 2^53, and
`Number.isInteger(10 ** 17 / 3)` is true, so a larger bound would claim a terminating
expansion for 3 Hz and ask for seventeen decimals of a number that repeats forever.

It also subsumes most of what 0.4.55 warned about. A 1e10 Hz recording terminates at ten
places, so it now gets a column that separates every sample rather than twenty rows sharing
three timestamps. TIME_RESOLUTION still has a real trigger — a rate above a gigahertz whose
expansion repeats, 3e10 Hz say — and a fixture now holds one, since a warning nothing can
raise is a warning nobody will maintain.

## 0.4.58

### Added: the header length the file claims is available beside the one that is used

api.md says "Every field is read straight from the 256-byte fixed header plus the per-signal
block. Nothing is normalised except where noted", and lists headerBytes with no note. It is
the one field that is computed rather than read: 256 for the fixed header plus 256 per
signal.

The computation is right, and has to be. Every data record offset is derived from it, a
writer that fills the length field in carelessly is common enough to have its own warning,
and believing the field over the arithmetic would put every sample at the wrong offset. What
was missing is the field's own value — which is a fact about the file, and is the thing
HEADER_BYTES_MISMATCH is comparing against.

`declaredHeaderBytes` now carries it, exactly as `declaredRecordCount` already carries what
the record-count field said. A caller auditing how a recording was written can see both; a
well-formed file has them equal, which is what makes the pair worth having.

## 0.4.57

### Fixed: the reference describes the inversion the code actually looks for

```
INVERTED_PHYSICAL_RANGE — A channel's physical minimum sits above its physical maximum
```

That is not the condition. The gain is (physMax - physMin) / (digMax - digMin), so what
inverts a channel is the sign of that fraction. Reversing exactly one of the two pairs makes
it negative; reversing both leaves it positive, and such a channel is not inverted at all.
The code has known this for some versions — its comment says warning on the physical pair
alone "was wrong in both directions" — and the page went on stating the version that was
wrong, in two places.

Someone matching on the described condition would raise a warning on a file with both pairs
reversed, which is correct data, and miss one with only its digital bounds reversed, which is
genuinely sign-flipped EEG. The page now gives the gain, a table of the three cases, and a
note that the message names whichever pair is actually reversed.

A fixture holds all three so the distinction is checked rather than described. Two of its
columns are constant, because the fixture writer clamps samples to the declared digital
range and a reversed range clamps every one of them to the same value — said so in the
fixture and in the test, since a constant column that looks like a converter bug and is not
one is worth labelling.

## 0.4.56

### Fixed: a channel with no samples stops being described as one nobody asked for

```
$ edf2csv rec.edf --info --channels unused
1  unused  unused  uV  0 Hz  -100 to 100  (not selected)
```

```
warning: Signal 1 ("unused") carries no samples at all (0 per data record).
```

The channel named on --channels was reported as not selected, in a table printed directly
above a warning explaining why it has nothing to contribute. It was selected; the file gives
it nothing. The column now says "(no samples)", which is true whether or not it was asked
for, and a channel that does carry samples and was not chosen still reads "(not selected)".

The conversion had the same gap from the other side. Selecting only such a channel leaves no
table to write, so the run produced channels.csv and metadata.json and no signals.csv —
while output-files.md says signals.csv is written unless --annotations-only was passed.
Nothing accounted for the missing file. It does now, and the page carries the exception.

Same shape as 0.4.51: a report describing what it measures rather than what the run did.

## 0.4.55

### Fixed: the slack at a window boundary stops being wider than the samples

Deciding which samples fall inside a requested window used a flat nanosecond of slack,
applied whatever the sampling rate. A nanosecond is far below any real interval — 20 kHz is
50 microseconds — but the format does not oblige it to be: EDF's record duration is an
8-character field that accepts 1e-9.

A recording of two 1 ns records holding ten samples each wrote ten of its twenty rows. The
window ends at 2e-9, the comparison asked for `time < 2e-9 - 1e-9`, and the whole second
record failed it. Exit 0, no warning, half the samples gone.

Slack that reaches the next sample is not slack, so it is now capped at half a sample
interval. Same lesson as 0.4.45: a constant chosen for one scale is a bug at another, and the
scale that matters is what the recording can express.

Fixing that exposes the other half. Sample times are written to at most nine decimal places,
so above a gigahertz the column repeats — those twenty rows carry three distinct times.
Nothing is lost, and every sample is written in order, but `time_s` stops identifying a row,
so joining or plotting on it collapses samples that are genuinely distinct. TIME_RESOLUTION
now says so and points at the row number instead. No shipped fixture raises it, and the
whole fixture set was checked to be sure.

## 0.4.54

### Fixed: the row buffer is emptied when it fills, not when the record ends

BufferedLineWriter exists to hold a bounded amount of formatted text, and the loop drained it
once per data record. Within a record nothing emptied it, so memory followed
samples-per-record rather than the buffer's own threshold.

```
16,000 records of 1,000 samples   ->  283 MB CSV, converts under a 256 MB heap
1 record of 16,000,000 samples    ->  JavaScript heap out of memory
```

The same 32 MB of samples either way. The format allows both layouts and says nothing about
which to expect: samples-per-record is an 8-character field, and a writer that puts an entire
recording in one record is producing a legal file.

The buffer is now emptied wherever it fills. `full` is a synchronous read of the pending size,
so the twenty million rows that are not at a boundary cost a comparison rather than a
microtask each — a 92 MB conversion times the same as before.

The test caps the heap at 256 MB, because without a limit the machine's own memory lets the
old code through and the test becomes a demonstration of nothing.

The FAQ said one thing scales with the recording. Two do, and neither is its length: the
annotation list, and one record held whole while it is read. Both are now named there.

## 0.4.53

### Fixed: a data record larger than one read no longer takes the process down

```
$ edf2csv rec.edf --out csv
node[87678]: void node::fs::Read(...) at ../src/node_file.cc:2632
Assertion failed: args[3]->IsInt32()
----- Native stack trace -----
$ echo $?
134
```

Nothing written, and exit 134 — which is none of the three codes this tool documents. Worse
through the library: the assertion is raised in C++, not thrown, so neither a try/catch
around readRecords nor an uncaughtException handler ever runs. A consumer's whole process
goes down with it.

A record is read in one call when it exceeds the chunk budget, there being nothing smaller to
divide it by: a record is the unit the format is addressed in. EDF's samples-per-record field
is 8 characters, so eleven channels at 99,999,999 samples make a record of 2,199,999,978
bytes — and a long record duration at ordinary rates reaches the same place. `fs.read` takes
a length that must fit in a signed 32-bit integer, and asserts rather than throwing when it
does not.

readFully already looped to handle a short read, so the fix is to cap what it asks for at a
gigabyte and go round again. The 2.2 GB record now converts in 1.2s. The boundary is exact,
so the test checks both sides of it: 2,199,999,978 bytes must convert, and 2,134,000,000 —
which always worked — must keep working, since a fix that refused large records rather than
reading them would pass the first and fail the second.

The FAQ said memory does not scale with the recording, with the annotation list as the one
exception. There is a second: one record is held whole. It is now named there.

## 0.4.52

### Added: the metadata.json the documentation prints is checked against one a conversion writes

output-files.md prints a whole metadata.json as its explanation of the format, and that
transcript is what someone reads before writing code against it. A key added to the record
and not to the page reads as a key that does not exist; one removed reads as a key they can
rely on. api.md had exactly that happen to its `window` object, which lost two fields for
several versions before an audit noticed — and the only reason this record has not is that
nobody has changed it lately.

The docs test now converts a fixture and compares the key structure of the result against
the sample on the page. The shape, not the values: the sample describes an eight-hour sleep
study that is not in this repository, and rewriting it to match a two-record fixture would
make it a worse explanation of the format, which is what it is there for.

The fixture is the discontinuous one, chosen so every part of the record the page shows is
populated — it raises a diagnostic, so `notes` is not empty, and carries annotations, so the
annotation fields are real. An empty array cannot say what its entries look like, and that is
the half of the shape worth checking.

Confirmed capable of failing: deleting one key from the sample fails the test.

## 0.4.51

### Fixed: --info stops promising nothing for a run that writes a file

```
$ edf2csv annotations.edf --info --annotations-only
Would write 0 rows, roughly 0 B.
```

```
$ edf2csv annotations.edf --out csv --annotations-only
Wrote csv
  annotations.csv  3  rows
  channels.csv     1  rows
```

The estimate describes the signal tables, and under --annotations-only there are none, so
zero was true of what it measures and false of the run. --info exists to say what a
conversion will do before you commit to it; asserting it will write nothing, when it will
write a file, is the one thing it must not do.

How many events there are cannot be answered from the header — the annotation channel has to
be read record by record, which is the scan --info exists to avoid. So it names the files and
says the count is not knowable this cheaply, rather than inventing a zero:

```
Would write annotations.csv and channels.csv, and no signal data. How many events there
are cannot be told from the header.
```

A recording with no annotation channel is told that instead, since it gets no annotations.csv
at all. An ordinary --info is untouched, --gzip keeps its "before compression" note, and a
test that had encoded "Would write 0 rows" as correct is replaced by one that checks the run
it describes really does write three events.

## 0.4.50

### Added: what --info predicts is checked against what a conversion writes

Two promises live in that one line, and they are not the same promise. The row count is
arithmetic on the header, so a conversion doing the same arithmetic has to land on the same
number — close is wrong. The byte count is documented as an approximation, and the direction
it errs in is the whole point: people read it to decide whether they have room, so reading
low is a defect even though "approximate" would excuse it.

Neither had anything checking it. `npm run estimate` crosses every fixture with every option
combination — 192 predictions over 34 recordings — and asserts the row count exactly and the
byte count as a bound. Sizes read 20% high on average, which is the side to be on.

It found the header row being measured as the raw labels rather than as the line that gets
written. A column name is quoted when it contains a comma, a quote, a newline or an edge
space, and every quote inside it is doubled; three channels labelled `a,b,c,d,e`, `x"y` and
`plain` write a 32-byte header and were budgeted 27. EDF labels are free text, so commas in
them are ordinary. csvRow writes that line, so csvRow now measures it — nothing else is in a
position to stay right when the quoting rules change.

The sweep carries no allowlist. There is a case the estimate cannot bound — a recording whose
samples fall outside the digital range its own header declares — but no fixture does that, and
an exemption nobody has to earn is how a regression gets in wearing the name of a known case.

## 0.4.49

### Fixed: two names a macOS filesystem makes one are refused, not merged

The guard that refuses two recordings landing in the same directory case-folded and stopped
there. HFS+ and APFS fold Unicode normalisation as well, so `café` written as e + U+0301 and
`café` written as U+00E9 are one directory — while remaining two different JavaScript
strings, which is all the guard compared.

```
study/café.edf   (NFC)  ->  csv/café/signals.csv
study/café.bdf   (NFD)  ->  csv/café/signals_256hz.csv, _128hz, _1hz
```

One directory holding two recordings, under a single metadata.json naming one of them,
reported as "Converted 2 of 2 recordings" and exit 0 under --force. The extensions differ,
which is what lets both files exist while their stems collide.

Without --force the second conversion happened to hit "already exists" — the accidental save
rather than the check doing its job, and it named the wrong problem: a directory in the way,
rather than two recordings claiming one name. It now says what is actually wrong, before
anything is written, with or without --force.

Folded only on darwin. On Linux those are genuinely two directories and refusing them would
be inventing a collision that is not there; Windows preserves normalisation too. That is the
same platform-shaped assumption the case fold already made, and it keeps the same limit — a
volume that normalises while the running platform does not is covered by neither.

## 0.4.48

### Fixed: the read buffer is the size of the data, not the size of the budget

`chunkBytes` is a ceiling on how much to read at once. The buffer was however many records
would fit in it — whether or not the file had that many.

```
a 848-byte fixture, 2 records, read with a 512 MB budget
  allocated 536,870,880 bytes
```

and every ordinary read of a small recording reserved the full 8 MB default for a file that
might be a tenth of a kilobyte. Nothing was wrong with the data; the memory simply had
nothing to do with it. A batch of five hundred short recordings paid it five hundred times.

Bounded now by what is actually going to be read, so the fixture above allocates 80 bytes and
a windowed read of two records allocates two records. Large files are untouched: their record
count exceeds what the budget allows either way, so the budget is still what decides.

The samples cannot move, and are checked not to: the same five recordings read with a
one-byte budget, a one-megabyte budget and a 512 MB budget produce identical sample
sequences. The suite already held that check for two of those; this adds the third.

## 0.4.47

### Fixed: two ways a batch still depended on things the command did not say

--out went back to meaning the output directory itself when a named folder turned out to
hold nothing.

```
edf2csv study named.edf --out csv     study holds recordings  ->  csv/named/signals.csv
edf2csv blank named.edf --out csv     blank holds none        ->  csv/signals.csv
```

0.4.20 took this decision off the recording count, and the flag it left behind answered "did
any input come from a directory" rather than "was a directory named" — the same question
only when the directory yielded something. So whether an unrelated folder happened to
contain anything decided where a different recording's output went, silently, exit 0. It is
now decided by what was named, which is what 0.4.20 said it was.

And a child was handed its options as two arguments each, so a value beginning with a dash
became another option in the child's parser:

```
edf2csv study --out ./-nightly            converts
edf2csv study --out ./-nightly --jobs 2   Option '--out' argument is ambiguous.
```

The same command, converting everything one way and nothing the other. A leading dash is not
exotic — path.join produces one from a folder given as `.`, and directories get named after
dates and flags. 0.4.19 fixed this for the recording's own path with a `--` separator; every
option that carries a value had it too, and they now go over as `--flag=value`, which cannot
be misread. Serial and parallel produce identical bytes with such a destination.

## 0.4.46

### Fixed: --info and the conversion agree again about where a recording starts

0.4.41 taught a conversion to take a continuous recording's origin from whichever record
first states one, so a single unreadable timekeeping entry no longer costs the file its
position. --info was left reading record 0 and stopping there, so from that version the two
halves of the tool described the same file differently.

```
$ edf2csv rec.edf --info --start 3
error: --start "3" is at or past the end of this 3s recording.
```

```
$ edf2csv rec.edf --out csv --start 3
Wrote csv
  signals.csv  2  rows
```

--info found nothing at record 0 and reported a recording starting at zero; the conversion
took the origin from record 1 and timed it from 0.5s. The flag exists to tell you what a
conversion will do before you commit to it, so disagreeing with the conversion is the one
thing it must not do.

It now reads on past record 0 until a record states its own time, up to sixteen of them.
Continuity is what makes that cheap and correct: record i beginning at t puts the origin at
t - i * duration, so any one of them settles it, and sixteen small reads keep --info a header
read rather than the per-record scan it was deliberately spared. On the 205 KB fixture it
still returns in 0.05s.

readFirstRecordStart is now readOrigin, since it returns the recording's origin rather than
one record's start. It was never documented.

## 0.4.45

### Fixed: an ordinary recording stops being accused of contradicting its own continuity

0.4.41 added a check that an EDF+C file's records sit where continuity puts them, and wrote
it as an equality between two doubles. They are not equal. A recording of 0.1s records
sitting at 0.1, 0.2, 0.3 ... is contiguous by construction, and 0.1 + 2 * 0.1 is
0.30000000000000004.

```
warning: This file is marked continuous (EDF+C), but 2 of its 8 data records say they
         start somewhere other than where continuity puts them.
```

On a file with nothing whatever wrong with it — and under --strict, a failed run. Fractional
record durations are ordinary; the format has an 8-character field for exactly that.

The comparison is now against what the recording can express: one sample of its fastest
channel is the shortest span it distinguishes, and anything below half of that is arithmetic
rather than a gap. canCarry already refuses origins where the double spacing swamps that
interval, so the representation error is under the tolerance by construction rather than by
hope — the two checks now share the same notion of "the finest thing this file can say".

A record that really is somewhere else is still caught: a file marked EDF+C whose records
jump from 1.5s to 10.5s reports one of three.

Shipped three versions ago and mine. The lesson is the ordinary one about comparing computed
floating point for equality, which is why the fixture that catches it is now in the suite in
both directions.

## 0.4.44

### Fixed: the numbers the documentation prints are numbers this repository produces

Five figures, each verified by running the thing that produces it.

The --info footer said "roughly 27.4 KB" on two pages where the tool says 22.2 KB, and
api.md printed estimate.bytes of 28095 against an actual 22749. The estimate changed and the
transcripts did not.

The convert() example in api.md was wrong three ways in one block. Its `window` object had
lost `recordingStartSeconds` and `recordingEndSeconds`, added to ResolvedRange since. Its
estimate said 6165 against an actual 5172. And its warning read "3 different sampling rates
(256 Hz, 128 Hz, 1 Hz)" for a call that selects two channels at two rates — where the prose
directly below it says "Two channels were requested at two different rates". That is the
0.4.x change making the mixed-rate warning describe the conversion rather than the file, and
the sample output was never updated, so the page contradicted itself in adjacent lines. The
note explaining why it is two rather than three is now there.

And the correctness page's test counts, wrong again: 179 against 197, having been 148 against
179 before 0.4.34 corrected them. So this time the docs test checks them — per file, against
the summary, and against the prose that repeats the total. It caught its own new test on the
first run, which is what it is for.

## 0.4.43

### Added: the documentation's lists are checked against the source's

Four times in the 0.4 line a new diagnostic shipped and one of the three places that
enumerate them was not updated — the table in warnings-and-errors.md, the code list in
cli-reference.md, the block in api.md. Nothing failed, because nothing checked. The lists
are prose, and prose does not compile.

Now a test reads both directions: every code in the source is named on all three pages, and
every code the pages list exists. Same for the conversion error codes against api.md, every
flag in --help against the README and the reference, and the set of exit codes against the
table that explains them.

It reads the three enumerating constructs rather than sweeping the pages for upper-case
words, because those are also --info column headings, errno names and the format's own
vocabulary — a check that caught those would need an allowlist that grows with the prose,
which is the kind of test people delete.

On its first run it found NONSTANDARD_UNIT declared in DiagnosticCode and named on two pages
out of three. It has been dead since 0.1: reserved for a physical dimension outside the set
the spec recommends, never raised, and a warning on every unusual unit would fire on most
real recordings, which is presumably why. 0.4.37 took the other dead code, NONPRINTABLE_LABEL,
and implemented it. This one is removed instead, so the type stops offering a value nothing
can produce and the reference loses its "codes that exist but are never raised" section
along with the last thing in it.

Nothing that ever occurred at runtime changes: no conversion could produce that value.

## 0.4.42

### Fixed: the reference stops describing a version of the tool that no longer exists

```
The input path must be a regular file that can be read. A directory, a missing path or
a special file is a file error (exit 1), not a usage error.
```

Every clause of that is wrong for a directory, and has been since folders became inputs. A
folder of recordings converts and exits 0. A folder holding none exits 2, not 1. The exit-1
list said the same thing a second time — "the input can't be read: ... it's a directory" —
and the UNREADABLE section printed an example the command line cannot produce.

That last one is worth keeping rather than deleting: `EdfFile.open` does still refuse a
directory, because the library takes one recording and a directory is not one. What changed
is that the CLI expands a directory before it gets there. The section now says which of the
two you are looking at.

A page that describes the wrong tool is worse than a page with a gap in it — the gap sends
you to try it, and this sent you to conclude the feature was not there. A test pins the
contract in all four of its parts: a folder converts, an empty folder is 2, a missing file
is 1, and the library still refuses a directory.

## 0.4.41

### Fixed: one unreadable timekeeping entry stops costing a recording its origin

The EDF+C origin came from recordStarts[0] and nowhere else. When that one entry could not
be decoded, the whole file was timed from zero — while records 1 and 2, saying plainly that
they begin at 1.5s and 2.5s, went unread.

A recording whose records sit at 0.5s, 1.5s and 2.5s came out with every sample half a
second earlier than the file states, against annotation onsets that kept their true values,
so an event at +0.75 fell between rows. That is exactly the mismatch 0.4.9 fixed, arriving
through the one hole left in it — and the byte-identical EDF+D twin timed it correctly,
which is what gives it away.

Continuity is what makes it recoverable: record i sits at origin + i * duration, so any
readable record fixes the origin for all of them. The EDF+D fallback for a record with no
readable time now starts from that origin too, rather than assuming zero, so the twins agree
about record 0 as well.

Two things fall out of reading the other records. A file marked EDF+C whose records say they
sit somewhere other than where continuity puts them is now reported rather than quietly
timed as contiguous. And a timekeeping entry is counted apart from the events, because
calling it an annotation that "could not be exported" was wrong twice: a file with one bad
timekeeping entry and three good events reported one entry lost while exporting all three,
and never mentioned the timing that had actually gone. The EDF+D path keeps its own
per-record message, which is more specific; saying both would report one problem twice.

## 0.4.40

### Fixed: a --stdout failure stops describing files it never wrote

```
error: Writing to stdout failed: ENOSPC: no space left on device, write
       The files written so far are incomplete and should not be used. The destination
       is out of space; free some up or choose another with --out.
```

Both halves of that hint were written for --out. There are no "files written so far" on this
path — the conversion writes to a stream the shell redirected — and --out is the flag whose
absence is the reason the message exists at all. Someone following it goes looking for a
partial directory that was never created, and is pointed at a mode they deliberately did not
use.

It now names what there actually is:

```
What reached stdout before it failed is incomplete and should not be used. The
destination is out of space; free some up or redirect it somewhere else.
```

Same class as the disk-space hint 0.4.36 replaced, one flag over: advice that fits one path
being given on another. The --out wording is untouched, and every errno keeps the sentence
0.4.36 gave it.

## 0.4.39

### Fixed: --stdout stops reporting success for bytes that never arrived

```
$ edf2csv long-stream.edf --stdout > /Volumes/small/sig.csv
Wrote 102,400 rows to stdout.
$ echo $?
0
```

94,977 rows on disk. The file ends mid-row at "371.00390625," with no trailing newline,
150,904 bytes short, and the line on stderr overstates the count by 7,423 rows. The same
recording onto the same volume through --out fails correctly — exit 1, ENOSPC named — which
is what gives it away.

POSIX write returns a short count rather than an error when the filesystem fills partway
through a single call; only the NEXT write raises ENOSPC. --out always has a next write,
since channels.csv and metadata.json come after the samples, so it always finds out.
--stdout has nothing after it. And when fd 1 is a regular file, Node's stdout is a
SyncWriteStream whose _write discards the count writeSync returns, so no error is raised at
all — which means checking the stream's recorded failure would not have caught it either.

What can be checked is the descriptor: how much it grew against how much it was handed. Only
for a regular file, since a pipe or a terminal has no size to compare and cannot lose a
write this way without saying so; appending with >> is fine, because the starting size is
taken first. Under --gzip the bytes counted are the compressor's output rather than the
CSV's, since those are what stdout is given.

Two guards keep it off the healthy paths: the audit declines anything that is not a regular
file, and it is skipped entirely when the reader hung up, because `--stdout | head -1` is a
shell idiom and not a failure. Reporting a failure for a command that worked would be worse
than the bug.

BufferedLineWriter.end() also returned early for stdout without consulting the failure the
stream's error listener had recorded, so an error not yet surfaced by a later flush was
dropped. It looks now.

This is a narrower window than "any full disk": when an earlier flush crosses the boundary a
later write does raise ENOSPC and that was always handled. It is the case where the output
very nearly fits.

## 0.4.38

### Fixed: the library stops blaming the destination for the caller's own failures

Two places where an answer came from the wrong layer.

`changedSinceOpen` returned false on a closed file. `convert` closes the file before it
returns, so `result.file.changedSinceOpen()` denied the very change the INPUT_CHANGED
diagnostic in the same result object had just reported — one object, two answers. False is
not something a closed descriptor can know. It now remembers the last answer it computed,
and `convert` always asks on the way out, so the result agrees with itself. A file closed
without ever being asked throws instead of guessing.

A progress callback that threw came back as

```
ConversionError WRITE_FAILED: Writing to "out" failed: caller bug
The files written so far are incomplete and should not be used. Check the destination
and run the conversion again.
```

The destination was working perfectly; the caller's own callback threw. onProgress ran
inside the same try that turns a stream failure into WRITE_FAILED, which is the same
misattribution the write hints carried until 0.4.36, one layer up. It now raises
CALLBACK_FAILED naming the callback, keeps the original as `cause` so the stack that matters
survives, and still stops the conversion — writing on into a directory whose owner has just
failed is not an improvement. A ConversionError that arrives at the outer catch already
saying what went wrong is passed through rather than wrapped a second time.

Found by an auditor looking at the library surface; a third report from the same pass — a
raw ENOENT escaping when the input is deleted mid-run — did not reproduce, since an open
descriptor outlives both unlink and rename.

## 0.4.37

### Fixed: a label made of control characters is reported instead of passed on in silence

NONPRINTABLE_LABEL has been declared in the source and documented as reserved since 0.1.
Nothing raised it.

`--info` has escaped control bytes since it was written, on the reasoning that an ANSI
escape in a header can drive the reader's terminal — \x1b[2J clears the screen, which is
enough to hide the rest of the output. The CSV had no such protection and needs none for
correctness: quoting makes any byte safe for a parser, and passing the label through exactly
as the file has it is the right call, since losing what the header says is not an
improvement.

What was missing is the sentence saying so. A recording whose channel is labelled
\x1b[2Jgone converted with no warning at all, and `cat signals.csv` then cleared the
terminal — while a script referencing that column by name carried an invisible control
character in it. The two halves of the tool disagreed about whether this was worth
mentioning.

Now every affected channel gets a warning naming the bytes, escaped, and saying to address
it by position with --channels "#N" since the name cannot be typed. Tab is included: it is
harmless to a terminal but it makes a column name nothing can match reliably. Nothing is
rewritten — the label still reaches the CSV as the file has it.

That leaves NONSTANDARD_UNIT as the only code still declared and never raised, and the
documentation now says so rather than saying two.

## 0.4.36

### Fixed: a failed write says what went wrong, not "free up space" every time

Every write failure carried one hint: "Free up space or choose another destination with
--out". That fits exactly one errno. A directory sitting where signals.csv belongs produced

```
error: Writing to "csv" failed: EISDIR: illegal operation on a directory, open "csv/signals.csv"
       The files written so far are incomplete and should not be used. Free up space or
       choose another destination with --out, then run the conversion again.
```

and so did a read-only volume, a permission denial, a path too long for the filesystem, and
running out of file descriptors. Wrong advice is worse than none: it sends someone to check
`df` on a disk that is fine, while the thing that actually failed stays unexamined.

The errno is the one part of the failure that names the cause, so it is what picks the
sentence now — out of space, over quota, no permission, read-only, a directory in the way,
a path that vanished, a name too long, too many open files (which a recording with many
sampling rates can reach, since it opens one output file per rate, so --channels narrows
it). Anything unrecognised keeps the general form rather than guessing.

What does not change is the part that matters: whatever the cause, the files written so far
are incomplete and must not be used.

## 0.4.35

### Fixed: a window that lands where there is no data says so

`--start` at or past the end of the recording is a usage error and stops the run. This is
the narrower case it leaves behind: a window that lies inside the recording but selects
nothing. Between the last sample and the nominal end of the last record —

```
edf2csv tiny.edf --start 1.95 --out csv
```

— or, on a discontinuous file whose records sit at 0s, 1s and 10s, anywhere in the eight
second gap:

```
edf2csv study.edf --start 2 --end 10 --out csv
```

Both produced a signals.csv holding its header and nothing else, exit 0, no warning, and
--strict passing. That is exactly what a successful extraction of an empty range looks like.
The summary does print "signals.csv 0 rows" and --json carries rows: 0, so it was not
invisible — but everywhere else that a request produces nothing, this tool says so: a
--channels term matching nothing is an error, and --annotations-only on a file with no
events raises NO_ANNOTATIONS.

EMPTY_WINDOW now covers it, quoting the window back and pointing at --info to see where the
records really sit. A warning rather than an error, because a batch of five hundred
recordings should not stop for the one whose gap lines up with the window; --strict makes it
a failure for those who want that.

The paths that write no signal table by design are left alone: --annotations-only, and a
file whose only channel carries annotations.

## 0.4.34

### Fixed: the correctness page states numbers this repository can produce

Five things had drifted apart from what the commands actually print.

```
"Three separate claims", followed by five numbered ones. The list grew as the batch and
fuzz harnesses were added and the heading did not.
```

```
"4,000 runs over 1,000 corrupted recordings" for `npm run fuzz`, which does 1,200 over 300
at its default seed. The larger figure is reachable — `npm run fuzz -- 42 2000` — so the
page now says which is the default and how to ask for more.
```

```
"ℹ tests 148" and a per-file table adding to 148, against a suite of 179. The table is
regenerated from what the files hold: 35, 59, 85.
```

```
129,536 sample values in the README's accuracy section, a number from a recording set that
is not in this repository. Both places now say 16,943 across the 75 recordings that are.
```

```
The README put `npm test` under the pyEDFlib claim, and `npm test` has never run that
check — it is deliberately kept out so the package can stay dependency-free. It now shows
`pip install pyedflib && npm run crossvalidate`, which is the command that does it.
```

A number nobody can reproduce is worse than no number, on a page whose subject is what has
actually been verified.

## 0.4.33

### Fixed: the library checks its options too, before anything is written

The command line has always rejected these values — `--decimals 1.5` is a usage error and
always has been — and the library did not, so the same value behaved differently depending
on how it arrived:

```
decimals: NaN   resolved successfully, having written whole numbers into a column the
                caller had asked for decimals in. No error, no warning, and output that
                looks like a deliberate choice.
decimals: -1    came back as a bare RangeError from inside toFixed, naming nothing the
                caller had written.
start: NaN      created the output directory, wrote signals.csv, and then failed saying
                the input was unreadable — a partial conversion, blamed on the file.
```

The first is the one that matters: a conversion that succeeds and is wrong.

`assertOptions` now runs at the top of buildPlan, which every path goes through before a
directory is created or a stream is opened, so a rejected option leaves nothing behind. It
throws `OptionError`, which the CLI already declared privately and now shares with the
library and exports, so a bad option is one error type whichever way it arrived — and the
CLI keeps exit 2 for it.

## 0.4.32

### Changed: the bit-for-bit cross-check actually compares bits

The correctness page has said, since it was written, that edf2csv's physical values match
pyEDFlib's "to the last bit ... not equal to within a tolerance, not numpy.allclose". It even
printed the method: dump the doubles through the API, compare the 64 bits.

`npm run crossvalidate` did something else. It converted with --decimals 20, parsed the cells
back into floats, and accepted anything within abs(reference) * 1e-9 — and skipped empty
cells without counting them as anything. That cannot be exact whatever the tolerance: a cell
is a rounded decimal rendering, so reading it back gives the nearest double to the printed
digits rather than the double that was computed. The page described a check that did not
exist.

The recipe the page prints is now checked in as test/crossvalidate/dump-doubles.mjs and is
what the checker runs, so the documented method and the executed one are the same code. Every
value is compared as its 64 bits, addressed by the signal's position rather than its label —
labels need not be unique, and matching on them could compare one channel against another's
samples.

Confirmed capable of failing before being trusted: flipping the lowest mantissa bit of every
scaled value is caught on the first sample of every recording, including differences no
decimal rendering shows — pyEDFlib -1.0 against edf2csv -1.0000000000000002, which the old
tolerance passed in silence.

```
Compared 16,943 sample values bit for bit, and 120 annotations, across 75 recordings.
Every value agreed.
```

The README and the correctness page said 129,536 values, a number from a recording set that
is not in the repository. Both now state what the shipped command actually compares, and the
README no longer files the pyEDFlib claim under `npm test`, which never ran it.

## 0.4.31

### Fixed: metadata describes the file that was converted, or admits it cannot

The size, timestamp and SHA-256 in metadata.json came from re-opening the input path once
the CSVs were written. That describes whatever answers to that name by then, which need not
be what was converted. A recording still being written grew from 2,000 records to 3,000
mid-conversion, and metadata.json recorded:

```
"bytes": 1536512, "sha256": "28535bb4...",     <- the 3,000-record file
"data_records": 2000                            <- what the CSV holds
```

Two halves of one provenance record describing two different files, with nothing to say so.
Replacing the file at that path did the same thing more thoroughly. That is the opposite of
what --checksum is for.

`bytes` and `modified` now come from the descriptor state at open — the same size every
record count and window in the output was derived from — so the record is internally
consistent whatever happens to the path.

The hash needed more than that. A file overwritten in place keeps its inode, so the open
descriptor sees the new bytes too and the converted ones are gone; no post-hoc hash can
recover them. So it is taken before the first record is read, and published only if the file
held still: if size or modification time moved at any point, `sha256` is null and the run
raises INPUT_CHANGED saying why. A plausible hash of the wrong bytes is worse than none.
`sha256` present now means the file demonstrably did not change while it was read.

The change is reported even without --checksum, since a conversion of a file that moved
under it is worth knowing about on its own. The CSVs stay correct for the records that were
read either way.

## 0.4.30

### Fixed: the folder above the recording stops choosing its name by accident too

0.4.29 settled which of two names for one recording the output is called after, and left the
directory above it deciding the same question the old way. The walk was a stack popped from
the back, so which of two names for one folder was visited first came down to the order
readdir returned them — and the loser was skipped as already seen, taking its name out of
the run.

```
study/aaa-real/rec.edf
study/zzz-alias -> study/aaa-real
```

```
edf2csv study --out ./out   ->  out/zzz-alias/rec/signals.csv
```

The link's name, chosen by a hash order that differs between filesystems. So the release
note for 0.4.29 was true of files and not of the folders holding them, which is the same
defect one level up.

Breadth first now, with each directory's children entered real names before links and
alphabetically within each, so the surviving name is a property of the tree: the shallowest,
then the one that is not a link, then the first in sort order. Both orderings of the names
are tested — aaa-real beside zzz-alias, and zzz-real beside aaa-alias — so passing cannot be
the sort order agreeing with the answer by luck.

## 0.4.29

### Fixed: one recording, two names — the output directory stops depending on the order

A recording reachable more than one way is converted once, and the surviving name was
whichever arrived first. That made the output directory a function of enumeration order:

```
edf2csv data/one.edf data/alias.edf --out ./out   ->  out/one
edf2csv data/alias.edf data/one.edf --out ./out   ->  out/alias
```

A shell orders a glob however it likes. Inside a folder it was whatever readdir returned,
which is hash order on APFS, a different hash on ext4, and creation order elsewhere — so
copying a study to another machine could rename its output, and a script that read
out/one/signals.csv found nothing there.

The winner is now decided by the names themselves. A name the recording actually has beats
a link pointing at it, since that is the name the file has; two links are settled by the
path that sorts first. Both are properties of the file set, so the answer does not move.

One behaviour change falls out of it: a recording reachable as `link.edf` and as
`linkdir/actual.edf` now converts into `<out>/linkdir/actual` rather than `<out>/link`,
which is also the layout the folder has.

## 0.4.28

### Changed: a request that cannot be carried out exits 2, like every other one

Exit 1 means "the file or the destination is the problem"; exit 2 means "the command line
is the problem". Both --stdout refusals were filed under 1:

```
error: --stdout has no signal data to write because --annotations-only was given.
       Drop one of the two flags.
```

```
error: --stdout needs exactly one table, but this recording produces 3, one for each
       sampling rate its channels use (256 Hz, 128 Hz, 1 Hz).
       Narrow it to one rate with --channels, or convert to a directory instead.
```

Both hints say, in as many words, to change the flags — and a script reading the exit code
went looking at the disk instead. `--stdout --json` was already 2 for exactly this reason,
so the three conflicts disagreed with each other.

Exit 2 has always covered checks that need the header first: a --channels term matching
nothing, a --start past the end of the recording. These belong with them. The library keeps
throwing a ConversionError so nothing about its API changes, under a new code
UNSUPPORTED_REQUEST that says which kind of problem it is; a destination that genuinely
cannot be written is still exit 1.

## 0.4.27

### Changed: --json is shaped by what you named, and the JSON Lines batch is documented

Two things, one cause.

The batch flag was `inputs.length > 1`, so the shape of --json depended on the contents of a
folder rather than on the command. A study holding one night printed an indented document;
the same study holding two printed JSON Lines. A script written against one broke on the
other — on the day a recording was added, not the day the script changed — and an input
going missing did it in reverse. That is the same count 0.4.20 took out of --out, for the
same reason, and it is now decided the same way: naming a folder means a batch whether it
holds one recording or fifty.

And the documentation never mentioned JSON Lines. It said "the whole result of a successful
run is one parseable document on stdout", which is true of one recording and false of a
folder: `json.load` fails on the second line. One object per line as each recording finishes
is the right shape for a batch — five hundred recordings can be consumed while the run is
still going, and `jq` reads it a record at a time — so the docs now say so, and say what to
use in Python.

## 0.4.26

### Fixed: the signal count is read the way every other header number is read

EdfFile.open has to know how many signals there are before it can know how much header to
read, and it worked that out with its own Number(). That parse tolerated the NUL padding
sloppy writers emit — the reason it existed — but not the comma decimal separator, which
every other numeric field here accepts and which the documentation lists this field among.

So a header written with a comma never got its signal headers read at all, and the file
died on a message whose arithmetic refuted itself:

```
error: File declares 2 signals, which needs a 768-byte header, but the file is
       only 848 bytes.
```

848 is larger than 768. Following that message leads to a truncation that is not there,
while parseHeader, handed the same bytes directly, read the file correctly and raised
COMMA_DECIMAL. The reader and the parser disagreed about which files were readable.

Both now share one parse, so they cannot drift apart again. The size error also names
whichever of the two is actually short — the file, or the bytes the parser was handed.

## 0.4.25

### Fixed: the _ch suffix is checked against the file, not only against the label it fixes

Duplicated labels get a `_ch<index>` suffix, which is unique among the channels sharing that
label — and nothing stopped it from landing on a label some other channel already had. EDF
labels are free text and nothing enforces uniqueness, so a file carrying T8, T8 and a third
channel genuinely labelled T8_ch0 is well-formed. It produced:

```
time_s,T8_ch0,T8_ch1,T8_ch0
```

Two columns, one name, and the warning beside it said the suffix kept them
"distinguishable". channels.csv listed T8_ch0 against two signal indices, so the join it
exists for could not resolve it either; metadata.json recorded the name twice; and a
name-based lookup returns one of the two with nothing to say which. Exit 0 throughout.

Names are now made unique across the whole file: anything still shared after the first pass
takes its own position too, which is unique by construction. And the channel that lost its
own label to another's suffix is named, because its column is the one thing in the output
that no longer matches the file:

```
warning: Signal 2 is labelled "T8_ch0", which is also the column name another channel's
         "_ch" suffix produces, so its column is "T8_ch0_ch2".
```

## 0.4.24

### Fixed: an origin the file's own arithmetic cannot hold is reported, not acted on

0.4.9 taught continuous recordings to honour the first timekeeping TAL, which is right, but
it took the number at face value. A double spaces its values further apart the larger they
get: at 1e16 the gap is two seconds, so `t + 1` is `t`. Past that point an origin stops
being a position and becomes a wall.

Two silent failures came out of that. At 1e16 the collapse is partial, and the test for
"does this record overlap the window" — `start + recordDuration > windowStart` — is false
for every record that rounded onto its neighbour. A twelve-row recording wrote four rows,
exit 0, no warning; the eight that vanished looked exactly like a file that never had them.

At 1e17 every record lands on one instant, so the recording measures zero seconds long, and
the window resolver had no reason to suspect the recording rather than the request:

```
error: --start 100000000000000000s is at or past the end of this 100000000000000000s
       recording.
```

--start was never passed.

Both paths now check that the origin can still separate two consecutive samples of the
fastest channel. When it cannot, the recording is timed from zero — what it did before
0.4.9, and the only column that can hold distinct values at that magnitude — and says so,
pointing at annotations.csv for the absolute onsets. An origin merely large is kept: at 1e15
the gap is an eighth of a second, so a 4 Hz recording's quarter-second steps survive.

## 0.4.23

### Fixed: one offset cache for the whole conversion, not one per sampling rate

The time-column cache was capped at 2^20 offsets per rate group. A file may hold as many
rate groups as it has channels, so nothing bounded the total.

Twelve channels at twelve rates just under the cap — a 25 MB file — peaked at 1.66 GB and
took 36 seconds. A 92 MB file at a single rate, four times the data, peaks at 283 MB and
finishes in a fraction of that. Twenty-four rates never finished at all: it spent two
minutes swapping and was killed. A per-group limit is not a limit.

One budget for the conversion, spent in the order the groups ask. They are already sorted
fastest-rate first, so the cache goes to the tables with the most rows to write and the
ones that miss out are the ones that would have gained least from it — they format the
same text the slow way.

```
12 rates, 25 MB   1.66 GB / 36.0s  ->  1.02 GB / 5.5s
24 rates, 50 MB   did not finish   ->  1.20 GB / 8.5s
```

A file with one rate group behaves exactly as it did: same budget, same cache, and 75
fixture and flag combinations byte-identical to 0.4.22.

## 0.4.22

### Fixed: the time column stops writing "1e+21.000"

`fixed` has guarded value cells against the 1e21 cliff since 0.3.x, where toFixed switches
to exponent notation. The time column lost that guard in 0.4.1, when the per-row toFixed
was replaced by a cached decomposition: whole seconds plus printed fraction, concatenated.
The concatenation is an implicit Number-to-String, which switches to exponent form at the
same 1e21 — and the cached fraction is then glued onto the end of it:

```
time_s,ch1
750000000000000100000.000,0.300
1e+21.000,0.400
1.25e+21.000,0.500
```

"1e+21.000" is not a number in any notation. pandas and R both read it as NaN, in a column
whose every other cell is plain fixed-decimal, so a reader has no reason to look for it.

Reachable because EDF's record-duration field is 8 characters and exponent form fits, so a
header may legitimately say 1e21; three records get there. One comparison per row hands
those to the slow path, which already expands them with BigInt, and leaves the cache doing
its job for the other twenty million.

## 0.4.21

### Fixed: a conversion killed mid-flight names itself, and the directory it left

A process that dies by signal exits with a null code and prints nothing on its way out.
The parent read that as an ordinary failure with empty output, so a batch whose child was
killed printed "Converted 1 of 2 recordings; 1 failed." and nothing else — not which
recording, not why, and not that out/b held a 194 MB signals.csv cut off mid-row with no
channels.csv beside it. Half a CSV opens in pandas exactly like a whole one.

The out-of-memory killer, a job scheduler's time limit and `kill` all arrive this way, and
they arrive on the machines where batches are largest. The close handler now reads the
signal it was given and says so, in the same words the interrupt handler uses for a run
stopped from the keyboard:

```
error: in/b.edf: stopped by SIGKILL before it finished.
       Incomplete, and should not be used: out/b
```

Ctrl-C keeps its single message: the interrupt handler names every abandoned directory at
once, and a per-child line under it would repeat that once per job.

## 0.4.20

### Changed: a link that leads nowhere is reported, and --out stops depending on what was found

A study kept as one folder per night, with one night linked to an external drive that
happened not to be mounted, converted the nights that were there and said nothing about
the one that was not. The walk only reported entries whose names ended in .edf or .bdf,
and a directory carries no such name.

Losing that input made it worse than a silent omission. --out decided between "the output
directory" and "a parent to fill" by counting the recordings, so dropping one left a single
recording and moved the survivor as well: csv/signals.csv instead of csv/night-01/rec/.
Whether a drive was mounted changed both what was converted and where it went, exit 0.

Two changes. The walk reports anything it cannot inspect, whatever it is called, and that
counts against the run. And what --out means is now decided by what was named rather than
by what was found: one recording names the output directory itself, a folder or several
recordings name a parent. `edf2csv study --out csv` writes csv/night-01/rec/ whether the
study holds one night or fifty — adding a second night no longer moves the first one's
output, and neither does an input going missing.

## 0.4.19

### Fixed: the nesting guard could be stepped past by a sibling

0.4.14 refuses a batch where one recording's output directory would sit inside another's. It
sorted the resolved destinations and compared neighbours, reasoning that an ancestor and its
descendant end up adjacent. They do not. The separator is not the lowest character, so any
sibling whose name begins with one of the thirteen printable characters below `/` lands between
them:

```
study/
  rec.edf        ->  out/rec
  rec!x.edf      ->  out/rec!x     '!' is 33, '/' is 47
  rec/inner.edf  ->  out/rec/inner
```

`out/rec!x` sorts between the pair, so the pair was never compared, and the run went ahead:
`Converted 3 of 3 recordings`, one of them written inside another's directory — the exact
outcome 0.4.14 was for.

Each destination is now checked against its own ancestors by name, which has no such gap.
Output trees are shallow, so it is a handful of lookups per recording.

### Fixed: a recording whose name begins with a dash failed under `--jobs`

```
$ edf2csv . --out ../converted             # a folder holding -lead.edf and ok.edf
Converted 2 of 2 recordings.

$ edf2csv . --out ../converted --jobs 2
Converted 1 of 2 recordings; 1 failed.
```

Each conversion runs in a child process that received the recording as its first argument, so a
path beginning with a dash parsed as an option and the child rejected a file the parent had
converted happily. `path.join` produces exactly that from a folder given as `.`: `./-lead.edf`
normalises to `-lead.edf`. The recording is now passed last, behind `--`.

### Fixed: a file name containing `$&` reported itself as something else

The parent puts a recording's name into the errors its children produce. It built the
replacement as a string, where `$&`, `` $` ``, `$'` and `$1` are patterns rather than text, and
a file may legitimately be called any of them:

```
error: study/baderror: name.edf: File is 10 bytes; an EDF header alone needs at least 256.
```

That is `bad$&name.edf`, with `$&` replaced by the `error: ` it had just matched. The name is
now inserted as data.

### Fixed: `--stdout --jobs 0` was accepted

`--stdout` converts one recording however many jobs are asked for, so the value was never
parsed. A request that cannot be honoured is a usage error rather than something to accept in
silence — which is what 0.4.2 established for `--info`.

All four came from an adversarial sweep of the 0.4.x code, and three of the four are faults in
work from earlier in the same batch.

## 0.4.18

### Fixed: `--jobs` with `--strict` called a converted recording a failure

```
$ edf2csv study --out ./converted --strict            # one recording raises a warning
Converted 2 of 2 recordings.
--strict: 1 warning raised, so this run is reported as a failure. The output was still written.

$ edf2csv study --out ./converted --strict --jobs 2   # the same two recordings
--strict: 1 warning raised, so this run is reported as a failure. The output was still written.
Converted 1 of 2 recordings; 1 failed.
```

Both recordings converted, both times, and both directories were written. The parallel run said
one of them had not been.

Two causes, one underneath the other. `--strict` was passed down to each child, so a child that
merely warned exited 1 — and announced "this run is reported as a failure" about its own single
file, which then leaked into the parent's output. The parent, seeing only an exit code, could
not tell "converted, and raised warnings" from "did not convert", because under `--strict` those
are the same code.

`--strict` is a verdict on the whole run, and a child converting one recording is not the whole
run. Children no longer receive it. Instead each reports what it did — how many recordings it
converted and how many warnings they raised — over the channel `fork` already opens, and the
parent applies `--strict` once, from the totals. `process.send` exists only in a forked process,
so an ordinary invocation is untouched.

Serial and parallel now produce the same count and the same single verdict. A recording that
genuinely fails is still a failure: two good files and one unreadable one report "Converted 2 of
3 recordings; 1 failed" and exit 1.

Found by an adversarial sweep of the 0.4.x code.

## 0.4.17

### Fixed: a folder it could not read was skipped without a word

A study folder holding three recordings, one of them inside a sub-directory without read
permission:

```
$ edf2csv study --out ./converted
[1/2] study/open/a.edf
[2/2] study/top.edf

Converted 2 of 2 recordings.
$ echo $?
0
```

Two of three, reported as two of two, and exit 0. The count agreed with itself and with
nothing else. Whatever was inside that directory never entered the list, so nothing downstream
had any way to know it existed.

This is the failure 0.4.4 fixed for symbolic links, arriving by a different route: the walk
caught the error from listing a directory and carried on with an empty list. Converting fewer
recordings than were asked for while reporting success is the one outcome this tool exists to
prevent.

```
$ edf2csv study --out ./converted
error: study/locked: could not be read, so any recordings inside it were skipped.
[1/2] study/open/a.edf
[2/2] study/top.edf

Converted 2 of 2 recordings.
$ echo $?
1
```

Everything readable is still converted — one locked sub-directory in a large tree is a reason
to name it, not to refuse the rest — and it is reported before the conversions start, so it
cannot be lost among the summaries. A file that looks like a recording but cannot be inspected
is reported the same way. A broken symbolic link is not: it names nothing and is ordinary.

Found by an adversarial sweep of the 0.4.x code.

## 0.4.16

### Added: `npm run fuzz:batch`, which builds folder trees and converts them

```bash
npm run fuzz:batch
```

```
12 folder trees, 49 recordings, 49 conversions (seed 1).
Serial and parallel agreed, and every batch matched converting alone.
```

Converting a folder is the hardest part of this tool to reason about. The tree is walked, links
are followed, destinations are derived from file names, and the conversions may run in any order
across several processes. Every batch bug so far came from an arrangement nobody thought to
write a test for, so this builds arrangements instead — nesting, names with spaces and non-ASCII
characters, mixed-case extensions, symlinks, files that are not recordings — and checks four
things that must hold whatever comes out:

1. **Serial and parallel produce the same directories.** A difference between them is what a
   race looks like from outside.
2. **Each recording's output equals converting it alone.** A batch may reorder the work; it may
   not change a byte of it.
3. **The closing count matches the directories produced**, so "Converted 5 of 5" is a fact
   rather than a hope.
4. **A non-zero exit comes with a message**, never a silent half-conversion.

The first of those is not hypothetical: it is how 0.4.14 was found two versions ago. One run
produced `<out>/rec` and another `<out>/rec/inner` from the same command over the same files,
which is the whole signature of that bug. Putting it back makes this fail in two independent
rounds and exit 1 — so the check is known to work rather than assumed to.

Runs are deterministic: the same seed builds the same tree, so a failure reproduces on another
machine. Like the other two harnesses it is opt-in and not part of `npm test`, which stays fast
and dependency-free.

There are now three: `npm run crossvalidate` for the arithmetic, `npm run fuzz` for damaged
files, and this one for batches.

## 0.4.15

### Fixed: two recordings differing only in filename case merged into one directory

On a filesystem that does not distinguish case — the default on macOS, always on Windows —
`<out>/REC` and `<out>/rec` are the same directory. The guard compared destinations exactly, so
both went through:

```
edf2csv a/REC.edf b/rec.edf --out ./out --force
Wrote out/REC
Wrote out/rec
Converted 2 of 2 recordings.
```

Exit 0. One directory was created, and it held both conversions:

```
out/REC/
  signals.csv           from REC.edf
  signals_256hz.csv     from rec.edf
  signals_128hz.csv     from rec.edf
  signals_1hz.csv       from rec.edf
  channels.csv          whichever wrote last
  metadata.json         names rec.edf, and only rec.edf
```

A directory whose provenance file describes a recording other than the data sitting beside it
is the one outcome this tool exists to prevent, and here it arrived without a word. Anyone
reading `signals.csv` there gets one recording's samples under another's metadata.

Without `--force` it already failed — the second conversion hit "already exists" — so the
damage needed that flag. It is now refused before anything is written, with both recordings
named.

The comparison follows the platform rather than applying everywhere, so a case-sensitive
filesystem, where those really are two directories, keeps converting both. A case-sensitive
volume on macOS is the case this gets wrong, and it errs in the safe direction: a refusal
naming both recordings rather than a silent merge.

## 0.4.14

### Fixed: two recordings whose output directories nest produced a different result each run

0.4.0 refuses a batch in which two recordings would land in the same directory. It compared
destinations for equality, which misses the case where one contains the other:

```
study/
  rec.edf         ->  out/rec
  rec/inner.edf   ->  out/rec/inner
```

A recording named `rec.edf` sitting beside a folder named `rec` is enough, and that is a normal
thing to find in a study folder. The two paths are not equal, so both went through.

What happened next depended on which conversion got there first. Each claims its own directory
with a single non-recursive mkdir — the atomic claim that stops two conversions sharing one
`signals.csv` — but creates its parents recursively. So whichever started second either found
the directory the other had already made as a parent, and failed:

```
error: study/rec.edf: "out/rec" already exists.

Converted 1 of 2 recordings; 1 failed.
```

or did not, and both succeeded. Under `--jobs 2`, **five runs in twenty failed and fifteen
succeeded** — the same command over the same files. Serially it always worked, because the
expanded list is sorted and `rec.edf` happens to sort before `rec/inner.edf`.

A destination inside another destination is now refused up front, with nothing written:

```
error: "study/rec/inner.edf" would be converted into "out/rec/inner", which is inside
       "out/rec" — where "study/rec.edf" is converted.
       One recording's output cannot sit inside another's. Convert them separately, or
       rename one of them.
```

Only nesting is refused; recordings that merely share a parent are the ordinary case and are
unaffected.

Found by a fuzzer that builds random folder trees and requires a batch to produce the same
files serially and in parallel — the two disagreed, which is what a race looks like from
outside.

## 0.4.13

### Fixed: `--info` disagreed with the conversion on a recording that starts mid-second

0.4.9 made a continuous recording take its origin from the first record's timekeeping TAL,
which is where EDF+ says it is. `--info` went on placing a requested window against zero, so
the two stopped agreeing about the same file:

```
edf2csv fractional-start.edf --info --start 1     Would write 8 rows
edf2csv fractional-start.edf --out ./converted --start 1
                                                  signals.csv   10  rows
```

The estimate exists so that someone can decide whether a conversion is worth starting, and it
was off by a fifth on a file whose discontinuous twin — byte-identical apart from the reserved
field — agreed with itself the whole time. Which is what made it findable: the two are supposed
to give the same answer, and 0.4.9 tested exactly that for a whole-file conversion, but not for
a windowed one.

`--info` reads annotations only for discontinuous files, on purpose: an earlier version was
fixed for scanning every record of a continuous one just to report a header summary, at 0.29 s
on a 12 MB file. So this does not undo that. A continuous recording needs one number, and the
reader now offers one read to get it — its first record's timekeeping TAL, rather than every
record's. `--info` on an 18 MB, 30,000-record EDF+C still returns in 0.05 s.

The test now compares the estimate against the rows actually written for both twins across five
windows, rather than asserting a number either one happens to produce.

## 0.4.12

### Fixed: `--info` could print a duration that cannot exist

A header declaring a record duration of `1e300` produced this:

```
Duration   8.333333333333333e+296h 48m -2880s  (3 records of 1e+300s)
```

Forty-eight minutes and minus forty-eight seconds, under an hours field in exponent notation.

Past 2^53 the decomposition into hours and minutes stops being arithmetic and starts being
noise: `total - h * 3600 - m * 60` cannot be exact once the total exceeds what a double holds
as a whole number, and the error lands in the seconds field. It went wrong well before the
absurd cases — 1e20 seconds printed `27777777777777772h 13m -780s`.

Durations that large are now given in seconds, which is the honest form for a figure nobody
reads as hours anyway — 2^53 seconds is 285 million years. The record count and record duration
are printed beside it either way, so a corrupt header stays just as visible:

```
Duration   3e+300s  (3 records of 1e+300s)
```

A duration that is not a number now says `unknown` rather than `NaNs` or `Infinitys`.

Everything a recording actually has is unchanged, including the rounding fix that keeps
3599.9996 s from printing as `59m 60s`.

## 0.4.11

### Fixed: a recording that changed while being read was reported as a disk problem

Reading and writing both fail through one place, and both were reported as writing. A recording
still being appended to by the acquisition software — or otherwise resized mid-conversion —
raises the reader's own error, which names the record and says exactly what happened. That
diagnosis was then filed under the wrong heading and handed the wrong advice:

```
error: Writing to "/data/converted" failed: Expected 8388600 bytes of data at record 41943 but
       only 0 were available; the file appears to have changed size while it was being read.
       The files written so far are incomplete and should not be used. Free up space or choose
       another destination with --out, then run the conversion again.
```

Nothing was wrong with the destination, and freeing space or choosing a different `--out` would
not have helped. It sends someone to look at the one part of the system that was working.

```
error: Expected 8388600 bytes of data at record 41943 but only 0 were available; the file
       appears to have changed size while it was being read.
       Make sure the recording is not still being written to, then try again. What was written
       to "/data/converted" before it failed is incomplete and should not be used.
```

The reader's message and its advice are kept; only the note about partial output is added,
since that much is true either way. A genuine write failure — a full disk, an unwritable path —
still reports as one, with the hint it always had. The error carries a new code,
`INPUT_UNREADABLE`, so a script can tell the two apart without reading English.

The test cuts the file at a deterministic point rather than racing a timer: records are read in
batches sized by a byte budget, and `onProgress` fires between them, so truncating in the first
callback is reliably before the next read. Getting there took two failed attempts — a timer
that lost the race on a small file, and a "larger" file made by concatenating one, which is not
a larger recording at all but one recording followed by bytes nothing reads.

## 0.4.10

### Fixed: `--stdout` onto a full disk crashed instead of reporting

```
$ edf2csv recording.edf --stdout > /full-volume/out.csv
dist/cli.js:108
        throw error;
        ^
Error: ENOSPC: no space left on device, write
    at writeSync (node:fs:917:3)
```

The same failure through `--out` has always printed the ordinary message:

```
error: Writing to "/full-volume/o" failed: ENOSPC: no space left on device, write
       The files written so far are incomplete and should not be used. Free up space or
       choose another destination with --out, then run the conversion again.
```

So did `--stdout` through the library API, which never installs the listener at fault. The
designed error path existed and worked; something was getting in front of it.

That something is the guard that swallows `EPIPE`. A reader closing early is not a failure, so
`EPIPE` is ignored — but everything else was rethrown, and the rethrow lands on a nextTick,
outside whatever `try`/`catch` the conversion is running inside. It became an uncaught
exception, taking the process down with a stack trace and discarding the warning that the CSV
already on stdout stops mid-recording. For a tool whose stance is that it will not go quiet
when something is wrong, losing that particular sentence is the worst part.

Non-`EPIPE` failures are now reported rather than thrown, and only when nothing else is
listening — during a conversion the writer is already watching that stream and turns the same
failure into the message above, so speaking twice would report one problem as two. `| head`
still exits 0.

Verified on a real 2 MB volume filled to capacity, and pinned by a test that hands the command
a read-only descriptor as stdout: writing to it fails with `EBADF`, which is a genuine write
failure that needs no full filesystem to arrange. Against the old code that test sees the stack
trace; against this one it sees the message.

## 0.4.9

### Fixed: a continuous recording that starts mid-second put its samples and its events on different clocks

EDF+ puts the header's start time and every annotation onset on one origin, and says the first
data record's timekeeping TAL "always starts with +0.X" — the fraction of a second by which
that record follows it. Continuous files never read it. Their samples were timed from zero
while their events kept their true onsets, so the two ended up half a second apart:

```
                first sample times          event at +0.75 lands on
EDF+D           0.500, 0.750, 1.000         sample 1     correct
EDF+C           0.000, 0.250, 0.500         sample 3     half a second late
```

Those two files are byte-identical apart from the reserved field. The discontinuous copy reads
its record times and gets the answer right; the continuous copy assumed record *k* begins at
*k* × the record duration, which is true of the spacing but not of the origin.

Nothing about the output says so. Both files convert cleanly, and the CSV is well formed —
the event simply sits on the wrong row, two samples from where the recording put it.

A continuous recording's records are still contiguous, which is what continuous means: only
the origin moves. A first TAL of `+0` needs no adjustment at all, which is nearly every file,
and every existing fixture is unchanged.

The test converts both copies of the same recording and requires them to agree, rather than
asserting a number either one of them happens to produce.

## 0.4.8

### Fixed: `--duration` dropped every annotation on a recording that starts after zero

The signal window and the annotation window read the same absent `--start` two different
ways. `resolveRange` defaults it to the earliest record, taken from the EDF+D timekeeping
TALs; the annotation filter defaulted it to 0. On a recording whose first record sits at 30 s,
`--duration 5` converted samples from [30, 35) while filtering annotations against
`(-inf, 5)` — windows that do not overlap at all:

```
edf2csv late-start.edf --duration 5 --out ./converted
```

```
signals.csv       30.000, 30.250, 30.500, …     every sample in the window
annotations.csv   onset_s,duration_s,…          nothing but the header
```

Silent: the run exits 0 and writes a well-formed file, so nothing about the output says the
events were lost. `--duration` is now measured from wherever the conversion actually starts.
`--end` was never affected, since it names an absolute offset.

### Fixed: `--stdout --gzip | head` reported a write failure

0.2.30 made `edf2csv big.edf --stdout | head` exit 0. 0.3.1 said compression would behave
identically. It did not:

```
$ edf2csv recording.edf --stdout --gzip | head -c 100
error: Writing to stdout failed: Cannot call end after a stream was destroyed
exit 1
```

The EPIPE forwarded from stdout destroys the compressor, and the writer's guard against
closing stdout compares against `process.stdout` — which under `--gzip` is not the stream it
holds. Calling `end()` on the destroyed compressor fails with `ERR_STREAM_DESTROYED`, which is
not `EPIPE`, so it escaped the hang-up path and came back as a conversion failure. All three
symptoms 0.2.30 removed — exit 1 for a routine shell idiom, a claim about files that were
never written, advice about disk space — had reappeared on the one path 0.3.1 promised would
match. The writer now stops at a hang-up whatever stream it is holding.

### Fixed: `--gzip` could overwrite the recording it was reading

The guard that stops an output from resolving to the input builds its list from the plan's
file names, which carry `.csv.gz`, and then spelled out the two sidecars uncompressed. A
compressed run therefore checked two names it would never write and missed the two it would.
A recording sitting at `<outdir>/channels.csv.gz` was overwritten by its own conversion, with
`--force`, and the run reported success. The same file named `signals.csv.gz` was refused,
which is what gives the oversight away.

### Fixed: `--info --json` carried the mixed-rate warning twice

0.3.2 made that warning describe the conversion rather than the file, and reached every
consumer but one. `--info --json` emitted both copies — same code, same severity, one counting
the rates being converted and one counting every rate in the file. Anything matching on `code`
saw it twice.

### Fixed: interrupting `--stdout` named a directory that was never created

```
interrupted (SIGINT): the conversion stopped part way through.
       Files already written to "recording_csv" are incomplete and should not be used.
```

`--stdout` writes no directory. It now says what is actually true — that the CSV on stdout
stops mid-recording — which is the same "files that were never written" complaint 0.2.30
fixed in this path's error message.

### Documentation that had gone false

- The correctness page said a non-finite gain writes the physical minimum. It has written
  empty cells and raised `UNUSABLE_PHYSICAL_RANGE` since 0.2.15; the page was not updated
  with the rest, and contradicted the warnings reference. The row covered two conditions
  and is now two rows, since only the `gain === 0` half was ever true.
- Its test transcript still showed 88 tests in 19 suites. It is 148 in 32, and the per-file
  counts were stale too.
- The sampling-rates page said the mixed-rate warning ignores `--channels`. 0.3.2 made it
  follow the selection.
- The warnings reference said `DISCONTINUOUS` can only be raised by a conversion. `--info`
  raises it, because it has to read the record times to report the span correctly.

All five code defects were found by an adversarial sweep of the subsystems: 51 agents raising
findings and then trying to refute each other's, of which 18 survived and 24 did not. The rest
are recorded and not yet addressed.

## 0.4.7

### Added: `npm run fuzz`, which damages real recordings and checks nothing crashes

```bash
npm run fuzz
```

```
1200 runs over 300 corrupted recordings (seed 1).
Every one exited cleanly with something to say.
```

A header is thirty-odd fields parsed out of bytes, and the ways one can be wrong are not a list
anybody can write down. A test asserts the cases its author thought of, which are the cases the
code already handles. Corrupting real recordings asks a different question — is there *any*
arrangement of bytes that gets past the checks — and it has the advantage of not sharing the
author's assumptions.

The property is deliberately narrow: whatever a damaged file contains, the tool must exit 0, 1
or 2 and say something. Not a stack trace, and not a hang.

Damage is weighted toward the first kilobyte, where the fixed header and the start of the
signal headers live, because that is where one byte changes the meaning of everything after it.
A corrupted sample is only a different number; a corrupted sample count is a promise about the
file's shape that the file no longer keeps. Each file is run four ways — `--info`,
`--info --json`, a conversion, and a conversion with `--gzip`, which puts a compressor between
the writer and the file and had a crash of its own as recently as 0.3.1.

Runs are deterministic: the same seed produces the same files, so a crash found on one machine
reproduces on another.

**Nothing was found.** 4,000 runs across four seeds and 1,000 corrupted recordings all reported
cleanly. Two attempts to prove the check could fail were themselves instructive: removing a
header guard changed nothing, because a later check caught the same case, and forcing the
generic error branch to misbehave changed nothing either, because corrupted files never reach
it. The error handling turned out to be layered more thoroughly than expected. Making the
branch they *do* reach return an out-of-range exit code produced the failure, with the
recording, the arguments and the message named — so the check is known to work rather than
assumed to.

Like `npm run crossvalidate`, this is opt-in and not part of `npm test`, which stays fast and
dependency-free.

## 0.4.6

### Fixed: naming the same recording twice was an error in one place and fine in another

The folder walk collapses a recording reached two ways — a link and its target both inside the
folder are one recording, converted once. The explicit list did not, and refused the whole run
rather than converting anything:

```
$ edf2csv *.edf recording.edf --out ./csv
error: "recording.edf" and "recording.edf" would both be converted into "csv/recording",
       so one would overwrite the other.
```

A shell produces that by accident easily enough, and there is nothing ambiguous about it: it is
one recording, and converting it once is what was meant. The advice to "rename one of them" was
no help either, since both names were the same name.

Recordings are now identified by where they actually resolve, so any repetition collapses —
twice on the command line, once directly and once inside a folder that was also given, through
a link, or any mixture. A path that does not resolve keeps its own identity, so a file that is
not there still reports itself rather than being folded into another entry.

Two *different* recordings that would land in the same directory are still refused before
anything is written, which is the case that check was for.

### The batch paths are now held to producing identical output

A recording converted in a batch, in a parallel batch, or on its own must produce the same
bytes. `--jobs` rebuilds each child's arguments by hand, which is exactly the kind of code that
silently drops a flag in one path only, so it is checked rather than reasoned about: across the
fixture set and five flag combinations — plain, `--gzip`, `--checksum`, `--decimals`, `--start`
— all 43 comparisons agree, including `metadata.json`.

One flaky test was found and fixed while doing it. The interrupt test spawns a batch and kills
it; at sixty recordings it could starve a neighbouring test of process slots and fail it about
one run in ten. Thirty is still far more than the interrupt window can consume.

## 0.4.5

### Fixed: interrupting a parallel batch left it running

`--jobs` gives each conversion its own process. Interrupting the command stopped the one that
was coordinating them and nothing else:

```
$ edf2csv /data/*.edf --out ./csv --jobs 4
^C
$ pgrep -f edf2csv
8203  8204  8205  8206
```

Four conversions carried on writing gigabytes into a directory their owner believed abandoned.
Ctrl-C at a terminal reaches every process in the group, so this did not show up by hand — a
signal sent to the process alone does not, and that is how a batch runs from a script or a CI
job.

The interruption was also silent. The serial path has always said so:

```
interrupted (SIGINT): the conversion stopped part way through.
       Files already written to "out/r2" are incomplete and should not be used.
```

The parallel path said nothing, and the last line on screen was a successful `Done in 1.6s`
from whichever recording had just landed, so the run read as though it had finished.

Both fixed. An interrupted batch now stops every conversion in flight and names each directory
left half-written:

```
interrupted (SIGINT): 3 conversions stopped part way through.
       Incomplete, and should not be used: out/r5, out/r6, out/r7
```

The exit status is 130 for SIGINT and 143 for SIGTERM, matching the serial path and the usual
convention. Covered by a test that interrupts a real batch of sixty recordings and then checks
that nothing outlived it.

## 0.4.4

### Fixed: a symlinked recording inside a folder was skipped without a word

0.4.3 took a folder as input, and left out any recording that was a symbolic link. A recursive
`readdir` reports a link as a link and never as a file, so the extension test never saw it:

```
study/
  plain.edf
  link.edf -> /data/real/actual.edf     skipped
  linkdir  -> /data/real/               skipped, and everything inside it
```

The run then said `Converted 1 of 1 recordings` — describing what it had noticed rather than
what the folder held. Linking recordings into a working directory is an ordinary way to arrange
data, and naming the same link directly on the command line always worked, which made the
omission harder to notice rather than easier. Converting fewer files than were asked for, and
reporting a total that agrees with itself, is the failure this tool exists to avoid.

Links are now followed, to recordings and to folders alike. Two consequences, both deliberate:

- **A cycle terminates.** `study/sub/loop -> study` is legal and would otherwise be walked
  forever. Directories are recorded by their resolved identity and visited once.
- **A recording reachable two ways is converted once.** Where `find -L` lists both `link.edf`
  and `linkdir/actual.edf`, this converts the one recording behind them. The alternative is
  two output directories holding identical data, and a count that overstates what was there.

The walk is written out rather than delegated to `readdir`'s recursive mode, which cannot
express either of those.

## 0.4.3

### Added: a folder as input

```bash
edf2csv /data/study --out ./converted --jobs auto
```

Every `.edf` and `.bdf` inside is converted, at any depth. Recordings arrive organised into
folders and a shell has no tidy way to reach them, which is why the recipes here carried a
`find` incantation to do it. Passing the folder is the obvious thing to try, and until now it
failed with "is a directory, not an EDF file".

**The layout is kept.** A recording at `study/night-1/rec.edf` comes out at
`converted/night-1/rec`. That is not only tidiness: one folder per night with the file always
called `rec.edf` is a normal way to lay out a study, and flattening those onto their file names
would have every one of them claim `converted/rec` — which 0.4.0 correctly refuses, so the
whole run would have stopped before writing anything.

Anything in the folder that is not a recording is skipped, and a folder holding none says so
rather than converting nothing in silence:

```
No EDF or BDF recordings found in "/data/empty".
```

A path that is not a directory is passed through untouched, so a file named on the command line
that does not exist still reports itself instead of quietly vanishing from the list.

Folders and files can be mixed in one command, and everything else — `--jobs`, `--out`,
`--channels`, the time window — applies to the lot.

## 0.4.2

### Added: `--jobs`, converting several recordings at once

0.4.0 made a batch possible; this makes it use the machine. Eight recordings of 19 MB, each
converting to 168 MB of CSV, on eight cores:

| | wall clock |
| --- | --- |
| `--jobs 1` | 9.7 s |
| `--jobs 2` | 5.6 s |
| `--jobs 4` | 3.3 s |
| `--jobs auto` | 3.8 s |

```bash
edf2csv /data/recordings/*.edf --out /data/csv --jobs auto
```

`auto` is one job per core less one, so a long batch leaves the machine usable. It is not
always the fastest setting: past a point the conversions compete for the disk rather than the
CPU, which is why it lands slightly behind `4` above.

**Each conversion runs in its own process.** The first attempt used concurrent promises inside
one process and gained 6%, which is the overlap in the file reads and nothing else — converting
is almost entirely arithmetic and string building, 1.17 s of CPU for 1.24 s of wall clock, and
Node runs that on one thread. Since each conversion is already a whole command, each one gets a
whole process, which is what `xargs -P` would do by hand.

The output is byte-identical to a serial run, and the tests check that across four recordings
rather than asserting it.

A recording's output is held until it finishes and then released in one piece, so two ending
together cannot interleave one's summary with the other's warnings. They therefore appear in
the order they finish rather than the order given, each announced by the `[n/m]` line naming
it. `--json` is still one object per line: a child sees a single recording and prints the
indented document a single conversion prints, so the batch puts it back on one line.

A failure still names its recording. The child converted one file and prefixed nothing the way
a batch does, so the parent puts the name in — the `[n/m]` header is not necessarily alongside
in a log.

`--stdout` ignores `--jobs`, since that path takes one recording anyway.

### Fixed: an unusable `--jobs` was accepted in silence under `--info`

Validation lived in the conversion path, so `--info --jobs 0` ignored the flag and printed the
report. A flag that cannot be honoured is a usage error whatever mode it was given in.

## 0.4.1

### Faster: large conversions run in about two thirds of the time

A 19 MB recording converting to 168 MB of CSV took 1.90 s and now takes 1.35 s. The output is
byte-identical — the 168 MB file compares equal, as does everything the fixtures produce across
four flag combinations.

Value cells were already cheap. A channel can only hold `digitalMax - digitalMin + 1` distinct
readings, so a small cache of formatted strings serves millions of rows and `toFixed` runs a
couple of thousand times for the whole conversion.

The time column had no such luck. It rises monotonically, so no two rows share a string and it
was formatted once per row — ten million calls on that file, and a third of the total time,
more than reading the recording and writing the CSV put together.

What repeats there is the offset *within* a record. Sample `s` sits at `s / rate` from the start
of whichever record holds it, and a recording has only `samplesPerRecord` such offsets however
long it runs. Splitting each one into whole seconds and printed fraction reduces the per-row
work to an integer addition and a concatenation:

```
record starting at 42s, sample 7 of a 100 Hz record
  ->  42 + 0 whole seconds, fraction ".070"  ->  "42.070"
```

The decomposition only holds for a record starting on a whole, non-negative second, which is
what lets the fraction come entirely from the offset. Two cases therefore fall back to
formatting the sum, and both were found by checking rather than by reasoning:

- **A record starting mid-second** mixes the two fractions. Continuous recordings start every
  record at `index * recordDuration`, so this only arises for a fractional record duration or a
  discontinuous file whose stored start lands between seconds.
- **A negative record start**, which appends the fraction the wrong way: −5 s plus half a
  second is −4.5, but `"-5"` and `".500"` concatenate to −5.500. No recording starts before
  zero, but an EDF+ timekeeping TAL is free to carry a negative onset, and that is reason
  enough for the fast path to decline it.

Checked against formatting the sum over 49,456 combinations — 29 sampling rates from 1e-6 Hz to
2048 Hz, against record starts from 0 to 1e8 seconds, which is three years of continuous
recording. Every one agrees.

Past roughly 1e9 seconds the two answers separate, because the sum no longer fits its fraction
into a double. Where they differ this one is right: 317 years in, sample 2 of a 999 Hz record
is at 2/999 = 0.002002002…, which is `0.002002` at six places, and formatting the sum gives
`0.002003`. Nothing real reaches that magnitude, and there is no case in which the change costs
accuracy.

## 0.4.0

### Added: several recordings in one command

Passing more than one file used to be a usage error, and the documentation's answer to
"how do I convert a directory" was a shell loop. Now:

```bash
edf2csv /data/recordings/*.edf --out /data/csv
```

```
[1/3] night-01.edf
Wrote /data/csv/night-01
  signals.csv  8,640,000  rows
[2/3] night-02.edf
...

Converted 3 of 3 recordings.
```

With `--out` the named directory becomes the parent and each recording gets its own inside it,
named after the file. Without `--out` each converts beside itself into `<name>_csv`, exactly as
it would have done alone — so a glob behaves like the loop it replaces, and a single file
behaves like it always did, down to the byte.

**One bad file does not end the run.** It is reported with its name and the rest still convert.
One unreadable recording among five hundred is a reason to name that recording, not to discard
the work already done and refuse the remainder. The exit code is still non-zero and the closing
line says how many made it, so nothing is quiet about it:

```
[2/3] night-02.edf
error: night-02.edf: File is 17 bytes; an EDF header alone needs at least 256.

Converted 2 of 3 recordings; 1 failed.
```

**Two recordings that would land in the same place are refused before anything is written.**
One folder per night is how these are usually organised, so `n1/rec.edf` and `n2/rec.edf` both
resolve to `<out>/rec`. Converting them in turn would leave one recording's data sitting under
the other's name with nothing to show for it:

```
error: "n2/rec.edf" and "n1/rec.edf" would both be converted into "out/rec", so one would overwrite the other.
       Convert them separately, or rename one of them.
```

**`--json` over several recordings is JSON Lines** — one object per line, so `jq` reads a
record at a time instead of waiting for the run to finish. A single recording still prints the
indented document it always has. Emitting a batch in the single-file shape would have repeated
0.2.28's mistake of putting two documents on one stream and leaving the caller to find the
boundary.

`--stdout` still takes one recording, since one stream holds one table. Passing several says so
rather than concatenating them.

`--strict` counts warnings across the whole run. `--info` accepts several too, printing each in
turn.

### A note on exit codes

2 still means the command was wrong and 1 that something went wrong with a file. When both
happen in one batch the result is 1: once a file has genuinely failed, the invocation cannot be
the whole story. A single input has only ever one outcome, so its exit status is unchanged.

## 0.3.7

### Fixed: messages that list what the file contains could run to 1,500 characters

Several messages enumerate something the recording controls — its sampling rates, its channel
positions. On an ordinary file that is the useful part: the rates are exactly what `--channels`
has to choose between, so naming them is the point. But how many there are is the header's
decision, and a recording with 200 auxiliary channels produced this on one line:

```
warning: Channels use 200 different sampling rates (200 Hz, 199 Hz, 198 Hz, 197 Hz, 196 Hz, … 1 Hz).
```

1,545 characters. Nothing was wrong with the conversion — all 200 files were written correctly —
but the sentence that mattered was buried under a wrapped wall of text.

Four messages did this, and two were mine, added while making other messages more helpful:

| message | was | now |
| --- | --- | --- |
| mixed-rate warning | 1,545 | 130 |
| `--stdout` refusal (0.3.6) | 1,612 | 197 |
| no channel at that position | 1,159 | 114 |
| malformed position (0.3.3) | 1,130 | 85 |

Each now shows the first eight and counts the rest — `and 192 more` — so the list is cut without
pretending the tail is not there, and the true total is still stated up front. A `DUPLICATE_LABEL`
warning, which lists every position sharing a label, got the same treatment.

Recordings small enough to list in full are unchanged, down to the byte: three rates still print
as `(256 Hz, 128 Hz, 1 Hz)`. The cap only ever fires where the alternative was unreadable.

## 0.3.6

### Fixed: time errors did not show where the value they quote begins and ends

The errors from parsing a time have always quoted what was typed. The errors from applying it
did not, so the value ran into the sentence around it:

```
edf2csv recording.edf --start "  5s  "
error: --start   5s   is at or past the end of this 2s recording.
```

Read back, the value appears to be `5s   is`, and the surrounding spaces — which are the whole
reason a time assembled by a shell went wrong — cannot be seen at all. Both kinds of message
now quote it the same way:

```
error: --start "  5s  " is at or past the end of this 2s recording.
```

Where nothing was typed there is nothing to quote, so a window rejected because of a computed
end still reports the arithmetic plainly: `ends at "0", which is not after its start at 0s`.
What is quoted is what the caller wrote, never a value derived from it — `--start 4h` has never
reported itself as `14400s`.

### The `--stdout` refusal now names the rates instead of restating its own count

```
--stdout needs exactly one table, but this recording produces 3 (its channels use 3 different sampling rates).
       Narrow it to one rate with --channels, or convert to a directory instead.
```

The hint says to narrow the selection; the message spent its parenthetical repeating the number
it had just given, and never said what there was to narrow to:

```
--stdout needs exactly one table, but this recording produces 3, one for each sampling rate its
channels use (256 Hz, 128 Hz, 1 Hz).
       Narrow it to one rate with --channels, or convert to a directory instead.
```

It follows the selection, like the mixed-rate warning did in 0.3.2: narrowing a three-rate
recording to two reports those two.

## 0.3.5

### The cross-check now covers BDF and annotations

0.3.4 made the pyEDFlib comparison a command, but it only read `.edf` files carrying signal
data. That left out the two places a reader is most likely to be quietly wrong.

**24-bit BDF.** A BDF sample is three bytes, and the sign has to be extended by hand. A value
that comes out unsigned is not obviously wrong to look at: it is a large positive number where
a large negative one belongs, which is exactly the kind of mistake that survives review. A
quarter of the generated recordings are now BDF over BioSemi's own digital range, with both
extremes present in every one.

**Annotations.** Half the recordings now carry EDF+ or BDF+ events, including one with no
duration and one whose duration is zero, and `annotations.csv` is compared against pyEDFlib's
own reading of the TALs — onset, duration and text. The two disagree on one point by design:
pyEDFlib reports a missing duration as `-1.0` where edf2csv leaves the cell empty, a duration
nobody recorded not being a duration of minus one second. That difference is expected and
treated as agreement.

```
Compared 16,943 sample values and 120 annotations across 75 recordings.
Every value agreed.
```

Both halves were confirmed capable of failing before being trusted: a one-part-in-a-million
error in the gain, and a one-millisecond shift in every annotation onset. Each exits 1 and
names the sample.

Writing the recordings turned up a fault in the generator rather than in the tool. A record's
timekeeping TAL states where that record begins, which is its index times the record duration —
it was writing the index. Recordings whose records are not one second long were therefore
internally inconsistent, and pyEDFlib rejected precisely those rather than reading them wrongly,
which is a good argument for comparing against something strict.

No behaviour of the tool changed in this release.

## 0.3.4

### Added: `npm run crossvalidate`, the pyEDFlib comparison as something you can run

The README and the correctness page have both said the arithmetic is checked against an
independent implementation. That was true, and it was done by hand, which meant nothing
rechecked it when the code changed. It is now a command:

```bash
pip install pyedflib
npm run crossvalidate
```

```
Compared 12,559 sample values across 77 recordings.
Every value agreed.
```

Why another implementation rather than another test: the digital-to-physical mapping is four
numbers out of the header and one multiply. It is easy to get subtly wrong and nearly
impossible to catch by reading, and a test written next to the code tends to encode the same
misunderstanding the code has. pyEDFlib was written by other people from the same
specification.

The recordings it generates are deliberately not the test fixtures. Those target what real
files get wrong, and pyEDFlib declines several of them — a truncated file, a header whose
digital range is a single point. These are the opposite: ordinary well-formed recordings
across a wide spread of calibrations, digital spans from `-1..1` to `-32768..32767` against
physical spans from `0.0001` to `99999`, which puts the gain anywhere from about 1e-9 to 1e5.
Both ends of the digital range appear in every one, because those are the two points the
header actually calibrates and where two derivations of the same mapping differ most.

The comparison runs at `--decimals 20` so that what is compared is two computations of a value
rather than one of them against its printed form. The first attempt used 12, where a reading
near 1e-5 keeps only seven significant digits and the rounding was larger than the
disagreement being looked for.

It is opt-in and not part of `npm test`, which stays dependency-free. Without pyEDFlib
installed it says so and exits 0 rather than reporting a pass it did not earn. Putting a
one-part-in-a-million error into the gain makes it exit 1 and name the sample, which is how
it was confirmed to be capable of failing at all.

## 0.3.3

### Fixed: a mistyped channel position converted a different channel

`--channels "#2"` addresses a channel by position, and `Number()` was doing the parsing. It
accepts a great deal more than a position:

| written | reached | why |
| --- | --- | --- |
| `#0x2` | channel 2 | read as hexadecimal |
| `#0b1` | channel 1 | read as binary |
| `#1e0` | channel 1 | read as exponent notation |
| `# 2` | channel 2 | leading space ignored |
| `#2.0` | channel 2 | read as a float |
| `#` | channel 0 | `Number('')` is 0 |

Every one of them selected a channel and exited 0. Nothing looked wrong: the run reported
success and wrote a `signals.csv` — of the wrong channel. For a tool whose point is that the
numbers in the output are the numbers that were recorded, quietly converting a channel other
than the one asked for is the worst available failure.

A position must now be written in plain digits, and anything else is a usage error naming the
positions that do exist. `#99` keeps its own more specific message, and `#2` is unaffected.

### Fixed: two-line error messages arrived with a literal `\x0a` in them

Control bytes coming out of a header are escaped before they reach the terminal, so that a
recording carrying `\x1b[2J` cannot clear the screen. That escaping was applied to whole
assembled messages, and several of ours are written on two lines:

```
error: No channel named "ECQ". Did you mean "ECG"?\x0aRun with --info to list the channels in this file.
```

Node's own option errors run to three lines and had the same treatment. Each line is now
escaped separately and continuation lines are indented under the `error:` prefix:

```
error: No channel named "ECQ". Did you mean "ECG"?
       Run with --info to list the channels in this file.
```

Nothing gained the ability to drive a terminal. A carriage return is still escaped, so no line
can be repainted after it is printed; a newline can only add a line.

## 0.3.2

### Fixed: the mixed-rate warning described the file rather than the conversion

`--channels` narrows what gets converted, but the warning explaining why output was split into
one file per rate came from the header parser, which sees every channel and knows nothing about
the selection. Converting one channel out of a three-rate recording produced one file and this:

```
warning: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
```

Neither sentence was true of that run — in output where `--info` had already marked the other
two channels `(not selected)`. Selecting two of the three was wrong in the other direction:
still "3".

The warning is now raised from the conversion plan and counts the rates actually being written.
One channel raises nothing, two rates report two, and a run with no selection is unchanged.

`parseHeader` keeps its own copy, which is the right answer there: it is handed a header and has
no conversion to describe. Only callers that plan one get the narrowed version.

## 0.3.1

### Fixed: `--gzip` turned a write failure into a crash

Converting with `--gzip` into a path that could not be written printed a raw stack trace and
took the process down, where the same conversion without the flag reports the problem and
exits 1:

```
node:internal/process/promises:394
    triggerUncaughtException(err, true /* fromPromise */);
[Error: EISDIR: illegal operation on a directory, open '.../signals.csv.gz']
```

The compressor sits between the writer and the file, so a failure below it arrives on a
promise the writer does not own. Both that promise and the writer's own `end()` reject, and
`end()` is awaited first — so the other rejection was attached to nothing, which Node treats
as fatal. It is now attached, and a blocked destination reports the same message and the same
exit code with or without compression.

### Fixed: `--stdout --gzip` closed stdout behind itself

`pipe()` ends its destination when the source ends, so the compressor closed stdout on its way
out. The buffered writer has always refused to do that — a closed stdout breaks every later
write in the process — and compression was going around it. It matters for callers using the
library, where the conversion is one step of a longer program rather than the whole of it.

Both are covered by tests, including one that asserts `process.stdout` is still open when
`convert({ toStdout: true, gzip: true })` returns.

## 0.3.0

### Added: `--gzip`

CSV is the point of this tool and also its main cost. An hour of 100 Hz EEG leaves as 168 MB of
text. `--gzip` compresses each table as it is written:

```bash
edf2csv recording.edf --out ./converted --gzip
```

```
converted/
  signals.csv.gz        26 MB, from 168 MB
  annotations.csv.gz
  channels.csv.gz
  metadata.json
```

Roughly six times smaller on real signal data — long runs of similar values in a fixed-width
decimal format are close to the best case for gzip — for about a second per hundred megabytes.
Nothing is buffered that was not buffered before: the compressor sits between the existing
writer and the file, so memory stays flat on a recording of any size.

The bytes are what an uncompressed run produces, so the usual readers need no extra step.
`pandas.read_csv('signals.csv.gz')` infers the codec from the extension, as do R's `read.csv`
and DuckDB's `read_csv`.

`metadata.json` is deliberately left uncompressed. It is small, and it is the file you open to
find out what a directory holds — which is a poor thing to have to decompress first.

It combines with `--stdout`:

```bash
edf2csv recording.edf --stdout --gzip > signals.csv.gz
```

`--info` reports the estimate as the size before compression, and says so, because how much
compression achieves depends on the data:

```
Would write 10,000,000 rows, roughly 160.1 MB before compression.
```

The package still declares no runtime dependencies; `zlib` ships with Node.

### Fixed: a compressed run left behind by a later plain one is now reported

The leftover-output check matches files by name, and did not know about `.csv.gz`. Converting
with `--gzip` and then rerunning with `--force` and no flag left the old compressed files in
place, unmentioned, next to the new plain ones.

## 0.2.34

### Fixed: `--info` could report a size the conversion then exceeded

The estimate took a channel's integer digits from the floor of its physical bound, but cells
are written with `toFixed`, which rounds. A channel bounded at 999.9999 and written to two
decimals produces `1000.00` — seven characters where the floor suggests six — so every cell on
such a channel was budgeted a byte short:

```
edf2csv sensor.edf --info   ->  Would write 200 rows, roughly 1.3 KB
edf2csv sensor.edf --out .  ->  signals.csv is 1.4 KB
```

It showed on unsigned channels. A signed one budgets a sign on every cell and the positive half
of its samples never spends it, and that slack absorbed the missing character.

The bound is now measured as it renders. Across 40,000 generated calibrations the estimate went
from 2,726 under-reports to none, and every fixture is now checked for it rather than the one
calibration that exposed it.

One case remains outside the estimate rather than under it, and is now documented as such:
nothing obliges a recording to keep its samples inside the digital range it declares, and one
that does not maps outside the physical range too. Clamping the data to make the estimate true
is not a trade worth making.

### Fixed: two different sampling rates could be reported as the same rate

`formatRate` rounds to six decimals, which is what keeps 30 samples in a 0.1-second record on
screen as `300` rather than `299.99999999999994`. Two rates closer than that then rendered
identically, and a file carrying 1e-6 Hz and 1.25e-6 Hz said:

```
warning: Channels use 2 different sampling rates (0.000001 Hz, 0.000001 Hz).
```

Announcing two rates and printing one twice — the same contradiction the exponent fallback
already removed for rates that round away to zero, one rounding step further out.

The output filenames had the sharper version of it. Both rates wanted `signals_0_000001hz.csv`,
and the numbering added in 0.2.2 kept them apart by calling one `signals_0_000001hz_2.csv` —
which left the plain name on the file holding 1.25e-6 Hz, the one rate that name rules out.

Rates shown together are now rendered together, and switch to their shortest exact form when
rounding would collapse them. This affects the `--info` table, the mixed-rate warning and the
output filenames. Ordinary recordings are unchanged: `signals_256hz.csv` is still
`signals_256hz.csv`, and every fixture's CSV content is byte-identical to 0.2.33.

### Added

`formatRates(rates)` is exported alongside `formatRate` for callers rendering more than one rate
at a time.

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
