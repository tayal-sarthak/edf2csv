# Changelog

Notable changes to edf2csv. Versions follow [semantic versioning](https://semver.org); while the
major version is 0, a minor bump may contain breaking changes.

The patch number rolls into the minor at 100. Semver puts no ceiling on it, so nothing forced the
question until 0.6 reached 149 — at which point "0.6.149" tells a reader nothing they can hold, and
sorting a list of them by eye stops working. Two digits is a number people can compare; three is a
serial. A roll is not a claim that anything broke.

## 0.7.71

### a minute of sixty was refused only at the hour that rolls the date

The minute and second bounds were tested only where something else would have caught them.

The header's start time is parsed by bounding each field and then building the date and
checking it did not roll over. That round trip is a second guard for anything that changes the
day: hour 24, month 13, the thirty-second of a month, the twenty-ninth of a short February. Each
of those is refused twice over, and each is tested.

Minutes and seconds do not change the day. `10.60.00` rolls to 11:00 on the same date and
passes the round-trip check completely, so the bound is the only thing standing between the file
and a start instant an hour later than it says. It was tested at `23.60.00` — which rolls
midnight, and would have been refused with no bound at all.

So widening one character:

```
-  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 60) return null;
+  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 60 || ss > 60) return null;
```

leaves all 400 tests passing while a header saying `10.60.00` is reported as `11:00:00`. The
seconds field is the same shape one place over: `10.59.61` becomes 11:00:01, and the sixty-first
second was tested at no hour at all.

Both are now refused at an hour that does not roll the date, alongside the two that do, and the
times either side of each — `10.59.59`, `23.59.59`, `00.00.00` — have to still be times.

## 0.7.70

### the terminal sweep's recording was too small to draw a meter

The sweep that exists to watch the progress meter has only ever seen it say 96%.

Its recording is 1,700 records of ten 256-sample channels: 8.7 MB against an 8 MB read budget,
which is two batches. The meter is drawn from inside the read loop and throttled to one draw
every hundred milliseconds, so on that file it can print exactly two numbers — 96 and 100 — and
the second is usually dropped by the throttle. Every run of this sweep since it was written has
produced `96%` and nothing else.

That is four per cent of the file for the cut to land in. 0.7.45 replaced a fixed sleep with
"wait for the first bytes the meter puts on the screen", on the reasoning that those bytes prove
the reader is inside the file. True, and on this recording they arrive when it is all but read —
so the conversion it is meant to interrupt kept finishing instead, and the sweep kept reporting
that the run had proved nothing:

```
5 runs under a pseudo terminal.
  the recording could not be shrunk under the reader; that run proved nothing
```

Five thousand records is 25 MB, four batches, and a first draw at 32%. Three runs in a row now
cut it in time, where the smaller file had just failed to.

And the numbers themselves, which nothing has ever looked at. Every other check here is about
what happens *around* the meter — that it is taken down before an error, that nothing but text
reaches the screen. A percentage is now required to be one: whole, between 0 and 100, and never
going backwards inside a run. Scaling it by a thousand is reported as `the meter drew 327, 655,
which is not a percentage`; running it backwards as `the meter went backwards: 67, 34`.

## 0.7.69

### --jobs auto counted cores the process could not use

`--jobs auto` counted the machine's cores rather than the ones this process may use.

The promise is in the reference: "`auto` is one job per core less one, so a long batch leaves
the machine usable." The count came from `os.cpus().length`, which is every core the kernel can
see — the machine's answer to a question about this process.

They are the same number on a laptop and different numbers everywhere a batch converter
actually runs at scale. A container given two CPUs of a sixty-four core node, a job pinned by
`taskset`, a `docker --cpuset-cpus`, a cluster scheduler handing out slices: in all of them
`edf2csv /data/study --jobs auto` asked for sixty-three workers on two cores. That is the
sentence above inverted, and it is the shape of run — a folder of overnight recordings on
shared hardware — that `auto` exists for.

`os.availableParallelism` is the call for that question. It reports the parallelism actually
available to the process, and it has been in Node since 18.14; this package requires 20.

Nothing checked the number either way. `auto` appears in one test as a value the option
accepts, and what it resolves to is invisible from outside — the only effect is how many
children run at once, which a test would have to race to observe. The resolver is exported and
asked directly now, the way `worstOf` already is: one per core less one, never more jobs than
recordings, never zero, and the explicit counts untouched.

## 0.7.68

### the one-record test asserted the fixture, not the conversion

The test for a record with sixteen million samples in it passed without converting one.

It builds a 32 MB recording holding all of them in a single data record, converts it under
`--max-old-space-size=256`, and then asserts:

```js
assert.equal(rows, 16_000_000, 'the recording really does hold that many samples');
```

where `rows` comes from a *second* `--info` on the same file. That describes the fixture. It
says nothing whatever about the conversion, which contributed only the possibility of `run`
throwing — so deleting the conversion outright leaves the test passing, in under a second
against the nineteen it takes when it does the work. A conversion that exited 0 having written
a header and no rows passed it too, which is the shape of failure a memory limit produces once
somebody makes the writer give up quietly.

The memory cap is still what makes it a test rather than a demonstration. What it now also
checks is that the run got to the end: the conversion's own `--json` summary has to report
`signals.csv` with sixteen million rows, and the file on disk has to be over a hundred
megabytes, which sixteen million rows of `time_s,A` comfortably are and a header alone is not.

Its skip message said "needs room to build two 32 MB recordings" while the body builds one.

## 0.7.67

### one formula written twice, and never compared

Two functions computing one formula, and nothing compared their answers.

`decimalsForSignal` works out how many decimal places a channel's quantization step needs and
clamps the result to the hundred `toFixed` allows. `decimalsAreClamped` answers whether that
clamp happened — and it worked the number out again, with its own copy of
`Math.ceil(-Math.log10(step)) + 2`, against its own copy of the ceiling.

Their only job is to agree. Change either `+ 2`:

```
-  return Math.ceil(-Math.log10(step)) + 2 > MAX_DERIVED_DECIMALS;
+  return Math.ceil(-Math.log10(step)) + 3 > MAX_DERIVED_DECIMALS;
```

and all 398 tests pass, while a channel whose precision really was capped is reported as not
capped. `VALUE_RESOLUTION` is the warning that says consecutive codes will print the same text,
and it asks this function — so the channel converts with every one of its codes rendered
identically, in silence, which is the exact thing that warning exists to prevent.

Reachable rather than theoretical: the ceiling is a hundred places, and an eight-character
physical bound reaches it. A step of `1e-98` needs exactly a hundred and is not clamped; `1e-99`
needs a hundred and one and is.

One expression now, asked once. The test compares the two without knowing the formula:
`decimalsForSignal` takes the ceiling as an argument, so handing it one nothing can reach gives
the unclamped answer, and "was it clamped" is whether the two differ. Twelve steps from `1e1`
down to `1e-300`, the boundary named on both sides, and a channel with no step at all, which
both have to decline the same way.

## 0.7.66

### negative zero was normalised by a line nothing tested

The one thing `fixed` exists to do was checked by nothing.

Its comment says so plainly: "Without this, a sample that scales to a very small negative value
prints as `-0.000`, which looks like a distinct measurement but is not." Underneath is a
comparison against character 45, the minus sign. Change it to 46 — one digit — and every such
sample prints `-0.000`, and all 397 tests pass.

Not a curiosity of the arithmetic. Anything between zero and minus half a unit in the last place
rounds there, so `--decimals 0` sends every negative sample under half a unit to it:

```
$ edf2csv near-zero.edf --out csv --decimals 0
$ cat csv/signals.csv
time_s,ch
0.000,-0
0.200,-0
0.400,-0
```

and an ordinary channel reaches it whenever a code lands just below the zero crossing. A column
with two zeroes in it groups and sorts as two values, and a `-0.000` beside a `0.000` reads as a
measurement that is somehow more negative than none.

Nine widths and shapes of it are asserted now — an actual negative zero, values that round to
one at three, six and zero decimals, and the genuine negatives either side that must keep their
sign — and a conversion of a channel sitting just below zero has to come back with plain zeroes
in every cell.

## 0.7.65

### twelve accepted time units that nothing named or checked

`--start 2hrs` is worth two hours because a number in a table says so, and nothing checked it.

Sixteen spellings of four units are accepted: `h`, `hr`, `hrs`, `hour`, `hours`; `m`, `min`,
`mins`, `minute`, `minutes`; `s`, `sec`, `secs`, `second`, `seconds`; and `ms`. The reference
lists all sixteen. The tool's own message named four:

```
error: --start "5x" uses an unknown unit "x". Use h, m, s, or ms.
```

and no test exercised any of the twelve others. They are entries in a lookup table, so being
wrong costs nothing to write and shows nothing when read: set `hrs` to 360 and `--start 2hrs`
converts from twelve minutes in, the reference is wrong about what it means, and all 396 tests
pass. A window that is quietly the wrong length is the one mistake this option may not make —
it is the reason `1h1h` is refused rather than summed.

Every spelling is now parsed and checked against what it is *called* rather than against the
table it came from: anything starting with `h` is worth 3,600 seconds, `ms` is 0.001, and so
on. The reference's list and the table are compared both ways, so a spelling added to one
without the other fails. And the message points at the long forms it never mentioned.

## 0.7.64

### a header that contradicts itself about the day it was recorded

A header stating two different start dates said nothing about it.

EDF+ requires the recording identification field to begin `Startdate dd-MMM-yyyy` and requires
that date to be the header's own start date. 0.7.63 started using the four-digit year there to
settle the century, which only works where the two agree. Where they do not, one of them is
wrong, there is no way to tell which, and the file's single statement of when the recording
happened has lost its corroboration:

```
$ edf2csv contradicts.edf --info --strict
Recorded   2002-03-02 22:15:00
...
Recording  Startdate 05-MAR-2002 PSG-1234/2002 NN Telemetry03
$ echo $?
0
```

Two dates, three days apart, printed two lines from each other, and exit 0.

`START_DATE_MISMATCH` now quotes both as the file writes them and says which is used and why —
the start date field, being the one the format defines, since nothing in the file decides
between them. This is the shape RECORD_COUNT_MISMATCH and HEADER_BYTES_MISMATCH have had for
versions: a header that contradicts itself, reported rather than resolved on a guess.

Nothing else changed. A file with no `Startdate`, one whose month is not a month, and one that
agrees — in either century — all say exactly what they said before.

## 0.7.63

### the century came from a rule while the file stated the year

A 1984 recording was reported as made in 2084, on a file that says 1984 four fields earlier.

EDF gives the start date eight characters, `dd.mm.yy`, and the specification pins the century
because two digits cannot: 85 to 99 are 1985 to 1999, 00 to 84 are 2000 to 2084. That is the
only rule available — on a plain EDF file.

EDF+ writes the year again, in full. Its recording identification field begins
`Startdate dd-MMM-yyyy`, and the specification requires it to agree with the date field. Nothing
here read it:

```
$ edf2csv archive.edf --info
Recorded   2084-03-02 10:20:30
Recording  Startdate 02-MAR-1984 PSG-8 NN Grass-Model-8
```

A sleep study digitised from 1984 tape, reported as a hundred years in the future, beside the
line that says otherwise. The same rule sends a recording made in 2085 back to 1985. A century
is not a rounding: `start_datetime_local` is the field output-files points at for turning
`time_s` into an absolute instant, and it is where every citation of when the data was taken
comes from.

The full year is used where the file gives one and it agrees about everything the date field
can express — the same day, the same month, and a four-digit year ending in the two digits the
header wrote. Everything else is unchanged: a plain EDF file, a `Startdate` that contradicts the
date field, one whose month is not a month, and one that agrees on a date the rule already gets
right all resolve exactly as before.

## 0.7.62

### a minus sign that starts a formula was the one nothing looked at

A label of `-2+3` opens as a column headed `1`, and nothing said so.

`FORMULA_LABEL` names a header field a spreadsheet will run instead of read, and it tested for
`=`, `+` and `@`. Every list of these characters names a fourth. This one left it out on
purpose, with the reason written out on the warnings page:

> A leading `-` is not flagged, though the same advice usually includes it. A lone `-` is a
> real convention for "no unit" and appears in the test recordings, a leading `-` on a montage
> label is ordinary, and **neither is evaluated unless what follows it parses as a formula**.

That last clause is a condition, and nothing applied it. Nothing with a leading minus was
flagged at all:

```
$ edf2csv arithmetic.edf --info --strict
#  COLUMN  LABEL  UNIT  RATE   RANGE      OUTPUT
0  -2+3    -2+3   uV    10 Hz  -100 to 100  signals.csv
$ echo $?
0
```

`-2+3` is arithmetic and opens as `1`. `-A1` is a name and opens as `#NAME?`. Neither is a lone
dash and neither is a montage label, and both go into the CSV header row and into channels.csv,
in a tool whose security policy already treats these four fields as attacker-controlled.

The exception is now the case it was written for rather than the whole character. A lone `-` is
left as text by every spreadsheet and is still not flagged; a field that is entirely a number —
`-100`, `-1.5`, `-1e3` — reads as that number, which is what the header says, and is not
flagged either. Anything else after the minus is named, in the same words the other three get.
The fixture with a channel labelled `-` still raises nothing.

## 0.7.61

### --info would not count annotations it had already read

`--info --annotations-only` declined to count events it had just finished reading.

The line it prints is:

```
Would write annotations.csv and channels.csv, and no signal data. How many events there
are cannot be told from the header.
```

which is true, and is the wrong question on half the files it was printed for. `--info` reads
the annotation channel of a discontinuous recording in full — every record start of an EDF+D
file lives there, so there is no other way to place its records — and then said the count could
not be told. It had the events in an array, and had counted them to decide how many record
starts it had.

The sentence is right about a continuous recording, which is read only as far as the first
record that states a start time. That reason is now in the line rather than left to the page:

```
Would write annotations.csv and channels.csv, and no signal data. How many events there
are cannot be told from the header, and finding out means reading the annotation channel
record by record.
```

and a discontinuous one gets the answer instead:

```
Would write annotations.csv with 3 events and channels.csv, and no signal data.
```

Counted through the same window predicate a conversion filters them by — exported for the
purpose rather than copied — so `--start 2` narrows the figure exactly as it narrows the file.
`estimate.rows` under `--json` stays `null`, which is documented and deliberate: the estimate
describes the signal tables, and there are none.

This is the same shape as the "Would write 0 rows, roughly 0 B." that 0.4.51 removed from this
line — `--info` declining to say what a conversion will do, on the one mode whose whole purpose
is saying it — and the test written for that one asserted the replacement sentence appears,
which it did, on every file.

## 0.7.60

### the worst over-estimate was a figure nothing measured

The number the three-times ceiling rests on was measured by nothing.

`--info` may not read low, and since 0.7.38 it may not read more than three times high either.
Three is justified in one sentence, written in the sweep's own comment and on the correctness
page: "the worst any fixture produces is 1.73x, a three-byte-per-sample BDF at `--decimals 0`".
That is what makes three a wall rather than a target — it stands at nearly twice the worst
anything has ever done.

The sweep never measured it. It summed the ratios to report an average and threw the maximum
away, so the sentence was an observation somebody made once. A fixture whose estimate read 2.9x
high would have passed under the ceiling in silence, with both copies of the sentence wrong and
the headroom they describe gone — and the ceiling itself is only as trustworthy as the distance
between the two numbers.

It is enforced now, from a constant beside `LOOSEST`:

```
601 predictions over 50 recordings.
Every row count exact, and every byte count between the truth and 3x it (sizes read 16% high
on average, worst 1.73x at biosemi-plus.bdf [--decimals 0]).
```

and a run that beats it is a failure naming itself:

```
biosemi-plus.bdf [--decimals 0]: 1.73x is worse than the 1.5x this sweep has ever produced
— raise WORST_SEEN and the figure on the correctness page
```

The page's figure is pinned to that constant by the suite, alongside the harness sizes it
already checks, together with the ordering the wall depends on: the worst seen has to stand
below the ceiling. A recording that legitimately does worse now raises the number in both
places, which is the point of writing it down.

## 0.7.59

### the output page still described the old annotation decoding

The page describing what lands on disk still said the annotation text is decoded as UTF-8.

0.7.54 stopped that being true — a description whose bytes are not UTF-8 is read as latin1 now,
because the alternative was writing a character the file does not hold — and updated the two
pages about the format. output-files.md is the page about the *output*, and its column table
went on saying "decoded as UTF-8 and copied verbatim", which are two claims that had stopped
agreeing with each other.

The check was in the wrong place too. It asked `decodeRecordAnnotations`, one function in from
the file, and between there and the cell lie the window filter, the sort, the CSV escaper and
the stream's own encoding. The claim on the page is about `annotations.csv`, so that is where
this asks it now: a recording with `café Sövn` written one byte per character converts, and the
row read back has to be

```
0.5,,café Sövn,0
```

with no replacement character anywhere in the file.

The bytes are laid into the data record by hand, which is the part worth saying out loud. The
fixture writer encodes a TAL as UTF-8, so a string with an é in it produces `c3 a9` — valid
UTF-8, the path that was never broken. The first version of this test did exactly that and
passed against a decoder with no fallback at all. It now asserts that the recording holds the
byte `0xE9` before converting it, so it cannot quietly become a UTF-8 test again.

## 0.7.58

### a list cap that hid one item behind a longer phrase

The list cap spent eleven characters hiding one rate.

Every message that enumerates something the recording controls goes through `listed`, which
shows eight items and counts the rest. That exists because a 200-channel recording produced a
1,545-character warning on one line. One item over the cap is not that:

```
warning: Channels use 9 different sampling rates (100 Hz, 99 Hz, 98 Hz, 97 Hz, 96 Hz,
         95 Hz, 94 Hz, 93 Hz and 1 more).
```

`and 1 more` is eleven characters standing in for `, 92 Hz`, which is seven. The line is four
characters longer than naming all nine would be, and one rate shorter — and the sentence around
it has already said there are nine, so the reader is handed the count and then denied the item,
by a phrase that costs more than the item does.

A cut that costs more than it hides is not a cut. Nine items are all named now; ten still reads
"and 2 more", which is where the summary starts paying for itself; eight is byte-for-byte what
it was, as is every list long enough to need cutting — the 40-rate fixture still says "and 32
more" and the leftover-files warning still says "and 112 more".

## 0.7.57

### only one of the two channel suggestions was ever pasted back

The check that pastes a suggestion back into a shell pasted one of the two suggestions.

0.7.30 named both places a channel is printed as something to retype, in its own comment:

```
error: "EEG "A1"_ch0" is a column name, not a channel name: ...
       Use "#0" to select just this one, or "EEG "A1"" for every channel sharing that label.

error: No channel named "EEG "A2"". Did you mean "EEG "A1""?
```

and then pasted the first. The second — the near-miss suggestion, which is the one a mistyped
name actually produces — was matched by nothing at all.

That is the branch a comma reaches. `--channels` splits its value on commas, so a channel
labelled `EEG,Fp1` can never be selected by name, and the offer has to be its position instead.
Weaken the guard that decides that:

```
-  if (label === '' || label.includes(',')) return null;
+  if (label === '' && label.includes(',')) return null;
```

and all 392 tests pass, while the tool answers a typo with advice that fails against itself:

```
$ edf2csv rec.edf --channels EEGFp1
error: No channel named "EEGFp1". Did you mean "EEG,Fp1"?

$ edf2csv rec.edf --channels "EEG,Fp1"
error: No channel named "EEG".
```

The suggestion survives the shell perfectly — which is all the old check asked — and is then
split by the tool that printed it into two names it does not have. Following the advice is the
loop 0.7.30 was written to end.

Six labels now go through the near-miss branch as well, comma included: the term is the label
with one character taken out of it, the offer is pasted into `/bin/sh` exactly as printed, and
the conversion that comes back has to be of the channel the message was about.

## 0.7.56

### two tests skipped themselves when they lost a race

Two tests skipped themselves when they lost a race, and a skip reads as green.

Both interrupt a running conversion, and both did it by waiting a flat 400 ms and then sending
SIGINT. That is a guess at how long Node takes to boot and install its handler. Lose it and the
default action applies, the process dies with a null exit code, and the test says so and
returns:

```
﹣ does not warn about files in a directory it never created # the signal arrived before the
  handler was installed (killed by SIGINT)
﹣ stops its children when interrupted, and says the output is incomplete # the signal arrived
  before the handler was installed (killed by SIGINT)
ℹ pass 385
ℹ fail 0
ℹ skipped 2
```

Two of them in one suite run, on this machine, with the sweeps running beside it. `fail 0` is
what a reader takes from that, and what went unchecked is that an interrupted batch does not
report success and does name the directories it left half-written — the defect 0.4.x fixed,
which ended a run with "Done in 1.6s" as the last thing on screen.

The batch one is not a race any more. It prints `[1/30]` as the first recording finishes, and
that line is proof of both things the wait was standing in for at once: the parent is well past
installing its handler, and twenty-nine recordings are still to come. It waits for the line.

The other has to interrupt *inside* the pre-write scan, before anything exists to observe, so
there are two ways to lose and they pull opposite ways — the scan finishing first wants a
shorter wait, the signal beating the handler wants a longer one. It now tunes the wait against
whichever it hit and tries again, halving or doubling, up to six times. Started at zero
milliseconds, where the old code skipped immediately, it recovers and passes.

## 0.7.55

### the input-changed check was only ever tested with both halves at once

The input-changed check says "size **or** modification time", and both tests moved them
together.

`changedSinceOpen` is what makes `--checksum` a guarantee rather than a hope: if the recording
moved at any point, the hash is dropped and the run says why. Its two tests both replace a
2,000-record file with a 3,000-record one, which changes the length and the timestamp at once.
So this:

```
-  now.size !== this.fileSize || now.mtimeMs !== this.modifiedAtOpenMs
+  now.size !== this.fileSize && now.mtimeMs !== this.modifiedAtOpenMs
```

passes all 391 tests.

The case neither covered is the one that matters most. A recorder patching a header field, or
rewriting the last record of a fixed-length buffer, overwrites in place: the length is exactly
what it was and only the timestamp moves. It is also where a recorded checksum is at its most
misleading, because the bytes it describes are gone and the file still looks the same size.
Under `&&`:

```
overwrote in place: true   size unchanged: true
metadata sha256   : 28535bb4b900cbb0...
hash of the file  : e90455176f1c4165...
INPUT_CHANGED     : false
```

A `sha256` in the provenance file matching neither the file on disk nor the bytes the samples
were read from, with nothing beside it, and exit 0. As shipped, that conversion records
`sha256: null` and raises INPUT_CHANGED, which is the whole point of the check.

Both halves are now asserted separately: a new modification time at an unchanged length, and a
new length at an identical modification time. The instant is pinned to a fixed value first,
because `utimes` cannot restore a sub-millisecond timestamp it did not set — a test that passes
because two timestamps happened to differ is not testing what it says.

## 0.7.54

### a latin1 annotation was exported with a character the file does not hold

An annotation written in latin1 came out holding a character the file does not.

EDF+ says the annotation channel holds UTF-8, so this decoded it as UTF-8 and took what came
back. What comes back for bytes that are not UTF-8 is U+FFFD, one per malformed sequence. A
recorder that wrote `café` the way most of the older ones do — one byte per character, `0xE9`
for the é — produced:

```
onset_s,duration_s,description,record_index
0.5,,caf<?>,0
```

A character nobody wrote, in a text column, in a tool whose one claim is that it does not
invent a value. Exit 0, no warning, nothing to read back.

The same byte in a channel label comes out `é`. Header text goes through `decodeLatin1`, whose
whole point is that every byte becomes the code point of the same value; the annotation channel
was the one place free text out of the same file went through a decoder that can substitute.
It is also the only place in this parser where a byte the file contains could be replaced by
one it does not.

Decided rather than guessed. The decoder is strict now, so bytes that decode as UTF-8 are
UTF-8 — including a genuine U+FFFD, which is `EF BF BD` and perfectly valid, and is left where
it is — and bytes that throw are not UTF-8 and are read as latin1, which cannot fail and is
the identity map the rest of the parser already uses. Greek, Japanese and accented UTF-8 all
decode exactly as before.

## 0.7.53

### --info skipped the annotation channel of the files that needed it read

`--info` could not see the one warning it most needed to.

MISSING_EDF_PLUS_MARKER is about a file that carries an annotation channel whose timekeeping
puts the records at a non-zero instant, and a reserved field with neither `EDF+C` nor `EDF+D`
in it. The marker is what applies the origin, so the samples are timed from zero; the
annotation channel is found by label, so its events keep the onsets the file gives them. The
two CSVs come out on clocks the origin apart, and the conversion says so.

`--info` said nothing:

```
$ edf2csv unmarked.edf --info --strict
File       unmarked.edf
Format     EDF
Duration   3s  (3 records of 1s)
...
$ echo $?
0

$ edf2csv unmarked.edf --out csv
warning: This file has an annotation channel stating that its records begin at 1000s,
         but its reserved field carries no EDF+C or EDF+D marker — so it is read as
         plain EDF, time_s counts from zero, and the two disagree by 1000s.
```

The reason is the condition that decides whether the annotation channel is read at all:
`continuity === 'EDF+C'`. A discontinuous file has every record start read, a continuous one
has its first records read to find the origin, and everything else is skipped — which is every
file this warning is about. The read it needed is the one the continuous case already pays for,
on a file that is anomalous to begin with, since an `EDF Annotations` channel is not something
a plain EDF file has.

So `--info` now reads it for anything that is not EDF+D and has an annotation channel, and
raises the warning in the same words the conversion does. `--info --strict` exits 1 on such a
file, where it exited 0 before. A plain EDF with no annotation channel reads nothing extra and
says nothing, as it did.

The check that keeps the page's list of "warnings `--info` cannot raise" honest is a sweep over
the fixture set, and no fixture in it raises this code — so the omission was invisible from
both ends. The test added here builds the file rather than waiting for a fixture to exist.

## 0.7.52

### a leap second in the start time was dropped without a word

A start time of `23.59.60` was recorded as `23:59:59` and nothing said so.

UTC writes a leap second that way, and the header parser admits it deliberately: the bound on
the seconds field is `ss > 60`, not `ss > 59`. What happens next is `Math.min(ss, 59)`, because
`Date.UTC(..., 60)` rolls over into the next minute and would move the instant fifty-nine
seconds the other way. Keeping the nearest instant a date can hold is the right answer.

Keeping it in silence was not:

```
$ edf2csv leap.edf --info --strict
Recorded   2020-01-01 23:59:59
...
$ echo $?
0
```

for a header that says `23.59.60`. `metadata.json` records the same second, and
`start_datetime_local` is the field output-files points at for turning `time_s` into an
absolute instant — so the one number that names when the recording happened was a second
earlier than the file says, with nothing anywhere to say it had been moved.

Every other header field this tool cannot represent exactly reports itself: a comma decimal
separator, a physical span that overflows a double, a record count that disagrees with the
file, a start date that is not a date. This one field is both accepted *and* changed, which is
the combination that had no diagnostic. It has `LEAP_SECOND_START` now, which quotes the field
as written and says which second was kept and why.

The neighbours are unaffected and now have a test saying so: hour 24, minute 60, day zero,
month thirteen and the twenty-ninth of a twenty-eight-day February are all still refused
outright with `START_TIME_UNREADABLE`, and `23.59.59` still says nothing at all.

## 0.7.51

### an example annotated "no warning" raises one

A documented command annotated "no warning" raises one.

The MIXED_SAMPLING_RATES section makes the point that the warning describes the conversion
rather than the file, and demonstrates it with a pair of commands:

```bash
edf2csv sleep-study.edf --channels "EEG Fpz-Cz"   # one file, no warning
edf2csv sleep-study.edf --channels "EEG Fpz-Cz,Temp rectal"
#   warning: Channels use 2 different sampling rates (100 Hz, 1 Hz).
```

Run against `sleep-study.edf` — the recording this site is written about, and the one the
command names — the first prints:

```
warning: At least one output file will have more than 1,048,576 rows, which is more
         than Excel or Numbers can open.
```

Eight hours at 100 Hz is 2.88 million rows, and narrowing to one channel does not change that.
The second command raises it too, so the comment beside it shows one of the two warnings it
prints. Both comments are the same kind of claim as a pasted output block: a statement about
what appears on the screen when you run the line above.

0.4.68 added a check for exactly this, after getting-started showed one of two warnings — and
that check ran one command on one page. It runs three now, and it looks inside the block making
the claim rather than at the page holding it: warnings-and-errors has a section per code, so
every warning either command raises is quoted somewhere on that page whatever its examples say.
Page-wide containment passed over a block asserting the opposite of what its command does.

## 0.7.50

### a span shorter than the duration was blamed on gaps

`--info` blamed gaps for a span that records overlap into.

The `Time span` line is printed whenever the elapsed span and the recording's duration
disagree, and the parenthetical said "includes discontinuities" whichever way they disagreed. A
span *longer* than the duration is the gap case the line was written for — three records of one
second covering eleven. A span *shorter* than it cannot be a gap at all: it is records that
overlap, which is what a device does when it re-sends a buffer. Three records of 1s starting at
0, 0.5 and 1 printed:

```
$ edf2csv overlapping.edf --info
Duration   3s  (3 records of 1s)
Time span  2s  (includes discontinuities)
...
warning: 2 data records start before the record before them ends, so their samples
         overlap in time.
```

A recording covering less time than its own records account for, blamed on gaps it does not
have, four lines above the warning saying what it really has. The fixture that produces it has
been in the tree since the overlap warning was written; the only assertion on this line was
against the gap case, and the sentence on the annotations page quotes the gap case too.

Which way the subtraction goes now decides the words: `(records overlap in time)` below the
duration, `(includes discontinuities)` above it. A file holding both is described by whichever
wins, and the overlap warning is printed either way.

## 0.7.49

### the narrowing sweep never narrowed an annotation

The narrowing sweep never looked at `annotations.csv`.

It picks the files it compares with `/^signals.*\.csv$/`, so all 253 windows and 106 channel
selections it runs are about sample rows. Events are narrowed by the same window under their
own half-open rule — an event at `--start t` is in, an event at `--end t` is out — and that
rule was asserted by nothing anywhere in this project. Flip it so the event sitting exactly on
the start is dropped:

```
-  annotations.filter((a) => a.onset >= window.from && a.onset < window.to)
+  annotations.filter((a) => a.onset > window.from && a.onset < window.to)
```

and all 387 tests pass, and the sweep goes on reporting that "narrowing a conversion returned
exactly the part it names" over every one of those windows. An event has quietly stopped
existing in both halves of a recording cut in two, and the only thing that says so is a row
count nobody compared.

This is the shape 0.7.34 found for samples, one file over. Asking whether a window is a *slice*
cannot see a boundary rule that is wrong in the same direction on both sides of the cut: each
half is still a correct subset. What decides it is `--end t` and `--start t` together, which is
the one arrangement where the rule has to be read both ways at once — so the sweep now cuts on
an event's onset, and halfway between two of them, and requires the halves to hold every event
the whole recording holds. 41 pairs over the fixture set, as a multiset, since an EDF+D
recording stores its events in record order rather than in time order.

Restored, it is clean. Flipped, it names the recordings and the cut:

```
lost-timekeeping.edf/annotations.csv cut at 0.75: the whole holds 3 events,
the two halves hold 2 between them
```

## 0.7.48

### --channels changed the time column

`--channels` changed the time column.

The time column has two implementations. One decomposes each instant into whole seconds plus
the printed fraction of the sample's offset within its record, which is what makes the column
cheap: only `samplesPerRecord` distinct fractions exist, so they are computed once and reused.
The other adds `recordStart + sample / rate` and formats the sum. They are not the same
answer. At a record start of 1e9 seconds and 30 kHz, the exact instant is
1000000000.0000333333 and the sum's nearest double prints as `1000000000.00003338` — the last
two places are the addition's rounding, not the recording's clock. The test above this one has
said so since 0.4.1, and calls the first "the more accurate of the two".

What decided which one a rate group got was the offset budget. Groups ask from one budget,
fastest rate first, and a group that cannot fit formats directly. So the answer depended on
the other channels — and `--channels` changes who is in the queue:

```
$ edf2csv far.edf --out whole                  # a fast channel takes the table
$ head -3 whole/signals_30000hz.csv
time_s,slow
1000000000.00000000,0.000
1000000000.00003338,0.100

$ edf2csv far.edf --out one --channels slow    # the same channel, on its own
$ head -3 one/signals.csv
time_s,slow
1000000000.00000000,0.000
1000000000.00003333,0.100
```

Two files out of one recording disagreeing about when a sample was taken, under a documented
promise — claim 8 on the correctness page — that `--channels` selects columns and changes
nothing else. The narrowing sweep asserts that promise and structurally cannot see this: a
fixture small enough to run in a sweep never exhausts a budget of a million offsets, so both
of its conversions take the table.

The fallback now computes the same decomposition, just without the table to read it from. The
sum survives only where the decomposition has nothing to stand on — a record starting on a
fraction or before zero, where whole part and fraction are not separable, and past 1e21, where
the whole part stops printing in full.

The test that should have caught it says so in its own comment: "Whether a group got the cache
may not change a single cell." Underneath, it compared each formatter against `fixed(sum)` at
a start of 42 seconds and three decimals, where every way of computing the instant agrees to
the last digit. It compares the two of them against each other now, across five rates and ten
starts out to 1e15.

## 0.7.47

### an empty --out was left to the filesystem to complain about

`--out ""` was the one option value nothing looked at.

Eight long options take a value. Seven refuse an empty one from the command line and say what
they wanted — `--start is empty. Try a value like 30s, 5m, or 00:30:00.`, `--channels was given
but lists no channel names.`, `--layout must be "wide" or "long", got "".` — all exit 2, all
decided before a byte is read. `--out` was the eighth:

```
$ edf2csv rec.edf --out "$DEST"        # DEST unset
error: Cannot create "": part of the path does not exist.
       Check the path exists and that you have permission to write there.
$ echo $?
1
```

Exit 1, so a script branching on 2 for "I typed it wrong" reads it as a failed conversion.
Advice about a path that exists and a permission to write there, for a value that is neither.
Decided by the filesystem, so in a batch it is decided once per recording rather than once for
the run. And with `--info` — where there is no directory to create — it exited 0 and said
nothing at all, which is the same silence 0.4.2 removed from `--info --jobs 0`.

Refused now where the other seven are, before the inputs are even expanded. Not trimmed first:
`--out " "` is a strange directory to ask for but it is one the filesystem has, and a path is
not a keyword.

The test that enumerates these had handed every value-taking flag the string
`!!not-a-value!!` — nonsense to seven of them and a perfectly good directory name to the
eighth, so the one flag not checking its value was the one the probe could not reach. It now
hands every flag an empty string as well, and asserts that all of them refuse it, rather than
only checking that the ones which happen to refuse are documented.

## 0.7.46

### a dangling symlink in the destination came back as an errno

A destination under a symbolic link that points nowhere came back as an errno.

`describeFsError` exists to keep system codes off the screen, and it knew six: permission
denied, the disk is full, over quota, part of the path is a file, read-only, too long.
Everything else fell through to `cause.message`, which is Node's own text — the code, the
internal call that raised it, and the argument that call was given:

```
$ ln -s /nowhere dangling
$ edf2csv rec.edf --out dangling/inner
error: Cannot create "dangling/inner": ENOENT: no such file or directory, mkdir 'dangling'.
       Check the path exists and that you have permission to write there.
```

ENOENT is the surprising one to be missing, because the parents of a destination are created
recursively. "No such file or directory" therefore never means a parent that was not there —
it means a component that exists and leads nowhere, which is what a dangling link is, or a
directory something else removed between the two calls. `--out ""` reaches it too, since
`mkdir('')` is ENOENT.

The page said so as well. Its OUTPUT_UNWRITABLE section promises that "filesystem failures are
translated into plain language rather than passed through as system codes" and then lists them,
and the list was copied by hand: six entries, one of them reworded from what the code actually
says ("a file rather than a directory" for "a file, not a directory"), and nothing comparing
the two. It is now read out of `describeFsError` and checked both ways — a phrase the page
names that nothing prints, and a phrase the tool prints that the page does not name, are each
a way of being wrong.

## 0.7.45

### the terminal sweep failed the build when it lost its own race

`npm run terminal` failed the build when it lost its own race, and named the wrong direction
when it did.

The check it exists for needs a conversion that fails *while the meter is up*, and it arranges
one by cutting the recording out from under the reader. That cut was a thread that slept fifty
milliseconds. Fifty milliseconds is not a synchronisation primitive — it is longer than this
conversion needs on an idle machine and shorter than Node takes to boot on a loaded one — and
the second is the case that hurts: the file is cut before the reader ever opens it, leaving a
short recording whose header overstates its records, which this tool reads happily and by
design. Exit 0, nothing for the check to look at, and:

```
$ npm run terminal
5 runs under a pseudo terminal.
  the recording did not shrink in time; nothing was proven
$ echo $?
1
```

Which is backwards. It shrank too early, not too late. And a sweep that could not arrange its
own conditions had turned a scheduling accident into a failed CI run — on the one harness whose
whole job is to be run on machines this project does not own.

The first bytes a conversion puts on a terminal are the meter, drawn from inside the read loop,
so the reader is demonstrably inside the file by then. That is the event the sleep was standing
in for, and the cut now waits for it. A run that outruns the cut anyway is retried with the file
put back, and if it still will not fail, that is said out loud as a note and the exit code is
left alone — the same answer this file already gives a machine with no `pty` module. Reduced to
`time.sleep(0.0)`, the old code produces the run above; the new code exits 0 five times out of
five under load, and still catches the 0.7.9 defect when the meter's erase is put back.

## 0.7.44

### two fatal errors nothing had ever provoked

Two of the eight fatal errors had never been raised by anything in this suite.

`INVALID_SIGNAL_COUNT` and `INVALID_RECORD_DURATION` are both in the exported union, both
have a section in warnings-and-errors.md quoting the exact line they print, and the only
occurrence of either name under `test/` was the documentation cross-check — which reads the
pages and confirms that a code documented on one is documented on all three. That is a check
on prose. Nothing had ever handed the parser a header that produces one.

Measurable rather than a worry. Weaken both guards to the off-by-one each would be written
as:

```
-  if (signalCount <= 0) {                 +  if (signalCount < 0) {
-  if (!(recordDuration > 0)) {            +  if (!(recordDuration >= 0)) {
```

and all 384 tests pass. What gets through is not caught further down so much as mislabelled.
A record duration of zero makes every sampling rate in the file `samples / 0`, and the run
ends on:

```
$ edf2csv zero-duration.edf --info
error: --start 0s is at or past the end of this 0s recording.
```

naming an option the command line never carried, about a recording whose real problem is four
bytes of its header. A signal count of zero comes out as "No signal in this file carries any
samples", which describes a file full of empty channels rather than one that declares none.

Both guards now have a test that hands the parser the header and asserts the code and the
whole sentence, at zero and below zero and at a fractional negative, with the one-signal
one-second header beside them as the smallest thing either check has to let through.

## 0.7.43

### a hex physical maximum was read as the number it spells

A physical maximum written as `0x64` was read as **100**. It printed in the channel table as
`-100 to 100`, went into `channels.csv` as `physical_max,100`, and became the gain every sample
on that channel was scaled by:

```
$ edf2csv shifted.edf --info
#  COLUMN  LABEL  UNIT  RATE   RANGE        OUTPUT
0  ch1     ch1    uV    10 Hz  -100 to 100  signals.csv
```

Exit 0. No warning. A whole calibration — and therefore every number written for that channel —
invented out of four bytes that are not a decimal number. `0b1100100` and `0o144` are the same
hundred; `0x02` in the signal-count field is a two-channel recording; `1e10` there is ten
billion channels, which at least fails loudly.

`Number()` accepts all of it, and this is the fourth place in this tool it has been caught doing
so. The other three have their own comments and their own fixes: `#0x2` reached channel 2
through `--channels`, `--decimals 0o5` wrote five places, `--jobs 0x10` ran sixteen jobs. Each
of those was a value somebody typed and got quietly reinterpreted. These are the fields every
number in the output is computed from, and `edf-format.md` says of them, in its second sentence,
"all fields are ASCII", and then gives the layout digit by digit.

Held to EDF's own grammar now: a sign, digits, an optional fractional part, an optional
exponent. The exponent stays because eight characters cannot express a magnetometer's range any
other way — `1e-16` is a physical bound real headers write, and a fixture depends on it. The
comma decimal separator is normalised before this, as it always was, and NUL padding is trimmed
before that. Anything else raises `BAD_HEADER_FIELD` naming the field and quoting what was
found, which is the message this file already had for a field that is not a number:

```
error: Header field "physical maximum (signal 0)" is not a number (found "0x64").
       The file may be truncated, byte-shifted, or not an EDF file at all.
```

Every fixture, every sweep and the whole suite read exactly as before: 2,700 corrupted files
still exit cleanly, 20,160 round-trip cells still recover, 601 estimates still hold. Nothing
legal was reading through this door.

## 0.7.42

### the header layout is written out four times and checked nowhere

The EDF header's byte layout is written out four times in this repository. Twice on
`edf-format.md` — a table for the fixed 256 bytes, a fence for the field-major signal headers —
once in the comment at the top of `header.ts`, and once more in the offsets passed to `dec` and
`readField` just below that comment. Nothing joined any of them.

That is the failure `OPTIONS` in `cli.ts` already carries a comment about — "a second copy of
twenty flag names is a copy that will be missing the next one" — with a sharper consequence. An
out-of-date list is missing an entry. An out-of-date offset is a wrong instruction, on the page
somebody reads to check a file by hand or to write a reader of their own, and the mistake it
would produce is the one the page's own last paragraph warns about:

> A hand-written parser tested on a single-channel file passes, then reads a two-channel file
> and gets a label where it expected a transducer string.

All four are held to each other now. The fixed header is compared by containment rather than by
equality, because one row is genuinely read twice — the version field is eight bytes on the
page, and the parser reads bytes 1 to 7 of it again on their own to recognise BDF's `BIOSEMI`
magic. So every read has to fall inside a documented row, and every documented row has to have a
read starting at it. The ten signal fields are compared exactly, and their last offset plus its
width has to come to 256, which is the arithmetic that makes field-major work at all.

Every copy agrees today. Change `| 192 | 44 | reserved` to 40, or `+ns*104` to `+ns*100`, and
the suite names which two disagree.

## 0.7.41

### the batch sweep never asked where the output went

A batch derives one destination per recording from the path it was found at, relative to the
folder the caller pointed at, joined onto `--out`. Whether that relative path can ever begin
with `..` is a question about the walk — a symlink leading out of the tree, a name that
normalises oddly, a root and a recording that share no prefix — and the answer decides whether
`--out` is a destination or a suggestion.

Nothing had looked, and nothing could have. Every property the batch sweep checks reads the
output roots: which directories appeared under them, whether their bytes match, whether the
closing count matches what is in them. A conversion that landed *beside* them is somewhere none
of those is looking. Put a `..` into the join:

```
6 folder trees, 23 recordings, 0 conversions (seed 1).
Serial and parallel agreed, and every batch matched converting alone.
```

Twenty-three recordings converted, none of them where the caller said, and the sweep whose
subject is batches calls it agreement. It found nothing under `serial/` and nothing under
`parallel/`, compared the two empty sets, and reported that they matched.

Property 5 asks of the whole round instead: every file that looks like a conversion — a
`signals`, `channels` or `annotations` CSV, or a `metadata.json` — has to be under one of the
three roots the round created, and the folder of recordings has to come back holding only the
recordings that were put in it. Under the same `..` it fails on the first tree and names the
files:

```
round 0 [no options]: written outside every destination named:
  UPPER-1/annotations.csv, UPPER-1/channels.csv, UPPER-1/metadata.json, ...
```

The trees this runs on are the right ones to ask: they already build nesting, names with spaces
and non-ASCII characters, mixed-case extensions, symlinks and files that are not recordings.
What they had never been asked is where the output went.

## 0.7.40

### a test named for time units asserted only the exit code

The whole of the test named *accepts a time window in human units*:

```js
it('accepts a time window in human units', async () => {
  const dir = await outDir();
  const { code } = await cli([fixture('fractional-recdur.edf'), '--out', dir,
    '--start', '0.5s', '--duration', '500ms', '--json']);
  assert.equal(code, 0);
});
```

The exit code, and nothing else. A build that ignored both flags converts the whole recording
and exits 0. So does one that reads `500ms` as five hundred seconds — change one digit in the
unit table:

```
old test's only assertion, exit=0
rows written: 375 (should be 125)
```

Three times the window it was asked for, and the test that exists for the units says fine.

What a unit is worth is checked now instead. `--start 0.5s --duration 500ms` has to select
exactly the rows `--start 0.5 --duration 0.5` selects, byte for byte, and `500ms` has to differ
from `500` — which is the whole of what "ms" means, and the assertion the old test could not
have made without converting twice. The recording is 2 seconds at 250 Hz in 0.1 s records, so
the window is 125 rows and its bounds land inside a record rather than on one: `0.500,12.500`
first and `0.996,24.900` last, both named.

The clock form and the compound form get a line each on a longer recording, since `00:00:01`
and `0h0m1s` are separate branches of the same parser and neither had ever been run through a
conversion.

The `ms: 1` edit fails this on the first assertion after the two conversions are compared.

## 0.7.39

### the too-large-for-a-spreadsheet test used a twenty-row recording

The whole of the test named *warns when a file would be too large for a spreadsheet*:

```js
it('warns when a file would be too large for a spreadsheet', async () => {
  const plan = await planFor('tiny.edf');
  assert.equal(plan.estimate.exceedsSpreadsheetLimit, false);
  assert.ok(plan.estimate.rows > 0);
});
```

A twenty-row recording, asserted not to overflow. It never warned, and nothing else did either:
every fixture is small on purpose, so no sweep and no test in the suite ever put a `true` in
that field or produced a `LARGE_OUTPUT` warning. The branch had been reached from one side only
for as long as it has existed.

It decides something people meet — "Can I open the output in Excel?" is a section of the FAQ,
and 1,048,576 is a cliff rather than a round number. What decides it is the header, which is a
row of the file and not a row of the data:

```js
if (groupRows + 1 > SPREADSHEET_ROW_LIMIT) exceeds = true;
```

So 1,048,575 data rows fit exactly and 1,048,576 do not. An estimate off by one either way tells
somebody to split a conversion that would have opened, or lets them open one that will not.

Both sides of both boundaries are named now, and planned from a header rather than written,
since the question is arithmetic on a record count and a gigabyte of CSV would answer it no
better. `Temp rectal` carries one sample per record, so the row count *is* the record count and
the edge can be stated exactly. The long layout has its own comparison — every rate in one
table, so the file that overflows is the sum rather than the largest group — and gets its own
boundary and a case showing the two layouts disagreeing about the same recording, which is the
distinction the estimate exists to keep.

Deleting either `+ 1` now fails this. Before, deleting both changed nothing.

## 0.7.38

### the estimate had a floor and no ceiling

Claim 5 has always been careful about which direction the byte estimate may err in:

> The byte count NEVER UNDER-COUNTS. It is documented as an approximation, and it is one —
> most samples sit well inside the range their channel declares, so it reads high. Reading
> high is the direction a size estimate must err in: people use it to decide whether they have
> room. Reading low is a defect even though "approximate" would excuse it.

That is half a contract. Somebody deciding whether they have room is answered wrongly by an
estimate ten times too large as surely as by one too small — it says no to a conversion that
would have fitted. And a check that only asks whether a number is large enough is satisfied by
*any* number: multiply the estimate by five and the sweep passes 601 for 601.

So there is a ceiling now, and it is the same 601 predictions that pass under it. Three times
the truth, which is a wall and not a target — the worst figure this sweep has ever produced is
1.73x, on a three-byte-per-sample BDF at `--decimals 0`, where every cell is as narrow as a cell
gets and the bound taken from the header is as wide as it gets. The average is 1.16x. Reaching
three would mean the arithmetic had stopped describing the file.

```
601 predictions over 50 recordings.
Every row count exact, and every byte count between the truth and 3x it
(sizes read 16% high on average).
```

With the estimate inflated fivefold, 552 of the 601 report it and name the ratio. Before this
release the same source produced "no byte count under the truth (sizes read 480% high on
average)" — the average was printed, and printed averages are not assertions.

## 0.7.37

### nothing compared --stdout with the file it replaces

`--stdout` is documented as writing the signal CSV "instead of a directory", and the recipes
that pipe a conversion into `duckdb`, `gunzip` or a script all depend on the two being the same
bytes. They are not the same code. `--out` opens a file stream per rate group and closes it;
`--stdout` writes one stream it does not own, through an audit wrapper that counts bytes so a
short write can be reported — it is the one destination with no second file after it to trip
over, which is why 0.4.39 had it exiting 0 after losing its tail.

Nothing compared the two. The estimate sweep measures files on disk. Layouts, narrowing and
round-trip all read directories. The batch sweep is about batches, and the terminal sweep checks
the one case `--stdout` refuses. A stream that dropped its last flush, or gained a mark the file
did not have, would have been caught by none of them, and by no test in the suite either — the
`--stdout` tests are about exit codes, disk-full reporting and what the summary line says, never
about what the bytes are.

`npm run stream` is the ninth sweep and the eleventh claim: every fixture `--stdout` accepts,
crossed with the seven modes that change what reaches it, against the single signal file the
same command writes to a directory. **305 streams over 50 recordings**, every one identical.
Compressed streams are decompressed first, since gzip need not choose the same block boundaries
twice and what is promised is the CSV inside rather than the container around it.

Confirmed capable of failing. Make the byte order mark skip the stdout path:

```
annotations.edf [--bom]: the stream is 4170 bytes and signals.csv is 4173, first differing at 0
```

The mixed-rate recordings are where the crossing earns itself: `--stdout` takes one table, so
those reach it only through `--layout long` or a selection narrow enough to leave one rate — and
both of those are paths a single-rate recording never exercises. Forty-five of the runs are
refused outright, which is its own answer and tested elsewhere.

## 0.7.36

### every calibration the round-trip sweep tried had a positive gain

Claim 6 is the reason this tool has no raw-digital output mode: the written decimals are always
fine enough to get the original integer back, and the FAQ prints the arithmetic for doing it.

```python
digital = (signals["EEG Fpz-Cz"] / gain - offset).round().astype("int64")
```

The sweep behind it crossed seven digital minima, six maxima and ten physical pairs. Every
physical pair ascends, and the digital pairs are filtered to ascend too — so **every calibration
it had ever round-tripped had a positive gain**. A channel whose header says
`physical_min 100, physical_max -100` is one this tool converts on purpose: `INVERTED_PHYSICAL_RANGE`
reports it and the conversion goes ahead "exactly as the header specifies, inversion included",
there are two fixtures for it and a table row on this page about getting the sign rule right.
Its digital codes had never been recovered from a cell.

Five reversed pairs are crossed now, taking the sweep from **13,440 cells over 840 calibrations
to 20,160 over 1,260**. Every one comes back exactly, so the arithmetic holds for a negative
gain as it does for a positive one — including the rounding, which is where a sign is easiest to
lose, since `Math.round` breaks ties toward positive infinity and a value halfway between two
codes therefore goes one way on an upright channel and the other way on its mirror image.

Confirmed capable of failing, and confirmed that the old shape was not. Drop the `Math.abs`
from `quantizationStep`, so an inverted channel's step comes out negative and the precision
falls back to three decimals:

```
20160 cells over 1260 calibrations.
1820 did not recover:
  EDF digital -32768..32767, physical 1..-1: cell "0.867" gives -28410, file holds -28399
```

The same source, under the sweep as it was:

```
13440 cells over 840 calibrations.
Every cell recovered the digital code the file holds.
```

## 0.7.35

### the batch sweep compared directory names and called them bytes

Claim 3 on the correctness page:

> Random folder trees are converted serially and in parallel, and both must produce
> **the same directories with the same bytes**.

The sweep compared the directory names. Nothing read a byte out of the parallel run.

That is the wrong half to leave out, because the two runs are not the same code. `--jobs 1`
converts in this process; anything more forks a child per recording and rebuilds its command
line by hand, out of three lists of flag names in `convertInChild`. The changelog carries three
separate defects from exactly that rebuild — `--out ./-nightly` split into two arguments, a
recording parsed as an option because its path began with a dash, `--strict` handed down to a
child that is not the run. A fourth of that kind produces the right directories with the wrong
numbers in them, which is precisely what a listing cannot see.

Nor could the sweep have seen it anyway: it passed **no flags at all**. Every tree was converted
with the defaults, so there was nothing in the rebuilt command line to lose.

Both halves are fixed together, because either alone is still blind. Each tree now runs under
one of twelve option sets, cycling — the compression, the mark, the layout, the precision, three
windows, a selection, the checksum and two combinations — so a run covers every option and a
different seed pairs each with a different tree. And the serial and parallel outputs are
compared file by file, `metadata.json` aside, which carries the time of the conversion.

Confirmed capable of failing, by the failure it was written for. Delete `decimals` from the
child's flag list and:

```
12 folder trees, 49 recordings, 49 conversions (seed 1).
11 problems:
  round 4 [--decimals 5]: a b-0/a b-2/signals.csv differs between serial and parallel
```

Before this release, the same deletion produced "Serial and parallel agreed, and every batch
matched converting alone."

## 0.7.34

### a window sweep that could not see a sample fall between two windows

Every check behind claim 8 asks the same question: is a window a *slice* of the full
conversion? Take the full run as the truth, ask for part of it, and require the part to be the
part, byte for byte.

A bound that drops the sample sitting exactly on it satisfies that perfectly. So does one that
writes that sample into both halves. Each window is still a run of consecutive rows in the
right order, and neither is ever asked about the other — the sweep has no way to notice a row
that fell between two of them.

Flip the half-open rule so `--start t` excludes the sample at `t`:

```js
- return time >= startSeconds - tolerance && time < endSeconds - tolerance;
+ return time > startSeconds + tolerance  && time < endSeconds - tolerance;
```

**Zero** of the 106 selections and 253 windows report anything. That is one sample missing from
every windowed conversion in the tool, and the sweep whose subject is windows says it is fine.

The arrangement that decides it is `--end t` and `--start t` together, which is the one place
the rule has to be read both ways at once. **174 pairs** now, cut on a sample — the case the
window loop deliberately avoids, because there a bound between two samples is compared against
a rounded column and a bound on a sample asks a question neither answer is wrong about; here it
is the question — and halfway between two, since a rule that is right at a sample can still
lose the row after it. Under that same flip, 68 of them fail, the first on the first recording.

Compared as a multiset, because an EDF+D recording may store its data records out of
chronological order and the rows are written in file order, so cutting it by time and putting
the halves back together reorders them, correctly. Order is what the slices already establish.
What the pair adds is that nothing falls between two windows or lands in both.

Every pair holds. The boundary arithmetic was right — including at the negative origin, the
fractional record start and the overlapping records — and now there is something that would
have said so.

## 0.7.33

### the layout sweep crossed every window and no selection

Claim 7 says the two layouts hold the same samples. The sweep behind it crossed six option
sets: four windows, one precision, and none at all. `--channels` was not among them, and it is
the one option that changes the shape of *both* layouts at once.

In the wide layout, dropping a rate removes a file. In the long layout, the single shared
`time_s` column takes its precision from the rates left in the conversion rather than from the
ones in the file — which is what 0.7.17 was about, found by reading the code rather than by
running anything, because nothing ran it. That release taught the narrowing sweep to cross the
long layout. It did not occur to it that the layout sweep had the same hole from the other
side: comparing the two layouts under every window there is, and never under a selection.

Crossed now, twice — a bare selection and one with a window on it — taking the sweep from
**275 conversions to 370**, over 690 channel sequences. Every sequence is still identical, so
the layouts do agree under narrowing; what was missing was anything that had asked.

The guard is the one 0.7.22 wrote for the estimate sweep, pointed at this one: every flag in
the CLI's own option table must either be crossed here or appear in a list of options that
cannot change a value, each with the reason. The lists differ, and the difference is the point
— this sweep compares decoded cells per channel, so `--gzip` and `--bom` change bytes without
changing a number and belong to the estimate sweep instead, while `--layout` is the axis being
compared along and `--annotations-only` leaves nothing to compare.

Third sweep in this shape: 0.7.16 for `--bom`, 0.7.22 for `--channels` and `--end`, this one
for `--channels` again in the other sweep that never had it.

## 0.7.32

### the crash sweep ran four of the nine ways a file can be converted

Claim 4 says a damaged file is reported rather than crashed, without qualification:

> **A damaged file is reported, never a crash.** Real recordings are corrupted byte by byte
> and converted; every one must exit 0, 1 or 2 with something to say, and never a stack trace.

The sweep behind it ran each corrupted file four ways: `--info`, `--info --json`, a conversion,
and a conversion with `--gzip`. Everything else the tool can be asked to do with a broken file
was outside the claim that says it never crashes — `--layout long`, which has its own row
writer and has shipped four defects, every one because nothing exercised it; `--stdout`, which
has no directory behind it for a failure path to name; `--annotations-only`, which skips the
signal writing altogether; a window, which is record arithmetic on a header the damage may
have made nonsense of; and `--channels`, which rebuilds the plan from a selection and is how a
rate group ends up in a differently-named file.

All five are crossed now. Nine invocations per file takes the sweep from **1,200 runs to
2,700**, and every one of them exits 0, 1 or 2 with something to say — at the default seed,
and at two others tried while writing this, one of them over 400 files. So the code was right;
what was missing was the sentence above it being true of more than four commands.

The invocation list is exported rather than written inline, because the page states the file
count multiplied by it. Adding a fifth would have made "1,200 runs" wrong by 300 with nothing
to notice — and five were added at once. `states harness sizes that match the harnesses
themselves` now recomputes it, as it already does for the estimate, layout and round-trip
sweeps, and both places the page prints the number are held to the same product.

The sweep takes about two minutes now rather than thirty-five seconds. It is one of seven CI
runs on every push, and the thing it is looking for is a stack trace nobody would otherwise
see until a real file produced one.

## 0.7.31

### the headline accuracy figures were checked by nothing

The tool's headline accuracy claim opens the README, is claim 1 on the correctness page, and
puts one of its numbers on the landing page in large type:

> Across the **75 generated recordings**, **16,943 sample values** were bit-for-bit identical:
> not equal to within a tolerance, but the same 64 bits.

Nothing checked any of the three figures. They are also the ones least able to be checked by
anyone reading them, because `npm run crossvalidate` needs pyEDFlib installed — which is why
it is a separate command and not part of `npm test`.

The split that makes this fixable: pyEDFlib is needed for whether the values **agree**. How
many there are to compare is arithmetic on the headers of recordings this repository generates
itself, `samplesPerRecord * recordCount` summed over each file's data channels. It comes out at
16,943 on the nose, and the annotations the reader finds come to 120, and the generator writes
75 files. So all three can be held to the recordings they describe on a machine with no Python
at all, in a tenth of a second.

The recordings are not the fixture set — `test/crossvalidate/generate.mjs` writes its own,
ordinary and well-formed and spread across calibrations, which is the opposite of what the
fixtures are for — so none of the counts the neighbouring test pins had any bearing on these.
That test exists because "192 predictions over 34 recordings" sat on the page while the sweep
ran 216 over 39; this is the same exposure on the claim with the most eyes on it and the
fewest ways to re-run it.

The figures are right today, which is the outcome these coverage releases keep having and the
reason to write the check while they are: a number nobody can reproduce is one nobody can
correct either. Change the count in the generator, or a digit on any of the three pages, and
the suite says which file disagrees with which.

## 0.7.30

### two more labels offered back in a form a shell rewrites

Two more places a label is printed as something to retype, both of which 0.7.18 walked past:

```
$ edf2csv rec.edf --channels 'EEG "A1"_ch0'
error: "EEG "A1"_ch0" is a column name, not a channel name: --channels matches the
       label, which for this channel is "EEG "A1"".
       Use "#0" to select just this one, or "EEG "A1"" for every channel sharing that label.

$ edf2csv rec.edf --channels 'EEG "A2"'
error: No channel named "EEG "A2"". Did you mean "EEG "A1""?
```

A shell collapses `"EEG "A1""` to `EEG A1`. Do that and the tool answers `No channel named
"EEG A1". Did you mean "EEG "A1""?` — the same suggestion, which collapses the same way.
Following the advice is a loop, and the only way out is to stop following it.

`$` and a backtick are the same failure without the visual warning. A shell expands both
inside double quotes, so `--channels "EEG $ref"` arrives as `EEG ` — the label the message
was about never reaches the tool, and nothing says a word about the difference.

Both now go through one rule. Double quotes stay wherever they survive, since they also show
where a label begins and ends and every documented example is written that way — `"T8-P8"` and
`"EEG Fpz-Cz"` are byte-for-byte what they were. A label carrying a quote, a `$`, a backtick or
a backslash goes in single quotes instead, the one POSIX form with no escapes inside it. A
label with a comma or a control byte has no form at all — `--channels` splits on commas after
the shell has finished, and a control byte cannot be typed — so those are offered as a position,
which is the answer NONPRINTABLE_LABEL already gives for the same two reasons:

```
       Use "#0" to select just this one, or 'EEG "A1"' for every channel sharing that label.
       No channel named "EEG $rff". Did you mean 'EEG $ref'?
       No channel named "EEGA1". Did you mean "#0"?
```

Checked by pasting. Each offered label goes to `/bin/sh` exactly as printed, and the CSV header
that comes back has to carry the label the message was about — six of them, covering the plain
case that must not move, a space, a double quote, a `$`, an apostrophe and a backtick. Matching
the sentence would have passed against every broken form.

## 0.7.29

### the last hint that printed a command a shell reads as a redirect

The last hint in this tool that printed a command nobody can paste:

```
$ edf2csv sleep-study.edf --stdout --gzip
error: --stdout --gzip would write compressed bytes straight to the terminal.
       Redirect it to a file or a pipe:
       edf2csv <recording> --stdout --gzip > signals.csv.gz
```

`<recording>` is not a blank to fill in as far as a shell is concerned — it is a redirect. Paste
that line and the shell looks for a file called `recording`, does not find one, and the command
never runs; and on the machine where one does exist, edf2csv is handed a stream it never reads
and answers about a missing recording instead. Angle brackets are a fine convention in an
options table, which is where `--out <dir>` lives. This line is not in a table: it is indented on
its own in the shape 0.7.18 and 0.7.19 went through making pasteable, and it is the only line in
the tool whose whole job is to be copied.

The name is in the invocation being refused, and exactly one of them reaches here — a folder and
a second recording are both turned away further up — so the hint now says it, quoted by the same
rule as the other two:

```
       edf2csv sleep-study.edf --stdout --gzip > signals.csv.gz
       edf2csv 'a steady one.edf' --stdout --gzip > signals.csv.gz
```

Checked by running it. The refusal only happens on a real terminal, so the check lives in the
pseudo-terminal sweep with the rest of what only a terminal can be wrong about: the printed line
goes to `/bin/sh` with `edf2csv` replaced by this Node and this CLI, and the bytes that land at
the destination have to start `1f 8b`. Two recordings, one of them named with a space in it,
which is the case that decides whether quoting was thought about at all. The sweep goes from
three runs to five.

## 0.7.28

### a hint suggested a conversion that changes nothing it describes

`TIME_RESOLUTION` ended on a suggestion:

```
warning: Channels at 3000000000000000 Hz sample faster than the time column can distinguish,
         so consecutive rows in signals.csv carry the same time_s value.
         Every sample is written, in order. Use the row number rather than
         time_s to tell them apart, or convert one rate at a time with
         --channels.
```

Take it — narrow that recording to the one rate the warning names — and the run exits 0 and
prints the identical warning back. So does the long layout. So does the long layout narrowed.
Four conversions, one sentence, no change to a single cell of the column it is about.

This is worse than a command that will not parse, which the last few releases have been about.
That kind fails loudly. This one succeeds, and the only thing it moves is whether the reader
believes the problem is behind them.

It cannot work in either layout, and for opposite reasons. `timeDecimals` is a function of the
rate alone, so in the wide layout — where each rate already has its own file and its own
precision — a narrowed conversion writes the column it was always going to write. In the long
layout the one shared column takes the finest precision *in the conversion*, so dropping rates
can only coarsen it: narrowing to the offending rate gives exactly what the wide layout had
already been giving it. Nor is there another flag: `--decimals` sets the value precision and
says so on the page, and every rate that reaches this warning has already been given the
fifteen places that are the ceiling — fifteen because 10^16 is past 2^53, where the test for a
terminating expansion stops being exact.

So the first sentence was the whole of the answer, and it is now the whole of the hint, with
the reason attached: the column already carries the fifteen places a double can hold exactly,
so no option or selection separates them.

The guard takes the advice rather than reading it. It converts a two-rate recording four ways
— as given, narrowed, long, and long narrowed — and requires the same warning about the same
rate each time, which is the fact that made the suggestion false, and requires the hint not to
name `--channels`. If some future selection ever does fix the column, that is what notices.

## 0.7.27

### a rename warning named a column the long layout does not have

A recording with a channel labelled `time_s` — legal, since EDF labels are free text, and what
a montage exported from a tool that already had a time column looks like — converted with
`--layout long`:

```
warning: Signal 0 is labelled "time_s", which is the name of the time column every
         signals.csv starts with, so its column is "time_s_ch0".
         Column names are unique; look this channel up in channels.csv by its
         signal_index.
```

A long `signals.csv` has three columns, `time_s`, `channel` and `value`, and none of them comes
from a label — a channel appears there as a *value* in the `channel` column. So the sentence
named a column the file does not have, to head off a collision it cannot have, and the hint
promised uniqueness about three fixed strings the header never supplied.

The rename itself is right in both layouts, so only the noun moves:

```
warning: Signal 0 is labelled "time_s", which is the name of the time column every
         signals.csv starts with, so it is named "time_s_ch0" in the channel column.
         Channel names are unique; look this channel up in channels.csv by its
         signal_index.
```

Why it is still right there is worth saying, since the message no longer implies it: the names
have to agree between the `channel` cells, `channels.csv` and other runs of the same file, and
the `pivot` the documentation gives for turning a long table back into a wide one would
otherwise put a `time_s` column against a `time_s` index — the same collision, one step later.

The wide sentence is byte-for-byte what it was, which is what the two pages quoting it show.
`buildPlan` already knows which layout it is planning; this warning was the one place that did
not ask. The header parser's own duplicate-label warning keeps its wording, because it is
raised before there is a layout to be wrong about.

## 0.7.26

### three JSON fields the reference said matched metadata.json by name

The reference, at the end of the `--json` section:

> Field names match `metadata.json` wherever the two describe the same thing, so a survey and a
> conversion can be read by the same code.

Three of them do not:

| `--json` summary | `metadata.json` |
| --- | --- |
| `records` | `recording.data_records` |
| `annotations` | `conversion.annotations_written` |
| `warnings` | `notes` |

Every pair carries the same value, checked on four recordings including one whose declared and
actual record counts differ. So somebody who took the sentence at its word — read a summary,
then reached for `doc["notes"]`, or archived a `metadata.json` and reached for
`data_records` — gets nothing back from a document that holds the number under another name.
The sentence sits two paragraphs below one that says *"neither is it in `metadata.json`'s
`notes`"*, which is where the contradiction is easiest to see and easiest to miss.

The sentence is the half that was wrong. Every one of these names is published in a table on
this page, and moving one would break every reader that already has it. So the page prints the
mapping instead: what does match, which is everything describing the recording, and the three
that do not, which are all about the run rather than the recording.

The guard has two halves. The three pairs have to keep carrying the same value, because a
mapping is only useful while both sides mean one thing. And any field in either JSON document
that `metadata.json` has no name for at all must be one of the handful that genuinely has no
counterpart — the channel table, which belongs to `channels.csv` and uses its column names, the
estimate, which describes a conversion that has not happened, and the elapsed time and output
directory of one that has. A new field cannot become a fourth mismatch without failing this.

## 0.7.25

### the page warned about an unsorted time column for the join and not for the slices

The same question 0.7.24 asked of the long layout, asked of the default one. Recipes opens with:

```python
signals = pd.read_csv("sleep_csv/signals_100hz.csv", index_col="time_s")
signals.loc[3600:3630]     # the 30 seconds starting one hour in
```

and follows it with "`time_s` is an ordinary float index in seconds, which makes
`.loc[start:stop]` a plain numeric slice." A label slice needs the index to increase down the
file, and two recordings do not:

```
KeyError: 'Cannot get right slice bound for non-monotonic index with a missing label'
KeyError: 'Cannot get left slice bound for non-unique label: 0.5'
```

The first is a recording whose data records are stored out of chronological order, the second
one whose records overlap in time. Both are warned about at conversion, and — this is what
makes the omission awkward — **the same page already spells this out**, three sections down,
for the `merge_asof` join: the `ValueError`, the warning, and `sort_values("time_s")` as the
fix. The two label slices, one above that section and one below it, said nothing.

Which of the two errors you get, and whether you get one at all, depends on where the bounds
land: `.loc[0.25:0.75]` on the out-of-order file returns three rows quite happily, and
`.loc[0.5:1.5]` on the same frame raises. A slice that worked once is not evidence the file is
in order, which is the reason to say this next to the recipe rather than leave it to be met.

A repeated time on its own is *not* a problem here, and the page now says so too. A channel
sampling faster than the time column can separate writes several rows at one instant, in order,
and the slice returns all of them — which is the right answer, since all of them were recorded.
That distinction is worth stating: it is the same repeated `time_s` that does break the `pivot`
one release back, for a different reason, and a reader who conflates the two will sort a file
that was never out of order.

The guard converts every fixture in the default layout and requires that any table whose
`time_s` decreases came with a warning, and that the page slicing on `time_s` names both
messages. Monotonicity and deliberately not uniqueness — checking uniqueness here would fail
the recording that slices correctly.

## 0.7.24

### a documented one-liner raises on two recordings the tool warns about

Three pages hand back the same call for turning the long layout into a wide frame, and one of
them calls it "one call away":

```python
wide = long.pivot(index='time_s', columns='channel', values='value')
```

`pivot` needs that pair to name one sample, and two recordings do not manage it. A channel
sampling faster than the time column can separate writes consecutive rows carrying the same
`time_s`; a recording whose data records overlap writes a later record across an earlier one's
span. Either way two rows share a time and a channel, and pandas answers:

```
ValueError: Index contains duplicate entries, cannot reshape
```

Not a wrong frame — an exception, on a one-line recipe, for a file the tool converted happily.

Both shapes are already warned about, and the faster-than-the-column warning even gives the
answer: *"Every sample is written, in order. Use the row number rather than time_s to tell them
apart."* What was missing was any connection between that warning and the recipe, on any of the
three pages that print it. Someone who converts, reads the warning, moves on, and then meets
the `ValueError` an hour later in a notebook has no reason to connect the two.

All three now say when the call raises and why, and the fullest of them — sampling rates, whose
whole subject is what a mixed-rate file does to a wide table — says what to do instead.

The guard reshapes every fixture's long conversion and requires two things: that any recording
whose table cannot be keyed on `(time_s, channel)` had a warning printed over it, and that every
page offering the recipe prints the exception with it. The duplicate pairs are counted in the
test rather than in pandas, which the suite does not have — the question `pivot` asks is only
whether the two columns identify a row.

## 0.7.23

### the eighty-column check promised what the design does not

A test titled *prints nothing that needs a terminal wider than eighty columns*, which ran six
refusals against one recording. The tool prints thirty-six distinct lines longer than that:

```
warning: Channels use 40 different sampling rates (40 Hz, 39 Hz, 38 Hz, 37 Hz, 36 Hz, ...
warning: The header declares 10 data records but the file contains 4. Converting the 4 ...
error: --start "abc" is not a time I understand. Try 30s, 5m, 1h30m, 00:30:00, or a plai...
```

Every one of the thirty-six is a first line — the one following `error: ` or `warning: ` —
and `printableLines` leaves those whole on purpose, because that is the line a log gets
grepped for and a break in the middle of it costs more than the overrun does. So the title
described a promise the design deliberately declines to make, and the test passed only
because the six messages it happened to sample begin short.

The promise that is real is about the lines that *are* wrapped: `--help`, and every
continuation under a diagnostic or an error. Those go through `wrap`, nothing enforces the
width but reading the output back, and six samples is not much reading.

So it checks that instead, and checks it over the corpus rather than a handful: every fixture
converted, plus every refusal the command line has, is **376 wrapped lines** against the six
it was looking at. All 376 hold at eighty — the wrapping was right, and the sentence above it
was describing something else. Widen `WRAP_COLUMNS` and it fails on a discontinuity hint at 96.

Same shape as 0.7.22 one release earlier, and the same lesson as the three before it: the
thing that goes stale is not the code but the sentence saying what has been checked.

## 0.7.22

### the guard against an uncrossed option was missing two

0.7.16 added a test to stop claim 5's coverage from drifting again. It read:

```js
for (const flag of ['--decimals', '--start', '--duration', '--gzip', '--layout', '--bom']) {
  assert.ok(crossed.has(flag), `the estimate sweep never crosses ${flag}`);
}
```

Six flag names, written out by hand, under a claim that the sweep crosses "every option that
changes what lands on disk". `--channels` is not among them, and `--channels` changes more of
what lands on disk than anything else there: it decides which columns are written, how many
rows each file gets, and — by taking a rate out of the conversion — which signal files exist
and what they are called. A mixed-rate recording narrowed to one channel stops writing
`signals_256hz.csv` and writes `signals.csv` instead. The estimate re-plans all of that and
promises the row count *exactly*, and the test that exists to notice an uncrossed option passed
over the largest one.

`--end` was missing too, beside the `--duration` that is crossed. They name the same far bound
by different arithmetic: `--duration` is measured from wherever the conversion starts, `--end`
is read on the recording's own clock, and only one of the two was ever exercised here.

This is the mistake `OPTIONS` in `cli.ts` already carries a comment about — "a second copy of
twenty flag names is a copy that will be missing the next one" — and the test written to
prevent a coverage gap was itself a second copy with two names missing. It reads the CLI's
option table now, and every flag in it must either be crossed or appear in a list of options
that cannot change a signal file's bytes, each with the reason it cannot. A flag added
tomorrow fails this until somebody classifies it, which is what the hand-written list could
never do.

The sweep goes from 466 predictions to **601**. Every row count is still exact and no byte
count reads under, so the arithmetic was right — what was missing was anything that could have
said so, for the third release in this shape and for the same reason each time.

## 0.7.21

### two lines named a clock in a notation the clock refuses

Two lines whose whole purpose is to say which numbers you may ask for, saying them in a
notation the parser refuses.

```
$ edf2csv far.edf --info
Timed from 1e+21s  (first sample; --start and --end use this clock)

$ edf2csv far.edf --start 9000000000000000000000
error: --start "9000000000000000000000" is at or past the end of this 3e+21s
       recording, which runs from 1e+21s to 4e+21s.

$ edf2csv far.edf --start 1e+21s
error: --start "1e+21s" uses an unknown unit "e". Use h, m, s, or ms.
```

The parenthesis on the first line is an instruction — type this back in — and the sentence on
the second exists to name the window there is to ask for. All three tokens are rejected. The
time parser refuses exponent form deliberately, for the same reason `--decimals` refuses
`0o5`: it is a form nobody types.

`toFixed` switches to exponent notation at 1e21, which `fixed` in the number formatter has
expanded with BigInt since the day a CSV cell read `1e+21.000`. These are the two places that
print a clock rather than a column, and neither went through it — the second re-introduced the
exponent a third way, through the `Number(...)` that was there to drop trailing zeros.

Reachable from a conforming file: an EDF+ timekeeping onset is plain digits of any length, and
a record duration wide enough to keep samples apart out there fits the header's eight
characters. Below 1e21 nothing moves — `Timed from 30.000s`, `-100.000s` and `this 2s
recording` are byte-for-byte what they were, since `fixed` is `toFixed` everywhere else and
normalises only negative zero.

The recording's *length* is still written as the file states it, `3e+21s`. That one is a
description beside `Size`, not a bound to ask for, and `formatDuration` says why it declines
to decompose a figure that size.

## 0.7.20

### a padded annotation duration was read as a zero

`Number('   ')` is `0` — the rule that makes `Number('')` zero, one step along. An EDF+
annotation whose duration field held nothing but the writer's padding took that zero and
wrote it out:

```
onset_s,duration_s,description,record_index
0.5,0,Spaces for a duration,0
0.6,,No duration at all,0
1.5,0,A real zero duration,1
```

The first row and the third are byte-identical in that column. The third file really did say
`0`; the first said `   `. An event lasting exactly no time is a claim about the recording,
and no writer made it — the same invention `+1.0<0x15>abc<0x14>` has been caught and counted
since the duration was first read, arriving through the one input that turns into a number
without containing a digit. Exit 0, no warning, and nothing in the CSV to read back that
would show the difference.

The empty field beside it — `+1.0<0x15><0x14>` — has always been read as "the file stated no
duration". Padding is that field with fill in it, so it takes the same answer and the cell is
left empty. `trim` empties exactly the strings `Number` would otherwise have swallowed into a
zero, so `  2.5  ` still reads as 2.5 and `abc` is still counted as unreadable.

It is the rule already applied twice elsewhere in this file — a chunk of nothing but padding
is not a lost annotation, a text segment of nothing but padding is not an event — reaching
the one field that had been left to `Number` to decide.

## 0.7.19

### two more hints printed commands the shell cannot carry

The same defect as 0.7.18, at the command line rather than in a channel label, twice.

```
$ edf2csv rec.edf --out "-my nightly"
error: --out was given "-my nightly", which begins with a dash and so reads as another flag rather than as its value.
       Write it as one argument instead: --out=-my nightly
```

`--out=-my nightly` is two arguments. Typed as advised, `--out` gets `-my` and `nightly`
becomes an input file. A quote is worse — `--out=-my"dir` does not parse at all — and the
unknown-option hint had it too:

```
$ edf2csv rec.edf --chan"nels" EEG
       edf2csv -- "--chan"nels"
```

Both of these are the hint that exists *because* the obvious form does not work. Answering
"here is how to type it" with something that also does not type is the failure this class
keeps producing: the header parser's `--channels` advice has now been fixed for an empty
label, a comma, a control byte and a quote, and these are the same shape one layer out.

A token is left exactly as it was when a shell would read it as written, so `--out=-nightly`
and `edf2csv -- "--chanels"` are byte-for-byte what they always were and every documented
example still reads the same. Anything else is single-quoted — the one POSIX form with no
escapes inside it, where a single quote in the value closes, escapes and reopens:

```
       Write it as one argument instead: '--out=-my nightly'
       Write it as one argument instead: '--out=-it'\''s'
       edf2csv -- '--chan"nels'
```

Checked by running them. The test takes the token the tool printed, pastes it into `/bin/sh`
the way a reader would, and asserts a conversion appears in the directory the awkward name
asks for — a space, a double quote and an apostrophe, the last being the one that makes naive
quoting wrong rather than merely insufficient. Matching the sentence would have passed against
the broken form.

## 0.7.18

### a hint printed a --channels command the shell cannot carry

```
warning: Signal 0's unit contains 1 control character (\x07), which will appear in channels.csv's unit cell exactly as the header has it.
         The column name is unaffected, so --channels "EEG "A1"" still selects it.
```

`--channels "EEG "A1""` is not a command. A shell collapses the adjacent quotes and hands over
`--channels "EEG A1"`, and the tool refuses it:

```
error: No channel named "EEG A1". Did you mean "EEG "A1""?
```

The suggester points back at the label the hint had just told the reader to type, which is the
loop closing on itself.

This hint exists to say how to reach a channel whose header text you cannot type, so a command
that fails is worse than none, and the comment above it already records three ways it had
failed before: an empty label produced `--channels ""`, which exits 2 saying no names were
given; a comma produced `--channels "EEG Fpz-Cz, ref"`, which splits on the comma and exits 2
naming half a channel; and a control byte in the label means the name cannot be typed at all.
Each of those routes to the by-position form instead. A double quote is the fourth, and the
only one where the advice is not even well formed before the tool sees it.

Reachable because the branch that quotes the label back is the one for a control byte
*somewhere else* — in the unit, the transducer or the prefiltering. The label is then perfectly
typeable in every respect except the quotes in it, which is exactly the case the "the column
name is unaffected" sentence was written for.

So a label containing a `"` takes the same route as the other three, and says which of the four
it is: *a quote in the label cannot survive being quoted back*.

EDF labels are free text, and a quoted montage reference is not a strange thing for an exporter
to write.

## 0.7.17

### narrowing was only ever checked in the wide layout

Convert a mixed-rate recording with `--layout long`, then convert one of its channels again to
check it, and the two disagree:

```
$ edf2csv many-rates.edf --out full --layout long
0.33333,ch3,0.100

$ edf2csv many-rates.edf --out one --layout long --channels ch3
0.3333,ch3,0.100
```

Same instant, same value, one decimal place apart. Nothing is wrong with either — it is the
long layout's shared time column doing what it is designed to do. Every rate lands in one
table, one column cannot mean three things, so its precision is the finest any rate needs. That
is the finest rate **in the conversion**, not in the file, and `--channels` changes which rates
are in the conversion. Narrow a 40-rate recording to one channel and the column stops needing
five decimals.

What was wrong is that nothing said so, and nothing checked it. Claim 8 on the correctness page
says asking for part of a recording returns that part unchanged, and the sweep behind it
converted with no options at all — so the property was verified in the wide layout, where each
rate has its own file and its own precision and narrowing genuinely is byte-for-byte, and never
in the layout where it is not.

The sweep crosses the long layout now. The comparison there is the property that actually
holds: same channel, same value, same order, and the same instant compared as a number rather
than as text. Stating it that way is the point — a byte-for-byte assertion would have failed on
correct behaviour, and quietly not running is how it avoided saying anything at all.

Both pages that describe the shared column now say which set it is taken over, and what follows
from that. Someone converting a channel to check their work is exactly the person who meets
this, and "the file I converted twice has different numbers in it" is a bad half-hour when the
numbers are the same.

Nothing about the conversion changes.

## 0.7.16

### the estimate sweep never crossed --bom

Claim 5 on the correctness page read:

> The row count is exact and the byte count never reads low, across every fixture crossed with
> **every option combination**.

The sweep crossed eight option sets. `--bom` was not one of them, and `--bom` has its own arm
of the byte arithmetic — `if (bom) bytes += BOM_BYTES`, three bytes per file, added once per
table rather than once per rate in the long layout. Nothing anywhere exercised it, underneath a
sentence saying everything was exercised.

Three bytes is exactly the size that hides. A one-row conversion is a few dozen bytes, so three
unaccounted for is the difference between an estimate that holds and one that reads under —
and reading under is the single direction this claim promises it never goes. It is the same
arithmetic that 0.6.x found wrong twice: once for a bound that gains a digit when rounded, once
for a time column that gains a minus sign.

`--bom` and `--bom --layout long` are crossed now, taking the sweep from 368 predictions to
**466**. Every one holds: the arm was right, and what was missing was anything that could have
told you so.

The claim says what is actually crossed — ten option sets, being the precisions, the windows,
both layouts, `--gzip` and `--bom`, which between them are every option that changes what lands
on disk. `--annotations-only` is excluded on purpose and the sweep has always said why: it
leaves no signal files, and signal bytes are what this estimate is about.

The guard checks the flags rather than the count, because coverage is the thing that slipped:
each option that changes the output must appear in the sweep's own option list, and claim 5
must not describe that list as more than it is. Both halves fail when reverted.

Third in a row of this shape — 0.7.12 and 0.7.13 were a sweep nobody ran and a list it was
missing from, 0.7.14 was a table covering fifteen of fifty. The pattern is not that the code is
wrong. It is that a sentence describing what has been checked outlives the checking.

## 0.7.15

### a destination ending in a dot was refused after being created

```
$ edf2csv rec.edf --out ./fresh/.
error: "./fresh/." already exists.
       Pass --force to overwrite it, or --out to choose a different directory.
```

`./fresh` did not exist. This run made it, one line before refusing it, and then left it there
empty and converted nothing.

`prepareOutputDir` claims the destination with a single non-recursive `mkdir` after creating
its parents recursively. That is deliberate and load-bearing: it is what makes two conversions
racing for the same directory safe, because exactly one of them can win the claim and the other
gets `EEXIST` from the filesystem rather than from a check with a window in it.

The parent is `path.dirname(dir)`, and `path.dirname("fresh/.")` is `"fresh"`. So for a
destination whose last component is `.`, the recursive parent step creates the destination
itself, and the claim then asks the filesystem to make `.` inside it — which exists in every
directory that has ever existed. `EEXIST` comes back, and the already-exists branch reports a
collision with a directory this run had just created.

`--force` does not rescue it. The claim fails identically whatever it is told, so the path was
not occupied, it was unusable — and the message sent the reader looking for output that was
never there.

`..` was the same shape with a truer message: `--out newdir/..` names the parent, which really
does already exist, so refusing was right. What was wrong is that it created `newdir` in order
to find that out and left it behind.

Both are fixed by normalising the destination, and only these: the test is that the last
component is `.` or `..`, which are the two that name something other than themselves.
`--out ./converted` keeps the spelling it was given, because that one is already how the
directory is found on disk — which is what `output_dir` is documented to be — and rewriting it
to `converted` would churn every example on the site for nothing.

**The test that nearly was not one.** The first version built the path with
`path.join(dir, 'fresh', '.')`, and `path.join` collapses the dot before it goes anywhere, so
it handed the CLI an already-normalised path and passed against the unfixed code. It builds the
string by concatenation now, and fails without the fix.

## 0.7.14

### "what each one covers" covered fifteen of fifty

The section is headed "The fixtures and what each one covers". It covered fifteen of them.

There are fifty files in `test/fixtures/generated`, and the table listed fifteen — so
thirty-five recordings, most of them written for a specific defect, existed as evidence nobody
could look up. Several are the evidence for claims made elsewhere on the same page: the
estimate sweep promises it never reads low, and `negative-origin.edf` is the recording that
proved it did; the long layout promises its rows come out sorted by time, and
`records-backwards.edf` is the one recording that breaks it.

All fifty are described now. Each row says what the file contains and what it pins down, taken
from the comment above it in `generate.mjs` rather than written fresh — that comment is where
the reason was recorded when the fixture was added, and it is more accurate than anything
reconstructed later.

Some of what was missing:

- `sub-nanosecond.edf` — two records of 1e-9 s, against a window slack that was a flat
  nanosecond, so ten of twenty rows vanished silently.
- `contiguous-fractional.edf` — an ordinary recording of 0.1 s records, where 0.1 + 2 × 0.1 is
  0.30000000000000004 and a continuity check written as equality failed a `--strict` run on a
  file with nothing wrong with it.
- `far-origin-negative.edf` — the same collapse as its positive twin, at -1e16, which the guard
  missed because it seeded a signed maximum with zero.
- `zero-first-annotation.edf` — a first annotation channel with no room in it, so the
  timekeeping in the channel after it went unread.
- `fractional-tie.edf` — two samples at the same instant one ULP apart, which a tie test
  written as equality does not see.

The guard reads the generated directory rather than a list, because that is what the heading
claims: a fixture added without a row is precisely the drift it catches. Renaming one row makes
it fail with `fixtures with no row: magnetometer.edf`.

The opening sentence now says all of them are listed, and says what it used to be — a heading
promising every one over a table holding a third is the sort of claim this page exists not to
make.

## 0.7.13

### the contributor's list of sweeps was missing the newest one

The guard added one release ago was too narrow, and the omission it was written for was still
sitting in a third file when it went green.

0.7.12 wired `npm run terminal` into CI and added a test that every sweep the correctness page
offers as evidence is run by some workflow. It checked two files. `CONTRIBUTING.md` carries the
list a contributor actually runs before opening a pull request, and it said:

```
The seven sweeps are separate, because they take minutes rather than seconds:
...
CI runs the first six on every push
```

Seven listed where there are eight, `terminal` absent from the list, and a count of what CI
runs that was already wrong before this line was written and is wronger now. A sweep missing
from that list is a sweep nobody outside CI ever runs — which for a contributor changing
terminal output is exactly the one they need.

So the test now reads that file too, and checks three separate things about it: that every
sweep named as evidence appears in the list, that "The N sweeps are separate" matches how many
there are, and that "CI runs the first N on every push" matches how many steps the `sweeps`
job actually has. The last is a claim about the list's *order* — everything before
`crossvalidate` runs on push — so it is checked against the workflow rather than against the
count, which is the only way it stays true when a sweep is inserted in the middle.

Each half fails on its own when reverted:

```
named as evidence but absent from CONTRIBUTING.md: terminal
CONTRIBUTING.md says CI runs the first six; the sweeps job runs 7
```

The lesson is the ordinary one about this kind of guard: it is only as wide as the set of
files you thought to hand it. Three files enumerate the sweeps, and a test written against two
of them proves nothing about the third.

## 0.7.12

### the sweep guarding the terminal was never run by anything

A sweep nobody runs is a claim nobody checks.

0.7.9 added `npm run terminal`, wrote it up on the correctness page as the tenth of ten
claims, and never wired it into CI. It has sat unrun for three releases — guarding the one
surface that produced two defects in this line precisely because nothing exercised it. The
progress meter and `--stdout --gzip` are terminal-only, every test in the suite runs with
stderr as a pipe, and the harness written to close that hole was itself outside everything
automatic.

0.6.58 gave the sweeps a CI job for exactly this reason: `npm test` covers the suite and not
the harnesses, so a regression in an invariant only a sweep checks ships in silence. The job
opens with a comment counting them — "The correctness page names seven sweeps as how this
project knows what it claims" — and it said seven while the page named eight. The same
failure as the claims heading fixed in 0.7.9, one file over: a number in prose that the thing
it describes has outgrown.

Seven of the eight now run on every push. `crossvalidate` stays on its weekly workflow because
it needs pyEDFlib installed and this package has no dependencies — which the comment now says
rather than leaving the reader to notice the absence.

The step cannot fail for the wrong reason. `terminal.mjs` borrows python3's `pty` module,
which `ubuntu-latest` has, and where python3 does not exist it reports that it checked nothing
and exits 0.

The guard reads the correctness page for every `npm run` it offers as evidence, then checks
some workflow runs each one — either as `npm run <name>` or as the harness the script invokes,
since the job steps call `node test/fuzz/<name>.mjs` directly so that a failure names the
invariant rather than the script. It checks the stated count against the list too. Removing
the new step makes it fail with "named as evidence but no workflow runs terminal".

## 0.7.11

### the package shipped four imports nobody read

Four imports nobody read, and a function nobody called, all of it shipped.

```
src/convert/run.ts(11,1): 'createHash' is declared but its value is never read.
src/convert/run.ts(12,1): 'createReadStream' is declared but its value is never read.
src/convert/run.ts(13,20): 'pipeline' is declared but its value is never read.
src/convert/run.ts(1513,10): 'rowsIn' is declared but its value is never read.
src/edf/reader.ts(20,10): 'decodeLatin1' is declared but its value is never read.
src/format/csv.ts(11,1): 'once' is declared but its value is never read.
```

In most projects that is lint noise. Here it is not, because `verbatimModuleSyntax` is on:
TypeScript keeps import statements exactly as written rather than eliding the ones whose
bindings are unused, so every line above was emitted into `dist/`, published to npm, and
resolved at startup by anyone who installed it. `dist/convert/run.js` opened `node:crypto`,
`node:fs` and `node:stream/promises` for three bindings it never touched, and
`dist/format/csv.js` opened `node:events` for one.

The first three are the checksum machinery, left behind when hashing moved into
`EdfFile.sha256()`. `rowsIn` had a doc comment — "Data rows across every signal table, so
'nothing was written' is one question" — and no callers.

The guard is the compiler: `noUnusedLocals` is now on, so this is a build error rather than
something to be noticed by reading. `npm test` builds first, so the suite fails too. Putting
any one of them back reproduces the message above.

Not `noUnusedParameters` alongside it. This codebase names a deliberately unused callback
argument `unused` rather than `_unused`, which that check does not accept, and renaming twenty
callbacks to satisfy a checker would be the tail wagging the dog.

Nothing about the conversion changes. `--checksum` still hashes, `--gzip` still compresses,
and the round-trip, layout and terminal sweeps all report what they reported before.

## 0.7.10

### --stdout --gzip put a deflate stream on the terminal

445,210 control bytes, straight at the terminal.

`--stdout --gzip` is a documented pair, and everywhere it is documented it is redirected:

```bash
edf2csv recording.edf --stdout --gzip > signals.csv.gz
```

Leave the redirect off and stdout is the terminal, so the deflate stream went to the screen.
For the smallest fixture here that is 244 bytes carrying 46 control codes and three ESCs; for
an ordinary recording it is the figure above. Some of those the terminal displays as mojibake
and some it acts on, and which is which depends on the compressed data, which is to say on
the recording. Nothing usable appears either way.

This tool escapes every control byte out of a header before printing it, on the stated
reasoning that a file should not be able to drive the reader's terminal — a recording holding
`\x1b[2J` can clear the screen, and nobody writes an EDF header that way on purpose. Emitting
several hundred thousand of them from output it generated itself is the same hazard with the
argument for it removed. gzip has declined to write compressed data to a terminal for thirty
years, which is where the expectation comes from.

```
error: --stdout --gzip would write compressed bytes straight to the terminal.
       Redirect it to a file or a pipe:
       edf2csv <recording> --stdout --gzip > signals.csv.gz
```

**Only when stdout is a terminal.** A pipe and a regular file both report `isTTY` false, so
the documented command is untouched and so is `| gunzip -c`. That is also why this cannot be
settled by refusing the flag pair the way `--stdout --json` is: the pair is correct, and it is
the destination that is not.

Found by the pseudo-terminal harness added in 0.7.9 for a different reason. That is two
defects now from the one surface the test suite structurally cannot reach — a captured stdout
is never a terminal, so every test in the suite runs with `isTTY` false and none of them can
see a terminal-only branch. `npm run terminal` now makes three runs instead of two, and also
asserts that every byte the refusal prints is text.

## 0.7.9

### a failed conversion printed its error onto the progress meter

```
  converting… 96%error: Expected 317440 bytes of data at record 1638 but only 0 bytes were
```

The progress meter writes `\r  converting… 47%` and leaves the cursor after the percentage.
Finishing a conversion took it down. Interrupting one took it down. Failing one did not — the
`finally` around that block removes the signal handlers and nothing else — so the error was
written onto the end of the meter.

That is the one property this output is shaped around. `error: ` and `warning: ` begin a line
so that a batch's stderr can be grepped for them; it is why the message on those lines is
left unwrapped at whatever width it runs to, and it has been the stated reason in every
release from 0.7.1 to 0.7.5. Here the prefix was mid-line, and `grep '^error:'` over a failed
run came back empty.

Taking the meter down is now one named function called from all three places rather than the
same escape sequence written at two of them.

**Why nothing caught it.** The meter only exists when `process.stderr.isTTY` is true, and a
test that captures stderr is reading a pipe, so the meter is off in every test in the suite —
all 367 of them, and every fuzz run. The feature has never been exercised by anything.

So there is now a tenth verification command, `npm run terminal`, which allocates a pseudo
terminal, fails a conversion under it, and asserts that whatever precedes `error: ` on its
line is a carriage return and an erase rather than the meter. Removing the fix makes it
report:

```
  "error: " does not start its line — preceded by "\r  converting… 96%"
```

It is not part of `npm test`, for the reason `crossvalidate` is not: Node cannot allocate a
pseudo terminal, so it borrows python3's `pty` module, and the CI matrix includes Windows. It
reports that it checked nothing, and exits 0, where that is unavailable.

**And the heading above it.** Adding a tenth claim to the correctness page meant counting
them, which turned up nine sitting under "## Eight separate claims" — in the section whose
own second sentence says the heading "did not keep up until 0.4.34". It did not keep up after
it either. Both the heading and the sentence restating the number are now checked against the
list they describe, along with the list being numbered 1..n without a gap.

## 0.7.8

### --quiet kept the blank line under the summary it removed

One stray blank line per recording, in the mode whose entire purpose is to print less.

The blank line under a block of warnings is there to separate them from the summary
underneath, which means it belongs to the summary. `--quiet` drops the summary and printed
the separator anyway.

On one recording that is a trailing newline nobody would notice. On a batch of five hundred
it is five hundred blank lines in a log, and it distorted the one place the spacing is load
bearing:

```
$ edf2csv mixed-rates.edf --out ./out --quiet --strict
warning: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.


--strict: 1 warning raised, so this run is reported as a failure. The output was
still written.
```

Two blank lines before the verdict, where the same run without `--quiet` shows one — because
the ordinary run spends that space on the summary and `--quiet` was leaving the gap where the
summary had been.

The test that covers `--quiet` converts `tiny.edf`, which raises nothing at all, so it
asserted an empty stderr and never reached the case. It now also converts a recording that
warns, and checks the `--strict` verdict is spaced the same way in both modes rather than
merely that the blank line is gone.

A batch under `--quiet` now runs its recordings' warnings together with no gap between them.
That is the intended shape rather than a side effect: `--quiet` suppresses the `[n/m]` header,
so since 0.5.49 every warning in that mode carries the path it came from, and what is wanted
there is a dense greppable log rather than a paginated one.

## 0.7.7

### a folder named with an escape byte drove the terminal

A directory named with an ESC byte put a live colour change on stderr — one line under an
`error:` line that had escaped the same path correctly.

0.5.67 established the rule and applied it: a path is untrusted text, a folder may be named
with an ESC byte and a file name may hold a newline on every platform this runs on, so every
path this tool prints goes through `printable` first. The `--info` File line, the `Wrote`
summary, the `[n/m]` batch header and every `error:` message have done so since. Two places
did not, and both are on failure paths, which is why the tests that cover this — all of which
convert successfully — never reached them.

**The hint under a refusal.** `ConversionError.hint` is a fixed sentence in every case but
one, which is why it read as text nobody supplies. The exception: a recording that shrinks
while it is being converted raises the reader's error, and the hint added to it names where
the partial output went.

```
edf2csv shrinking.edf --out $'out\x1b[31mred'

error: Expected 8386560 bytes of data at record 0 but only 2899456 bytes were
       available; the file appears to have changed size while it was being read.
       Make sure the recording is not still being written to, then try again.
       What was written to "…/out<ESC>[31mred" before it failed is incomplete
```

`--out` takes whatever path the caller gives it. `Diagnostic.hint` has always been escaped by
`formatDiagnostics`; this is the same field one class over, printed by `reportError`, and it
was the only line of that message not passing through `printable`.

**The empty-folder summary.** `No EDF or BDF recordings found in "<path>"` names the paths
straight off the command line. Coming from the caller is not the same as being typed by the
caller — a shell glob expands to whatever the directory holds, so `edf2csv ./study/*/` puts
directory names on stderr that nobody looked at. The batch interrupt handler's list of
abandoned destinations had the same shape and is escaped too.

Escaped, not stripped: the path still prints, as `esc\x1b[31mdir`, so a name that is causing
trouble stays diagnosable. That is the same trade `printable` has always made — a corrupt
field should be readable, just not executable.

The existing path-escaping test now covers a run that fails as well as ones that succeed,
which is the gap that let this sit. Reverting either fix makes it fail.

## 0.7.6

### three types crossed the API boundary without their names

You could hold the value, and read it, and not write down what it was.

```
import type { ConversionErrorCode } from 'edf2csv';
error TS2724: '"edf2csv"' has no exported member named 'ConversionErrorCode'.
              Did you mean 'ConversionError'?
```

`ConversionError.code` is a `ConversionErrorCode`. The field is typed, so reading it and
comparing it to a literal always worked — which is why nothing caught this. What did not work
is naming the type: no `function explain(code: ConversionErrorCode)`, no
`Record<ConversionErrorCode, string>` of messages, no `switch` the compiler checks for
exhaustiveness. The api page recommends exactly that pattern for `DiagnosticCode` two hundred
lines earlier ("a closed union, so a `switch` over it type-checks"), and both of this one's
siblings — `EdfErrorCode` and `DiagnosticCode` — have been exported since they existed.

Two more of the same kind. `ConversionPlan.estimate` is an `OutputEstimate`, and
`selectChannels()` returns a `ChannelSelection`. Both types were exported from their own
modules and neither from the package root, so the value crossed the boundary and its type did
not. The api page's list of types "available through `import type { ... } from 'edf2csv'`"
named twenty-one and was missing all three.

**Why the existing test could not see it.** The API test imports `dist/index.js` and reads
properties off the namespace, which is the right shape for checking that `convert` and
`EdfFile` are there. Types are erased before that file exists — a missing `export type` leaves
the JavaScript byte-identical, so no amount of importing it finds one.

So the guard is a compiler. It writes a consumer that names the declared type of everything
the API returns or exposes, points `paths` at `dist/index.d.ts`, and runs `tsc --noEmit`
against it; the assertion is that the output is empty. Deleting `ConversionErrorCode` from
`src/index.ts` makes it fail with the TS2724 above, which is the error a user would have got.

## 0.7.5

### a refusal naming a deep path ran to 268 columns

268 columns, and how far past 80 it got depended on how deep the caller's directories were.

Seven messages are written straight to stderr rather than raised as an error, so they never
passed through `printableLines` and none of the last four releases touched them. Five of
them interpolate a path:

```
error: --stdout writes a single CSV, and a folder is converted as a batch even when it holds one recording.
       Name the recording itself — /data/night-recordings/subject-0142/session-b/pre-sleep-baseline/rec.edf — or convert to a directory instead.
```

That is the one class of long line that no fixed choice of wording could have prevented, and
the one that gets *worse* on real data — the fixtures in this repository sit four directories
down and are already past 80 before the sentence around them starts. The interrupt handlers
are the same shape: "Incomplete, and should not be used: <destination>" after a Ctrl-C, and
"Files already written to <destination> are incomplete and should not be used" after one
part way through a batch. Two more carry no path and were merely long: the `--strict` closing
line at 95, and the "Nothing could be converted" summary.

All seven now go through the same wrap, five of them via a `detail()` helper that puts the
continuation in the same column as everywhere else.

**The path stays whole.** It is a single word with nowhere to break, so it overruns onto its
own line rather than being split across two:

```
       Name the recording itself —
       /data/night-recordings/subject-0142/session-b/pre-sleep-baseline/rec.edf
       — or convert to a directory instead.
```

which is the better shape anyway, because the path is the part that gets copied. The suite
asserts both halves: that no wrappable text passes 80, and that the path arrives on one line
unsplit. It builds a four-deep destination to do it, because every existing test used a
temporary directory short enough that the 268-column line never appeared.

That is the last of the terminal output. `--help`, warning hints, `--info`, refusal hints,
message continuations, and now the lines written directly — all 80 columns, all with the
long unbreakable words left long.

## 0.7.4

### an error that carried its advice in the message ran to 145 columns

0.7.3 wrapped `error.hint` and named this as the thing it was leaving: `ChannelSelectionError`,
`TimeRangeError` and `OptionError` do not carry a hint. They write their advice as a second
line of the message, and it landed in the same column, did the same job, and did not wrap.

```
error: "EDF Annotations" is this recording's annotation channel, not a signal: it holds event text rather than samples, so it has no column to select.
       Its events are already written to annotations.csv by any conversion of this file — pass --annotations-only for those and no signal data.
```

145 columns. So `printableLines` wraps every line after the first, and the first — the one
that follows `error: ` and gets grepped for — stays whole, as everywhere else.

**The reason this waited a release.** One of these messages ends in a command:

```
error: There is no --chanel option. Did you mean --channels?
       If it is the name of a file, pass it after -- instead:
       edf2csv -- "--chanel"
```

That last line exists to be pasted back into a shell. Wrapping it puts `edf2csv --` on one
line and the flag on the next, and what gets pasted is half a command — a worse failure than
the long line, and a silent one. Prose survives being re-flowed and a command does not, so
the two are told apart explicitly: a continuation beginning `edf2csv ` is passed through
untouched. A rule that has to be stated is better than one that happens to hold because
today's flags are short. The suite now asserts that line survives intact, not merely that
nothing is too wide.

Two callers write their indent into the message string rather than passing it, because they
print without an `error: ` prefix in front of them. Reading the line's own leading space when
none was given keeps both conventions working and keeps the wrap aligned under the same
column either way.

Still unwrapped, and next: the interrupt and batch-summary lines, which are written straight
to stderr rather than through this, and interpolate a destination path into a line whose
length then depends on how deep the output directory is.

## 0.7.3

### the same advice wrapped as a warning and did not as an error

The same sentence, about the same recording, laid out two different ways.

`edf2csv mixed-rates.edf --stdout` is refused, because three sampling rates cannot share one
table. `edf2csv mixed-rates.edf --info --stdout` describes the same refusal without
performing it. Both end on the same advice, and until now they printed it like this:

```
error: --stdout needs exactly one table, but this recording produces 3, one for each sampling rate its channels use (256 Hz, 128 Hz, 1 Hz).
       Narrow it to one rate with --channels, write --layout long to get them all in one table, or convert to a directory instead.

warning: --stdout would refuse this recording: needs exactly one table, but this recording produces 3, one for each sampling rate its channels use (256 Hz, 128 Hz, 1 Hz).
         Narrow it to one rate with --channels, write --layout long to get them
         all in one table, or convert to a directory instead.
```

One string, one file, one piece of advice. It wrapped when it arrived as a `Diagnostic.hint`
and ran to 130 columns when it arrived as a `ConversionError.hint`, and the only thing that
decided which was whether the tool went on to convert the file.

So `error.hint` goes through the same wrap. It is the third and last place terminal prose is
emitted: `--help` since it existed, warning hints in 0.7.1, `--info` in 0.7.2, refusal hints
here.

Only the hint. The `error: ` line above it carries the path the tool was given — a path is
one word and can be arbitrarily long — and stays a single line, for the same reason
`warning: ` does: a batch's stderr is grepped for it.

**Not changed, and worth naming.** `ChannelSelectionError`, `TimeRangeError` and
`OptionError` put their advice in the *message* rather than in a hint, on a second line
they write themselves:

```
error: No channel named "ZZZ".
       Run with --info to list the channels in this file.
```

That line sits in the same column and does the same job, and it does not wrap. It cannot
simply be fed through the same function, because one of these messages ends in a command
meant to be copied —

```
       If it is the name of a file, pass it after -- instead:
       edf2csv -- "--chanels"
```

— and wrapping `edf2csv -- "a really long flag"` puts half a command on each line. Prose
survives being re-flowed; a command does not. That distinction needs making explicitly
rather than by a rule that happens to hold for today's strings, so it is left for its own
change. The guard added here covers the hints, and will catch the day one of these grows
past 80.

## 0.7.2

### --info explained itself in 156-column sentences

156 columns, on the sentence explaining why a mixed-rate recording is split across files.

`--help` has been written to 80 columns since it existed. Hints under warnings joined it in
0.7.1. `--info` — the mode whose entire purpose is being read by a person before they commit
to a conversion — was still emitting whatever length the sentence happened to come out at,
and seven of its lines ran past 80:

```
Sampling rates differ, and the long layout puts them in one table anyway: each
row carries its own time, so nothing has to line up. No channel is resampled.
Would write 1,155 rows, roughly 32.4 KB.
```

Only the prose. Everything above it in `--info` is laid out in columns — the `Format` /
`Size` / `Patient` block, and the channel table — and those are aligned to each other, not
wrapped. Either can exceed 80 legitimately, because a header is free to carry a long patient
identifier or a long channel label, and re-flowing a column is how a table stops being one.
So the split is exactly where the columns end: everything below the channel table wraps,
everything above it is left alone.

The guard added in 0.7.1 was extended to cover this. It reads `--info` over every fixture
crossed with four option sets, finds the channel table, and asserts that no line after it
passes 80 — the header block and the table above deliberately excluded rather than exempted
by accident. Raising the wrap width to 300 makes it fail on 123-column lines, so it is
testing what it claims to.

The captured `--info` output on the landing page and in four documentation pages was
regenerated from a real run of the recording it names, which the docs suite already
re-derives and compares byte for byte.

## 0.7.1

### a hint under a warning ran to 180 columns

Seventeen of them, the widest at 180 columns, on the line that tells you what to do about the
warning above it.

0.6.132 looked at this and left it, on the grounds that `formatDiagnostics` is "one line per
diagnostic, prefixed so warnings are greppable" and that wrapping would break `grep warning:`
for anything reading the output of a batch. Half of that is right, and it is the half about
the message. The hint has never been on that line. It has always been emitted below it,
indented nine spaces, carrying no prefix — so `grep warning:` has never returned a hint and
nothing that greps this output can have been relying on its width.

So the head stays one line, at whatever width the message runs to, and the hint wraps at 80:

```
warning: Signal 0's label and unit contain 2 control characters (\x1b), which will appear in the CSV column name and in channels.csv's unit cell exactly as the header has them.
         Address the channel by position with --channels "#0" rather than by name,
         since the name cannot be typed. Printing the CSV to a terminal may do more
         than print it.
```

At 180 columns the terminal was already breaking that sentence — just wherever the window
happened to end, with the continuation starting in column one. The nine-space indent is the
only thing saying "this belongs to the warning above", and it was being lost at exactly the
width where there is enough text for the reader to need it.

Nothing about a `Diagnostic` changes. `hint` is still one unwrapped string, so `--json` and
the library API are byte-identical; the wrapping is in the terminal renderer, where the
column width is a fact. A word wider than the column is left to overrun rather than broken,
because the long words here are paths and quoted channel labels and neither survives being
split across two lines.

The documented samples on the website were regenerated to match, which meant separating each
hint from the message above it — the pages hand-wrap long messages for the page width, and a
naive rewrap folded those continuations into the hint. The split is made against the hint
texts in `src/`, so a sample is only rewrapped where the tool's own hint is found in it.

## 0.7.0

### the patch number reached 149

The patch number reached 149.

Semver puts no ceiling on it, which is why nothing ever forced the question — 0.6.149 is a perfectly
valid version and it sorts correctly against 0.6.150 in every tool that parses it. It just stops
working for the reader. "0.6.149" carries no shape: you cannot tell at a glance whether it is recent
or ancient, whether the gap to 0.6.62 is large, or which of two numbers in a changelog is newer
without counting digits. Two digits is a number a person compares; three is a serial.

So the patch rolls into the minor at 100, and this is the roll. The convention is written at the top
of this file, along with the part that matters most: it is not a claim that anything broke. Nothing
in this release changes behaviour — the same code that shipped as 0.6.149 ships as 0.7.0.

At the current rate that is a minor bump every few days, which is the honest description of what
this project's release cadence has been.

## 0.6.149

### any site could put these pages in a frame

The site sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`
on every response. The third of that set was missing: nothing said whether the pages may be put in a
frame, so anything could embed them.

For a documentation site that is a small thing, and it is not nothing. These pages carry controls —
a theme toggle that writes to storage, a copy button that writes to the clipboard — and a page you
can frame is a page whose controls can be operated by someone the reader cannot see.

`Content-Security-Policy: frame-ancestors 'none'`, which is the current spelling of that
restriction; `X-Frame-Options` is the deprecated one. A policy carrying only `frame-ancestors` sets
no `default-src`, so it restricts framing and nothing else — the inline theme script that runs
before first paint and the JSON-LD blocks on every page are untouched. `vercel.json` is strictly
validated, so it is checked for parse and for the three headers landing on the catch-all rule.

## 0.6.148

### the site could be installed on a Node the repository does not support

The package declares `engines: { node: ">=20.0.0" }`. The website, which is a separate npm project in
the same repository, declared nothing.

That was survivable while nobody was told to install it. 0.6.145 added a CONTRIBUTING file that says
`cd website && npm install`, which makes it somebody's next command. On Node 18 that install
succeeds, because Vite 6 accepts `^18.0.0 || ^20.0.0 || >=22.0.0` and React asks for `>=0.10.0` — and
then the build fails inside a dependency, with a message about neither Node nor this project. On
Node 19 or 21 it fails Vite's own range, which is at least a sentence naming Vite.

`>=20.0.0`, matching the package beside it, so one Node version serves the whole repository and npm
says which one before anything is downloaded. Three lines of manifest; it changes no output, and
the built site is byte-identical.

## 0.6.147

### the build checked one of the two ways a page points at its own ids

The build refuses to emit a page with a duplicate id or an `href="#..."` that matches nothing. It
was checking one of the two ways a document points at its own ids.

SVG uses the other one. A gradient, a mask, a clip path, a filter or a marker is reached through
`url(#id)`, and none of those were being looked at. The failure is quieter than a broken anchor:
nothing throws, nothing 404s, the property just resolves to none. The hero's edge fade is exactly
that — the mask that stops the four traces looking as though they begin and end at the border — and
a typo in its name would have removed it silently, on the largest thing on the homepage.

Four lines, in the guard that was already walking every emitted page. Confirmed by breaking it:
renaming the gradient to `faed` and leaving the reference alone stops the build with
`index.html: url(#fade) matches no element`, which is the sentence somebody wants at that moment.

## 0.6.146

### a release that changed only the stylesheet left the homepage dated older than itself

The sitemap's `<lastmod>` for the homepage was the newest of: every documentation page, Landing.jsx,
App.jsx and index.html. That list was written after the first version of this went wrong — the date
had been taken from `content/*.md` alone, and the 0.6.64 rewrite of the hero changed every sentence
above the fold without touching any Markdown.

Naming three files fixed that instance and left the shape of the mistake in place. The homepage is
also styles.css, Waveform, PhosphorScope, RateComparison and Nav, and none of them were on the list.
Six days ago is not the example: 0.6.140, five releases back, changed the stylesheet and nothing
else, so the date the sitemap reported for the homepage that day was the newest documentation page's
— older than the change that had just been made to the page. Which is the direction the comment
above it calls the costly one, because it tells a crawler not to bother re-reading something that
was rewritten.

It reads `src` now, as a directory, plus index.html. A directory cannot fall behind the files added
to it. Verified against the build: the homepage's lastmod is now 10:08:41, the stylesheet's commit,
where it had been 10:06:18 — a documentation page edited two minutes earlier.

## 0.6.145

### everything this project checks was undiscoverable from the repository

This repository has 363 tests, seven sweeps, four build-time guards in the prerenderer and a file of
tests that reads its own documentation and compares it to the source. None of that was discoverable
from the repository. `npm test` works and tells you nothing about the rest of it.

The specific way that costs someone: a change to behaviour fails a test in `test/docs.test.js`
naming a page they never touched — a diagnostic code table, a flag list, a number on the correctness
page. Without knowing what that file is for, the reasonable conclusion is that the test is broken.
It is not; the page is. That sentence is now written down.

So are the seven sweeps and what each one asserts, that they take a seed and a size, that the
website build refuses to emit a page that is quietly wrong, and that a version bump has to move four
files or the suite fails. The last one is not something a pull request needs — it is there because
it is the failure most likely to waste an afternoon.

And one paragraph on what gets declined, which is the only part that is opinion: this tool does not
invent data. Not resampling, not converting units, not closing gaps, not guessing at a header that
contradicts itself. A change that makes the output more convenient by making it less true is the
change that does not land.

## 0.6.144

### a bug report about a header arrived without one

Almost every question about this tool is a question about a header, and the recording is almost never
shareable — EDF stores patient identifiers in the header as plain text, so "please attach the file"
is a request most people in this field correctly refuse. SECURITY.md worked that out for advisories
and says what to send instead. Ordinary bug reports arrived through an empty text box.

There is a form now, and it asks for one thing above all: the output of `edf2csv rec.edf --info
--json`. That document reads the header and writes nothing, and since 0.6.127 it carries the version
that produced it — along with the format, every channel's calibration, and every warning raised.
Which is, in practice, the whole of what an answer depends on. Checked against a real recording: 3
channels, 2 warnings, the version, no data touched.

It also says to replace `patient_id` and `recording_id` before posting, and that nothing else in the
document identifies anyone. Asking for a header without saying that would be asking people to paste
a name and a date of birth into a public issue.

Blank issues stay enabled. A form that refuses the questions it did not anticipate is worse than no
form. Security reports are routed to the private advisory link instead, where they belong.

## 0.6.143

### a hung job would have held a runner for six hours

Seven jobs across four workflows, and not one of them had a `timeout-minutes`. GitHub's default is
360.

So anything that hangs rather than fails — an `npm ci` against a registry that stopped answering, a
sweep that loops on an input it cannot finish — holds a runner for six hours before anybody is told
anything, and `core` is a three-version matrix, so that is eighteen runner-hours for one stuck push.
The fuzz job added last release is exactly the shape that can hang: it generates inputs nobody has
seen, which is the point of it.

Each job now has a ceiling several times its real duration — 15 minutes for the suite, 30 for the
sweeps, 10 for the website build, 60 for the weekly fuzz — so a slow morning is still a pass and a
hang is a failure within the hour it happens.

## 0.6.142

### the fuzzer ran the same 300 files every time

The correctness page's fourth claim is that a damaged file is always reported and never a crash,
checked by corrupting real recordings byte by byte. 0.6.94 put that sweep in CI. It has run at seed
1 every time since.

Which makes it a regression test wearing a fuzzer's clothes. The same 300 corrupted recordings, on
every push, forever: once it has passed it can only fail again if the code changes underneath it.
The value of the claim is that damage takes forms nobody anticipated, and a fixed seed produces
exactly the forms it produced the first time and no others.

A weekly job now runs the two sweeps that generate their own inputs — the byte corrupter and the
folder-tree builder — at a seed taken from the date, and at several times the size: 2,000 corrupted
recordings against CI's 300, and 40 folder trees against 12. The seed is days-since-epoch and gets
printed, so anything it finds is reproducible with `npm run fuzz -- <seed> 2000` on any machine, and
`workflow_dispatch` takes a seed directly for exactly that.

Scheduled and on its own, for the reason the pyEDFlib cross-check is: this job can fail on a commit
that broke nothing, because what it finds was already there. That is a fine thing for a Tuesday
morning and a terrible thing to put between a pull request and a merge — which is also why CI keeps
its fixed seed and stays deterministic.

Run here at the current date's seed before committing: 480 runs over 120 corrupted recordings and 6
trees, all clean.

## 0.6.141

### a Windows checkout got line endings the suite disagrees with

This repository had no `.gitattributes`, so the line endings in a working tree were whatever the
person cloning had `core.autocrlf` set to — and Git for Windows turns it on by default.

That is not cosmetic here. The suite is largely a comparison between text this tool generates, which
is always LF, and text read back out of committed files. Put those on opposite sides of an equality
with `\r` in between and they stop matching. Demonstrated rather than assumed: converting
`output-files.md` to CRLF and running the suite fails the metadata.json shape guard immediately. The
structured data on this site claims `macOS, Linux, Windows`, and one third of that was a checkout
where the tests do not pass for reasons having nothing to do with the code.

`* text=auto eol=lf` decides it in the repository instead — LF in the object store, LF on checkout
everywhere, which is what tsconfig's `"newLine": "lf"` already demands of the compiler's own output.
Recordings, fonts, images and tarballs are marked binary so the normalisation cannot reach them:
none are committed today, since every recording is generated into a gitignored directory, but a
sample checked in later would otherwise be quietly corrupted by that rule.

`git add --renormalize .` reports no changes, so nothing in the tree moves — this only fixes the
next checkout.

## 0.6.140

### on paper, the majority of the documentation's links led nowhere

The print stylesheet already understood the problem: a link's destination is invisible on paper, so
it wrote out the address after any `http` one. It just solved the smaller half of it.

Across the eleven documentation pages there are 52 links the documentation makes to itself and 48 it
makes anywhere else. The internal ones are the majority, and they are the ones a printed page most
needs, because that is what these pages are full of — "see the CLI reference", "which
`--channels` would read as two names", "as above". Every one of those printed as an underlined
phrase leading nowhere. Getting started alone has eleven internal links and one external, so the
rule that existed covered a twelfth of that page's references.

The origin is written out rather than the bare path, since `/docs/cli-reference` is not something a
reader with a sheet of paper can do anything with. It matches the prerenderer's default `SITE_URL`.
Checked by reading the compiled print rules back out of the loaded stylesheet.

## 0.6.139

### the most-quoted table on the site had its headings checked by nothing

`--info`'s channel table is the most-quoted block on this site — four pages print its heading row —
and that row was the one part of it nothing checked. The test that compares `--info` output against
the documentation reads the header fields above the table, File and Format and Duration and
Channels, and stops there. The seven column names were written by hand in `src/cli/report.ts` and
again on each of the four pages, with nothing between them.

These names are not decoration. The CLI reference tells you to "match against the label from the
`LABEL` column of `--info`, not the `COLUMN` name" — advice that can only be followed while those
two words are the ones on screen, and that sentence lives on a different page from three of the
tables it describes.

They agree today. The check runs `--info` and requires every page printing a heading row to print
that sequence of names, compared as names rather than as text, since the column widths come from
whichever recording the page is using. Confirmed capable of failing: changing `UNIT` to `UNITS` in
the source alone turns it red on all four pages.

## 0.6.138

### two of the four output files had their columns described and never checked

A conversion writes four things. `metadata.json`'s shape has been guarded since its shape drifted:
"a key added to the record and not to the page reads as a key that does not exist; one removed reads
as a key they can rely on." That argument is not about JSON. It is about a documented output being
described in one place and produced in another.

`channels.csv` and `annotations.csv` are both described by a row-per-column table in output-files.md,
and neither had ever been checked against the file. `channels.csv` has fourteen columns, written out
by hand in the writer and again in the table.

They agree today, which is the good case and not the point — nothing was making them agree. The
check reads the header line of each file out of a real conversion and requires the table to list
exactly those names in that order. It is confirmed capable of failing: renaming `record_index` to
`record_number` on the page alone turns it red.

One row can name two columns, where the page explains a pair in a single sentence —
`| `physical_min`, `physical_max` | ... |` — so a row contributes the set of names in its first
cell rather than one name.

## 0.6.137

### one box, its height decided in three places

`.docs__toc` was declared twice, thirty-eight lines apart, with four unrelated selectors between
them. The first block is the box: grid, gap, padding, border, background. The second added the two
declarations that decide how tall it is and that it scrolls.

Nothing was wrong with the result — the browser merges them — but a reader of the first block had no
reason to think the box was capped at all, and it had already cost something. 0.6.107 needed to
lower that cap on a phone and could only do it by adding a *third* `.docs__toc` block in a media
query, so the height of one box was being decided in three places, none of which was where the box
is defined.

One block now, with the cap in it and a line pointing at the narrow-viewport override that lowers
it. Computed styles read back identical either side of the change: 480px and `auto` on the desktop
page, 176px and `auto` at 375 wide.

## 0.6.136

### the workflow that signs the release trusted three moving tags

Thirteen `uses:` lines across three workflows named their actions by major tag — `actions/checkout@v4`
and so on. A tag is a mutable pointer. `@v4` is whatever the `v4` ref names on the day the job runs,
which is a reasonable trade for most repositories and a strange one for this one.

This repository publishes with npm provenance. That is an attestation, signed by Sigstore, that the
tarball on the registry was built by this workflow, from this repository, at this commit — and the
value of it rests on knowing what the workflow did. Under a moving tag the answer is "whatever those
three actions were that morning", which is precisely the link the attestation is meant to close.
`publish.yml` is where that argument bites, and it now says so beside the pins.

All thirteen are commit SHAs now, each with its version in a trailing comment. That comment is not
decoration: it is the form dependabot reads, so the weekly check added in 0.6.113 still proposes
upgrades — as a diff naming a new commit, which is a thing a person can look at, rather than as
nothing at all.

## 0.6.135

### every jump to a section overshot it by a full header

Clicking an entry in a page's contents left the heading 192 pixels down the viewport. It was meant
to land at 96.

Two rules were doing the same job and the browser applies both. `html { scroll-padding-top: 6rem }`
tells the scroller to stop that far short of a target; `scroll-margin-top: 6rem` on the h2 and h3
tells each heading to keep that much space above itself when scrolled to. They add. Measured
directly: with both set the heading lands at 192, with either one alone it lands at 96.

96 is right — 28 pixels clear of the 68-pixel sticky header. 192 puts it 124 clear, an eighth of a
laptop window given to blank space above the section somebody just asked to be taken to, and on the
warnings reference that is 53 contents entries every one of which overshoots.

`scroll-padding-top` is the one kept. It belongs to the scroller, so it covers every target on the
page — including `#main`, which is where the skip link goes and which the heading rules never
touched. The pair it replaces covered h2 and h3 and nothing else. Checked afterwards on an h2, an
h3, and the skip link's target.

## 0.6.134

### the site never linked the changelog

Every release this project has made is described in `docs/CHANGELOG.md`, at some length. The
documentation site linked it from nowhere: not the footer, not the twelve cards on the landing page,
not `llms.txt`. The README has the link, and the README is not on this site.

The documentation answers what the tool does now, which is a different question from the two people
actually arrive with: when did this flag appear, and does the version I have got the fix. Both are
answered in a file that was one click away from GitHub and no clicks away from anywhere else.

It is in the footer now — the one that is a single constant since 0.6.67, so the documentation
pages, the 404 and the landing page all got it at once — and in the Source section of `llms.txt`,
where an agent asking what changed can find it. Checked at 1280 and at 375, where the three links
still sit on one line.

## 0.6.133

### the security policy was invisible from npm, where the package lives

0.6.97 gave this project a security policy. Everywhere it is actually read, it was invisible.

`files` is `["dist", "README.md", "LICENSE"]`, so SECURITY.md is not in the tarball, and npm shows
the README and nothing else — so the package page, which is where most people meet this tool, had no
route to a private report at all. GitHub does surface SECURITY.md in its own interface, which is
what made this easy to miss: the file looked findable because it was findable from the one place its
author looks.

The README now says where to report and links the policy for the rest. Six lines, on the page every
consumer of this package already has in front of them.

## 0.6.132

### the help table came apart on an eighty column terminal

Eighty columns is what a terminal is unless somebody has changed it. `--help` had six lines between
81 and 86, and three refusals ran to 104, 108 and 114.

For the help text that is not an aesthetic complaint. The option list is three aligned columns, and
when a line wraps its tail lands under the flag names — so the alignment that makes the table
readable is the first thing a narrow terminal destroys, on the six longest and most detailed
entries.

The longest line the tool printed was newer than the rest and mine: the unknown-option hint added in
0.6.115 ran to 95 columns.

```text
error: --stdout and --checksum cannot be combined: --stdout writes no
       files, and --checksum has nothing to act on.
       Drop --checksum, or drop --stdout and convert to a directory.
```

Every one of these strings is wrapped by hand, so nothing enforced the width and nothing was going
to notice. There is a check now: it runs `--help` and six refusals and measures what comes back. It
found the three `--stdout` combination errors on its first run, which is why it exists rather than a
one-off tidy-up.

Scoped to the usage text and the refusals, deliberately. Diagnostic messages are wider still — 42
distinct lines across the fixtures run past eighty — and they are quoted verbatim throughout the
documentation and pinned by a dozen tests, so rewrapping them is a change to make on its own rather
than alongside this.

## 0.6.131

### the first page anyone reads said to open it in Excel the one way not to

Getting started is the page a first-time reader opens, and its Excel section said: "Open
`signals.csv` directly. It's plain UTF-8 CSV with a header row and needs no import wizard." The only
caveat it gave was the row limit.

That is the one piece of advice this tool has both a flag and a warning against.

Excel on Windows reads a CSV with no byte order mark in the system code page rather than as UTF-8,
so `µV` — one character, two bytes — arrives as `Âµ`, in the unit column of an EEG conversion. That
is exactly what `--bom` exists for; the flag's own help text says so, and this page did not mention
`--bom` once, in any section. It also says why it is not the default, because that matters: Python's
`csv.reader` over a plain `open()` and Node's `readFileSync(path, 'utf8')` both hand the first
column back as `﻿time_s`, so a lookup of `time_s` misses. On for a spreadsheet, off for code.

And `FORMULA_LABEL`, added four releases ago, warns that a label beginning `=`, `+` or `@` is run as
a formula by a spreadsheet rather than shown as text — where its own hint says to use the text
import path. "Needs no import wizard" was the page steering people around it.

## 0.6.130

### a test raced a signal against a process that was not listening yet

Two tests spawn a conversion, wait 400 ms, send SIGINT, and require the exit status to be 130 with
the tool's own "interrupted" message on stderr. During this batch one of them failed on a commit
that had nothing wrong with it:

```text
  actual: null,
  expected: 130,
```

`null` is not a wrong exit status, it is no exit status. A Node process only survives SIGINT once it
has a listener for it, and this tool installs its handler when the conversion starts. Until then the
default takes the signal and terminates the process outright, and `close` reports `code: null` with
`signal: 'SIGINT'`. Four hundred milliseconds is normally plenty to get past startup — and this
suite runs its own conversions in parallel, so under that load it sometimes is not.

The tests already know about one race of exactly this kind: if the pre-write scan finishes before
the signal lands, the run is skipped, because losing the race says nothing about the message being
tested. This is the same situation at the other end, and it is treated the same way — a skip that
names the reason rather than a red tick on a good commit. Both branches checked directly: a child
with no handler comes back `{code: null, killedBy: 'SIGINT'}` and takes the skip, one with a handler
comes back `{code: 130, killedBy: null}` and is asserted on as before.

Flaky tests are worse than missing ones. A suite people have learned to re-run is a suite that stops
being read, and this one is what `prepublishOnly` gates a release on.

## 0.6.129

### nothing ever installed the package and ran it

Every check in CI ran against the working tree, where `npm test` has just built the code. Twice the
thing that was broken was the tarball, and neither time could any of those checks see it: 0.5.30
published four files and no `dist/` at all, and 0.6.117 — eleven releases ago — shipped a manifest
whose `bin` pointed at a `dist/cli.js` no lifecycle hook was building, because `prepack` does not
run for a git install.

The suite reasons about the manifest: `files` says what ships, `bin` and `exports` say what has to
be in it. That is a check on what the package *claims*. Nothing packed the thing and used it.

A job now does. It runs `npm pack`, installs the tarball into an empty directory somewhere else —
the way anybody else gets this package — and asks it the two questions a consumer asks: does
`edf2csv --version` run and report the version the manifest declares, and does `import('edf2csv')`
hand back `convert`, `EdfFile` and `parseHeader`. Neither can pass against a tarball with no code in
it, which is exactly what both of those releases shipped.

Its own job rather than a step on the existing ones, so a failure says "tarball" instead of being
the last line of a matrix entry, and so it runs beside them instead of after.

## 0.6.128

### a sample metadata.json claimed a version 125 releases old

The documentation prints a whole `metadata.json` as its explanation of the format, and the comment
beside the test that guards it calls that transcript "what someone reads before writing code against
it". It said `"version": "0.2.0"`. The package is at 0.6.128. A hundred and twenty-five releases,
sitting in the sample that teaches the file.

The test guarded the record's *keys* and never looked at what was in them, so the one value in that
document that cannot help going stale was the one nothing watched.

0.6.127 then added four more of them: the `--json` samples on four pages, each printing the release
that happened to be current when they were written, each of which would have been wrong by this one.

They all read `"..."` now — which is what the landing page's copy of the same object has shown since
it was written, and the only thing a sample can say about a version and still be right next week. A
check alongside the key guard refuses any other value, in any documented tool object, on any page.

## 0.6.127

### the JSON meant for a pipeline never said which version wrote it

`metadata.json` has carried `"tool": { "name": "edf2csv", "version": "..." }` since the file
existed, so a conversion can be reproduced later. Neither JSON *stream* carried anything of the
kind — not the `--json` conversion summary, not `--info --json`.

Those are the two that most need it. A `metadata.json` sits in the directory it describes, beside
the CSVs it belongs to. A `--json` document exists to be piped into `jq`, appended to a log, or
committed next to a result, and it gets separated from its run immediately and permanently. The
question a year later is which release's field names, rounding and warning codes these are, and the
document could not answer it. The same reasoning that put a version on `llms-full.txt` in 0.6.83:
the copy travels further than the thing it describes.

```json
{
  "tool": { "name": "edf2csv", "version": "0.6.127" },
  "output_dir": "./converted",
  ...
```

The same object and the same key as `metadata.json`, first in the document, so a consumer reads one
field whichever of the three it is holding. Both shapes, both documented, and every sample of them
across the four pages that print one has been updated to match.

## 0.6.126

### the header never said which page you were on, and had a style for it

Three of the header's four links go to documentation pages — Docs, CLI, Correctness — and the
stylesheet has had a rule for marking the one you are on since the header existed. Nothing ever set
the attribute it selects on, so the rule matched no element on any page, and a reader on the CLI
reference got a header identical to the header on every other page. Two ways to fix a rule with no
markup, and this is the one that keeps the behaviour the rule was written for.

The token is `aria-current="page"` rather than `"true"`, in the header and in the sidebar both. Both
values are valid; `"page"` is the one defined for "this is the current page in a set of pages", and
a screen reader announces "current page" for it where `"true"` gets the generic "current item". The
sidebar has said `"true"` since it was written — the right idea in the wrong word, on the control
whose entire job is answering "where am I".

The list of files on the landing page keeps `"true"`, and that is not an oversight: those are six
sample files, not six pages, and `"page"` would be a claim about the browser's location that is not
true of any of them.

Checked on the built pages: the CLI reference marks two elements, the header's `CLI` and the
sidebar's `CLI reference`, and both render at full-strength text against the dimmed links around
them. The 404 marks nothing, since it is not one of the pages.

## 0.6.125

### the security policy knew the labels were hostile and named one place they go

The security policy listed four things that are in scope, all of them about the parser and the
filesystem: reading or writing outside the given files, a crash instead of a reported error,
unbounded memory or disk from a lying header, and anything escaping the output directory "including
through channel labels, since those are attacker-controlled text that reaches filenames".

It knew those fields were attacker-controlled and named only one of the places they go. The other
one is the CSV itself, which is the whole product: four free-text header fields written through
verbatim into a file the README says opens in Excel. 0.6.124 added the warning for the case that
matters today; the policy is what tells someone who finds the next one that it is worth reporting.

So the scope now says it in general — a way for header text to reach something that executes it —
rather than enumerating the one instance. It also records the answer, because a reporter should know
it up front: these fields are written unchanged on purpose, the tool warns rather than rewrites, and
"the CSV no longer says what the recording says" is not an acceptable fix here.

## 0.6.124

### a channel label could be a spreadsheet formula and nothing said so

Excel, LibreOffice and Google Sheets read a cell beginning `=`, `+` or `@` as the start of a formula
rather than as text, whatever file it arrived in. EDF's label, unit, transducer and prefiltering
fields are free text, and this tool writes all four through unchanged into a CSV header row and into
channels.csv — so a channel labelled `=1+1` opens as a column headed `2`, and one labelled
`=HYPERLINK("http://...","EEG")` opens as a link nobody in the reading chain wrote.

The README says the output opens in Excel. SECURITY.md already calls these four fields
attacker-controlled, because they reach filenames. This is the other place they reach something that
executes text, and until now nothing anywhere said so.

```
warning: Signal 0's label starts with =, which Excel, LibreOffice and Google Sheets read as
         the start of a formula rather than as text.
         The text is written exactly as the header has it, so the cell is what the recording
         says. Open the CSV with pandas or R, or import it into the spreadsheet as text, if
         you do not want it evaluated.
```

Said, not rewritten. The usual mitigation is to prefix the cell with an apostrophe, which means
writing something the recording does not contain — the one thing this tool refuses to do.
`NONPRINTABLE_LABEL` answers control bytes the same way and for the same reason.

Not `-`, which the same advice usually includes. A lone `-` is a real convention for "no unit" and
is in the fixtures already, a leading `-` on a montage label is ordinary, and neither is evaluated
unless what follows parses as a formula. A warning that fires on files that are fine is a warning
that stops being read — 0.5.10 is what that costs.

Raised per channel and by `--info` as well as by a conversion, so it appears before anything is
written. Documented on all three pages the other codes are on, and checked against a recording
carrying `=1+1` as a label, `@lookup` as a unit and `-A1` and `-` as the two that must stay quiet.

## 0.6.123

### the citation file had no year in it

`CITATION.cff` is the file GitHub's "Cite this repository" button reads, and the file a reference
manager imports. It carried a title, an abstract, an author, a repository, a licence and a version,
and no date.

`date-released` is where every citation format gets its year. Without it the generated APA line has
no year in it and the BibTeX entry has no `year` field — from the one file in this repository whose
entire purpose is being correct in somebody else's bibliography. The version has been guarded since
0.5.27, after it sat 107 releases behind; the field that carries the date was simply never there to
drift.

The suite checks its shape rather than its freshness: a real calendar date, in the `YYYY-MM-DD` form
CFF 1.2.0 asks for, and not in the future. No test here can tell "released yesterday" from "the
field was forgotten", and a date one release old is a much smaller problem than no date at all. It
moves with the version at release time, the way the version itself does.

## 0.6.122

### a tarball left by npm pack would have been committed into the package

`npm pack` writes `edf2csv-<version>.tgz` into the repository root, and nothing ignored it. Commits
here are made with `git add -A`, so the next one would have swept up a 316 kB copy of the package
into the package's own history.

The repository already has a guard for exactly this — "tracks nothing at the top level that nobody
put there on purpose", written after a stray `undefined/` directory sat in the tree for eighty
versions — but the way that guard reports a stray tarball is by failing the suite, and the suite is
what `prepublishOnly` runs. So the sequence was: pack a tarball to look at, commit anything, and the
next release cannot publish until someone works out why. One line in `.gitignore` costs less than
the diagnosis.

Verified by packing for real: `git check-ignore` now attributes the tarball to `*.tgz`, and
`git status` no longer offers it.

The same commit corrects a sentence 0.6.117 left behind: the paragraph explaining that test still
named `prepack` as the hook guaranteeing `dist/` exists, two releases after the hook became
`prepare` and the assertion beneath it changed to match.

## 0.6.121

### two comments addressed to a linter this repository does not have

Two lines in this repository were addressed to ESLint:

```text
src/cli/report.ts:53          // eslint-disable-next-line no-control-regex
website/src/components/Waveform.jsx:100   // eslint-disable-next-line react-hooks/exhaustive-deps
```

There is no ESLint here. No config at the root, none under `website/`, not in either manifest, not
in any workflow. They are instructions to a program that has never run, and they were doing the
work a comment should have been doing: `no-control-regex` on a function whose entire job is
rendering control characters as escapes, and `exhaustive-deps` on an effect that leaves `paint` out
because it is rebuilt every render and listing it would re-run the effect on every render to redraw
the identical frame.

Both now say that, in English, to the reader who is actually going to be looking. A suppression
comment answers a question nobody asked and, worse, hides the answer to the one somebody will.

## 0.6.120

### a rule for focusing something nothing can focus

Every h2 and h3 on a documentation page carries a `#` permalink, hidden at opacity 0 until the
heading is hovered. The stylesheet also revealed it on `:focus`, and the comment above described it
as visible "until the heading is hovered or it is itself focused".

There is no such thing as it being focused. The anchor is `tabindex="-1"` and `aria-hidden="true"`,
on purpose — a page like the warnings reference has fifty-three of them, and announcing fifty-three
"link, permalink" stops would cost a screen-reader user more than the permalinks give. Out of the
tab order, not focused on click in this browser either, and nothing on the site calls `.focus()` on
one. The selector had nothing it could ever match.

Two lines, and neither is the point. The point is that a reader of this stylesheet was being told
the permalink has a keyboard route to it, one directory from the file that explains why it
deliberately has none.

## 0.6.119

### a style shipped to every reader since the first commit, on nothing

`.eyebrow` — a small uppercase mono label in the accent colour — was in the stylesheet from the
website's first commit and has never been on anything. Not in a component, not in the prerenderer,
not in a single emitted page, across 416 commits.

Unlike an unused JavaScript export, an unused CSS rule is not tree-shaken: it was in the stylesheet
every reader downloads, on every page, for the whole life of the site. Small — the file goes from
16.92 kB to 16.84 — but the reason to take it out is not the bytes. It is a named thing that looks
available, and the next heading that wants a label would be given a class the design no longer has
any opinion about.

Checked by listing every class selector the stylesheet declares against every class that appears in
the components, the prerenderer and all thirteen built pages. Eighty selectors, and after this one
none of them is unused.

## 0.6.118

### the 404 drew a line meant for a sidebar it does not have

The 404 page lists the documentation, using the same markup as a documentation page's sidebar with a
`docs__nav--static` modifier on it. That modifier exists to say "this one is in the page, not beside
it", and exactly one declaration was reading it: `position`.

So the 404 quietly took everything else aimed at a collapsed sidebar. On a phone it got a rule whose
whole purpose is separating a sidebar from the article it had been sitting above — and drew a
horizontal line across a page that has no article, directly under the sentence "The documentation is
below, or start from the beginning." It read as a mistake because it was one. 0.6.106 changed which
edge the line was on without noticing it was on the wrong page.

The mobile rule is scoped to `:not(.docs__nav--static)` now, so the modifier governs the whole
treatment rather than one property of it. Checked on both: the 404's list has no border and no added
padding, and a documentation page still moves its sidebar below the article with the separator
intact.

## 0.6.117

### installing from a git URL got a bin pointing at a file nothing built

`npm i github:tayal-sarthak/edf2csv` installed a package with no code in it.

The manifest had `prepack: npm run build`. npm runs `prepack` for `npm pack` and `npm publish`, and
for nothing else. The hook it runs when a package is installed **from a git URL**, or from a
checkout, is `prepare` — and there wasn't one. So a git install cloned the repository, installed
nothing else, and left `bin.edf2csv` pointing at `dist/cli.js`, a file the build had never been
asked to write. The registry install was always fine, because the tarball carries a built `dist/`;
it is the two ways of installing straight from source that got a manifest describing files that
were not there.

Shown by cloning to a fresh directory and running plain `npm install`, which uses the same hook: no
`dist/` before, no `dist/` after, `bin` target missing. Add `prepare` and the same clone comes out
with `dist/cli.js` present and `--version` answering.

`prepare` replaces `prepack` rather than joining it, since it runs on pack and publish as well —
everything `prepack` covered plus the two cases it did not. A registry install still does not build,
which is correct: it already has the compiled code. The suite now checks for the hook that covers
all four rather than the one that covered two.

## 0.6.116

### the tool knew which flag you meant and did not say

The refusal last release finishes its sentence and carries the prefix, and it still did not say the
useful thing. `--chanels` is a missing `n`, and the reply was a paragraph about passing files whose
names begin with a dash. The tool knows all twenty of its options; it can say which one that is.

```text
error: There is no --chanels option. Did you mean --channels?
```

Two shapes of mistake, two rules. An unfinished name is a prefix — `--chan`, `--decimal` — taken
only from three characters up, so `--c` is not resolved to `--channels` or `--checksum` by coin
toss, and only when exactly one option starts with it. A misspelt name is within a couple of edits,
the allowance scaled to the option's own length so `--jobs` cannot be reached from three characters
away.

A wrong guess is worse than none, because it sends someone to re-read a flag that was never the
problem. So `--xyzzy` gets no suggestion, `-Z` gets none — one character is not evidence — and
`--st` gets none, since `--start`, `--strict` and `--stdout` all answer to it. Checked in both
directions.

The option list is one constant now, read by `parseArgs` and by the suggestion. A second copy of
twenty flag names is a copy that will be missing the next one.

## 0.6.115

### a mistyped flag got Node's sentence, and Node never finished it

Mistyping a flag is the most common way to get a command wrong, and it was the one refusal this
tool did not write. It printed Node's:

```text
Unknown option '--chanels'. To specify a positional argument starting with a '-', place it at
the end of the command after '--', as in '-- "--chanels"
```

Three things are wrong with shipping that. The sentence does not finish — Node opens a quote before
`--` and never closes it, so the last thing the reader sees is a dangling `'`. It has no `error:`
prefix, which every other refusal in this tool carries and which is what separates a message from
the output around it. And the advice answers a different question: it explains how to pass a *file*
whose name starts with a dash, to someone who has just misspelt one of twenty flags.

```text
error: There is no --chanels option.
       If that is the name of a file, put it after -- so it is read as one: edf2csv -- "--chanels"
```

The dash-file advice is kept, because that case is real and the message is the only place it is
said — it is simply no longer the whole answer. Short options come back the same way. Node's other
two, a switch given a value and an option missing its value, are still Node's: they say something
true in words a reader can act on, and rewriting them would be churn.

## 0.6.114

### a comment restated the false fact that cost a channel 69 percent of its samples

`MAX_DECIMALS = 20` in convert/options.ts was labelled "the largest `toFixed` will accept". It is
not. `toFixed` takes 0 to 100 and throws a RangeError at 101.

That exact sentence is the one `edf/scale.ts` was written to correct. `MAX_DERIVED_DECIMALS` used
to be 20 "on the stated grounds that 20 was what `toFixed` allowed", and the consequence is
recorded there: a magnetometer channel spanning ±1e-16 T over a 16-bit converter steps by 3.05e-21
and needs 23 places, so clamping it to 20 landed every value on a 1e-20 grid — about three digital
codes to a printed value — and 69% of the samples could not be recovered, with the conversion
exiting 0 and nothing said.

The limit on `--decimals` is not wrong. It is a bound on a number a person types by hand, which is
what both documentation pages say, and the derived precision that nobody types runs to 100. What
was wrong was the reason written beside it: the same false fact, still stated as fact, one
directory from the file that documents what believing it cost. That is how it comes back.

## 0.6.113

### nothing was watching the dependencies the site actually has

Nothing in this repository was watching its dependencies.

"No runtime dependencies" is the package's own claim and the suite checks it, which made it easy to
read as "no dependencies". It is not the surface. The website ships React, motion and marked to
every reader and builds with Vite; the root carries TypeScript and @types/node; and three workflows
pin actions by major tag. An advisory against any of them would have sat there until somebody
happened to run `npm audit`, and nobody was going to — the same shape of gap as 0.6.97, which added
a way to report a vulnerability to a project that had none.

Weekly, and grouped: minor and patch updates arrive as one pull request per ecosystem, a major comes
on its own because that is the one worth reading. The failure mode of this file is a pull request
every morning until someone deletes it, so it is configured not to do that. Three entries, one per
ecosystem, both lockfiles present for the two npm ones.

## 0.6.112

### every build printed a warning about a script no build can resolve

Every build printed this:

```text
<script src="/_vercel/insights/script.js"> in "/index.html" can't be bundled without
type="module" attribute
```

Vite treats a root-absolute `src` in index.html as a build input and tries to resolve it. This one
cannot be resolved and never will be: Vercel serves it at request time and no build writes it. So
the warning was correct about the fact and wrong about it being a problem — and a warning printed by
every green build is a warning that trains you to skim past the next one, which will not be this.

The tag was also the last thing on this site written out by hand in three places: index.html, the
documentation page template and the 404. It is one constant in the prerenderer now, added to all
thirteen pages including the landing one, for the same reason the footer became one in 0.6.67 and
the header in 0.6.100.

A clean build from an empty `dist/` prints nothing but its two summary lines, and all thirteen pages
carry exactly one analytics tag, in the head.

## 0.6.111

### a helper nobody calls was still holding the id rule 0.6.87 replaced

`highlight.js` still exported `highlightWithin` and `addHeadingAnchors`, a pair of browser passes
over markdown rendered at runtime, and `content.js` still exported `docPath`. Nothing has called any
of the three since the documentation became prerendered: `renderMarkdown` highlights the code and
stamps the ids at build time and marks the blocks `data-highlighted`, so there is no second pass to
make. Vite tree-shakes unused exports, so all three were absent from the bundle and cost nothing,
which is why they sat there.

They are gone because of what one of them contained. `addHeadingAnchors` computed ids as
`node.id || slugify(text)` — the plain rule, one id per heading text — which is exactly what 0.6.87
replaced with `makeSlugger` after the warnings page shipped two `NO_SAMPLES` headings both answering
to `#no_samples`. It looked like a working helper and would have put that bug straight back. A
function nobody calls costs nothing; a function nobody calls that holds a rule this project has
already fixed is a trap with a tidy name.

The file's own header described a pass over the DOM, which had not been true of anything left in it,
so that is corrected too. The landing page still ships its 48 highlighted tokens and the CLI
reference its 128 and 29 heading permalinks.

## 0.6.110

### a hash comment in a code block counted as a heading

The site has two things that walk the headings of a page. `renderMarkdown` stamps ids on what
marked parsed as a heading; `extractHeadings` builds the contents list from a regex over raw lines.
Since 0.6.87 both feed the same slugger, which numbers repeated headings, so the two only agree as
long as they agree about what a heading *is* — and the regex one counted a `##` at the start of a
line inside a fenced code block. That is a comment in a shell script and in Python, and a heading in
neither.

A page with two `## Flags` sections and a `## Flags` comment in a code block between them listed
`flags`, `flags-2` and `flags-3` while the page carried `flags` and `flags-2`. So the contents entry
for the second real section pointed at nothing, and the entry taken from the code comment pointed at
the second real section. That is 0.6.87's failure exactly, one layer up: not a broken link, a
working link to the wrong paragraph.

`extractHeadings` now tracks fences, backtick and tilde, indented up to three spaces as CommonMark
allows. No page has such a line today — which is the only reason this never shipped visibly, and the
build's anchor check would have refused it after someone wrote one. All 222 contents entries across
the eleven pages are unchanged.

## 0.6.109

### the file holding every page at once was the one left indexable

Every `/docs/<slug>.md` mirror is served `X-Robots-Tag: noindex`, because it is the same prose as
the HTML page beside it at a second address, and a plain-text file cannot declare a canonical link —
so left indexable it competes with the page it copies. That reasoning is written down in
website/README.md, and `llms-full.txt` is the one file it was never applied to, while being the file
it applies to hardest: all eleven pages concatenated, 374 kB, at a single URL. The eleven mirrors
were noindexed one page at a time and the file holding all eleven at once was left indexable.

It also sat outside the cache group. `sitemap.xml`, `robots.txt` and `llms.txt` are served with an
hour of caching and excluded from the catch-all; `llms-full.txt` matched neither, so the largest
file on the site — the one an agent re-fetches to fill a context window — was the one told to
revalidate on every request.

Both fixed in the same five lines of vercel.json, and the header routes checked against a URL each
way. `llms.txt` stays indexable: it is a 3 kB index of the site, not a copy of it.

## 0.6.108

### a browser that refuses the clipboard made the copy button do nothing

The install command on the landing page has a copy button, and a browser is allowed to refuse it.
Two of them do: an insecure origin has no `navigator.clipboard` at all, so the call throws before it
starts, and Firefox can decline the write. Both landed in a `catch` whose entire body set the button
back to the state it was already in — the reader pressed Copy and nothing happened at all, no check
mark, no message, no clipboard. On the one control the page asks anyone to use.

The refusal now selects the command instead, and says so: "This browser refused the clipboard. The
command is selected; press your copy shortcut." Selecting it is what the button was for; the
reader's own shortcut finishes the job, which is a great deal better than a button that appears
broken.

Checked by making `navigator.clipboard` throw the way an insecure origin does — the selection lands
on exactly `npx edf2csv recording.edf` and the label changes — and by letting the write succeed,
which still reports "Copied" and still returns to "Copy command" afterwards.

## 0.6.107

### the contents box took 59 percent of a phone screen and still scrolled

The on-page contents box is capped at `min(60vh, 30rem)` so a long list scrolls inside itself
rather than pushing the page down. Sixty percent of a desktop window is a reasonable share. Sixty
percent of a phone is not: on a 375x812 screen the box was 480 pixels, 59% of everything visible.

And the cap only ever engages on the two reference pages, whose lists are 942 and 1635 pixels tall
on that screen. So a reader on the warnings page got most of a screen filled with an index, most of
that index still hidden inside it, and the page the index belongs to below both — the worst
available arrangement of those three things.

11rem below 900px. The box is 176 pixels, 22% of the screen, showing four entries with the fifth
cut off, which is what tells you it is a list and that it continues. With 0.6.106 putting the title
back at the top of the page, the position line, the title, the lede, the contents and the first
paragraph of the page now all land inside the first screen; the first paragraph was at y=1333 two
releases ago and is at y=557 now. The desktop cap is unchanged.

## 0.6.106

### a phone got ten links to other pages before the page it asked for

Documentation pages are two columns: the list of the eleven pages on the left, the page on the
right. Below 900px that collapses to one column, and the list collapsed into the top of it — 448
pixels of links to other pages, which is the entire first screen of a 375x812 phone.

Measured on the CLI reference: the title sat at y=624, on the bottom edge of the viewport, and the
first sentence of the page at y=1333. A reader arriving from a search result — which is how people
arrive at reference documentation — got a screen and a half of navigation before the thing the
result had just promised them, and the ten links they were being offered instead were the ten pages
they had not asked for.

It is a sidebar because it sits beside the page. With nothing beside anything, it is a footer, so
below 900px it is now one. The title moves to y=152 and the first sentence to y=861; the desktop
layout is untouched, sidebar still sticky at the left.

## 0.6.105

### the preview server answered every documentation URL with the homepage

`npm run preview` is the one command for looking at what the build produced, and it could not show
you any of it. Vite's default `appType` is `spa`, which puts a fallback in front of the preview
server answering every extensionless request with index.html — correct for an app behind a
client-side router, and this site is not one. It is eleven prerendered documentation pages, a
landing page and a 404.

So the homepage came back at all eleven documentation URLs, and at every wrong URL as well. The 404
page the prerenderer writes was unreachable, and the soft 404 that page exists to avoid was
precisely what checking the site locally produced. The prerenderer's guards were doing all the
work: nothing else could see the pages they were guarding.

The preview server now resolves the way Vercel does — `/docs/faq` to `docs/faq/index.html`, and
anything it cannot find to 404.html with a 404 status. Checked across the landing page, a
documentation page with and without its trailing slash, a Markdown mirror, llms.txt, a wrong URL
and a bare directory. `appType` is `mpa` besides, so `npm run dev` — which has no prerendered
documentation to serve — says that instead of answering with the homepage.

## 0.6.104

### the homepage shipped every hero trace twice, 71 kB of its 92

The hero scope scrolls by drawing one period of each of its four traces twice, side by side, and
sliding the pair one width left; when the first period runs off, the second is already where it
was. Both copies were separate `<path>` elements carrying the same 600-point `d` attribute written
out in full.

That cost nothing while the landing page was an empty `<div id="root">`. Since 0.6.62 it is
server-rendered, so those eight coordinate strings ship in the HTML — 71 kB of them in a 92 kB
document. Three quarters of the homepage was the same four curves, spelled twice, on a page whose
actual prose is 825 words.

The second copy is not a second trace. It is the same trace one width along, which is what `<use>`
says, and the browser draws it from the geometry it already has. The document is 92,103 bytes
before and 55,949 after: the clone lands 475 px right of the original at the same 474 px extent,
which is where the duplicated path was putting it.

The same argument as 0.6.91, where the 765 sample dots stopped being server-rendered. That one had
the easier answer, since nothing visible depended on the dots existing before hydration. This one
has to be in the initial HTML — it is the largest thing on the page — so the fix is to say it once.

## 0.6.103

### the hero backdrop removed a listener it had never added

The oscilloscope backdrop watches `prefers-color-scheme` so the beam recolours when the system
theme flips. It added `onTheme` as the listener and its cleanup removed `readTheme` —
`removeEventListener` matches on function identity, so it removed nothing and the listener outlived
the effect that made it.

The effect it belongs to re-runs whenever `prefers-reduced-motion` changes, which is its one
dependency, and React's StrictMode runs every effect twice in development. So there was always at
least one abandoned listener holding the canvas, its 2D context and the whole effect closure, and a
reader who turns reduced motion on collects another. They are not inert: the canvas element is the
same one the live effect is using, so the next system theme change had the retired painter drawing
the animated seed trail onto the canvas the current one had just filled with the reduced-motion
still.

One word. It is the same word in both calls now.

## 0.6.102

### the selected file was marked with an attribute buttons do not have

The landing page's output section lists six files and shows one at a time; the file you are looking
at is the one highlighted in amber. The highlight was the whole answer. The buttons carried
`aria-selected`, which is defined on option, tab, treeitem, row, columnheader and rowheader, and on
nothing else — a plain button is none of those, so the attribute was dropped on the floor. A screen
reader read six buttons with identical names and no indication that one of them was current, while
the panel beside them silently swapped its heading, its paragraph and its sample every time one was
pressed.

`aria-current` is allowed on any element and is exactly what the documentation sidebar has used to
mark the page you are on since that sidebar existed. The two lists in this site that answer "which
one am I looking at" now answer it the same way.

## 0.6.101

### the four figures on the landing page answered to nothing

The landing page ends with four figures in large type: 16,943 values verified against pyEDFlib,
1.4 seconds for a 40 MB recording, a 48 MB heap cap, zero runtime dependencies. Each is a claim
about something measured, each is written by hand in Landing.jsx, and what justifies them is
written on the correctness page — with nothing connecting the two. Two numbers on this site have
already drifted from their sources that way, a row count in 0.4.67 and a byte count in 0.5.150,
and those had sources. These had none.

The suite now reads the figures out of the landing page and requires the correctness page to state
each one. The zero is checked against package.json instead, since "no runtime dependencies" is a
fact about the manifest and nowhere else — the prose could agree with itself all day while a
dependency sat in the file.

The same test count this suite publishes moved from 358 to 359 as a result, and the guard that
checks it caught the page still saying 358, which is what that guard is for.

## 0.6.100

### the header was written twice and named itself nothing

The prerenderer wrote its header out twice, once for the documentation pages and once for the 404,
and the two had already drifted: until 0.6.67 the 404's copy carried one link where the others
carried four, and 0.6.92 had to add the theme toggle to both by hand — the second time in three
releases that a change to "the header" meant editing two headers. It is one constant now, for the
reason the footer became one in 0.6.67.

The header also had no accessible name. A documentation page has three `<nav>` landmarks, and the
other two introduce themselves: "Documentation" for the page list, "On this page" for the contents.
The third was announced as "navigation", which is the word a screen reader uses when a landmark
declines to say what it is. All three headers — both prerendered ones and the React one — now
answer "Site".

## 0.6.99

### the toggle added last release showed one icon for three states

The toggle 0.6.92 added to the documentation pages worked and looked like it did not. Its script
updated the accessible name and the tooltip on every press, and the glyph was a fixed piece of
markup: eleven pages showed the same "follow the system" icon whether the reader was in light,
dark or auto. The landing page's React toggle has always swapped between a sun, a moon and that
one, so the two controls disagreed about which state they were in — while writing to the same
storage key.

Fixed in CSS rather than in the script. All three glyphs ship inside the button and a rule shows
the one matching `data-theme` on the root element, which is the attribute the script already sets.
So the icon is derived from the theme rather than maintained alongside it, and there is no second
place for it to fall out of step. Exercised through all three presses: one glyph visible at a time,
matching the theme at every step.

## 0.6.98

### the website README described a directory three releases old

The website README's file tree predated three releases' worth of files: it named `public/fonts/`
and, since 0.6.62, `public/og.png` "plus icons", while the directory also holds favicon.svg,
apple-touch-icon.png and site.webmanifest, and it did not mention `scripts/` at all — the two
files that produce every static page on the site.

It also said nothing about what the build now refuses to ship. Four guards have been added across
0.6.76, 0.6.81 and 0.6.88, and each exists because the failure it catches is invisible in a
browser: a page that lost its content still renders for anyone whose bundle loads, a mistyped
link in the template still builds, and a duplicated id still scrolls somewhere. Someone editing
this site should know the build will stop them, and why, before it does.

## 0.6.97

### there was no private way to report a parser vulnerability

There was nowhere to report a vulnerability privately. GitHub surfaces a repository's SECURITY.md
from the Security tab, from the issue composer and from the sidebar, and with no such file the only
route was a public issue — which for a parser bug means publishing the crafted recording that
triggers it before there is a fix.

The file names the private advisory form and, more usefully, says what counts. This tool reads a
file and writes files: no network, no code from the input, no dependencies, so the surface is the
parser and the filesystem work around it — reading or writing outside the given paths, crashing
instead of reporting, unbounded memory from a header that claims more than the file holds, and
channel labels reaching filenames, since those are attacker-controlled text. A crash rather than a
clean exit is listed as reportable even when it is not exploitable, because "a damaged file is
always reported" is one of the nine things this project claims and checks.

It also says what is not: wrong numbers are correctness bugs and belong in an issue, and the patient
identifiers EDF stores in plain text are copied into metadata.json by design, documented in the FAQ,
rather than being a leak.

## 0.6.96

### the preview card had no description on the platform that shows it largest

0.6.62 gave the preview card an `og:image:alt`, which covers the platforms that read Open Graph. X
is not one of them: it reads `twitter:image:alt` and does not fall back. So on the platform where
the card is largest and most often seen, the one image this site publishes had no description at
all — on a site that has just spent a dozen releases on the things screen readers are told.

The sentence is written once and used by both tags. Two copies of the same alt text is how one of
them ends up describing a picture that has since changed.

## 0.6.95

### a second push left the first run testing a dead commit

Pushing twice to a branch left both runs going. Each one is now three Node versions of the suite,
seven sweeps and a website build, so the second push meant the machines were busy proving things
about a commit already replaced — and 0.6.94 made that a third heavier again.

Keyed by ref, so pushes to the same branch supersede one another. Runs on main are exempt: a run
on main is the one that says whether the commit being released is good, batched releases put
several of them in flight at once, and cancelling those would leave that question unanswered for
every version but the last.

## 0.6.94

### CI tested every supported Node but the current one

The matrix was [20, 22]. `engines` says `>=20`, so every Node above 20 is a version this package
claims to support, and Node 24 has been the active LTS line since October 2025 — which makes it
the version a good share of `npx edf2csv` runs actually execute on, and the one nothing tested.
The gap is not hypothetical for a tool that reaches into `fs.read` byte counts and Node's own
assertion behaviour, which is exactly the sort of thing that changes between major versions: the
`MAX_READ_BYTES` cap in the reader exists because of one of them.

Added to the matrix, and the suite run on Node 24 locally first rather than pushed and hoped for:
358 tests, none failing.

## 0.6.93

### trimming the URL to /docs reached a 404

Every documentation URL on this site is `/docs/<something>`, and `/docs` itself was a 404. That is
the address people arrive at by trimming a URL back to see what else is there, and the one a
crawler tries when it works out the shape of a site. The 404 it reached is a good 404 — it lists
every page — but it is still an error response for a path this site clearly uses as a directory,
and search engines treat one as a dead end rather than as a section.

A permanent redirect to getting-started, which is the page the sidebar puts first and the one the
landing page's primary button already points at. `permanent: true` because this will not change:
the documentation lives under `/docs/` and its first page is its first page.

## 0.6.92

### eleven pages honoured a theme they gave you no way to change

The documentation pages have honoured a saved theme since the day the anti-flash script was added,
and offered no way to set one. The toggle lives in the React nav, and React only mounts on the
landing page — so a reader who arrived on the CLI reference from a search result, which is how
people arrive at documentation, could read eleven pages in a theme they had not chosen and find no
control anywhere on them. The fix was to visit the homepage and come back.

Twelve lines of inline script, rather than shipping a 195 kB React bundle to eleven static pages
for one button. It cycles the same three states in the same order, writes the same storage key and
carries the same labels as the React one, so they are two faces of a single setting. Exercised
through all three presses on the CLI reference: auto to light to dark and back, with the attribute,
the stored value and the button's accessible name agreeing at each step.

## 0.6.91

### a third of the homepage HTML was decorative dots

Server-rendering the homepage in 0.6.62 had a consequence nobody measured: the 765 dots standing
for the values a resampling reader invents are one span each, and all of them went into the HTML.
The page was 147 kB, 50 kB of it those spans — 35% of the document, spent on a decoration that
conveys nothing without eyes on it. Every crawler fetch, every phone on a slow connection and
every agent reading the homepage paid for it.

They are drawn after hydration now. The homepage HTML is 92 kB, and what left it is only the part
that was never readable: the count, the caption, the three real samples and the entire argument are
still in the served HTML, and the word count a crawler sees is unchanged at 825. Confirmed in the
browser afterwards: 765 ghosts and 6 real dots, exactly as before.

## 0.6.90

### a third of the npm package was release notes

`docs/CHANGELOG.md` has been in the package's `files` list since the early releases, when it was a
few kilobytes. It is 404 kB now — this project writes long entries, and there have been ninety of
them — which made it by a wide margin the largest single file in the tarball, larger than every
piece of compiled code put together. The primary way anyone runs this tool is `npx edf2csv`, which
fetches the tarball; a third of what it fetched was release notes about versions that are not the
one being run.

Removing it takes the package from 457 kB to 313 kB, and the unpacked size from 1.4 MB to 1.0 MB.
Nothing is lost: the changelog is on GitHub and rendered on the site, the README now links it
where it did not before, and the test that keeps the newest entry in step with package.json reads
the file from the repository, not from the package.

The source maps stay. They are large too, and they are the reason a stack trace from a user's
machine points at a line of TypeScript — that is what they are for, and a test already checks they
point at files the package actually ships.

## 0.6.89

### the pages knew their place in the sequence and never said so

Two places where the site knew something it never told the reader.

The documentation is an ordered set — the frontmatter carries an `order`, the sidebar is sorted by
it, the footer offers the next page, and the breadcrumb structured data has described the position
to crawlers since 0.6.62. Nothing said it to a person. Each page now opens with where it sits:
"Documentation / 4 of 11", which is what makes the previous/next pair read as a sequence rather
than as two arbitrary neighbours, and tells someone arriving from a search result how much of the
set they are standing in.

The Markdown mirrors gained the version, for the reason 0.6.83 gave the llms files one. A mirror is
fetched in order to be kept — pasted into a conversation, cached by an agent, saved next to a
script — and the HTML page it copies states its version in structured data while the copy stated
nothing at all.

## 0.6.88

### nothing checked that an anchor arrives where it says

The duplicate id fixed in 0.6.87 had been shipping for as long as both headings had existed, and it
survived every check this site has: it is valid-looking markup, it renders correctly, no link
404s, and the page reads properly top to bottom. The only symptom is that one link in the contents
list arrives at the wrong paragraph — which is exactly what proof-reading does not catch and what a
build can settle in a dozen lines.

Every emitted page is now checked for two things: no id used twice, and no `href="#..."` pointing
at an element that does not exist. Verified by breaking each one deliberately — removing the
numbering from the slugger, then misspelling a contents link — and confirming the build stops with
the page and the id named, before putting both back.

## 0.6.87

### two headings shared an id and the second link went to the first

`NO_SAMPLES` is documented twice on the warnings page, deliberately: once as the warning a single
empty channel raises, once as the fatal error an entirely empty recording raises, with a paragraph
between them explaining that the same name means two things. Both headings were given
`id="no_samples"`. That is invalid HTML, and it fails in the quiet way — the browser scrolls to the
first match, so the contents entry for the fatal error took the reader to the warning, and 0.6.84's
permalink beside the second heading handed out a link that goes to the first. Nothing 404s. It
simply arrives at the wrong paragraph.

Slugs are now unique per page: the first occurrence keeps the plain id, so every link that already
points at one still lands where it did, and repeats are numbered. The renderer and the contents
list share one slugger walking the same headings in the same order, because two independent
implementations of "which one is the duplicate" is how they would disagree later.

## 0.6.86

### the contents list omitted every diagnostic code on the page about them

The on-page contents list showed h2s only. That is right for a page whose subheadings subdivide an
argument, and wrong for the reference pages, where the subheading is the entry: warnings-and-errors
is 13,000 words holding 42 of them, one per diagnostic code, and a reader who has just seen
INPUT_CHANGED in their terminal was handed a list of eleven section titles, not one of which is
what they came to look up. They could search the page, which is what people did, or scroll 13,000
words. The ids were already there and already permanent.

Subheadings are now listed, indented under their section and set a step smaller, so 53 entries read
as a structure rather than a wall. The box scrolls at 60% of the viewport rather than pushing the
first paragraph off the screen on the pages that need it most.

## 0.6.85

### printing a reference page spent the first sheet on navigation

Reference documentation gets printed and saved next to the recordings it describes, and this site
had no print styles at all. A printed CLI reference spent its first sheet on a sticky header, an
eleven-item sidebar and a contents list of links that cannot be clicked on paper, then asked the
printer for a near-black background across every page, which obliging printers supply.

The navigation, the contents list, the skip link, the heading permalinks and the footer are the
parts that only work on a screen, so they are dropped. Colours are forced to black on white.
Headings avoid breaking away from the text they introduce, and code blocks are allowed to break
across pages rather than being pushed whole onto the next sheet, since a forty-line transcript
would otherwise leave half a sheet blank. External links have their destination written out after
them, because a link on paper is otherwise a word with nowhere to go.

## 0.6.84

### every heading was addressable and none of them said so

Every h2 and h3 in the documentation has carried an id since the on-page contents list was added,
so every warning code, every flag and every JSON field on this site is already addressable. There
was no way to get the address. A reader wanting to send a colleague to the paragraph about
INPUT_CHANGED had to read the page source, or scroll back up and hope the heading appeared in the
contents list, which lists only h2s.

Each heading now carries a permalink beside it, invisible until the heading is hovered. It is in
the markup rather than conjured by script on hover, so it survives JavaScript being off and can be
copied out of the page source. It is `aria-hidden` and out of the tab order on purpose: it points
at the heading it sits beside, which a screen reader has just read, so announcing eleven more
stops per page would be noise rather than access. On touch screens, where there is no hover to
reveal it, it simply sits there at reduced opacity.

## 0.6.83

### the files written to be read out of context named no version

llms.txt and llms-full.txt exist to be read out of context: pasted into a conversation, fetched
into a context window, cached by something that will still have it next month. llms-full.txt is
6,400 lines of flag names, exit codes and JSON field names, and neither file said which release it
described. A reader holding a copy had no way to tell whether the `--layout` flag it documents
existed in the version they installed, and no way to tell a stale copy from a current one.

Both now carry the version, read from package.json at build time, so it is the same number the
site's structured data reports rather than one somebody remembers to update. llms-full.txt also
names the documentation on the site as canonical and says plainly that the site is the newer of
the two when they disagree.

## 0.6.82

### the 404 was a version behind on everything in its head

The 404 got its footer and its header back in 0.6.67, and its head stayed a version behind
everything else: no `theme-color`, so a phone browser painted its chrome a default colour on the
one page in the site that does not match it; no font preloads, so the page that is already a
disappointment also arrived with a flash of fallback type; no touch icon and no manifest link.

It keeps its own `robots` value. Every other page carries `max-image-preview:large`, which is
about how a page appears when it is indexed; this is the page that must never be indexed at all,
and `noindex` is not a tag to share from a helper for the sake of symmetry.

## 0.6.81

### the links the template writes were the ones nothing checked

The prerenderer hand-writes links that nothing reads back: the four in the header, the two in the
footer, the skip target, the eleven on the 404, the previous/next pair, and the Markdown-mirror
line added in 0.6.68. A typo in any of them produces a page that builds, passes its word count,
carries valid structured data and looks correct in the browser anybody actually opens — and 404s
for whoever clicks it. The documentation's own links are already checked by the test suite;
these were the ones written in the template, which is the file nothing was testing.

The build now resolves every internal `href` and `src` in every emitted page against the list of
files it just wrote, treating `/docs/x` as satisfied by `docs/x/index.html` and skipping
`/_vercel/`, which the platform injects at request time and no build produces. Checked by
misspelling the header's link to getting-started: the build stops and names every page that
carried it.

## 0.6.80

### a table-header rule set its colour twice and used the second

`.prose th` set `color: var(--text)` and then, four lines later in the same rule, `color:
var(--text-faint)`. The first declaration never applied to anything — the last one wins — so the
table headers throughout the documentation had been the faint colour since the rule was written,
while the file claimed twice over that they were two different colours. Whichever was intended,
the stylesheet was not the place to find out.

The faint one is what shipped and what the design wants: uppercased, small and quiet, so a header
row reads as a label rather than as the first row of data. That is now the only declaration, with
a line saying why.

## 0.6.79

### a dead light-theme rule outranked the one that dims the hero on phones

`:root[data-theme='light'] .hero__backdrop { opacity: 0.62 }` set the same value the base rule
already set, so it looked like a leftover that cost nothing. It cost something: at two class-ish
selectors and an attribute it outranks `@media (max-width: 900px) .hero__backdrop`, which drops
the beam to 0.32 because the hero collapses to one column and the copy runs the full width across
it.

So a phone in light mode had two behaviours. Chosen from the header, the attribute is present, the
dead rule wins, and the beam stays at 0.62 behind the sentence describing the tool. Coming from
the system preference, no attribute is set, the selector does not match, and the same phone in the
same colours renders it at 0.32. Measured both ways before removing it, and both ways after: 0.32
and 0.32.

## 0.6.78

### the third text colour failed contrast on text meant to be read

`--text-faint` was 3.10:1 against the raised surface in dark and 3.27:1 against the sunken one in
light, both under the 4.5:1 WCAG asks for body text. It would be defensible if it painted only
chrome, and the name suggests it does — but it is the colour of the footer, of every comment
inside every code sample, of the header row of every table in the documentation, and of the line
0.6.68 added pointing at the Markdown mirror. Those are all things written to be read.

It is now #867e6f in dark and #726b5d in light: 4.58:1 and 4.60:1 against their worst backgrounds,
and still visibly a step below `--text-dim` at 6.2:1, which is the reason the third step exists.

## 0.6.77

### the skip link could be focused and stay off-screen

The skip link added in 0.6.66 revealed itself on `:focus-visible`, which is the right selector for
a control that can also be clicked and the wrong one here. A skip link is the first element in the
document and sits off-screen until focused, so there is no pointer path to it: everything that
ever focuses it is a keyboard or an assistive technology, and there is no mouse-focus ring to
suppress. What `:focus-visible` adds in that situation is a heuristic that can decline — focus
moved by a script, or a browser whose rules differ — and when it declines the link is focused and
still off-screen, which is worse than having no skip link at all, because the reader's focus is
now somewhere they cannot see.

`:focus` has no such gap. The built stylesheet was checked for the rule and the link confirmed as
the document's active element after focus; the visual reveal cannot be exercised in a window that
does not itself have focus, which is the only part of this a browser in the background will not
show you.

## 0.6.76

### the homepage guard would have passed a homepage with no heading

0.6.62 made the build fail if the homepage server-rendered to fewer than 150 words, which catches
a render that collapsed to nothing and nothing else. It would pass a homepage that lost its h1,
or whose lede fell back to placeholder text, or that rendered four of its five sections — every
one of them the failure the step exists to prevent, stopping just short of total. The count was
never the claim being made; it was the easiest thing to measure.

The build now asserts the four things a crawler is read for: a heading, the sentence that says
what the tool does, the install command, and a link into the documentation. Deleting the lede
fails the build with the name of what went missing, which is how it was checked before being
committed.

## 0.6.75

### the sitemap dated the homepage from files the homepage is not written in

0.6.62 gave the sitemap a `<lastmod>` read from commit history, and derived the homepage's date
from the newest date across `content/*.md`. The homepage's text is not in `content/`. It is in
Landing.jsx, so the previous release — which rewrote every sentence above the fold — left the
sitemap reporting a homepage last modified two days earlier, on the same commit that changed it.

That is the one direction a wrong date costs something. Reading late is a crawler re-reading a
page it did not need to; reading early tells it not to bother with a page that has been
rewritten, which is exactly what a sitemap is supposed to prevent. The homepage's date is now the
newest of its own sources and the documentation's, since the landing page renders both.

## 0.6.74

### the Markdown mirrors competed with the pages they mirror

Every documentation page is published twice: as HTML at `/docs/<slug>`, and as the same prose in
Markdown at `/docs/<slug>.md`. The mirrors exist so an agent or a reader can fetch the text
without stripping tags, and 0.6.68 finally linked them — which also made them properly
crawlable. Two URLs carrying identical prose, and a plain-text file has no way to declare a
canonical link, so the pair competes as duplicates of each other and a search engine picks a
winner on its own terms.

`X-Robots-Tag: noindex` on the mirrors settles it. They stay fetchable by anyone who asks for
them, which is the entire reason they are published, and each page keeps exactly one indexable
copy — the HTML one that carries the canonical link, the structured data and the navigation.

## 0.6.73

### the theme button named the state it was in, not what pressing it does

The theme button announced itself as "Switch theme, currently auto" and had a tooltip reading
"Theme: auto". Both describe the state the reader is already in, on a control that cycles through
three of them, so the one thing neither says is what pressing it will do — which for a three-way
cycle is not guessable. It now reads "Switch to the light theme", then "Switch to the dark
theme", then "Match the system theme", naming the outcome each press produces.

The icon keeps showing the current state, which is the division of labour that was intended: the
name of a button is its action, and its appearance is its state.

## 0.6.72

### the hero readout offered a screen reader a snapshot of a moving animation

The hero's readout rewrites five numbers sixty times a second, straight into the DOM through
refs. A screen reader reaching that row reads whatever the numbers happened to be at the moment
it arrived: a snapshot of an animation that has already moved on, presented as though it were
data on the page. The traces above it already carry a description of what the visual is showing,
so the numbers are the same idea a second time, and the second time is the one that cannot be
read accurately.

Marked `aria-hidden`, which is what it always was in substance. Nothing about the sighted
experience changes, and the `role="img"` label on the traces stays as the accessible account of
the visual.

## 0.6.71

### table headers claimed no direction on pages that are mostly tables

The reference pages are largely tables: every flag with its default, every diagnostic code with
its cause, every exit status with what produces it. marked emits `<th>` with no `scope`, so a
screen reader announcing a cell in the middle of the warnings table had to guess which header
governed it, and the guess is what the heuristics do rather than what the markup says.

One `replaceAll` in the renderer, because every table on this site is the same shape — one header
row across the top — so `scope="col"` is true of all of them and would have to stop being applied
blindly the day one of them grows a row header. 18 header cells on the CLI reference alone.

## 0.6.70

### a screen reader listed five regions all called section

The landing page is five `<section>` elements, and a screen reader's list of regions showed five
entries all called "section". The headings are right there — each section opens with the h2 that
names it — but nothing connected the two, so the one navigation aid that would let a reader jump
straight to the sampling-rate argument or the correctness figures listed five identical rows.

Each section now points `aria-labelledby` at its own heading. The ids follow the anchors the
sections already had, so `#rates` and `rates-title` sit next to each other rather than inventing
a second naming scheme.

## 0.6.69

### a pinned or bookmarked site had no name and no icon

Bookmarked to an Android home screen or pinned in a browser that reads one, the site had no name
and no icon of its own to offer: it took whatever the browser could scrape, which is the page
title of whichever page was open and a screenshot-derived glyph.

The manifest states the name, the description the About field uses, the two icons the site
already ships, and the background it already paints. `"display": "browser"` on purpose — this is
documentation, not an app, and claiming `standalone` would strip the address bar from a site
whose whole job is linking to other pages.

## 0.6.68

### the Markdown mirror of every page was served and linked from nowhere

The build has written a plain-Markdown mirror of every page to `/docs/<slug>.md` since the
llms.txt work, and Vercel serves them with a `text/markdown` content type. Nothing on the site
ever linked one. They were discoverable by reading llms.txt, guessing the convention, or reading
the prerenderer — which is a strange place to hide the copy of the documentation meant for people
and agents who do not want to strip HTML.

Each page now declares its mirror with `<link rel="alternate" type="text/markdown">`, which is
where a machine looks, and says so in a line under the previous/next links, which is where a
person looks. That line also points at llms-full.txt, the whole documentation as one file, for
the same reason.

## 0.6.67

### the 404 was the only page with no way back to the source

The 404 was the one page with no footer, which made it the one page with no link to the
repository or the package — a page reached by a broken link or a typo, and therefore the page
most likely to be somebody's first, offering the fewest ways out. It also had no skip link, and
its header carried one nav item where every other page carries four.

The footer is now a single string both the documentation pages and the 404 render, rather than a
literal copied into one of them, which is what let them diverge in the first place. The two
inline `style` attributes it was laying itself out with became rules in the stylesheet next to
the ones they were duplicating.

## 0.6.66

### reaching the prose by keyboard took fifteen tab stops

A documentation page opens with the header links and then an eleven-item sidebar, so a reader
using the keyboard pressed Tab fifteen times before reaching the first word of the page, on every
page. The landing page is shorter about it but no different in kind.

There is now a skip link as the first focusable element, pointing at the `<main>` both layouts
already had. It is positioned off-screen rather than hidden with `display: none`, which would
remove it from the tab order and make it useless to exactly the people it exists for; it slides
into view when focused and returns when focus moves on.

## 0.6.65

### every documentation page said two of its links were the current one

Every prerendered page carried `aria-current="true"` on the header's "Docs" link, hard-coded,
while the sidebar correctly marked the page actually being read. A screen reader on the CLI
reference was therefore told two links were the current one, and neither the header link nor the
page it points at is the CLI reference. The attribute also drives the styling rule the sidebar
uses, so the header link rendered permanently highlighted, as though it were where you were.

The header is a link to the documentation, not a claim about which page is open. The sidebar is
where that is expressed, and it was already expressing it correctly.

## 0.6.64

### the hero said four things before saying what the tool does

The hero read "EDF, EDF+ and BDF biosignal files become CSV you can open in pandas, R or Excel.
Local, streaming, and honest about what it found" — two sentences, four claims, before saying
plainly what the thing does. The repository's own About field has said it in one sentence the
whole time: convert EEG and biosignal files to CSV in one command. That is now the lede, and the
claims it displaced are made by the sections underneath, which is where a reader who wants them
is already going.

The meta description carried the same problem in a worse place. It read "Convert EDF, EDF+ and
BDF recordings - EEG, ECG, sleep studies - to CSV with one command", and that parenthetical is
what a search result and a pasted link show first. It now leads with the sentence and states the
formats after it, with no dashes to read around.

## 0.6.63

### Fixed: phones could scroll the whole site sideways, and every heading faded in

Three grids collapse to a single column on narrow screens, and all three collapsed to `1fr`.
A plain `1fr` track has `min-width: auto`, so the one child with an unwrappable width — the
scope readout's 420px minimum on the landing page, a CSV sample's longest line in the docs —
set the track wider than the phone, and every element on the page shared one clipped right
edge with 26px of sideways scroll to find it. The two-column desktop layouts already used
`minmax(0, 1fr)` for exactly this reason; the single-column collapses now match them. The
code blocks scroll inside their own boxes, which was always the intent.

The scroll-reveal animation is gone. Every section's heading, lede and body used to fade
upward as the reader reached it, which was defended in the README as arriving "in reading
order" — but a page where every heading rises into place is indistinguishable from every
other page where every heading rises into place, and the pattern costs something real here:
the prerendered landing page shipped its text wrapped in inline `opacity: 0` until the bundle
arrived to animate it. Content is now simply present. Motion stays where it argues something
— the hero trace turning into rows, the 765 interpolated dots appearing out of nowhere — and
in interaction feedback. The hero's own entrance became three lines of CSS, which paint with
the HTML instead of after it.

Two smaller things. The documentation grid on the landing page held eleven cards in a
four-column grid, leaving a permanent empty cell; a twelfth card now points at
llms-full.txt, the whole documentation as one plain-text file for pasting into a coding
agent — a real destination this site already served without linking to it. And the footer
finally links the npm package, which no page on the site did.

## 0.6.62

### Changed: the homepage is real HTML, and a pasted link unfurls into something

Two findings from an SEO pass over the website, both the same shape: the site said less about
itself to machines than it does to people.

The documentation pages have been prerendered static HTML from the start, precisely so that
crawlers that do not run JavaScript — which is most of the AI crawlers the docs were written
for — get the full text. The landing page never got the same treatment: it was an empty
`<div id="root">` until the bundle arrived, so the one page that explains what the tool is was
blank to exactly the readers the prerendering exists for. It is now server-rendered at build
time through Vite's SSR transform and hydrated in the browser, and the build fails if the
rendered landing ever comes back as a stub, the same check the documentation pages have.

A pasted link had no image at all: `twitter:card` said `summary` and no `og:image` existed, so
Slack, iMessage and the rest unfurled the URL into two lines of grey text. There is now a
1200x630 card in the site's own oscilloscope idiom — the H1, the command, a trace — referenced
with `summary_large_image` from every page. One committed PNG rather than a per-page generator,
because eleven near-identical title cards would say less than one good one.

The smaller corrections follow the same principle. The sitemap dropped `<priority>`, which
Google states it ignores, for `<lastmod>` read from each page's commit history — and a page
whose date git cannot supply gets no tag, because a fabricated date teaches crawlers to
distrust all of them. The title now leads with the phrase people type ("Convert EDF to CSV
from the command line") while the H1 keeps the site's own voice. Documentation pages carry
BreadcrumbList and a `dateModified` from the same commit history; the SoftwareApplication
entity gained `sameAs` links tying the site, the repository and the npm package into one
thing, and a `softwareVersion` read from package.json at build. It still carries no
aggregateRating and no download count: the schema for star ratings is the one piece of SEO
this site will not do, because inventing social proof is fabricating data on a site whose
argument is that fabricating data is the problem.

Also fixed on the way through: the landing page never inlined the theme-restore script the
documentation pages have, so a reader who had chosen light mode got a flash of dark on every
visit to the homepage.

## 0.6.61

### Added: the pyEDFlib cross-check runs weekly instead of never

0.6.58 put six of the seven sweeps into CI and left this one out on purpose: it needs pyEDFlib
installed, and a check whose whole value is comparing against an independent implementation must
not quietly pass when that implementation fails to install. A green tick meaning "pip was
unhappy" is worse than no tick.

Its own scheduled workflow answers that. On a schedule a failed install is a failed run — there
is no pull request it would be blocking and no temptation to make it skippable — and weekly is
the right cadence for what it actually guards: drift in the arithmetic, or in pyEDFlib. Neither
moves at the speed of a commit. `workflow_dispatch` is there for running it against a change
that touches the scaler.

That is claim 1 on the correctness page — the one this project leads with — and it was the last
one whose evidence had to be produced by hand.

## 0.6.60

### Changed: the publish step retries the two failures that are not the code's

Both failures seen while releasing were the registry's, not the tarball's. Publishing a batch
together made one run die on `E409 Conflict - Failed to save packument`, which is npm refusing a
write with another in flight. A later one died on `CA_CREATE_SIGNING_CERTIFICATE_ERROR - (403)
Forbidden`, which is Sigstore declining to mint the provenance certificate after a clean build
and a passing suite. Both published on a manual rerun, unchanged.

Three attempts with a widening pause, and the registry is asked between them: if the version is
already there, the write landed and whatever failed came after it, so the step succeeds rather
than retrying. That is what makes a retry safe here — it cannot publish the same version twice,
and it cannot mistake a genuine refusal for a transient one, because the check is what actually
shipped rather than what the exit code said.

## 0.6.59

### Added: an npm downloads badge on the README

`img.shields.io/npm/dt/edf2csv`, linked to the package page. It reads the registry's own download
total rather than a number written into the file, so it cannot drift the way the figures this
project keeps correcting have.

## 0.6.58

### Added: CI runs the six sweeps it has always claimed as its evidence

The correctness page names seven checks as how this project knows what it claims — the estimate
sweep, the layout sweep, the round trip, the corruption fuzzer, the batch trees, the narrowing
sweep, and the pyEDFlib cross-check. CI ran none of them. `npm test` covers the suite; the
harnesses are separate scripts, and nothing invoked them on a push, so a regression in an
invariant that only a sweep can see would have shipped in silence.

Six of the seven now run as their own job, each as a named step so a failure says which invariant
broke rather than "sweeps". A separate job because they take minutes where the suite takes one,
and GitHub runs jobs concurrently — a pull request waits for the slowest, not the sum. One Node
version, since these assert what the tool computes and `core` is what covers computing it on
both.

The seventh, `crossvalidate`, stays manual: it needs pyEDFlib installed, and a check whose value
is that it compares against an independent implementation should not be silently skipped when
that implementation fails to install.

## 0.6.57

### Added: a sweep checking that narrowing a conversion returns the part it names

`--channels` selects columns and `--start`/`--end` selects rows. Both are documented as
selections rather than transformations — output-files puts it as "a section converted on its own
lines up with the full conversion" — and nothing ran it. The layout sweep compares wide against
long, the estimate sweep compares predicted row counts against written ones, and neither asks
whether the rows a narrowed run writes are the rows the full run wrote.

`npm run narrowing` takes each fixture's full conversion as the truth, converts every channel
alone and three windows out of it, and requires the narrowed output to be the corresponding slice
byte for byte: 106 single-channel selections and 253 windows over 50 recordings. Everything
agrees, which is the result to want from a check written after the fact.

Its first run did not agree, and the disagreement was the sweep's. Window bounds were read back
off the CSV, where `time_s` is rounded — 8/17 is 0.47058823… and prints as `0.47059` — while a
conversion filters the exact sample times, so a bound taken from the file sits just past the
sample it came from and the conversion rightly keeps a row the check excluded. Bounds now sit
halfway between two samples, where no rounding on either side can move a row across them.

## 0.6.56

### Fixed: the `UNREADABLE` case list, four of the six things it covers

The reference gave a missing file, a directory where a file was expected, a permission failure
and a file that changed size mid-read. Missing: a path running through a regular file, which
0.6.12 taught the reader to word as "part of the path is a file, not a directory"; anything that
is not a regular file, such as a socket or a fifo; and calling a method on a closed `EdfFile`,
which is where a library caller meets this code most often.

Third time a message change in this line has left prose behind it, after 0.6.20 and 0.6.42 — and
the same remedy each time: diff the list against the function, don't read it.

## 0.6.55

### Fixed: the API reference's first example serialised `startDateTime` the one way it must not

```js
console.log(`start ${file.header.startDateTime?.toISOString() ?? 'unknown'}`);
```

That is the opening worked example on the page, and `toISOString()` is precisely what the same
page warns against six hundred lines later, in the paragraph explaining why `formatWallClock`
exists: the `Z` asserts UTC over digits the format never assigned a zone to, so a reader
converting to local time moves the recording by their own offset — "13:43:04 in the file becomes
08:43:04 in New York".

The `EdfHeader` field list called it "a UTC `Date`" flatly, which is the belief that produces the
mistake. Both now say what the source comment says, and the example uses `formatWallClock`.

## 0.6.54

### Fixed: the FAQ's truncation transcript punctuated the hint differently from the tool

`The recording looks truncated - it may have been cut short or copied incompletely.` The tool
writes `truncated. It may`. A hyphen and a lowercase letter where there is a full stop and a
capital — small, and still a block presented as captured output that no run of edf2csv produces.

The test that keeps quoted hints honest checks that each is attached to the diagnostic it belongs
to, not that it is transcribed character for character, so this sat inside a fenced block being
read as real.

## 0.6.53

### Changed: the API guard checks class members, not just class names

`EdfFile` is one name in the package's exports, so the test asserting api.md documents every
export was satisfied by the word "EdfFile" appearing once — while two of its twenty-two public
members went unwritten until 0.6.35 and 0.6.36 found them by hand.

The check now walks the prototype of every exported class and requires each member to appear on
the page. Read off the shipped object rather than the declarations, so it follows what consumers
actually get. Extended in place rather than added as a new test, since the suite's size is pinned
on the correctness page and this is the same claim the existing one was making.

## 0.6.52

### Changed: the long-layout guard learns the wordings that got past it

Three findings in this line — 0.6.26, 0.6.51 and one beside 0.6.45 — were passages telling a
reader a mixed-rate recording becomes several files without mentioning the layout that does not.
There is a test for exactly that, and all three walked past it, because it matches four fixed
phrases and each passage used a fifth: "several output files" against its "several signals
files", "produce exactly one" against its "more than one table".

The four wordings it missed are added, along with `recipes.md`, which was not in the page list at
all despite carrying two of the passages. A phrase list cannot be complete; it can at least
accumulate the misses instead of forgetting them.

## 0.6.51

### Fixed: the `--stdout` recipe offered one of the three fixes the refusal names

"`--channels` narrowed to channels that share a rate is the usual fix" — and `--layout long`
is the one that needs no narrowing at all, since it streams every rate in a single table. The
tool's own error message has listed all three since 0.5.0.

Third finding caught by the same guard gap. The test that requires every mixed-rate passage to
mention the long layout matches on four fixed phrases, and this passage says "needs the
recording to produce exactly one" — none of them. 0.6.26 was the second. The guard is checking
wording rather than meaning, which is why widening it is worth doing before the next sweep.

## 0.6.50

### Fixed: the third page defining an empty `duration_s` as "no duration"

0.6.22 fixed this on the annotations page. `output-files.md` has had it right all along. This is
the third copy, in the file-summary at the top of recipes, and it is the same half-definition:
an empty cell also means the file stated a duration that could not be read, which is why
`ANNOTATION_DECODE_FAILED` counts those rows and says so.

Three pages, one sentence, written three times — and the two that were wrong were wrong in the
same direction, because they were describing the behaviour from before the warning existed.

## 0.6.49

### Fixed: recipes showed a 100 Hz row as `286.50000000`

Eight decimal places is what 256 Hz gets. The paragraph is about `signals_100hz.csv`, three code
blocks under a snippet that loads it, and 100 Hz gets three places — the file really writes
`286.500`, which converting the page's own example recording confirms.

The point being made is right and worth keeping: a window converted on its own keeps the whole
recording's clock rather than restarting at zero. It was the illustration that came from a
different file.

## 0.6.48

### Fixed: nothing said the JSON drops the hint every terminal warning carries

A warning on screen is two lines: the message, and an indented hint saying what to do. The
`warnings` array and `metadata.json`'s `notes` carry `code`, `severity` and `message` — and every
transcript on the site shows both lines, so a reader moving from the terminal to a script has no
reason to expect the second one to be gone.

Nothing on any page was false about this; it was absent, which for a machine-readable contract
is the same problem. Said outright now, with the reason — a hint varies with the run while a
code does not — and a pointer to where the remedy lives.

## 0.6.47

### Fixed: `INPUT_CHANGED` missing from the list of warnings `--info` cannot raise

It is raised in exactly two places, both inside `convert()`, and `--info` reaches neither. The
page lists four things a conversion can report that `--info` cannot and this was a fifth.

The guard behind that list cannot catch it. It converts every fixture, compares the codes
against `--info`'s, and requires any difference to be named on the page — and `INPUT_CHANGED`
fires only when a file moves mid-conversion, which a static fixture never does. So the sweep sees
the code on neither side and has nothing to compare. Same shape as 0.6.25, where the code was
missing a section: guards that compare observed behaviour are blind to what never happens in the
fixture set.

## 0.6.46

### Fixed: `--info --json` had no field reference, and was described as "the same fields"

The conversion summary gets a sample document and a field-by-field table. Its sibling got one
sentence — "the recording's description as JSON instead of the table — the same fields, shaped
for surveying" — and the two documents in fact share two field names out of eighteen. Three of
its fields are mentioned anywhere on the site; the other fifteen, including everything a survey
script would actually read, appear in no page in any form.

Larger than a release in this line usually is, because a missing field reference cannot be
fixed in two lines. The sentence claiming the documents match is corrected in the same change,
since it is what made the absence look deliberate.

## 0.6.45

### Fixed: the warnings page's usage table omitted every `--stdout` refusal

Fourteen rows, and the whole `--stdout` family was one of them — "Several recordings with
`--stdout`" — while the CLI reference lists five distinct ways that flag is refused: a folder,
`--annotations-only`, a mixed-rate recording in the wide layout, and the four flags it
contradicts. The empty-folder case and the nested-destination case were missing too.

The two pages enumerate the same set and each was missing what the other had, which is the
failure mode of keeping one list in two places. Both now carry all of it.

## 0.6.44

### Fixed: the CLI reference's exit-2 list omitted the destination collisions

Nine categories listed, and the one missing is the only one that can stop a batch of five
hundred recordings before a byte is written. `assertDistinct` refuses two recordings whose output
would land in one directory, and refuses one destination sitting inside another; both throw
`OptionError` and exit 2.

The warnings page tabulates the first of the two and the CLI reference tabulated neither, so
between them the site described half of it. The next version gives the warnings page the rest.

## 0.6.43

### Fixed: `exceeds_spreadsheet_limit` was emitted by `--info --json` and documented nowhere

Thirty-one snake_case keys are written into the JSON this tool produces — the conversion
summary, the `--info` document and `metadata.json` — and thirty of them appear somewhere on the
site. This was the one that did not, on any page, in any form.

It is the machine-readable half of `LARGE_OUTPUT`: a boolean a script can branch on instead of
matching a warning message, which is exactly what the surrounding paragraphs tell scripts to do.
Its two siblings in the same object, `rows` and `bytes`, are documented a line away, including
0.6.0's rule about them being `null` when no signal table is written.

## 0.6.42

### Fixed: the `OUTPUT_UNWRITABLE` list of translated failures, stale since 0.6.11

0.6.11 taught `describeFsError` to say "you are over your disk quota on this filesystem" instead
of leaking `EDQUOT`, and did not add it to the page enumerating what that function translates.
The list gave five of its six.

Second time in this line that a message fix has left prose behind it — 0.6.20 was the same shape
— and both were found by diffing a list against the function it describes rather than by reading
it. Worth doing after any change to a user-facing string.

## 0.6.41

### Fixed: the errno table left out `EPIPE`, the one a shell pipeline produces

`writeHint` turns eleven errnos into sentences and the table on the page reproduces ten. The
missing one is the only one an ordinary command reaches without anything being wrong with the
destination: a reader closing the pipe. It has its own written sentence in the source —
"Whatever was reading the output closed it before the conversion finished" — which nothing on
the site showed.

## 0.6.40

### Fixed: `CALLBACK_FAILED` had no section — the last of the four

Fourth and last undocumented `ConversionErrorCode`. It is the only one the command line cannot
produce, which is presumably how it stayed unwritten: it reaches a library caller and nobody
else. That also makes it the one whose reader has no terminal transcript to compare against, so
the page was the only place it could have been explained.

Every code in `DiagnosticCode`, `EdfErrorCode` and `ConversionErrorCode` now has a section.

## 0.6.39

### Fixed: `UNSUPPORTED_REQUEST` had no section, and it is the one that exits 2

Third of the four. It is the only `ConversionErrorCode` in `USAGE_ERROR_CODES`, so it is the
only one where the code a script sees is 2 rather than 1 — a distinction the page's own exit-code
table draws and this code's absence made unverifiable from the page.

Placed at the head of the usage-error section rather than with the other conversion errors,
since that is where its exit code puts it.

## 0.6.38

### Fixed: `INPUT_UNREADABLE` had no section, and is the one that leaves output behind

Second of the four undocumented `ConversionErrorCode` values. It is not a duplicate of
`UNREADABLE`: that one fails before anything is written, this one fails during the streaming
pass, so the difference between them is whether there is a half-finished directory on disk. The
code separates them for exactly that reason — a read failure used to be reported as
`Writing to "<dir>" failed` with advice about disk space, pointing at the part of the system
that was working.

The page had the distinction nowhere, so a reader hitting the second met a message whose code
they could not look up.

## 0.6.37

### Fixed: `INPUT_OUTPUT_COLLISION` had no section on the errors page

All twenty-seven diagnostic codes and all seven fatal reader errors have a section explaining
cause, behaviour and remedy. Four of the seven `ConversionErrorCode` values do not, and this is
the first of them — the one that stops a conversion writing a CSV over the recording it is
reading, which is the least recoverable thing this tool could do and the one place `--force` is
deliberately powerless.

## 0.6.36

### Fixed: `EdfFile.modifiedAtOpenMs` was the last unmentioned member of the class

The second of the two 0.6.35 found. It is what `changedSinceOpen()` compares against, so a
caller reasoning about whether their input moved has the predicate documented and not the value
under it — and it carries a decision worth stating: it is a raw number rather than a `Date`
because `new Date(ms).getTime()` truncates to whole milliseconds, which against a filesystem
that keeps finer precision reported every quiet conversion as one whose input had changed.

Every public member of `EdfFile` is now named somewhere on the page.

## 0.6.35

### Fixed: `EdfFile.sha256()` is public API and the reference never mentioned it

Twenty-two members on that class and this was one of two the page did not name once. It is the
method `--checksum` runs, and the one with a rule attached that a caller cannot guess: it hashes
the bytes that were there when the file was opened, through the descriptor already on them, so
it has to be called before `close()` and it deliberately does not re-read the path.

The test that keeps the reference honest checks the package's top-level exports. `EdfFile` is
one name; its members are not checked, which is how two of them stayed unwritten.

## 0.6.34

### Fixed: the `NO_SAMPLES` summary repeated a conflation the warning itself stopped making

"No signal file was written because nothing carries any" is the wording for one of two cases.
The other is a recording holding nothing but EDF+ annotations, which has no channel that could
have carried anything — and the conversion prints a different sentence for it precisely because
the first one was, as the source comment puts it, three false statements in one warning when
applied to that file.

The summary line kept the wording that was split in two.

## 0.6.33

### Fixed: the CLI reference's exit codes, the fifth and last page with this gap

"`1` — The file or the destination is the problem" is the sentence the source quotes back at
itself: `USAGE_ERROR_CODES` in `run.ts` carries it verbatim as the distinction the exit codes
draw. It is exactly right for every code path except `--strict`, where neither the file nor the
destination is the problem and the output is written in full.

That completes the sweep — README, getting-started, the FAQ, the warnings page and this one all
now say the same thing about exit 1, and all five list 130.

## 0.6.32

### Fixed: the canonical exit-code table had the gap the other three pages had

0.6.10, 0.6.16 and 0.6.18 fixed this on the README, getting-started and the FAQ. This is the
table those pages defer to, and it had the same two omissions: `--strict` returns 1 over a
conversion that wrote every file it meant to, and Ctrl-C returns 130.

130 is the sharper miss, because the prose directly under the table already discusses it — "a
signalled child exits 130 or 143" — while explaining how a batch combines codes. The number was
on the page, in a paragraph about workers, and absent from the list of what the tool returns.

## 0.6.31

### Fixed: `ANNOTATION_DECODE_FAILED` also covers a duration that decoded fine

A duration of `-3` parses without trouble; what is wrong with it is arithmetic, not decoding. It
is kept and written to `annotations.csv` exactly as the file gave it — inventing a zero would put
a number there no writer wrote — and it is warned about, because the recipe this documentation
gives for the samples an event covers is `onset_s + duration_s`, which for a negative duration
ends the window before the event starts and selects nothing at all.

The summary line said "couldn't be read", which is true of the other four causes and not of this
one. Fifth raise site, and the only one where the value survives.

## 0.6.30

### Fixed: `DISCONTINUOUS` has six raise sites and the table summarised two

"Gaps in time, or its records are out of order" leaves out four, and they are not variations on
those two. Records that *overlap* are counted and reported separately from records that are out
of order, because a record starting before the previous one ends is strictly increasing and the
reversed-order check never fired on it. A file marked EDF+C whose records contradict the marking
gets its own message. So does an origin too far from zero for a sample interval to survive being
added to it, and so does an EDF+D file with no annotation channel to record positions in.

Each has a section further down the page. Only the summary line was standing in for all six.

## 0.6.29

### Fixed: the warnings table listed two of `DUPLICATE_LABEL`'s three causes

The third is the one a reader is least able to work out for themselves: a channel that loses its
own column name to something else in the header — another channel's `_ch<index>` suffix landing
on it, or the `time_s` the writer puts in front of every signals.csv. `label-suffix-collision.edf`
in this repository raises it beside the ordinary shared-label warning, and the two read very
differently:

```
warning: 2 signals share the label "T8" (positions 0, 1).
warning: Signal 2 is labelled "T8_ch0", which is also the column name another channel's "_ch"
         suffix produces, so its column is "T8_ch0_ch2".
```

The second is the one that renames a channel that did nothing wrong, and the table had no room
for it.

## 0.6.28

### Fixed: the warnings table gave `TIME_RESOLUTION` only its duplicate-timestamps half

Third row of the same table with the same shape as 0.6.26 and 0.6.27. The code has two branches
and they have opposite outcomes: samples too close together share a `time_s`, or the rate worked
out to `Infinity` — samples per record over a record duration too small to divide into — and no
rows are written for those channels at all. The section explains both, including why 0.5.84 was
needed. The summary line named the branch that still produces data.

Three rows of one table, each summarising a two-branch warning with one branch. The table is now
consistent with the sections under it.

## 0.6.27

### Fixed: the warnings table gave `UNUSABLE_PHYSICAL_RANGE` only its overflow half

The code picks the word from which way the span failed — `too ${underflowed ? 'small' : 'large'}
to represent` — and the section on the same page explains both at length, including the
underflow case 0.5.83 was released for. The one-line summary said "too wide to represent",
which is the half a reader scanning the table would take for the whole rule and the half that
does *not* apply to a magnetometer, the channel type the section names.

## 0.6.26

### Fixed: the warnings table still said a mixed-rate file means "several output files"

`--layout long` writes one, and the warning's own hint says so — it has two forms, and the one
it prints under `long` reads "They share one table, each row carrying its own time". The summary
line at the top of the page kept the pre-0.5.0 answer.

There is a test for exactly this class, added when 0.5.0 landed the flag: it requires every page
claiming a mixed-rate recording becomes several files to mention the layout that does not. It
missed this row because its phrase list looks for "several signals files" and the row says
"several output files" — one word apart from the thing it was written to catch.

## 0.6.25

### Fixed: `INPUT_CHANGED` was one row of a summary table and nothing else

Every other diagnostic on the warnings page gets a section: what causes it, what edf2csv does,
what to do. `INPUT_CHANGED` had a single line in the table at the top and no section anywhere —
the only code of the thirty-three in that table without one. The docs test that keeps codes and
pages in step asks whether a code is *named* on the page, which one table row satisfies.

It is not a minor one to leave unexplained: it is the warning that says the output describes the
file as it was rather than as it is, and the one that turns `--checksum` into a `null`.

## 0.6.24

### Fixed: the timekeeping TAL described as one "which carries an onset and no text"

It is allowed to carry text, writers use that, and edf2csv exports those events like any other —
which is the whole reason `malformedTimekeepingWithText` is counted apart from
`malformedTimekeeping`. A 0.5 release exists because the warning beside them said "No event was
lost" over a conversion whose annotations.csv had gone from six rows to two, and the code comment
recording that says in as many words that the specification allows both in one entry.

The page describing annotations was the one still asserting they cannot coexist.

## 0.6.23

### Fixed: "Record `n` starts at `n * record_duration` seconds, and always will"

Said of EDF+C, and false since 0.4.9 made the first record's timekeeping TAL the point a
recording is timed from. `fractional-start.edf` is a continuous fixture in this repository whose
first row is `0.500`; `output-files.md` states the correct rule two pages over — "a plain EDF+C
file can begin anywhere" — and `--info` prints a `Timed from` line for exactly this case.

"And always will" is the part that makes it worse than a stale sentence: it tells a reader the
arithmetic is guaranteed, which is what would send them to compute sample times themselves
rather than read the column.

## 0.6.22

### Fixed: an empty `duration_s` has meant two things since 0.5.x, and this page said one

"An empty cell records that the file gave no duration" is the sentence the annotations decoder
quotes in its own comment as the definition it was breaking: a TAL whose duration reads `abc` is
exported with an empty cell too, indistinguishable from one that genuinely had none. That is why
`ANNOTATION_DECODE_FAILED` counts them and says so. `output-files.md` has described both cases
since the warning was added; the page devoted to annotations never got the second one.

## 0.6.21

### Fixed: getting-started said the output directory is the filename "with `_csv` appended"

That is `recording.edf_csv`. `defaultOutputDir` strips the extension first, so it is
`recording_csv` — which the same page prints in its own transcript nine lines above, and which
the other three pages describing this all state correctly as the extension being removed or
replaced. One page, contradicting itself and the other three, on the first fact anyone learns
about where their output goes.

## 0.6.20

### Fixed: two pages quoted the short-read error as 0.6.4 stopped printing it

0.6.4 put the count through `counted` so it could not say "1 were available", which added the
noun: the message now reads `but only 131072 bytes were available`. Two pages quote that error
verbatim and neither was updated, so this repository spent four versions showing output its own
tool does not produce — the exact defect most of the 0.5 line was spent removing, introduced by
a fix for a different one.

Nothing caught it. The suite pins the quoted *hints* and the warnings of one example command;
these two are error transcripts in prose, which nothing reads.

## 0.6.19

### Fixed: "only `--info` output goes to stdout", in the paragraph about piping

The sentence exists to say a conversion is safe to pipe, and the flag it leaves out is the one
that puts a CSV on the pipe. `--stdout` is the whole reason someone reads this paragraph before
writing `edf2csv rec.edf --stdout | head`. Same omission 0.6.17 fixed in getting-started's
version of the claim, which at least named `--help` and `--version`.

## 0.6.18

### Fixed: the FAQ's exit codes, in the answer written for scripts

Third page with this gap, after the README in 0.6.10 and getting-started in 0.6.16, and the one
where it costs most: the question is "how do I check whether a conversion had problems from a
script", and the answer gave three codes as the whole set. A pipeline built on it reads 1 as "a
problem with the file or the output directory" — but the same page recommends `--strict` two
sections later, and `--strict` returns 1 over a conversion that wrote every file it meant to.
130 was missing as well.

## 0.6.17

### Fixed: the list of what writes to stdout left out `--stdout`

"Only `--info` and `--json` write to stdout — along with `--help` and `--version`" is an
enumeration that says "only", on the page that teaches the stream split, and it omits the flag
named after the stream. 0.5.144 found `--help` and `--version` missing from this same sentence
and added them; the third was there the whole time and is the one whose entire purpose is to
put a CSV on stdout.

## 0.6.16

### Fixed: getting-started's exit statuses had the same gap the README did

0.6.10 fixed this on the README and this page says it too, in its own words, with the same two
omissions: a `--strict` run that converts a recording perfectly and warns about it exits 1
without anything having failed to read or write, and Ctrl-C exits 130. Both pages are read
before anyone reaches the CLI reference, which has had the full table all along.

## 0.6.15

### Fixed: two more pages said `--info` reads "the first sixteen records"

getting-started and recipes carry the same sentence, word for word, and both stated the bound
as the amount. The two pages that describe the same read — `cli-reference` and the second
mention in `recipes` itself — have said "at most" all along, so the site disagreed with itself
about its own tool while a test checked only that the pages agreed with *each other*, which
identical copies always do.

Now they say what the other two say, and what `scanOrigin` does: at most sixteen, stopping at
the first record that states a start time.

## 0.6.14

### Fixed: "`--info` sees an unreadable timekeeping entry in those first sixteen records"

The same overstatement 0.6.13 fixed, one page over and stated as a capability rather than as a
bound — and this one is checkable in a sentence. Give record 1 of a three-record continuous
EDF+ a corrupt TAL: the conversion raises `ANNOTATION_DECODE_FAILED` and `--info` prints
nothing, because `scanOrigin` stopped at record 0 the moment it had the origin it came for.

The sentence beside it, about an unreadable *event* later in the file, was right and is kept.

## 0.6.13

### Fixed: "which on a continuous file is those first sixteen records"

`scanOrigin` reads records until one states a start time and then returns, which on any
well-formed continuous recording is one record — sixteen is the point it gives up, not the
amount it reads. The page describing what `--info` can and cannot warn about took the bound for
the behaviour, and the difference is visible on a three-record file: corrupt the timekeeping
TAL of record 1 and a conversion raises `ANNOTATION_DECODE_FAILED` while `--info` says nothing,
though record 1 is well inside the sixteen the sentence promised.

The paragraph's other two claims were already right, including the reason the EDF+C
contradiction is missed. This is the extent of the read, which nothing else states.

## 0.6.12

### Fixed: an input path running through a file answered in errno text

```
$ edf2csv recording.edf/inner.edf
error: Cannot read "recording.edf/inner.edf": ENOTDIR: not a directory, stat 'recording.edf/inner.edf'
```

The path twice, the syscall, and the errno — where the same errno on the output side reads
`part of the path is a file, not a directory`. The reader's own describer knew `ENOENT` and
`EACCES` and passed everything else through as Node wrote it. `EPERM` joins `EACCES` at the
same time, since the two other places in this codebase that read an errno both treat them as
one answer and this one had only half the pair.

## 0.6.11

### Fixed: a quota failure creating the output directory came back as a raw errno

`describeFsError` turns the errno from a failed `mkdir` into a sentence, and covers a full
disk, a permission denial, a read-only filesystem, a path component that is a file and a path
too long. It did not cover `EDQUOT`, so being over quota produced `Cannot create "out": EDQUOT:
disk quota exceeded, mkdir '...'` where every neighbouring failure produces plain words. The
write path a few hundred lines down has had a sentence for `EDQUOT` since 0.4.36 — and a shared
or cluster filesystem, which is where a night of polysomnography usually gets converted, hits
quota far more often than it hits a genuinely full disk.

## 0.6.10

### Fixed: the README's exit codes contradicted its own options list

`1` was given as "the file couldn't be read or written", twenty lines under an options list
that says `--strict` "Exit 1 if the recording raised any warning". A `--strict` run over a
discontinuous recording writes all four files and exits 1, so the one page a reader meets first
described that outcome as a failure to read or write a file that was read and written. It also
skipped 130, which is what Ctrl-C gives and what a wrapper script has to know about.

## 0.6.9

### Fixed: package-lock.json had been claiming 0.5.51 for fifty-eight releases

The lockfile carries the package's version in two places and both had stopped moving. Nothing
breaks on it — `npm ci` does not read the field, and `npm install` rewrites it — but anyone
checking out a tag and opening the file is told a version other than the one they checked out.

CITATION.cff had exactly this happen, 107 releases of it, and the answer was a test asserting
it against `package.json`. That test now checks the lockfile in the same breath.

## 0.6.8

### Fixed: the `--info` table's `OUTPUT` column has three values and the reference listed two

`(no samples)` has been printed since 0.4.53, for a channel that declares zero samples per data
record, and the page enumerating the column said only "the file the channel would land in, or
`(not selected)` when `--channels` excludes it". A reader meeting the third value had nowhere
to look it up, and the obvious guess — that it means the same as `(not selected)` — is the one
0.4.53 exists to contradict: a channel asked for by name and carrying nothing is not a channel
that went unasked for.

## 0.6.7

### Fixed: `--info` and `--info --json` listed the same warnings in different orders

The text form prints the file's own diagnostics and then the plan's; the JSON form concatenated
them the other way round. On `records-backwards.edf` that put the `DISCONTINUOUS` warning first
on screen and last in the document, with `MIXED_SAMPLING_RATES` moving the opposite way — the
same three warnings about the same recording, in two sequences, depending only on which form
was asked for. Anyone reading a script's output against a terminal's is comparing two orders of
one list.

## 0.6.6

### Fixed: "1 of 1 data records carries no readable timekeeping annotation"

0.5.133 made the verb of this warning agree with the count of unreadable records — the subject
is the one, not the three — and left the noun agreeing with nothing. A discontinuous recording
of a single data record whose timekeeping annotation cannot be read says so in a sentence with
both numbers in it, and the second one is also 1:

```
warning: 1 of 1 data records carries no readable timekeeping annotation (record 0), so its
         true position in time is unknown.
```

## 0.6.5

### Fixed: "after 0 of 1 rows had been written"

The `--stdout` hang-up summary has two branches and 0.5.82 singularised one of them. The other
counts the rows the conversion *would* have written, which is the estimate, and a window narrow
enough to select a single sample makes that one — so a reader that closed the pipe before
anything reached it was told `after 0 of 1 rows had been written`. The comment four lines above
it names this family and lists 0.5.74 and 0.5.78; this is the branch it did not reach.

## 0.6.4

### Fixed: "but only 1 were available"

A recording that shrinks while it is being read — still being written by the acquisition
software, usually — is caught by comparing what came back against what was asked for, and one
byte is a perfectly ordinary amount to come back with. The count read `only 1 were available`,
with the verb agreeing with nothing in the sentence. The bytes asked for cannot be one, since a
data record holds at least one sample; the bytes that arrived can be.

## 0.6.3

### Changed: the short-read message is built in one place, not two

`readRecords` threw a sentence it composed itself, character-for-character identical to the one
`changedWhileReading` builds for the annotation reader a few lines down — right down to the
hint. Two copies of one message is one copy too many to keep in step, and the next version
changes that wording, which would otherwise have meant changing it in one of the two.

## 0.6.2

### Fixed: "File is 1 bytes"

The first message a file too small to hold a header gets, and the count was not agreeing with
its noun. A one-byte file — the shortest thing that is not empty, and what a truncated copy or
a failed download leaves behind — was told `File is 1 bytes; an EDF header alone needs at least
256.` Through `counted`, like every other count in this parser.

## 0.6.1

### Changed: the changelog lives at `docs/CHANGELOG.md`

Twelve of the repository's thirteen top-level entries are pinned there by something that reads
nowhere else: GitHub for `README.md`, `LICENSE` and `.github/`, its citation widget for
`CITATION.cff`, npm for the manifest and its lock, Vercel for `vercel.json`. `CHANGELOG.md` was
the one free to sit anywhere, so it sits under `docs/` now, moved with `git mv` so its history
follows it.

`files` ships it from the new path and the tarball is the same 61 files, so the only visible
change is where a consumer finds it: `node_modules/edf2csv/docs/CHANGELOG.md`. Both tests that
read the file — the one pinning the top-level layout, and the one checking the newest entry
against `package.json` — follow it there.

## 0.6.0

### Changed: `--info --json` reports no estimate rather than an estimate of nothing

```
$ edf2csv sleep-study.edf --info --json --annotations-only
  "estimate": { "rows": 0, "bytes": 0, "exceeds_spreadsheet_limit": false }
```

For a run that goes on to write an `annotations.csv` with every event in the recording. The text
form has refused to say this since 0.4.51 — it prints "Would write annotations.csv and
channels.csv, and no signal data. How many events there are cannot be told from the header."
because, as the code comment there puts it, `--info` exists to say what a conversion will do and
asserting it will write nothing when it will write a file is the one thing it must not do. The
JSON went on asserting it, to the surface a script reads.

`estimate.rows` and `estimate.bytes` are now `null` when the run writes no signal table: under
`--annotations-only`, and for a recording that holds only annotations. `exceeds_spreadsheet_limit`
stays `false`, which is true of a set of no files. Everything else is unchanged, and a run that
writes a signal table reports exactly what it did before.

A minor version because it is a change to a machine-readable contract: code doing arithmetic on
`estimate.rows` gets `null` where it used to get `0`, and that is worth a version number that
says so rather than a patch that does not.

## 0.5.151

### Fixed: the landing page pointed at the wrong file for rebuilding its recording

The comment above the `--info` block is the instruction for regenerating it, and it named
`test/fixtures/edf-writer.mjs` — the generic EDF writer, which builds every fixture and this
recording no more than any other. The recipe lives in `test/fixtures/sleep-study.mjs`, which
0.4.68 added for exactly this reason: the page had drifted twice while the recipe was prose in
a comment, so it was moved into code where a test could run it.

## 0.5.150

### Fixed: the landing page's metadata sample had the wrong byte count

`"bytes": 19670016` for a recording that is 19,643,392 bytes — 26 KB out, on the page whose
opening comment says every block on it is real output captured from that file. The `--info`
block six lines up gets it right, because a test regenerates it; this sample was never checked,
since the one that reads the page's samples skips any containing an ellipsis and this one
elides three fields.

## 0.5.149

### Fixed: "No dependencies at all, runtime or otherwise"

The published package has no `dependencies` and no `peerDependencies`, so nothing is installed
alongside it — which is the claim worth making and the one the rest of the documentation makes.
"Or otherwise" went further than that: building this repository needs TypeScript and
`@types/node`, both sitting in `devDependencies` a screen away in the same tree. The README now
says what is true and just as strong.

## 0.5.148

### Fixed: records_converted described as the records that were read

output-files defines it as "the half-open range of data record indexes that were read". Under
`--annotations-only` that is wrong twice over: no signal records are read, and the annotation
channel is read from end to end regardless of the window — so a run reporting
`records_converted: [1, 2]` read every record's annotation slot and none of its samples. What
the field actually describes, in every mode, is the window.

## 0.5.147

### Fixed: --force does not overwrite the output directory

`--help` and the README both described it as "Overwrite the output directory". It overwrites the
files the run produces and leaves everything else where it is — which is why `STALE_OUTPUT`
exists, and why converting a single-rate recording over a mixed-rate one leaves
`signals_256hz.csv` sitting next to the new `signals.csv`, both looking current. The FAQ has a
whole answer about that surprise; the one-line description was the sentence that set it up.

Both now read "Write into the output directory if it already exists".

## 0.5.146

### Fixed: --help promised the long layout comes out in time order

It said `--layout long` writes "time_s, channel and value, in time order". The tool warns about
two ways that is untrue — records stored out of chronological order, and records that overlap —
and cli-reference sets both out. `--help` stated the happy case as the rule, which is where a
reader decides whether they need to sort. It now says "one row per sample", which is the part
that is always true.

## 0.5.145

### Fixed: a third copy of the slug rule, in the file that stamps the ids

`slug.js` exists because two copies of "how a heading becomes a fragment id" had already
disagreed about hyphens — `## --layout` was `#--layout` in one and `#layout` in the other — and
its header comment says so. `addHeadingAnchors`, which is the function that actually puts the id
on the heading in the browser, still carried its own inline copy and did not import the module
at all.

The two agree today: all 217 headings on the site produce the same id either way, so no link
moves. It now calls `slugify` rather than reimplementing it.

## 0.5.144

### Fixed: two more things write to stdout than the page allows for

getting-started's tour of the output says "Only `--info` and `--json` write to stdout". `--help`
and `--version` do too, and are the two commands most likely to be run first. The sentence is
there so a reader knows what a pipe will carry.

## 0.5.143

### Fixed: --help is not handled before every other check

cli-reference said `--help` and `--version` are "handled before any other argument checking".
They are handled before the *inputs* are looked at, which is what the two examples beside the
claim show — but an unrecognised flag is caught first, so `edf2csv --help --bogus` exits 2 and
prints no usage. Someone reaching for `--help` to find out what they got wrong was told it
would work.

## 0.5.142

### Fixed: an estimate comment describing a quoting rule the writer does not have

The comment above the line that measures the header row said a column name is quoted when it
contains "a comma, a quote, a newline or a leading or trailing space". `escapeCsvField` quotes
on a comma, a quote, a carriage return or a line feed and nothing else — which is also what
output-files documents as the dialect — and a surrounding space cannot occur anyway, since
header fields are trimmed as they are read. The comment is the justification for measuring the
row with `csvRow` rather than by hand, so it is the wrong place to state a rule that is not the
one being measured.

## 0.5.141

### Fixed: the usage-error table was missing three of them

warnings-and-errors keeps a table of the ways a command exits 2. It listed `--decimals` and not
`--jobs` or `--layout`, which are refused the same way, and it never gained the `--channels`
term naming the annotation channel that 0.5.122 added. cli-reference's own exit-2 list picked
these up in 0.5.130; this is the second place that enumerates them.

## 0.5.140

### Fixed: two diagnostic codes documented above the wrong one

`DiagnosticCode` is an exported type, so its per-member comments are what an editor shows on
hover and what ships in the `.d.ts`. Both of these sat above `MISSING_EDF_PLUS_MARKER`:

```ts
  /** The header's start date or time is not a date or a time. ... */
  /** An annotation channel with a non-zero origin, in a file marked neither EDF+C nor EDF+D. ... */
  | 'MISSING_EDF_PLUS_MARKER'
  | 'START_TIME_UNREADABLE'
```

So hovering `MISSING_EDF_PLUS_MARKER` described a bad start date, and `START_TIME_UNREADABLE`
had nothing at all. Each comment now sits above the code it is about.

## 0.5.139

### Fixed: "1 signals require 512 bytes"

Two header messages counted signals into a fixed plural, and one signal is an ordinary
recording — a single-channel ECG strip is the smallest real file this reads:

```
warning: Header says it is 99 bytes, but 1 signal requires 512 bytes. Using the value computed
         from the signal count.
error: File declares 1 signal, which needs a 512-byte header, but the file is only 300 bytes.
```

Both are the reader's account of a header it distrusts, which is a bad place to be visibly
sloppy about the file's own numbers.

## 0.5.138

### Fixed: a batch arithmetic example that does not divide

api.md explains why the last `readRecords` batch is short, with: "a 24 MB recording read in 8 MB
chunks gives two full batches and a 2.9 MB one". Twenty-four divided by eight is three, and no
remainder at all — the sentence contradicts itself in its own numbers. Measured on the recording
the page actually reads, it is 18.7 MB and comes out as two 8 MB batches and a 2.7 MB one, which
is what it says now.

## 0.5.137

### Fixed: "Converted 1 of 1 recordings."

The closing line of a batch, on the ordinary case of a folder holding one recording. Every
other count this prints has agreed with its noun since 0.5.74; this one was still building the
sentence by hand.

## 0.5.136

### Fixed: the far-origin warning was quoted without the half that says what to do

The block for an origin too large for the file's own sample interval stopped at "Sample times
are written from zero instead, so every row is present and the column increases" — and dropped
the sentence after it, which is the one a reader needs: "Add the onsets in annotations.csv to
recover absolute times if you need them." Times written from zero are not the times in the
header, and where to get them back was the part left out.

## 0.5.135

### Fixed: "1 control character ... exactly as the header has them"

`NONPRINTABLE_LABEL` counts the control bytes it found and already says "character" or
"characters" accordingly. The pronoun closing the same sentence was fixed at "them", so a
channel with one of them read `contains 1 control character (\x07), which will appear in the
CSV column name exactly as the header has them`. It now says "has it" at one.

## 0.5.134

### Fixed: the FAQ counted four channels in a recording with five

"There is no annotations.csv in my output directory" tells you to run `--info` and read the
channel-count line, and showed `Channels   4 signals + 1 annotation channel`. The recording the
rest of that page converts has five, as the four other pages showing this line all say.

## 0.5.133

### Fixed: "1 of 3 data records carry ... their true position"

The subject of that sentence is the one, not the three:

```
warning: 1 of 3 data records carries no readable timekeeping annotation (record 2), so its
         true position in time is unknown.
         That record is timed as if it were contiguous; treat its timestamp as unreliable.
```

The record list beside it already agreed — "record 2" rather than "records 2" — so the singular
case was half handled and read as though the count had been pasted into a plural sentence. Both
pages that quote it are updated.

## 0.5.132

### Fixed: "Two exceptions" followed by three of them

The column-naming section lists the cases where a column is not the channel's label verbatim.
0.5.113 added the third — a channel labelled `time_s`, which would otherwise give the file two
columns of that name — and left the sentence introducing them saying two.

## 0.5.131

### Fixed: a size of 1024 KB, which is a megabyte

`formatBytes` picked the unit and then rounded, so anything within half a percent below a
boundary printed as 1024 of the smaller one: a 1,048,575-byte recording reported `Size 1024 KB`,
and the estimate line did the same at every boundary above it. Rounding is now carried into the
unit, which is the fix `formatDuration` already has one function down — it rounds before
splitting, so 3599.9996 s is `1h 00m 0s` rather than `59m 60s`.

## 0.5.130

### Fixed: the exit-2 list left out half of what exits 2

"**Exit 2** covers anything decided before touching data", says the reference, and then lists
what that is. The list named `--decimals` and neither `--jobs` nor `--layout`, which are checked
the same way, in the same function, a dozen lines apart — `--jobs 0` has been a usage error
since 0.4.2 and `--layout tall` since 0.5.0. It named one of the `--stdout` refusals, the one
about tables, and not `--json`, `--out`, `--checksum`, `--force`, a folder or a second
recording, every one of which the tool refuses before it opens the file. And the empty folder
appeared only as a parenthesis under exit 1, which is where it is not.

A list that claims to be complete and is half a list is worse than no list: a script written
from it treats an exit 2 it did not expect as a crash.

The missing conditions are named now, and a test derives them rather than trusting a copy. It
reads `--help` for every long option that takes a value, hands each one a value nothing could
mean, and requires the exit-2 section to name every flag that answers with exit 2 — so a flag
added tomorrow with a value it checks fails this until the reference mentions it. The `--stdout`
combinations are run the same way.

## 0.5.129

### Fixed: the commonest refusal on the site was quoted with its advice flush left

```
error: No channel named "ECQ". Did you mean "ECG"?
Run with --info to list the channels in this file.
```

The tool indents that second line by seven, under the first word of the message. Four hundred
lines below its own copy of this block, the reference explains why: "Every refusal takes that
shape — `error:` on the first line, the advice indented under it — so stderr can be grepped for
`^error:` and find all of them." Written flush left it reads as a second error, and a reader
building that grep out of these blocks would expect two lines back from a run that emits one.

The FAQ had it the same way, in the answer titled "I asked for a channel and it says there is
no channel with that name" — which is the page a reader arrives at holding the real message,
looking for the one on screen.

Both now match, and a test runs the refusal rather than matching its text: any block on the
site that opens `error: No channel named "…"` is compared against what that term really
produces.

## 0.5.128

### Fixed: the step formula the pages print is negative for a calibration real files carry

Three pages state the smallest physical step a channel can express, because it is what decides
how many decimals its values get. Two printed it with the magnitude on one difference only:

```
step = |physical_max - physical_min| / (digital_max - digital_min)
```

`reversed-bounds.edf` has a channel whose digital pair is written the wrong way round — legal,
warned about with `INVERTED_PHYSICAL_RANGE`, and converted as the header says. For that channel
the printed formula is -0.1, and the next thing the page tells you to do with it is take
`ceil(-log10(step))`, which of a negative number is not a number at all. The code takes the
magnitude of the whole quotient and gives that channel 3 decimals, the same as the upright
channel beside it — the only answer that keeps its distinct codes distinguishable.

Both differences are magnitudes now, on all three pages, with a sentence saying why. Held by a
test that evaluates the formula the page prints against the function the conversion uses, on
each of that fixture's three shapes: physical pair reversed, digital pair reversed, and both.

## 0.5.127

### Fixed: the chunked-reader recipe printed a row count and a peak from nowhere

```python
print(rows, peak)   # 7372800 122.161
```

The file it reads is `sleep_csv/signals_100hz.csv`, and neither number is that file's.
7,372,800 rows is eight hours at 256 Hz; eight hours at 100 Hz is 2,880,000, which the same
page states eighteen lines further down while explaining what `merge_asof` would do to it. And
122.161 is not the peak of anything — that column reaches 250, its declared physical maximum.

A recipe that prints a result is a claim about a file. This one is now converted and read down
by a test, the way the snippet reads it, and both numbers are checked against what comes out.

## 0.5.126

### Fixed: the metadata.json the page explains was a different recording's

output-files prints a whole `metadata.json` as its explanation of the format — the transcript
someone reads before writing code against those fields. Its `source.path` ends in
`sleep-study.edf`, which on this site is one specific recording: eight hours of five channels
at 100, 10 and 1 Hz with an annotation channel.

The sample described three channels at 256, 128 and 1 Hz. 39 MB against 18.7. 412 events
against 7. Three channel rows against 5. `signal_count` 4 against 6. Started in March 2026
rather than March 2002. One warning where that conversion raises two — and the field named
`notes` is the one a reader consults to find out what a warning looks like in the record.

The guard that existed declined to check any of it, on the stated grounds that "the sample
describes an 8-hour sleep study that is not in this repository". It has been in this repository
since 0.4.68, as `test/fixtures/sleep-study.mjs`, and is what every `--info` block on the site
is generated from. The values are now compared against a real conversion of it; the run's own
fields — the tool version, where the file sat, when it was converted — stay illustrative.

The same page ran `edf2csv sleep-study.edf` over a directory listing of `signals_256hz.csv`,
`signals_128hz.csv` and `signals_1hz.csv`. That is `recording.edf`, the three-rate example
sampling-rates uses, and it is now called that.

## 0.5.125

### Fixed: the FAQ's --json example was another recording's summary, warnings included

"How do I check whether a conversion had problems from a script?" runs `--json` on
`sleep-study.edf` and showed:

```json
{
  "files": [
    { "name": "signals.csv", "rows": 921600 },
    { "name": "annotations.csv", "rows": 3 },
    { "name": "channels.csv", "rows": 1 }
  ],
  "annotations": 3,
  "duration_seconds": 3600,
  "records": 3600,
  "warnings": []
}
```

Every figure belongs to some other file. That recording is eight hours of five channels at
three rates: three signals files, seven events, five channel rows, 28,800 records. And it
raises two warnings — the paragraph directly below promises they will be in that array, and
the same page prints one of them, five answers earlier, about this same file. Someone comparing
their own output against this block would conclude their conversion had gone wrong.

The block is now what that command writes, `warnings` included, and a test converts the
recording and holds every `--json` block on the site to it. `elapsed_ms` and `output_dir`
belong to the run rather than to the recording and stay illustrative.

## 0.5.124

### Fixed: a stray space meant four things depending on which option carried it

A value reaching the tool with space around it is ordinary — `--jobs "$(cat n)"`, a copied
argument, a shell variable holding a trailing newline. Four options took four views of one.

`--start` and `--decimals` trimmed it, and when the value was wrong anyway they quoted back
what was typed. `--layout` did not trim at all, so ` long` was refused for a character nobody
wrote and the message could not show. And `--jobs` trimmed and then quoted the remains:

```
$ edf2csv rec.edf --jobs " "
error: --jobs must be a whole number of 1 or more, or "auto", got "".
```

Which reads as though no value had been given, when the value is the entire reason it failed —
and `--jobs " x"` came back as `got "x"`, with the space that a shell had put there invisible.
The quotation marks exist to show where a value begins and ends; trimming before printing them
takes that away exactly where it is needed.

All four now trim, and all four quote the value as given. The comments in `--jobs` and
`--decimals` claimed ` 4 ` and ` 3 ` were among the forms they refused, which they never were.

## 0.5.123

### Fixed: the FAQ showed one recording's long layout under another recording's command

"Why did I get several signals files instead of one?" answers with `sleep-study.edf`: it lists
that recording's three rates, names all five of its channels, and then offers `--layout long`
as the one-file alternative:

```bash
edf2csv sleep-study.edf --out ./converted --layout long
```

```
time_s,channel,value
0.00000000,EEG Fpz-Cz,0.061
0.00000000,ECG,0.00122
0.00000000,Temp rectal,37.00073
0.00390625,EEG Fpz-Cz,9.096
```

Three channels, one of them an ECG that recording does not have, at the eight decimal places a
256 Hz channel needs and none of its channels ask for. It is `mixed-rates.edf` converted, and
captioned with somebody else's command — eight lines under the same answer's own list of what
the file holds.

What that command writes is five channels at the first instant and `time_s` at three places,
which is what the block shows now. cli-reference has had it right all along; the two pages now
agree because a test converts the recording and holds every `--layout long` block on the site
to what came out.

## 0.5.122

### Fixed: asking for the annotation channel was answered by denying it exists

```
$ edf2csv sleep-study.edf --channels "EDF Annotations"
error: No channel named "EDF Annotations".
       Run with --info to list the channels in this file.
```

Both halves are wrong for the same reason. `EDF Annotations` is the label the specification
reserves, the file really carries it, and `--info` counts it two lines above on the "Channels"
line — but the table `--info` prints lists signal channels only, so a reader who follows the
advice arrives back at the same message with nothing new to try. And what they were after is
already on disk: any conversion of a file with this channel writes `annotations.csv` out of it.

```
error: "EDF Annotations" is this recording's annotation channel, not a signal: it holds event
       text rather than samples, so it has no column to select.
       Its events are already written to annotations.csv by any conversion of this file — pass
       --annotations-only for those and no signal data.
```

`BDF Annotations` gets the same answer on a BDF+ file, and matching is case-insensitive like
every other term. A recording that genuinely has no annotation channel keeps the old message,
because for that file the old message is true.

## 0.5.121

### Fixed: the first conversion on the page printed a line the tool does not print

getting-started's first conversion — the first output anyone reading the documentation sees:

```text
Wrote recording_csv
  signals.csv      300  rows
  annotations.csv    3  rows
  channels.csv       1  rows
```

The last line is `1  row`. The summary has agreed its count with its noun since 0.5.98, and one
channel is the ordinary case for the small EDF+ file that block describes — so the page showed
the one run where the rule applies and printed it as though it did not. The seizure-window
recipe did it twice more, for its `annotations.csv` and its `channels.csv`.

Held now by a test that reads every quoted summary line on every page and checks the noun
against the number, since the recordings these blocks describe are examples rather than
fixtures: they need not match a run, but they cannot disagree with the rule the writer applies.

## 0.5.120

### Fixed: a recording timed from before zero had no window you were allowed to ask for

`--info` on `negative-origin.edf`, whose records run from -100 s to -97 s:

```
Duration   3s  (3 records of 1s)
Timed from -100.000s  (first sample; --start and --end use this clock)
```

That line is an instruction — the number is printed in seconds precisely so it can be typed
straight back in. Every way of typing it was refused:

```
error: --start "-100" is not a time I understand. Try 30s, 5m, 1h30m, 00:30:00, or a plain
       number of seconds.
```

`parseTimeSpec` took no sign, and every offset that file has is below zero, so the whole of
`--start` and `--end` was unreachable on it: not a wrong window, no window at all. A bare
conversion worked, which is why it went unnoticed. The library said the same thing one layer
down, where `checkOptions` refused a negative `start` while `plan.range` handed the caller back
`recordingStartSeconds: -100`.

`--start` and `--end` now take a leading `-`, in every form the parser already accepted:
`-100`, `-100s`, `-1h30m`, `-00:01:40`, `-250ms`. The sign applies to the whole value, so
`-1h30m` is ninety minutes before the origin rather than sixty before and thirty after.
Nothing may sit between the sign and the number, and `+5` is still refused — the rule
`--decimals` and `--jobs` already hold. `--duration` is a length rather than a position and
still refuses one: `--duration=-5` is `not a valid non-negative time`.

Written as one argument, since a value beginning with a dash otherwise reads as another flag —
`--start=-100`. The tool has said so in as many words since 0.4.34.

## 0.5.119

### Fixed: a paragraph written into the middle of a quoted warning

The `CONTINUOUS_LIAR` entry in warnings-and-errors quotes what the run prints. What the page
showed was this:

```
warning: This file is marked continuous (EDF+C), but 2 of its 3 data records say they start
         somewhere other than where continuity puts them.

A BDF+ file gets its own spelling — `BDF+C` and `BDF+D` — the same as the discontinuous entry
above. Until 0.5.105 this half of the code printed the EDF markers whatever the format, so a
BDF+ recording was told about a string it does not contain and pointed at a marker BDF+ does
not define.
         Times are written as if the records were contiguous, which is what EDF+C means.
         If the recording really has gaps, the file should have been marked EDF+D.
```

An English sentence, backticks and all, inside the code block, between the warning and its own
advice — so the two indented lines read as hanging off the paragraph rather than off the
warning, and the warning itself reads as ending mid-sentence. The paragraph is true and belongs
on the page; it is now below the block instead of inside it.

A hint is joined to its message by nothing but that indent. So an indented line in a quoted
diagnostic has to have a diagnostic directly above it, and a test now holds every such block on
every page to that. A blank line inside one is still fine — the mixed-rate example shows a
warning, a blank line and then the closing summary, which is exactly what that run prints.

## 0.5.118

### Fixed: one failed write, two error lines, and the second one wrong about it

`edf2csv wide.edf --info > desc.txt` onto a filesystem with no room:

```
error: Writing to stdout failed: ENOSPC: no space left on device, write
error: Writing to stdout failed: 58900 of 58900 bytes did not reach the destination, which
       stopped accepting them part way through.
       What is there ends mid-row and should not be used. ... and nothing after it raised an
       error because there was nothing after it.
```

Three of the second message's claims are false of what happened. Nothing was accepted, so the
destination did not stop part way through. The file is empty, so nothing "is there" and nothing
ends mid-row — and a description is a table, which has no rows to end mid-. And something after
it did raise an error: the line printed directly above.

The stdout audit exists for the one failure nothing else reports, a write that is accepted and
silently truncated. When the stream itself has already errored there is nothing left for it to
add, and it now says nothing. When it does speak and nothing landed at all, it says so rather
than describing a short write.

### Fixed: and then that failure exited 0

With the audit silent the run exited 0 — the error printed, the file zero bytes, and success
reported. The stdout listener sets the failing exit code, and the entry point assigned `main`'s
0 straight over it; the audit's second error was the only thing that had been making the run
fail. A code already set by a reported write failure now survives a run that returns 0.

A closed pipe still exits 0: that path deliberately sets no code, which is what makes
`--info | head` an ordinary thing to do rather than a failure.

## 0.5.117

### Fixed: the recipes page loaded a file the example recording never writes

recipes runs `edf2csv sleep-study.edf --out ./sleep_csv`, shows an `ls` of the result, and then
reads it fourteen times over — pandas, R, data.table, MATLAB, DuckDB, the chunked reader, the
`merge_asof` recipe. Every one of them opened `sleep_csv/signals_256hz.csv`.

That recording has no 256 Hz channel. It has three at 100 Hz, one at 10 Hz and one at 1 Hz, and
converts into six files:

```text
annotations.csv
channels.csv
metadata.json
signals_100hz.csv
signals_10hz.csv
signals_1hz.csv
```

The `ls` block listed four, one of them a file the run does not write and three of them missing.
Every snippet on the page after it was a `FileNotFoundError` on its first line.

The channel names went with it: the snippets print an `ECG` column, which belongs to a different
recording — this one's third 100 Hz channel is `EOG horizontal`. The `--info` table a hundred
lines above them has listed the real channels and the real file names all along.

faq's answer to "why several signals files" laid the same recording out as `signals_256hz.csv`,
`signals_128hz.csv` and `signals_1hz.csv`, and its two loader snippets and its digital-code
recipe read the 256 Hz file.

Corrected against a conversion: file names, channel names, the sample values and times in the
outputs shown, the wall-clock example's timestamps, the `channels.csv` listing, and the count of
interpolated rows in the `merge_asof` note (2,880,000 at 100 Hz, not 7,372,800 at 256 Hz).

A test converts one second of the fixture the example recording is built from and holds every
path under that output directory, and the `ls` block itself, to what the run writes.

## 0.5.116

### Fixed: a recording it is not allowed to read came back as a raw Node error

```
error: EACCES: permission denied, open '/data/noread.edf'
```

Every neighbouring failure prints the tool's own sentence — `Cannot read "nope.edf": no such
file` — and the library raises an `EdfError` whose `code` says which kind of failure it was.
This one printed Node's errno text with no hint, and threw a plain `Error` whose `code` was
`EACCES`.

`stat` needs the parent directory searchable and says nothing about the file's own mode, so a
recording with no read permission passes it and fails at the open two lines later, which was
the one call not wrapped. Denying the *directory* was translated correctly, which is why this
looked covered.

api.md says `UNREADABLE` "covers a missing file, a directory passed where a file was expected,
a permission failure, and a file that changed size while being read. Branch on `code`, never on
the message text." A consumer doing exactly that fell through to its generic handler for the
commonest permission failure there is.

```
error: Cannot read "/data/noread.edf": permission denied
```

The test skips itself where the file turns out to be readable anyway, since root reads a mode-000
file regardless and there would be nothing to assert.

## 0.5.115

### Fixed: the padding at the end of an annotation slot was exported as an event

A file holding two events wrote four rows:

```
onset_s,duration_s,description,record_index
0.5,,Lights off,0
0.5,,          ,0
1.5,,Lights off,1
1.5,,          ,1
```

The invented rows carry the real event's onset, so anything keyed on `onset_s` saw each event
twice, and `annotations_written` and the run summary agreed with the larger number. No warning.

The decoder already refuses to call a run of spaces a lost annotation — but that check sees only
the chunks between NULs, and a writer that leaves its last TAL unterminated puts the fill inside
the chunk, after the final `0x14`. Split on that separator it is a text segment like any other,
and `" "` is not `""`.

A text segment that is nothing but slot fill — space, tab, CR, LF or NUL — is padding now, by the
same rule the chunk-level check uses. An event whose description is genuinely nothing but spaces
cannot be told from fill at this level; inventing rows out of fill is the worse of the two
answers, and it is the one that was being given.

## 0.5.114

### Fixed: "No event was lost" printed over a conversion that lost four

A TAL in first position states the record's start time, and may carry events after it — the
format allows both in the one entry, and writers use it. When one of those cannot be parsed,
both are gone. It was counted only as lost timekeeping, whatever it held, and the warning for
that says in so many words that nothing was lost.

Two files differing in one character, a decimal comma for a decimal point in the first entry:

```
+1.5   6 rows in annotations.csv
+1,5   2 rows
       warning: 2 data records carry a timekeeping annotation that could not be read...
                No event was lost — a timekeeping annotation states a record's start time
                and is never exported.
```

Four events gone, and the only warning about them denies it. `ANNOTATION_DECODE_FAILED`'s other
half — "N annotation entries were unreadable and could not be exported" — never fired, because
the entry was routed by position alone.

These counts were split apart in 0.4.41 so each message would describe the loss it names, after
the same sentence had been wrong in the other direction. This is the case that split missed.

An unreadable first-position entry that carries text is now counted as both: one entry that
could not be exported, and one record with no position. The hint keeps to what is true of the
entries it is about — "2 of them also carried event text, which went with them and is counted
above" — and still reads "No event was lost" for a bare timekeeping entry, which is nearly all
of them.

## 0.5.113

### Fixed: a channel labelled `time_s` gave signals.csv two columns of that name

Column names are made unique among the channels. The time column is not one of them — no file
supplies it, the writer puts it in front — so a channel whose label is `time_s` collided with it
and nothing noticed:

```
time_s,time_s,ECG
0.000,50.000,0.000
```

Exit 0, no warning, and `channels.csv` gave that channel's column as `time_s`, so the join it
exists for pointed at the wrong one. `metadata.json` said the same.

A repeated header name is resolved by whichever reader you happen to use, and the two this site
names resolve it opposite ways round: pandas `read_csv(..., index_col="time_s")` takes the time
column, and Python's own `csv.DictReader` keeps the last field of that name, which is the channel.
So `signals.pop("time_s")` and `long.pivot(index="time_s", ...)` silently used one or the other.

The label is legal — EDF labels are free text — and it is what a montage exported from a tool that
already had a time column looks like.

The time column is now reserved in the same pass that keeps the channel columns apart, so such a
channel takes `time_s_ch0` and is named in a warning, as any channel that loses its own label
already was. The writer takes the name from that pass rather than repeating the literal, so the
reservation and the header cannot drift apart.

`--channels "time_s"` still selects the channel: what moved is the column, not the label, and
`--channels` matches the label.

## 0.5.112

### Fixed: the advice for a channel with a comma in its label printed a command that exits 2

`NONPRINTABLE_LABEL` exists to say how to reach a channel whose header text you cannot type, so
a hint whose command fails is worse than no hint — which is why 0.5.103 fixed the empty-label
branch. There was a third case, and it looks like the one branch that was right.

A channel labelled `EEG Fpz-Cz, ref`, with a control byte in its unit, got:

```
warning: Signal 0's unit contains 1 control character (\x1b), which will appear in
         channels.csv's unit cell exactly as the header has them.
         The column name is unaffected, so --channels "EEG Fpz-Cz, ref" still selects it.
```

That command exits 2 with `No channel named "EEG Fpz-Cz"` — a channel the file does not have,
named after half of one it does. `--channels` separates names with a comma and splits on every
occurrence, so a label holding one cannot be selected by name at all. The label is perfectly
typeable; it just isn't a term.

The hint now sends those channels to `--channels "#0"`, like the other two cases, and says why.
The reference's matching rules and the warning's own page say so too — both listed the
no-label case as the one thing `#<index>` was needed for.

The test that runs what the hint says, rather than matching it, gains a fourth case. Its column
count now splits the CSV header on the commas that separate columns rather than on every comma,
which the case it was added for would otherwise have passed for the wrong reason.

## 0.5.111

### Fixed: a directory called `undefined` has been in the repository since 0.5.30

0.5.30 fixed `npm pack` shipping a tarball with no code in it. The same commit also added ten
files under `undefined/` — the output of two conversions whose `--out` had been built from a
shell variable that was never set, swept up by a `git add -A` along with the real change.

It has been tracked ever since. `files` limits the tarball to `dist`, the README, the licence and
this file, so nobody installing from npm was ever given it; anyone cloning the repository, or
installing from a git URL, got 84 KB of somebody else's converted sleep study.

Removed from the tree. A test now holds the list of top-level entries the repository tracks, so
the next one has to be added to that list on purpose rather than arriving with a batch of edits.
It skips itself outside a git checkout, since running the suite from an extracted tarball is a
reasonable thing to do.

`deleted/` is added to `.gitignore` alongside it.

## 0.5.110

### Fixed: the reference said there was one way a long file comes out unsorted, and quoted it wrong

`--layout long` writes one row per sample, sorted by `time_s` — because records are written in
file order and each record's samples fall inside its own span. The reference named "one exception
the format allows and the tool warns about". There are two, and the tool warns about both.

The first is the obvious one: a discontinuous recording may store its records in a different order
than it times them. The second is overlap. Records of one second at 0 s and 0.25 s have strictly
increasing starts, so nothing fires for order, and the column comes out `0.000, 0.500, 0.250,
0.750` anyway, because the first record's samples run past where the second begins. That case has
had its own warning since 0.5.25 and its own entry in warnings-and-errors; the page that describes
the layout's ordering didn't mention it.

Both are now described where the guarantee is stated, with the arithmetic for the overlapping one.

### Fixed: two quoted warnings that no version prints

0.5.107 made these two sentences agree with the number they count. The documentation kept the
sentences from before it:

```
warning: 2 data records start earlier than the record before it.      (the reference)
warning: 1 data record start earlier than the record before it.       (warnings-and-errors)
```

One wrong pronoun and one wrong verb, and between them every count a reader might search their
logs for.

A test now generates all four of these sentences — both kinds, singular and plural — from files
built for the purpose, and holds every quoted `warning:` line in the documentation that counts
data records to the set.

## 0.5.109

### Fixed: three pages still described an inverted channel by the rule that was corrected

What inverts a channel is a negative gain, and the gain is
`(physical_max - physical_min) / (digital_max - digital_min)` — so reversing exactly one of the
two bounds pairs inverts the polarity, and reversing both leaves it positive and ordinary. The
code was corrected to that rule and `reversed-bounds.edf` was written to hold it: three channels,
two warned about, one not.

One page was corrected with it. Three were not:

- **correctness** listed "`physicalMin` above `physicalMax`" as a header condition that raises
  `INVERTED_PHYSICAL_RANGE`.
- **edf-format** said "`physicalMin > physicalMax` inverts the polarity of the channel".
- **output-files**, describing the `physical_min` and `physical_max` columns of `channels.csv`,
  called such a channel "an inverted channel" outright — the page a reader lands on when they
  are looking at those two columns and wondering.

The fixture's third channel is exactly that shape and draws nothing.

All three now state the rule by the sign of the gain and say what reversing both pairs does.
`reversed-bounds.edf` is also added to correctness's fixture table, which claimed the inversion
row had a fixture "listed below" and then didn't list it.

A test opens that fixture, confirms the channel is still there and still unwarned, and then
holds every page to it. It reads the backticked field and column names, so the warning's own
sentence — true of the channel it names — is not caught by it.

## 0.5.108

### Fixed: the annotations page said the example recording has one signal

`edf2csv sleep-study.edf --info`, on the EDF+ annotations page, answered

```
Channels   1 signal + 1 annotation channel
```

Three other pages run that exact command on that exact recording and print `5 signals`, which
is what it has: two EEG derivations, an EOG, a respiration trace and a rectal temperature, all
of them listed in the channel table further down two of those pages.

The line had been written to make the section's point — that the annotation channel is counted
apart from the signals — and the real number makes it just as well.

A test now runs `--info` on the fixture the site's example recording is built from and compares
every header line the docs show against the line that comes out, on every page, skipping only
`File` (the path as typed, which differs by page on purpose). It reads the fields a block chose
to show, so an excerpt of two lines is checked as strictly as a full block.

## 0.5.107

### Fixed: recipes.md said the signal CSVs are already sorted, and one kind of file is not

The `merge_asof` recipe for aligning two rate files closes with "Both frames must be sorted on
the join key, which they already are." True of an ordinary recording. An EDF+D file whose data
records are stored out of chronological order writes its rows in file order, so `time_s` comes
out `0, 0.5, 10, 10.5, 5, 5.5` — and pandas raises `ValueError: left keys must be sorted` on it.

output-files has always said this can happen, in the `time_s` section. The recipe that depends
on it did not, and a recipe is where the claim actually gets used.

Qualified, with the warning the conversion prints and the one-line fix (`sort_values` before the
join), linked to the section that sets out when it happens.

### Fixed: "1 data record start earlier than the record before it"

The two warnings that report records out of order or overlapping counted with hard-coded verbs
and pronouns. They read "starts ... before it" at one and "start ... before them" above it.

## 0.5.106

### Fixed: two warnings printed together, and the second denied the first

```
warning: This is a discontinuous (EDF+D) recording: its data records are not contiguous in time.
         Each row carries its true recording time, so gaps stay visible instead of being closed.
warning: This file is marked discontinuous but has no annotation channel, so where its records
         sit in time is not recorded anywhere.
         Times are written as if the records were contiguous. Any gaps are lost.
```

The column runs contiguously from zero. No row carries a true recording time, because none is
recorded — which the second warning says plainly, four lines under the first one promising the
opposite.

The header parser raises the first, and it cannot know: whether the record starts can be derived
is settled after the annotation channel has been read. So the promise is withdrawn where the
answer is, the way `withoutFileRateWarning` already drops a header diagnostic the plan has
superseded. A file that can keep it keeps it — `discontinuous.edf` still says gaps stay visible,
and its rows still carry the nine-second gap.

## 0.5.105

### Fixed: a BDF+ recording was told it is "marked continuous (EDF+C)"

```
warning: This file is marked continuous (EDF+C), but 2 of its 3 data records say they start
         somewhere other than where continuity puts them.
         Times are written as if the records were contiguous, which is what EDF+C means. If
         the recording really has gaps, the file should have been marked EDF+D.
```

on a file whose reserved field reads `BDF+C`. Neither `EDF+C` nor `EDF+D` appears anywhere in
it, so a reader who greps the header for what the warning names finds nothing — and `EDF+D` is
not a value BDF+ defines, so the remedy is for the wrong format. `continuity` normalises the
BDF markers to the internal `EDF+` tags, and this message printed the tag.

The sibling discontinuous warning has substituted the BDF spelling since 0.3.x, in the same
file, from the same header field. The continuous branch never got it.

It reads `BDF+C` and `BDF+D` for a BDF+ file now, and the test refuses either EDF marker
anywhere in the message or its hint. An EDF file is unchanged.

The same sentence counted with a hard-coded plural: "1 of its 3 data records say they start
... where continuity puts them". It says "says it starts ... puts it" at one.

## 0.5.104

### Fixed: signals.csv and annotations.csv came out a thousand seconds apart, in silence

The reserved field decides whether a recording's origin is applied. The annotation channel is
found by its label. A file carrying an annotation channel whose timekeeping says the records
begin at 1000s, with neither `EDF+C` nor `EDF+D` in its reserved field, got both halves of that:

```
$ head -2 out/signals.csv        $ cat out/annotations.csv
time_s,EEG                       onset_s,duration_s,description,record_index
0.000,0.0244                     1001.5,,event,1
```

One conversion, two files, a thousand seconds apart, exit 0 and nothing said — against a
documented promise that "`onset_s` is on the same clock as `time_s` in the signal files".

New warning `MISSING_EDF_PLUS_MARKER`, naming the offset and both consequences. Reported rather
than repaired: which field is wrong is not knowable from inside the file. The marker says plain
EDF and the annotation channel says otherwise; applying the origin moves every sample and
ignoring the onsets moves every event, each on a guess. A file whose records begin at zero has
no disagreement and says nothing.

### Fixed: the docs test was checking 24 of the 27 diagnostic codes

It reads the `DiagnosticCode` union by scanning to the semicolon that ends the declaration, and
the members carry doc comments — so a semicolon inside one of those ended the scan three codes
early. The checks built on it went on passing: the missing three were never looked for, and the
opposite check called them codes the source does not have.

Found by writing a comment containing a semicolon. Comments are stripped before the scan now,
and the member count is checked against the source, because a guard that quietly measures less
than it claims is the failure this file exists to prevent.

## 0.5.103

### Fixed: the advice for reaching an awkward channel printed a command that exits 2

`NONPRINTABLE_LABEL` exists to say how to reach a channel whose header text you cannot type, so
a hint whose command fails is worse than no hint. One branch of it quoted the label back:

```
warning: Signal 0's unit contains 1 control character (\x07), ...
         The column name is unaffected, so --channels "" still selects it.
```

`--channels ""` exits 2 with "--channels was given but lists no channel names". The channel has
no label — 0.5.73's `EMPTY_LABEL` message already says the position is the only way in for one
of those, and this hint, added in 0.5.71 and widened in 0.5.102, did not.

It gives `--channels "#0"` for an unlabelled channel now, and keeps quoting the label when there
is one to quote.

The test runs what the hint says rather than matching it, across all three branches — no label,
a typeable label, an untypeable one — and requires the command to exit 0 and select a channel.
Checking a hint any other way is checking the sentence rather than the advice.

## 0.5.102

### Fixed: NONPRINTABLE_LABEL checked two of the four free-text fields

A channel header carries four pieces of free text: label, physical dimension, transducer and
prefiltering. The warning checked the first two. `transducer` and `prefiltering` land in
`channels.csv` exactly as the unit does, so

```
EEG,0,EEG,uV,2,2,-1,1,-1,1,AgAgCl<ESC>[2J,,signals.csv,yes
```

reached the CSV with nothing said, and `cat channels.csv` would clear the terminal. That is the
hazard this warning exists for, two columns over.

All four are checked now, and the message names which of them — which 0.5.71 taught it to do
for the first two, since what it costs differs: a label becomes the column name in
`signals.csv`, the other three are cells of `channels.csv`. When one field carries them it names
the cell rather than the file, because `channels.csv` has fourteen columns and "somewhere in
this file" is not an answer.

## 0.5.101

### Fixed: a header with no readable timestamp raised nothing

EDF gives the start date and time eight characters each and enforces nothing about them. A
recording carrying `32.13.99` and `25.61.61` converted, exited 0, passed `--strict`, and left
`"start_datetime_local": null` in metadata.json with no note against it. `--info` echoed the
raw fields with "(unparseable)" beside them, so an interactive reader saw something; a script
reading the archive got a bare null and no reason for it.

Every other unusable header field reports itself — a degenerate digital range, a physical span
that cannot be represented, a comma decimal separator, a header whose declared size disagrees
with its signal count. The start instant was the one that did not, and it is the field
output-files points at for turning `time_s` into a wall-clock instant.

New warning `START_TIME_UNREADABLE`, quoting the fields as the header has them so the message
can be checked against the file, and saying what is and is not affected: `time_s`, the values
and the annotation onsets all count from the recording's own start, which does not depend on
the header saying when that was. Documented on all three pages.

## 0.5.100

### Fixed: `--stdout --force` was accepted and did nothing

`--force` means "write into an output directory that already exists". Under `--stdout` there is
no directory, so it was accepted and dropped — which is exactly what 0.5.5 refused `--out` and
`--checksum` for, on the reasoning its own entry gives: "Both were accepted and dropped in
silence before that." `--force` was the third of the same kind and was left behind.

Refused now, with the same sentence the other two get.

`--jobs` is deliberately not refused. A job count is a property of the run rather than a request
about this file's output, `--stdout` clamping it to one is documented, and a wrapper that passes
`--jobs 4` to everything is not asking for something about this recording. I had it refusing
that too and backed it out: an existing test accepts `--jobs 4` under `--stdout` on purpose, and
reversing a deliberate decision is not what this change is for.

### Fixed: those two refusals were still printing in the shape 0.5.79 replaced

`--stdout --out` and `--stdout --checksum` printed flush left with no `error:` prefix and no
indented continuation. 0.5.79 gave every other refusal that shape so stderr can be grepped for
`^error:` — and its test listed the refusals it happened to think of, which did not include
these two. It enumerates every `--stdout` refusal now, which is how this was found.

## 0.5.99

### Fixed: "Anything the tool noticed is printed after the table" — followed by one of the two

`edf2csv sleep-study.edf --info` prints two warnings: the mixed sampling rates, and that at
least one output file will exceed what Excel and Numbers can open. getting-started introduced
the block with that sentence and showed the first.

The omission is an odd one to leave: the row limit is a section of this project's own FAQ, and
a reader is sent there later having been shown a run of the same recording that apparently did
not raise it.

Both are there now, with a link to the answer. The test runs the command the page is describing
and requires every `warning:` line it prints to appear on the page — which is the only way a
block quoting output stays honest as the tool gains things to say.

## 0.5.98

### Fixed: "what --info can and can't tell you" was wrong in both directions

cli-reference points readers at that section for the answer, which makes being wrong there
worse than being silent. It was wrong twice.

It said `--info` "also raises `ANNOTATION_DECODE_FAILED`", unqualified. It raises it for what
it read, and on a continuous file that is sixteen records — so `two-annotation-channels.edf`
warns about three unreadable events when converted and says nothing at all under `--info`. Its
byte-identical discontinuous twin warns either way, because there the whole channel is read.

And its list of what `--info` cannot raise — `NO_ANNOTATIONS`, `STALE_OUTPUT`, the EDF+C
contradiction — left out the `NO_SAMPLES` that reports a signal file *not written*.
`annotations-only.edf` raises it on conversion and not under `--info`. The per-channel
`NO_SAMPLES`, about a channel carrying no samples, comes from the header and is raised, so the
code alone does not settle it and the page now says which form it means.

Held to it by a sweep rather than by review: every fixture is described and converted, and any
code the conversion raises that `--info` does not has to be one the page names. That is how the
two missing ones were found, and it is what would find the next.

## 0.5.97

### Fixed: three pages said `--info` reads only the header, on files where it reads records

"`--info` reads only the header for plain EDF and continuous EDF+, so it returns in
milliseconds whatever the file's size." Getting-started said it, recipes said it twice.

Since 0.5.46 it reads up to sixteen records' annotation slots of a *continuous* EDF+ as well,
to find where the recording begins — which is why it raises `ANNOTATION_DECODE_FAILED` on
`lost-timekeeping.edf`, a continuous file, and prints `Timed from 0.500s` for
`fractional-start.edf`, another one. Both are behaviours the pages elsewhere describe and
recommend.

warnings-and-errors has had this right since 0.5.37 — "the first few records of a continuous
one to find where the recording begins" — and cli-reference points readers there for the
answer, so three pages contradicted the fourth about how much of a file a command touches.

All three say what it does now, and link to the page that sets out which warnings follow. The
test asserts the behaviour first and the prose second: if `--info` ever really did stop reading
records, the pages would be right and this test is what should fail.

## 0.5.96

### Fixed: api.md said `readAnnotations` returns three counts, then named four

0.5.58 added `negativeDurations` to the list and left the number in front of it. That is the
mistake 0.5.62 fixed one page over — "This code covers three conditions" against a list of five
— on a sentence a reader checks against the list in the same breath.

The pronoun after it had slipped the same way: "That last one is why `duration` being `null` is
not by itself the same as the file giving no duration" was written when `unreadableDurations`
was last in the sentence, and by then it named `negativeDurations`, which is not what the
paragraph goes on to describe. It names the count now rather than pointing at a position.

The number is counted from `readAnnotations`'s own return type, so the page has to agree with
the function rather than with itself, and every count it returns has to be named — a number is
only useful with the list.

## 0.5.95

### Fixed: api.md's cheap timing recipe mistimes every record after a gap, and says the conversion uses it

The page argues, correctly and at length, that `index * recordDuration` is not where a record
sits — a discontinuous file puts its records where its timekeeping annotations say, and a
continuous one need not start at zero. It then offers `readOrigin()` as "the cheap version",
shows

```js
const origin = (await file.readOrigin()) ?? 0;
const recordStart = origin + (batch.firstRecordIndex + r) * recordDuration;
```

and closes: "That is what the conversion itself does, which is why its `time_s` and its
`annotations.csv` agree."

The conversion does that for `EDF+C`. For `EDF+D` it reads every record's own start time. On
`discontinuous.edf`, whose records sit at 0, 1 and 10 seconds, the recipe puts the third at 2 —
nine seconds from where the file says it is and from where `convert()` writes it. A reader who
took the shortcut because the page said it was the same thing lines every record after a gap up
against the wrong samples, and the sentence promising agreement with `annotations.csv` is
exactly the promise it breaks.

Scoped to continuous recordings now, with the check to make first and the arithmetic's answer on
that fixture spelled out. The test runs both and requires them to differ, so the example cannot
quietly stop being a counterexample.

### Fixed: the same page still described the gain-of-zero rule 0.5.83 replaced

"A gain of zero is different: the mapping is defined but flat, so `physicalMin` is returned and
written normally." That is now true of one of the two ways to get a gain of zero. The other —
a span too small to represent, which underflows — returns `NaN` and leaves the cells empty, and
raises `UNUSABLE_PHYSICAL_RANGE`, which the sentence beside it did not list either.

## 0.5.94

### Fixed: two conversions with identical output disagreed about whether they were whole

```
$ edf2csv tenmin.edf --out a            # whole_recording: true
$ edf2csv tenmin.edf --out b --end 600.3 # whole_recording: false
$ diff a/signals.csv b/signals.csv       # no output
```

Byte-identical files, 60,030 rows each, described two ways. `whole_recording` is
`clampedEnd >= latest`, and `latest` is `recordCount * recordDuration` — 6003 records of 0.1s
is 600.3000000000001, not the 600.3 that `--info` prints as the recording's length. So naming
the length exactly makes the conversion partial by a rounding error, on the field a pipeline
reads to decide whether it has the lot.

The same arithmetic 0.5.91 fixed one field over, and both now go through one `sameInstant`
comparison so they cannot drift apart: a relative epsilon, well below any real sample interval
and well above the gap between two routes to the same quantity. A window that really is partial
still says so.

## 0.5.93

### Fixed: the padding after a TAL was counted as an annotation that could not be read

```
$ edf2csv space-padded.edf --out out
warning: 2 annotation entries were unreadable and could not be exported.

$ cat out/annotations.csv
onset_s,duration_s,description,record_index
0.5,,Lights off,0
```

The file holds one annotation and it was exported in full. The two "entries" are the spaces
filling the rest of each record's annotation slot.

EDF+ pads that slot with `0x00`, which the decoder skips because NUL is also what ends one TAL
and starts the next. Writers pad with spaces, and a run of spaces after the last TAL is a
non-empty chunk that does not begin with a sign — so it took the malformed branch. Under
`--strict` that is a failed run over the whitespace at the end of a slot, on a file that lost
nothing.

Whitespace-only chunks are padding now — space, tab, CR, LF and NUL. A chunk of anything else
that does not parse is still counted and still reported, which is the case the warning exists
for.

## 0.5.92

### Fixed: `--info` redirected into a full filesystem wrote nothing and exited 0

```
$ edf2csv wide.edf --info > desc.txt
$ echo $?
0
$ wc -c desc.txt
0 desc.txt
```

A conversion audits what actually reached stdout — that is what 0.5.82 and the disk-image tests
are about. `--info` wrote its description with `process.stdout.write` and looked at nothing, so
a run that produced no description at all reported success. `edf2csv rec.edf --info > desc.txt`
in a script is exactly how someone captures one.

A description is usually a few hundred bytes, which is why this went unnoticed; a 900-channel
recording's is 58 KB, and no destination is guaranteed to have that.

It uses the same audit now, so it exits 1 and names the cause. That audit declines anything
that is not a regular file, so a pipe and a terminal are untouched and `--info | head` still
exits 0.

The test took two attempts: filling the volume completely means the shell cannot create the
redirect target and the tool never runs, which is what the first one measured. It leaves twenty
kilobytes and writes 58 into it.

## 0.5.91

### Fixed: `--start` at the recording's exact length was accepted when the length was a product

`--start` at or past the end of a recording is an error, because the result would be an empty
file that looks like a successful conversion. The guard compares against
`recordCount * recordDuration` — and with a fractional record duration that product is not the
number it prints as. 6003 records of 0.1s is 600.3000000000001, so on a recording `--info`
calls "10m 0.3s":

```
$ edf2csv tenmin.edf --start 600.3 --out out
warning: No samples fall inside the requested window (600.300s to 600.300s), so the signal
         files hold their headers and no data.
$ echo $?
0
```

Exactly the empty conversion the error exists to prevent, and exactly what `--start 2` on a
two-second recording is refused for. Which of the two you get depends on whether your record
duration is a whole number.

Compared with a relative epsilon now — the same shape the long layout uses to decide two sample
times are one instant: well below any real sample interval, and well above the rounding that two
routes to one quantity produce. `--start 600.2` on the same file still converts its ten samples.

## 0.5.90

### Fixed: the duration warnings described rows a window had excluded

```
$ edf2csv rec.edf --start 2 --end 3 --out out --strict
warning: 1 annotation states a duration below zero ... The value is written to annotations.csv as the file gave it ... check these rows before using the durations.
warning: 1 annotation states a duration that is not a number, so its duration_s cell is empty.
--strict: 2 warnings raised, so this run is reported as a failure.

$ cat out/annotations.csv
onset_s,duration_s,description,record_index
2.5,0.25,clean event,2
```

One row, with a populated, positive duration. There is no such value, no such cell and no such
rows — and `--strict` failed the run over two events it never wrote.

Both warnings are mine, from 0.5.55 and 0.5.58, and both were raised from the counts the
decoder accumulates over the whole file while `annotations.csv` is filtered to the requested
window. `--info` had the other half of it: on an EDF+D recording it printed "The value is
written to annotations.csv as the file gave it" while writing no files at all.

Counted from the events themselves now, after the same filter the writer applies, so the count
and the sentence describe the same rows. An unreadable duration is carried on the event as
`durationUnreadable`, because `duration: null` cannot say whether the file gave one — which is
the ambiguity those warnings exist to flag, and a library caller now has it too. A negative
duration needs no flag; the value is right there.

`--info` raises them against the window it was given, so it predicts what the conversion will
say rather than a different set. On a continuous EDF+ it still says nothing, because it does not
read the whole annotation channel — that is the documented limit of a header read, not a
regression.

## 0.5.89

### Fixed: the getting-started example asked for a channel the recording does not have

```bash
edf2csv sleep-study.edf --start 1h --duration 5m \
  --channels "EEG Fpz-Cz,ECG" --out ./epoch-42
```

exits 2 with `No channel named "ECG"`. The `--info` table forty lines up the same page lists
that recording's five channels — EEG Fpz-Cz, EEG Pz-Oz, EOG horizontal, Resp oro-nasal, Temp
rectal — and none of them is ECG. It is the page's one example of combining a window, a filter
and a destination, and it is the third command a new reader runs.

The same pair appears on four pages: getting-started, recipes, and faq twice. The fifth is in
warnings-and-errors, demonstrating the mixed-rate warning, where the quoted rates were wrong for
this recording too — "2 different sampling rates (256 Hz, 128 Hz)" against a file whose channels
run at 100, 10 and 1 Hz. That one now pairs `EEG Fpz-Cz` with `Temp rectal` and quotes 100 Hz
and 1 Hz, which is what the file gives.

api.md's JavaScript examples have been executed against a fixture for a long time. The shell
examples were checked by nobody, and this is the part of them a test can check without a shell:
a channel named for this recording either exists in it or does not. It reads every page and the
README, and it took two attempts — the first missed getting-started's command entirely, because
that one wraps with a trailing backslash and its `--channels` is on the second line. It joins
continuations first now.

## 0.5.88

### Fixed: a worker killed from outside made the batch exit 2, "the command line is the problem"

`worstOf` combines the children's exit codes into the run's:

```ts
return codes.includes(EXIT_ERROR) ? EXIT_ERROR : EXIT_USAGE;
```

which assumes every child exits 1 or 2. A child killed by a signal exits 130 or 143 — its own
interrupt handler does that — so a `--jobs` worker stopped by SIGTERM fell through to 2. The
exit-code table calls 2 "The command line is the problem", and warnings-and-errors "The command
was invoked incorrectly, or asked for something the recording can't provide". The command was
fine; something killed a worker, which is how the out-of-memory killer and a scheduler's time
limit both arrive. A script branching on 2 to mean "I typed it wrong" would retry forever.

Asked the other way round now: 2 is the narrow claim, so every recording has to have earned it,
and anything else in the list makes the run a failure. `[143]` is 1, `[2]` is still 2, `[2, 143]`
is 1.

Pinned by testing the mapping directly rather than by racing a signal at a real worker — the
mapping is the defect, and a batch long enough to catch mid-flight is a race in a test suite.

## 0.5.87

### Fixed: `--info --stdout` described files the command never writes

```
$ edf2csv mixed-rates.edf --info --stdout
Would write 1,155 rows, roughly 22.2 KB.
warning: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
```

for a command that refuses to run, writes nothing, and names no file:

```
$ edf2csv mixed-rates.edf --stdout
error: --stdout needs exactly one table, but this recording produces 3 ...
```

`--info` exists to say what a conversion will do, and refusing is one of the things it does.
It was not passed `--stdout` at all, so the plan it described was a different command's.

The conversion's three `--stdout` guards are lifted into `stdoutRefusal` and `--info` asks the
same question, so there is one wording rather than two that can drift — the test asserts the
preview contains the refusal's own sentence. Reported as a warning rather than a refusal, for
the reason 0.5.51 gives about the destination guards: `--info` writes nothing, so a rule about
the output has no business stopping it from describing the recording, and being told the command
will not work is exactly what was asked. New diagnostic code `STDOUT_UNSUPPORTED`, documented on
all three pages.

`--info --stdout --json` is no longer refused either. That guard exists because a CSV and a
summary cannot share stdout; under `--info` there is no CSV, and the description *is* the JSON.
It was the one way a script could see this warning at all.

## 0.5.86

### Fixed: a file holding half a million samples was told no data was written

```
$ edf2csv partial.edf --out out
error: The file contains a header but no complete data record.
       The recording was probably interrupted before any data was written.
```

The file was 606 KB, of which 589 KB is sample data — more than half a million readings, 60% of
one record. Data plainly was written.

That hint is right about one way to reach this error and wrong about the other. A record is the
unit the format is addressed in, so a file holding less than one has nothing convertible and the
error stands — but "less than one record" happens both when a recording is cut short and when a
header describes records larger than the ones actually written, and only the first is an
interrupted acquisition. The message carried no figures at all, so nothing in it could be
checked against the file, and the one number worth looking at — the declared record size — was
the one not said.

Both are there now, because the comparison between them is the whole diagnosis: "The file
contains 589824 bytes of data, which is less than the 983040 its header says one data record
takes", pointing at the samples-per-record fields. A file that really does hold nothing after
its header keeps the sentence that is true of it.

## 0.5.85

### Fixed: the byte estimate read low on a recording timed from before zero

`--info` predicted 203 bytes for a file that came out 216, and 261 against 274 in the long
layout. An estimate reading low is the one direction the correctness page says it never goes —
claim 5 is "the byte count never reads low", and the estimate sweep asserts "no byte count
under the truth" over every fixture.

The time column was measured against the window's far end, unsigned, while the value column
two lines below already allowed for a sign whenever either physical bound is negative. A
recording whose first record's timekeeping TAL says `-100` writes `-100.000` where that
budgeted for `100.000`: one byte a row, every row. Both estimates now measure over both ends
of the window — from -100s to -97s the widest instant is the start, not the end — and carry
the sign.

The sweep could not have caught it: every fixture began at zero or later. There is one now,
`negative-origin.edf`, and it turned up a second defect on the way in. `buildTal` in the
fixture writer glued a `+` onto every onset, so asking it for a record at -100 produced
`+-100` — which no reader parses, so the fixture came out with no timekeeping at all and timed
from zero like every other one. EDF+ requires an explicit sign and the format page says a
negative onset is legal; the helper could not write one. It takes the sign from the number now.

50 fixtures: 376 estimate predictions and 275 layout comparisons.

## 0.5.84

### Fixed: a record duration too small to divide into dropped every sample and blamed the window

A sampling rate is samples per record over record duration. EDF's record-duration field is
eight characters and accepts `1e-308`, so four samples in one of those records is `Infinity` —
and `1 / Infinity` is zero, which the resolution check reads as "no step to report" rather than
"no resolution at all".

So a file holding two complete records of four samples wrote none of them, exited 0, and
printed one warning:

```
warning: This recording's 2 data records carry no samples in range, so the signal files hold
         their headers and no data.
```

Untrue twice: the records carry their eight samples, and no range was asked for. `--info`
listed the channel at `Infinity Hz` and predicted zero rows, which at least agreed with the
conversion.

One power of ten away, at 1e-300, the rate is 4e300 and the same file converts all eight rows
with `TIME_RESOLUTION`. That code covers this now too, in a branch of its own — the existing
hint promises "Every sample is written, in order", which would have been the third false
sentence — and `EMPTY_WINDOW` no longer fires over the top of it, since the rate warning is the
accurate account of the same zero.

The same guard `decimalsAreClamped` had before 0.5.83, one column over: a step of exactly zero
means the quantity could not be computed, not that there is nothing to say about it.

## 0.5.83

### Fixed: a physical span too small to represent became a flat channel, silently

```
time_s,MAG
0.000,0.000
0.250,0.000
0.500,0.000
```

Eight samples spanning digital -16,000 to +12,000, all written as the same number, no
diagnostic anywhere, `--strict` exiting 0. The header declares -1e-320 to 1e-320 over the full
16-bit range: 65,536 distinct physical values, none of them equal to another.

The gain is the span over the digital range — 2e-320/65535, or 3e-325, which is smaller than
the smallest subnormal double and underflows to +0. `makeScaler` tests `gain === 0` and takes
its flat-range branch, whose comment is correct about the case it was written for: "A flat
physical range makes every sample the same value ... That mapping is defined, so its constant
is written." An underflowed gain is not a flat range, and from inside that test the two look
identical.

The answer was already in the function, eight lines below. Overflow gets it: "the physical span
overflowed a double, so there is no mapping at all. Returning physicalMin filled the column with
one enormous constant — every distinct sample rendered as the same 300-digit number — and raised
nothing." Underflow is the same fact about the same header and now takes the same route: empty
cells, and `UNUSABLE_PHYSICAL_RANGE` saying the span is too small rather than too large.

A genuinely flat range still writes its constant. That mapping is defined, every sample really
is that value, and it has `DEGENERATE_PHYSICAL_RANGE` of its own.

One power of ten away, at 1e-319, the same file has always raised `VALUE_RESOLUTION` — this was
the one gap in a row of neighbours that all report themselves.

## 0.5.82

### Fixed: `--stdout --gzip` onto a full destination announced every row and exited 0

```
$ edf2csv rec.edf --stdout --gzip > /Volumes/small/out.csv.gz
error: Writing to stdout failed: ENOSPC: no space left on device, write
Wrote 102,400 rows to stdout.
$ echo $?
0
```

Two lines that cannot both be true, and the exit code agreed with the wrong one. The file was
11,270 bytes short of the 470,022 the stream needs, its gzip member had no trailer, and
`gzip -dc` refused it. Through `--out`, on the same volume with the same free space, the
identical failure is reported and exits 1.

`compressed()` returned an already-resolved `settled` for the stdout path, so `await
entry.settled` waited for nothing: the conversion declared itself finished while the
compressor still held the tail, and the ENOSPC arrived afterwards, too late to be anything
but a line on stderr. The byte audit could not catch it either — it stats the descriptor as
soon as the writers are done, which on this path is before the compressor has flushed.

It waits on `finished(compressor)` now. That is the source side, so `end: !toStdout` is
untouched and nothing here closes stdout; what it waits for is the compressor pushing its last
chunks into a write that fails.

One thing the wait must not do is turn `--stdout --gzip | head` into a failure. A reader
closing the pipe is documented as ordinary and answers with "Stopped: the reader closed the
pipe after 52,507 of 102,400 rows had been written", exit 0 — and waiting surfaced that EPIPE
as an error until it was filtered out, which the first attempt at this fix did. It is the same
error the writer already records as a hang-up. Both cases are tested on the disk image now: the
one that must fail, and the one that must not.

## 0.5.81

### Fixed: the listener leak 0.5.36 fixed, still there one flag away

```js
for (let i = 0; i < 12; i++) await convert(rec, { toStdout: true, gzip: true });
```

leaves twelve `'error'` listeners on `process.stdout` and prints Node's
MaxListenersExceededWarning on the eleventh — which is 0.5.36's entry word for word, including
the count. That version fixed it for the writer's own listener, through
`BufferedLineWriter`'s `#release()`, and wrote a regression test that loops fifteen `toStdout`
conversions and asserts the count comes back. The test never passes `gzip: true`.

It could not have caught this one anyway. `#release()` only detaches from a stream the writer
holds, and under gzip the writer's stream is the compressor — `process.stdout` is the
compressor's *destination*, and the listener on it is `compressed()`'s error forwarding, which
was attached and never removed. Same leak, same stream, same warning, behind one flag.

The forwarder is removable now, released after the conversion settles and in a `finally`, with
the ownership rule the writer already uses: detach from `process.stdout` and `process.stderr`,
leave a file stream alone, since a file stream is created for the conversion and closed with
it. In a `finally` for 0.5.45's reason — a conversion that fails still has to leave stdout as
it found it, and a failure is exactly when a caller goes on to convert something else.

The CLI could never accumulate these: `--stdout` takes one recording and the process exits.
It is the library API that leaks, which is the surface 0.5.36's entry says its fix was for.

The regression test runs both paths now.

## 0.5.80

### Fixed: "Wrote 1 rows to stdout." — and the sweep that kept missing this family

The third message in three versions to disagree with itself about number, and the third found
the same way: by running a mode the test did not.

0.5.74 fixed the header lines and swept whole-recording conversions. The estimate line and the
written-files table were never seen at a count of one, so both still read "1 rows" — a window
narrow enough to select a single sample is what produces that, and 0.5.78 fixed them and added
the window. It still never ran `--stdout`, whose summary is a separate line: "Wrote 1 rows to
stdout."

A count that is never one in the run is a count the sweep cannot check, so the modes are
enumerated now rather than sampled: plain, windowed, `--gzip`, `--layout long`,
`--annotations-only` and `--stdout`, each with an assertion that the narrow window really does
estimate, write and stream exactly one row, so a mode cannot quietly stop exercising the case
it was added for.

## 0.5.79

### Fixed: two refusals printed in a shape nothing else uses, so `^error:` missed them

Every usage error prints `error: <what>` with its advice indented seven spaces underneath. The
documentation shows them that way. Two did not:

```
$ edf2csv rec.edf --stdout --json
--stdout and --json both write to stdout, so they cannot be combined.
Use --stdout for the CSV, or --json for the summary.
```

Flush left, no prefix. They were written before the prefix was and kept their own shape — and
they are the pair a script is most likely to meet, since `--stdout` and `--json` are flags a
script passes rather than a person. A refusal that does not match `^error:` is invisible to the
grep that finds every other one, on the stream the reference says to grep.

The same two lines carried two more of what recent versions have been fixing: the recording's
name went into the folder refusal unescaped, which 0.5.67 corrected everywhere it could find,
and "cannot take 2 recordings" was hard-coded plural, which 0.5.74 did the same for.

The test checks the shape over every refusal rather than adding two more string assertions:
first line matches `^error: `, every continuation line is indented seven spaces, stdout is
empty, exit is 2.

## 0.5.78

### Fixed: "Would write 1 rows" — the two lines 0.5.74's test could not reach

0.5.74 made counts agree with their nouns and added a sweep that fails on any `1 <word>s` in a
run's output. It passed while two of the most-read lines were still wrong:

```
$ edf2csv rec.edf --info --start 1.9 --end 2.0
Would write 1 rows, roughly 39 B.

$ edf2csv rec.edf --out out --start 1.9 --end 2.0
  signals.csv   1  rows
```

The sweep only ran whole-recording conversions, and the recording it builds never estimates or
writes exactly one row. A count that is never one in the fixture is a count it cannot check —
so the test was as green as it would have been if the fix were complete.

Both lines agree now, and the sweep runs a window narrow enough to select a single sample, with
an assertion that the window really does produce one row so it cannot quietly stop exercising
the case. It found this before this version was written, which is the point of extending it
rather than adding two more conditionals.

One existing test needed a word: it asserted `.csv.gz` summary lines carry a unit by matching
`rows`, and `annotations.edf` has one channel, so `channels.csv.gz` now says `row`. What that
test checks is that the unit is there at all, so it matches `rows?`.

## 0.5.77

### Fixed: the stale-output warning grew without bound, and told you to delete "them" when there was one

How many leftover files a directory holds is up to the directory, and a mixed-rate recording
converted into a reused one is exactly how it fills up — one `signals_<rate>hz.csv` per rate.
120 of them produced a single 2,373-character warning line.

That is the failure `listed` was written for. Its own comment quotes the 1,600-character
version of the same thing, from the sampling-rate warning, and every message that enumerates
something the run does not control has gone through it since — except this one, which joined
its own list. Past eight the rest are counted now: 258 characters instead of 2,373.

The hint was hard-coded plural, so a directory with one leftover read "signals_999hz.csv is
left over from an earlier conversion into this directory and was not rewritten. Delete them."
The sentence above it had agreed since it was written; the advice underneath had not.

## 0.5.76

### Fixed: the reference described a line 0.4.51 had already removed, and said elsewhere that it was wrong

In the `--info` section: "With `--annotations-only` the signal channels read `(not selected)`
and the estimate is 0 rows, because that run would write no signal data."

Two hundred lines further down, in the `--annotations-only` section: "Until 0.4.51 this line
read `Would write 0 rows, roughly 0 B.`, which was true of the signal tables and false of the
run." One page describing a behaviour and its own fix of that behaviour, disagreeing.

What `--info --annotations-only` prints is neither: no row estimate at all, and a sentence
naming the files instead — "Would write annotations.csv and channels.csv, and no signal data.
How many events there are cannot be told from the header."

The sentence now says that, and says which version it was describing, since a reader who built
on it should be able to tell when it stopped being true. Pinned by running the command: the
sample output the page quotes has to be what the tool prints, compared on the words rather than
the layout, since the page wraps to its own width.

## 0.5.75

### Fixed: two pages gave different formulas for where an untimed record goes, and one was wrong

A data record whose timekeeping annotation cannot be read has to be placed somewhere.
`deriveRecordStarts` puts it at `origin + index * recordDuration`, where the origin comes from
the first record that does state a time.

api.md says exactly that, and says why: "not at `index * recordDuration`, which silently assumes
the recording begins at zero". edf-plus-annotations.md then said `index * record_duration` — the
form the other page names in order to warn against it. On `lost-timekeeping-d.edf`, whose origin
is 0.5 s, the documented arithmetic gives 0.000 for a record the conversion writes at 0.500.

Corrected, with the reason attached rather than only the formula, since the formula alone is
what drifted. A test anchors the claim: both pages must carry the origin-aware form, and the
sentence in edf-plus-annotations.md that states the fallback must be that one. Anchored on the
sentence rather than on every appearance of the arithmetic — both pages also name the bare form
in order to reject it, and flagging those would take a phrase blacklist that grows with the
prose.

## 0.5.74

### Fixed: "1 records", "1 bytes"

`--info` opened a one-record recording with

```
Duration   1s  (1 records of 1s)
```

and a file with a single stray byte after its last record warned that "1 bytes after the last
complete data record were ignored". A one-record recording, a one-byte tail and a truncation
down to one record are all ordinary things, and these are the first two lines a reader looks at.

Counts and their nouns agree now, through one helper rather than a conditional at each site:
the record count in the duration line, the trailing-byte count, both record counts in the
mismatch warnings, and the file count in the mixed-rate message. The verbs with them too — "1
byte ... was ignored", "the 1 record that is present".

The test checks by pattern rather than by listing the sentences: it converts a recording built
to make every count land on one and fails on any "1 <word>s" in the output, so a message added
later that counts something is covered without anyone remembering to come back here.

## 0.5.73

### Fixed: EMPTY_LABEL named a column the file does not have

An unlabelled channel takes `signal_<index>`, and the warning said so. It is right only while
nothing else claims that name — and EDF labels are free text, so a channel may be labelled
`signal_0` literally. Then the synthesised name and the real one collide, both columns are
suffixed, and:

```
warning: Signal 0 has no label. It will appear as "signal_0".

time_s,signal_0_ch0,signal_0_ch1
```

The one sentence the run printed named a column that exists in neither signals.csv nor
channels.csv. It could not have known: the message was raised inside the header loop, where the
later channels have not been parsed yet.

The other half was silent. The channel that genuinely carries the label `signal_0` lost its own
column name to the collision, and nothing said so — `DUPLICATE_LABEL` does not fire, because the
two labels are not the same label.

Raised after the loop now, where every label is known, and both halves are one sentence because
they are one event: "Signal 0 has no label, so it takes the name "signal_0" — which signal 1
already carries as a label, so both columns are suffixed with their position instead." No
suffixed name is quoted; the suffix rule has a second pass for names still shared afterwards,
and hard-coding `_ch<index>` would be guessing again in the way this fixes. A channel with no
label and no collision keeps the sentence it always had.

The test checks the claim against the file rather than against the wording: every column name
the message quotes must be one signals.csv has, or under a collision must be one it does not.

## 0.5.72

### Fixed: one unreadable path was reported and counted once per name it was reached by

Each named directory is walked separately and its findings appended, with no deduplication —
while the recordings found beside them are deduplicated by identity a few lines later. So the
two halves of one run disagreed about what "one" means:

```
$ edf2csv study study --out out
error: study/locked: could not be read, so any recordings inside it were skipped.
error: study/locked: could not be read, so any recordings inside it were skipped.
Converted 1 of 1 recordings; 2 paths could not be read.
```

One locked directory, named twice. The recordings were right; the count beside them was not,
and that count is the part that matters — it is what tells someone how much of their study was
never looked at. The same happened for a folder given relatively and absolutely, and for a
folder given alongside a symbolic link to it.

Deduplicated by identity now, through `realpathSync`, which resolves a directory even when it
cannot be opened — that needs search permission on the parent rather than on the target. A path
that cannot be resolved at all keeps its own identity, so a name that is simply not there still
reports itself. Two genuinely different unreadable paths are still two.

## 0.5.71

### Fixed: NONPRINTABLE_LABEL told a channel with a clean label that its name could not be typed

The message said "Signal 0's label **or unit** contains 1 control character", and then said two
things that are only ever true of a label: that the bytes "will appear in the CSV column name",
and that "the name cannot be typed, so address the channel by position".

A channel labelled plainly `ECG`, in a unit of `u\x07V`, got all of it. Its column is `ECG`,
`--channels ECG` selects it and exits 0, and the byte is in channels.csv's `unit` cell — which
the warning never mentioned, so the one thing a reader needed to know was the one thing missing.
Three sentences, none of them true of the file that raised it, on a warning whose entire purpose
is to say where an invisible byte went.

It names the field now, and where the bytes land follows from that: a label becomes the column
name in signals.csv, a unit is a cell of channels.csv and nothing else, and a header carrying
them in both says both. When only the unit is affected the hint says the column name is
unaffected and gives the label that still selects it, rather than sending the reader to a
position they do not need.

Checked against the file rather than against the wording: the test asserts the column really is
`ECG`, that selecting by that name really works, and that the byte really is in the unit cell.

## 0.5.70

### Fixed: the page that defines `time_s` said zero is the first sample

"`time_s` is seconds elapsed since the start of the recording. Zero is the first sample of the
first data record." The second sentence has been false since 0.4.9 made the first data record's
timekeeping annotation the origin: `fractional-start.edf` writes its first row as `0.500` and
`late-start.edf` as `30.000`.

The page's only other mention of record start times is the bullet headed "On a discontinuous
recording it jumps", scoped to EDF+D — and `fractional-start.edf` is EDF+C. So a reader working
from output-files.md had no way to learn this, on the page whose job is to define the column,
while cli-reference.md, `--info`'s `Timed from` line and the 0.5.59 changelog all say the
opposite. The sentence beside it, "add `time_s` to `recording.start_datetime_local` to get an
absolute instant", is right and only makes sense once zero is the header's start time rather
than the first sample.

Rewritten to say what the tool does, and pinned rather than left as prose: a test now sweeps
every fixture and requires the first value in `signals.csv` to equal what `--info` prints as
`Timed from`, or zero where it prints no such line. Behaviour is unchanged — it was correct
throughout, and only the page was wrong.

## 0.5.69

### Fixed: metadata.json described a long table with the wide layout's contract

`rate_groups` is documented as "for each output file, its sampling rate, the columns it
contains in order". Under `--layout long` that is three false statements at once. A mixed-rate
recording produced:

```json
"rate_groups": [
  { "file": "signals.csv", "sampling_rate_hz": 256, "channels": ["EEG Fpz-Cz"], "decimals": [3] },
  { "file": "signals.csv", "sampling_rate_hz": 128, "channels": ["ECG"],        "decimals": [5] },
  { "file": "signals.csv", "sampling_rate_hz": 1,   "channels": ["Temp rectal"],"decimals": [5] }
]
```

for a file whose columns are `time_s,channel,value`. One file named three times, three
different sampling rates for it, and channel names that are values in a column rather than
columns of the table.

The array itself is right — it is the grouping decision, and the grouping is real under both
layouts. What was missing is the one fact that makes it readable: **`metadata.json` now records
`layout`**, `"wide"` or `"long"`, so a pipeline handed an output directory can tell which shape
`signals.csv` is in. Nothing else in the archive distinguished them, and the two files have
different columns. The `rate_groups` documentation now states both readings.

The invariant sweep that would have caught this — "what the run says it produced must match
what is on disk", run over every fixture — only ever ran the wide layout, plain, windowed and
annotations-only. It runs the long layout now, with the expectation each layout actually
promises.

## 0.5.68

### Fixed: `--decimals` read its value the way `Number()` felt like reading it

`--decimals 0o5` wrote five decimal places. `--decimals 0b11` wrote three. So did `0x3`,
`3e0`, `+3` and ` 3 `. Every one converted, exited 0, and produced a CSV that looks exactly as
intended — at a precision that reads as that precision to nobody.

`3.5` was refused all along, which is what makes the message believable: a reader who sees
"must be a whole number between 0 and 20" reject `3.5` has no reason to suspect `0o5` of
quietly meaning five.

Plain digits now, the same rule `--jobs` was given in 0.5.50 and `--channels "#N"` before it —
where the comment records why it matters: "Every one of them selected a channel and exited 0,
so a slip did not fail — it quietly converted a different channel than the one asked for, which
for this tool is the worst way to be wrong." A precision is the same kind of quiet. The value
still comes back quoted as typed, and a leading or trailing space is still trimmed, exactly as
`--jobs` does.

## 0.5.67

### Fixed: a path reached the terminal unescaped, on the lines that report where output went

Header fields have been escaped for display since 0.2.x, because an ANSI escape in a patient
identification field could otherwise drive the reader's terminal. A path is untrusted text of
exactly the same kind: a directory may be named with an ESC byte, and a file name may hold a
newline on every platform this runs on.

The `[n/m]` header a batch prints escaped it. The two lines underneath did not:

```
[1/1] study/esc\x1b[31mred.edf
Wrote o/esc<ESC>[31mred
```

One line of the same run showing the name, the next handing it to the terminal. `--info`'s
`File` line had it too, and so did the collision refusals, the nesting refusal, the killed-child
line and the three interrupt messages — every place a path is printed except the ones that had
been fixed one at a time.

The newline is the worse half, because nothing about it looks wrong:

```
Wrote nl
name_csv
```

One recording, and a summary line that reads as two paths to anything parsing the output. It
prints `Wrote nl\x0aname_csv` now.

All of them go through the same `printable` the header fields use.

## 0.5.66

### Fixed: 0.5.49's warning attribution never reached `--jobs`

That version made a batch's warnings carry the recording's name under `--quiet`, because
`--quiet` suppresses the `[n/m] <path>` header and the header is what pairs a warning with the
file that raised it. The fix keyed off the conversion's own `batch` flag — and a forked child
does not have one. It is handed a single recording and a single destination, so it believes it
is a single conversion and names nothing:

```
$ edf2csv study --out out --quiet
warning: study/a.edf: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
warning: study/b.edf: The header declares 10 data records but the file contains 4.

$ edf2csv study --out out --quiet --jobs 2
warning: The header declares 10 data records but the file contains 4.
warning: Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
```

Worse in the parallel case than it had been in the serial one: conversions finish in whatever
order they finish, so there is not even a position to infer the attribution from.

Named by the parent now, which is where both facts are known — that this is a batch, and which
recording the child was given. `error:` lines have been named there since 0.4.20; warnings join
them under `--quiet`, and only under `--quiet`, or the header and the prefix would both say it.

## 0.5.65

### Fixed: a file error was listed among the usage errors, on the page a script reads to tell them apart

The usage-errors table opens by explaining why the distinction exists: "They exit **2** rather
than 1, so a script can tell 'you asked for something impossible' apart from 'this recording is
broken'." Its third row was "The recording changed size while it was being read", which exits 1.

That message comes from `changedWhileReading` in the parser, as an `EdfError` with code
`UNREADABLE`, and the same page's `UNREADABLE` section describes the same case and gives the
right code. One page, two answers, about the one thing a script branches on. Reproduced by
shrinking a sparse 262 MB recording mid-conversion: exit 1, every time.

The row is gone — the case was already documented where it belongs — and the section now says
so, since a reader who built a branch on the old table needs to know which way it was wrong.

A test holds the classification rather than the row. A usage error is raised by the CLI or the
planner and never by the parser, so no example message in that table may be a string `src/edf`
produces; the check matches on the longest run of plain words in each example, since every one
of them carries interpolated byte counts and record numbers that no source string contains.

## 0.5.64

### Fixed: a leading `./` decided whether a batch ran at all

A recording named both directly and through a folder keeps the position the folder gives it.
That rule is documented, and the depth comparison in `outnames` is what applies it — but it
was never reached. The comparison above it settled the two names on lexicographic order of the
paths *as typed*, so `study/night-01/rec.edf` and `./study/night-01/rec.edf` were two different
names for one file, and the loser was picked by string order rather than by the rule.

With a `study/rec.edf` beside it, whose bare name collides:

```
$ edf2csv study study/night-01/rec.edf --out out
Converted 2 of 2 recordings.

$ edf2csv study ./study/night-01/rec.edf --out out
error: "study/rec.edf" and "./study/night-01/rec.edf" would both be converted into "out/rec",
       so one would overwrite the other.
```

Same files, same folder, same request. Without the colliding sibling it was quieter and no
better: one spelling wrote `out/night-01/rec` and the other `out/rec`, so a script that started
passing absolute paths moved its output without saying so.

Names are compared by identity now. Through `realpathSync` rather than a lexical resolve,
because lexical is not enough: on macOS `$TMPDIR` sits under `/var`, a link to `/private/var`,
so a folder walked from the name the caller gave and a recording named relative to the
process's own directory come out with different prefixes for one file — which the test found
before this shipped. Following links here is safe, since the rule preferring a real name over a
link pointing at it has already run.

## 0.5.63

### Fixed: a value beginning with a dash was refused in Node's words, with a placeholder for advice

`edf2csv rec.edf --out -nightly` printed:

```
Option '--out' argument is ambiguous.
Did you forget to specify the option argument for '--out'?
To specify an option argument starting with a dash use '--out=-XYZ'.
```

which is `parseArgs` talking, not this tool. The user did not forget the argument — they gave
one — and `-XYZ` is a placeholder, where every other message here quotes what was actually typed
and prints the command to run instead. A destination named `-nightly` is not exotic, and neither
is a negative `--start` on a recording timed from before zero.

0.4.34 already fixed this message where the tool produced it itself, building child argv for
`--jobs`: `--out ./-nightly` reached the child as two arguments and died on it while the serial
path converted the same command without complaint. The half a user can hit was left alone.

```
error: --out was given "-nightly", which begins with a dash and so reads as another flag rather than as its value.
       Write it as one argument instead: --out=-nightly
```

The two shapes join differently and the message says which, because getting it wrong would be
worse than the text it replaces: `parseArgs` reads `-o=-nightly` as the value `=-nightly` and
converts happily into a directory of that name. Long options join with `=`, short ones join
directly, and the test runs both forms rather than matching the sentence.

Node's other three refusals — an unknown option, a switch given a value, an option missing its
value — say something true in words a reader can act on, and are left as they are.

## 0.5.62

### Fixed: the warnings reference described two codes as they were two versions ago

`ANNOTATION_DECODE_FAILED` opens with "This code covers three conditions, which are counted
separately because they lose different things", and then lists them. 0.5.55 added a fourth —
a duration the file stated that could not be read — and 0.5.58 a fifth, a duration below zero.
Both were counted separately, exactly as that sentence promises, and neither appeared. The
number is one a reader checks against the list immediately below it.

`NO_SAMPLES` had the other half of the same drift. Its section describes the per-channel case
and says "as a warning it means one channel is empty", which stopped being the whole story
when the code also began reporting the signal file that was *not* written — and 0.5.54 gave
that case two different wordings depending on why, neither of them on the page.

Both sections now list what they cover, with the message each condition actually prints. And
a test reads the sentence against the list: any section saying how many conditions it covers
has its bold lead-ins counted, so the next one added has to be written down or the suite goes
red. It is the same shape of check as the one holding the test counts and the harness sizes —
the prose still has to be written by a person, but the number in it no longer drifts on its
own.

## 0.5.61

### Fixed: `--channels` rejected the column name it had just printed, and called it unknown

Matching is on the label. Where two channels share one, their columns gain a `_ch<index>`
suffix — so `T8-P8_ch1` is a name this tool invented. It prints it in the COLUMN column of
`--info`, writes it into channels.csv, and puts it at the head of signals.csv. Passing it back
got:

```
error: No channel named "T8-P8_ch1". Run with --info to list the channels in this file.
```

which is the table it was copied out of. The reference has documented the trap for a long
time; the message someone actually hits did not, and the advice it gave was a loop.

It says what the term is now, and gives the form that works — `#<index>`, which is also the
only way to select one channel of a colliding pair and exactly what someone reaching for the
suffixed column name wants:

```
error: "T8-P8_ch1" is a column name, not a channel name: --channels matches the label, which for this channel is "T8-P8".
       Use "#1" to select just this one, or "T8-P8" for every channel sharing that label.
```

Only for a term that really is some channel's column name; a typo still gets "No channel
named "ECQ". Did you mean "ECG"?". A label that merely looks like a column name still wins,
which `label-suffix-collision.edf` pins: its third channel is genuinely called `T8_ch0`, the
same text as the first channel's column, and `--channels T8_ch0` selects the channel whose
label it is. A channel with no label has nothing to match at all, so that case is told to use
the position rather than offered an empty string to type.

## 0.5.60

### Fixed: two window messages that were false about a recording not timed from zero

The same three-second file as 0.5.59 — records running 1000s to 1003s, because that is what
its first timekeeping annotation says — got two answers about itself, neither true.

`--start 5000` said "is at or past the end of this **16m 43s** recording", while `--info` two
lines away said "Duration 3s". 1003 seconds is where the recording ends on its own clock and
is its length only when it begins at zero. It now names both, and only when they differ:
"is at or past the end of this 3s recording, which runs from 1000s to 1003s." A recording
timed from zero keeps the sentence it has always had.

`--start 0 --end 1` warned that "The window **is inside the recording** but lands where there
is no data — past the last sample, or inside a gap in a discontinuous file". The window sits
entirely before the recording, which is neither of the two things offered, and following the
advice led back to a report that did not mention the origin at all until two versions ago.
When the window ends at or before the first sample it says so instead, and points at the
`Timed from` line that now exists. A start at or past the end is already an error, so a window
outside the recording can only be one that falls short of it — the gap wording is left exactly
as it was for the case it describes, and the EDF+D fixture still gets it.

## 0.5.59

### Fixed: `--info` never said where a recording starts, on the recordings that do not start at zero

0.4.9 made the first data record's timekeeping annotation the point a recording is timed
from. A file whose first record says `+1000` therefore writes `time_s` from `1000.000`, and
`--start` and `--end` are read on that same clock. None of that appeared in `--info`, which
said

```
Duration   3s  (3 records of 1s)
```

and nothing else — three seconds, which reads as 0 to 3. `--start 0 --end 1` on that file
then converted nothing and explained: "The window is inside the recording but lands where
there is no data — past the last sample, or inside a gap in a discontinuous file. Run with
--info to see where the records actually sit." `--info` was the one place the number was
missing, and the advice was a loop.

It is printed now, whenever it is not zero, and in seconds rather than through the duration
formatter — this number exists to be typed back in, and `--start` takes `1000s` where it does
not take "16m 40s":

```
Duration   3s  (3 records of 1s)
Timed from 1000.000s  (first sample; --start and --end use this clock)
```

Under `--json` it is `first_sample_seconds`. `duration_seconds` and `time_span_seconds` were
both already there and are both lengths; neither says where the length sits. The value was
already in `plan.range` and already governed the row estimate printed underneath — it was
simply never shown. A recording timed from zero, which is nearly all of them, gains no line.

## 0.5.58

### Fixed: a duration below zero was exported without comment

`+0.1<0x15>-3<0x14>backwards` parses perfectly. It came out as

```
onset_s,duration_s,description,record_index
0.1,-3,backwards,0
```

with nothing on stderr and nothing in metadata.json, and there is nothing about that row to
look at twice. A duration is a length of time and a length below zero is not one, so every
use of it goes quietly wrong — starting with the recipe this project's own annotations page
gives for the samples an event covers, `onset_s + duration_s`, which for -3 ends the window
three seconds before the event begins and selects nothing at all.

The value is still written exactly as the file gave it. Replacing it with a zero, or emptying
the cell, would put a number in annotations.csv that no writer wrote, and not inventing
numbers is the point of the tool. What it does now is say so: "1 annotation states a duration
below zero, which is not a length of time", with the arithmetic spelled out in the hint.

Counted apart from a duration that could not be read, which 0.5.55 added — that one failed to
parse and lost its value, this one parsed and kept it, and what is wrong is arithmetic rather
than decoding. `readAnnotations()` returns the new count as `negativeDurations`, documented
alongside the other three, and a duration of exactly zero is not negative.

## 0.5.57

### Fixed: api.md's `readAnnotations()` signature was missing two of its three counts

The page shows the return type, and it showed three fields where the function returns five.
`malformedTimekeeping` has been returned since 0.4.41 and was never added; `unreadableDurations`
arrived in 0.5.55 two versions ago and would have gone the same way. Someone destructuring
from the documented signature gets `undefined` for a count that exists, and `undefined` reads
exactly like "nothing was wrong with this file" — on the page whose subject is how to read a
recording without being lied to.

The prose beneath it said the function returns "a count of entries that couldn't be decoded",
singular, which is the wording the three counts were separated out of: a failed TAL, a failed
timekeeping TAL and an event that lost only its duration are three different losses and were
made three different numbers precisely so they could not be reported as one. The `Annotation`
interface had the same drift in one line — `duration` was still commented "null when the TAL
omitted a duration", which 0.5.55 had just made untrue.

All corrected, and a test now calls `readAnnotations()` on a fixture and compares the keys of
what comes back with the fields listed in the page's own code block, along with the same check
for `Annotation`. Matched against the runtime object rather than the source, because what a
caller can destructure is what the object has.

## 0.5.56

### Fixed: an interrupted conversion warned about files in a directory it had never created

A conversion writes nothing for the first part of its run. Under `--checksum` it hashes the
input before anything else, and an EDF+ file has its whole annotation channel scanned for
record start times before the output directory is claimed — on a 40 MB EDF+C recording that
window is about three seconds wide. The SIGINT handler is installed before any of it.

Ctrl-C inside that window printed:

```
interrupted (SIGINT): the conversion stopped part way through.
       Files already written to "oa" are incomplete and should not be used.
```

and `ls -A oa` then said no such file or directory. Nothing had been written, no directory
had been created, and the advice was to go and distrust nothing. It is the same defect
0.2.30 removed from this path's *error* message — "files that were never written" — left in
place one branch over.

Three cases now, because they call for three different things. Nothing written: "Nothing was
written: "oa" was never created." Written into a directory this run created: the sentence
above, which was always true of that case. And `--force` over a directory that was already
there: what is in it may be the previous run's output or this one's, which the message says
rather than guessing. Whether the directory existed beforehand is read once at the start,
since at interrupt time there is no other way to tell the last two apart.

## 0.5.55

### Fixed: a duration that could not be read was exported as a duration nobody wrote

`duration_s` is empty in annotations.csv when the event carries no duration, and the
documentation says so on three pages. The decoder produced the same empty cell for a TAL that
stated a duration which is not a number — `Number('abc')` is NaN, NaN became `null`, and
`null` is what an absent duration is. So

```
onset_s,duration_s,description,record_index
0.25,,duration-was-given,0
0.5,,no-duration-given,0
```

two rows that the file distinguishes and the CSV does not, with nothing on stderr and no
diagnostic in metadata.json. The onset is already held to a stricter standard: one that is
not a number costs the whole TAL and raises ANNOTATION_DECODE_FAILED. A duration is one field
of an otherwise perfectly readable event, so losing the event over it would be the wrong
trade — but losing it in silence is not the alternative.

Counted now, and reported: "1 annotation states a duration that is not a number, so its
duration_s cell is empty", with a hint saying the onset and description were read normally
and that these rows cannot be told apart from the ones whose file gave no duration. Counted
per row rather than per TAL, since one TAL may carry several texts and each becomes a row
with the same empty cell. A recording whose durations are all readable or all absent stays
silent, which is nearly all of them.

## 0.5.54

### Fixed: a recording with no channels was told its channels carry no samples

`signals.csv` is not written when there is nothing to put in it, and the run says so. There
are two ways to get there, and the warning gave the reason for one of them in both cases.

Converting a recording that holds nothing but EDF+ annotations printed, directly beneath a
warning saying the file has no signal channels: "every channel selected carries zero samples
per data record", "channels.csv still describes them", and "Run with --info to see which
channels do carry samples". No channel was selected, because there are none to select; its
channels.csv is a header row and nothing else, so it describes nothing; and `--info` on that
file prints an empty channel table. Three statements about channels, on a file with none.

The other two paths already had this right. `--stdout` on the same recording distinguishes
the two cases and says "this recording has no signal channels, only EDF+ annotations";
`--info` says "Would write annotations.csv and channels.csv, and no signal data". Only the
conversion path did not.

It says "there is no signal data in this recording to put in one" now, pointing at
annotations.csv for the events and explaining that channels.csv lists signal channels and so
has none to list — both checkable, and both checked. Selecting a channel that carries no
samples keeps the original wording, which is true of that case and was only ever true of it.

## 0.5.53

### Fixed: the correctness page's layout sweep disagreed with itself about how many recordings it ran

Claim 7 says the two layouts are checked over 49 recordings. Six lines further down, the
pasted output of the command that checks it read `266 conversions compared over 48
recordings`. Both numbers were on screen at once, on the page whose whole argument is that
its figures can be reproduced by running the command printed above them.

The output block was pasted when there were 48 fixtures and never repasted. A test already
held the claim to the fixture count; it did not look at the block below it, so the two drifted
apart the moment a fixture was added.

Repasted, and the test now reads both. The recording count in that output is `names.length` —
the fixture list itself — so it is the same number in both places by construction. The
conversion and channel-sequence counts beside it genuinely do move with which windows each
recording can honour, and are left alone; so is the batch sweep's recording count, which is
how many files a seed scattered across its random trees and was never the fixture count.

## 0.5.52

### Fixed: a bound on one channel is not a bound on a file's channels

Every channel is handed a cache of its formatted values, because a channel has only
`digitalMax - digitalMin + 1` distinct readings and the same handful of strings then serve
millions of rows. 0.2.5 sized that cache to the range a channel declares rather than to the
whole 16-bit domain, which fixed the dense montage of 12-bit channels — and left the ceiling
at 512 KB per channel, with nothing whatever said about how many channels a file may have.

The full 16-bit range is legal, usual, and what an ordinary EEG amplifier writes. 256 such
channels claim the ceiling 256 times: 134 MB of pointer arrays reserved before a single row
is written, and it is the channel count that does it, not the file size. A 229 KB recording
exits 134 with a native V8 stack and an empty output directory under a 96 MB heap; a 7.9 MB
one needs 192 MB to finish, where the site advertises 48 MB and means it.

One budget for the conversion, 16 MB, the same shape of fix the time-offset cache got in
0.4.23 one level over — there the unbounded count was rate groups, here it is channels.
A 32-channel montage at the full range keeps every cache it had, as do 512 channels of a
12-bit ADC. Past that, channels format each value directly: about a quarter slower on a
recording where almost none of them are cached, and byte-for-byte the same output. The
229 KB file now converts under 48 MB, and the 7.9 MB one holds a 28 MB working set.

## 0.5.51

### Fixed: 0.5.32 removed the collision refusal from `--info` and put nothing in its place

That version stopped both destination guards refusing `--info`, which was right — `--info`
writes nothing, so a rule about where output would land has no business stopping it. The
sentence it added to cli-reference reads "`--info --out` is how you would want to find out
about them."

It was not. Two recordings whose names collide were described one after the other with no
mention of the collision at all, so the command documented as the way to learn about it was
the one command that would not tell you.

Reported as a warning now, using the guard's own message so there is one wording rather than
two. Still exit 0, still both recordings described, and stderr stays empty when there is
nothing to collide.

## 0.5.50

### Fixed: `--jobs` read its value the way `Number()` felt like reading it

`--jobs 0x10` ran sixteen. `--jobs 1e3` ran a thousand. `--jobs 999999999999999999999` was
accepted as an integer it is not — only the nearest double to one. And `--jobs 4.7` was
refused, which is what makes a reader believe the message: "a whole number of 1 or more".

So the flag rejected the malformed value a person is most likely to type and quietly
reinterpreted three they did not mean at all. It is the flag 0.4.2 hardened because accepting
`--jobs 0` in silence "is the kind of quiet this tool avoids".

A plain decimal integer now, or `auto`. Surrounding whitespace is still trimmed, since a shell
supplies that rather than a person.

## 0.5.49

### Fixed: `--quiet` took a batch's warning attribution away with the summary

A batch prints `[n/m] <path>` before each recording, and that header is what pairs a warning
with the file that raised it. `--quiet` suppresses it — correctly; it is the summary line the
flag is documented to suppress — and the warnings, which `--quiet` deliberately keeps, were
left with nothing saying which recording each belonged to. Two recordings, two warnings, no
way to tell them apart, while `error:` lines in the same run stay named because 0.4.20
prefixes those separately.

The same shape as the `--info` defect 0.5.34 fixed, in the mode that had a header and lost it
rather than the mode that never had one. Warnings carry the recording under `--quiet` now, and
do not when the header is there to do it.

## 0.5.48

### Fixed: cli-reference said `--info` reads only the header, on the page describing `--info`

"`--info` reads only the header for plain EDF and continuous EDF+, so it returns in
milliseconds whatever the file's size. A discontinuous (EDF+D) recording is the exception."

Two of the three are wrong. A continuous EDF+ has its annotation slot read for up to sixteen
records, which is what finds the offset the recording starts at — the offset 0.4.9 made the
point samples are timed from, and the very read that 0.5.46 made report its failures. The
claim was false in the way that matters: it made a warning `--info` genuinely raises look
impossible.

The page now says what each of the three kinds costs, and what follows from it — `--info`
sees an unreadable timekeeping entry in those first records and reports it, and does not see
an unreadable *event* later in a continuous file, because it never looks there. warnings-and-
errors.md has said this correctly since 0.5.37; the two pages now agree, and link.

## 0.5.47

### Fixed: `--info` never said a window selects nothing, and told you to run `--info`

`edf2csv rec.edf --info --start 0.31 --end 0.39` on a 10 Hz recording printed "Would write 0
rows, roughly 15 B." with no warning, and exited 0 under `--strict`. Converting the same
window raised `EMPTY_WINDOW` and exited 1.

`EMPTY_WINDOW` was pushed from the rows a conversion actually wrote, so the mode that writes
nothing could never reach it — while its own hint reads "Run with `--info` to see where the
records actually sit", which is the one mode that would not have told you.

It is a fact about the plan, and the plan is where it is raised now. The estimate's row count
is exact — `npm run estimate` checks that across every fixture crossed with every option set —
so the plan says what the rows would have. Reported once in each mode, and still not raised
for a recording that has no signal channels, which has no signal files for a window to be
empty of.

## 0.5.46

### Fixed: `--info` read an unreadable timekeeping entry and threw the failure away

On a continuous recording `--info` does not scan every record — it reads at most sixteen to
find where the recording begins, which is what keeps it a header read. That read decodes the
timekeeping TAL and sees it fail. The count was hard-coded to zero at the call site, so the
failure went nowhere.

`lost-timekeeping.edf` therefore raised `ANNOTATION_DECODE_FAILED` when converted and nothing
under `--info`, and `--info --strict` exited 0 where the conversion exits 1. Its
byte-identical EDF+D twin — the same bytes but for a reserved field that has nothing to do
with the defect — raised it both ways, because that path reads every record and counts as it
goes.

`EdfFile.scanOrigin()` returns the origin and what the search saw on the way to it;
`readOrigin()` keeps its shape for callers who only want the number. `--info` and the
conversion now agree about this on every fixture, and no recording whose timekeeping is
readable says anything.

## 0.5.45

### Fixed: 0.5.36 let a full disk take the process down with a raw stack trace

The listener that turns a stream failure into a message came off one tick too early. An
`fs.WriteStream` whose write failed emits `'error'` a second time during its own auto-destroy,
after `end()`'s callback has settled — and 0.5.36 released the listener at that callback. So a
destination that filled up during the final flush produced this:

```
node:events:485
      throw er; // Unhandled 'error' event
      ^
Error: ENOSPC: no space left on device, write
```

The process down, no `WRITE_FAILED` line, `signals.csv` truncated with no `channels.csv`
beside it and nothing saying so, and `convert()` never rejecting — a library caller's
try/catch bypassed and their process taken with it. Which is, word for word, the failure the
constructor's comment says this listener exists to prevent.

Released only from `process.stdout` and `process.stderr` now. Those are the streams that
outlive the writer, and the leak 0.5.36 fixed was only ever about them; a stream this writer
opened is finished with and about to be collected, so a listener left on it leaks nothing.

The existing disk-full tests missed it because a conversion that overshoots by a lot fails in
a mid-stream flush and reports correctly. Leaving a little under the whole output free is what
puts the failure in the last flush, and that is what the new test does.

## 0.5.44

### Fixed: `--info` promised nothing for a recording that converts to three files

"Would write 0 rows, roughly 0 B." — for a recording holding only EDF+ annotations, which
goes on to write `annotations.csv` with its events in it, `channels.csv`, and
`metadata.json`.

That is the sentence 0.4.51 removed, arriving by the other route. It asked only whether
`--annotations-only` had been given; a recording that simply has no signal channels has no
rate groups either, and fell past the check to the estimate line. `--info` exists to say what
a conversion will do, so asserting it will write nothing when it will write three files is
the one thing it must not do — which is what that entry said when it fixed the first route.

Both reach the same sentence now: "Would write annotations.csv and channels.csv, and no
signal data. How many events there are cannot be told from the header."

## 0.5.43

### Fixed: 0.5.40 made `--stdout` refuse a recording named twice, quoting a folder nobody named

`edf2csv one.edf one.edf --stdout` is one recording, named twice, converted once, and
perfectly streamable. It came back with:

```
--stdout writes a single CSV, and a folder is converted as a batch even when it holds one recording.
Name the recording itself — one.edf — or convert to a directory instead.
```

No folder was named, and "name the recording itself" quotes back the name just given twice.

0.5.40 made the run's shape count the names rather than the surviving recordings, which is
right for `--out` and for `--json` — and this guard was reading that flag when the question it
needs answered is how many recordings there are to stream. Two different questions that
happened to share an answer until the shape changed.

It asks the recordings now. A folder is still refused however few it turns out to hold, for
the reason 0.5.5 gives: what a folder holds is not known until it is walked.

## 0.5.42

### Fixed: nineteen declaration maps pointing at source the package does not ship

Every `.d.ts.map` in the tarball said `"sources": ["../src/index.ts"]` and carried no
`sourcesContent`. `files` is `["dist", ...]` on purpose, so in an installed copy "Go to
Definition" followed those maps to a path that is not there.

0.4.66 fixed the same thing for the `.js.map` files by turning on `inlineSources`, which puts
the TypeScript inside the map so a stack frame resolves without shipping the tree twice.
TypeScript has no equivalent for declaration maps — that is why the JS maps carry their
sources and these never did, under the same setting.

So they are no longer emitted. The declarations themselves still ship, all nineteen of them,
and "Go to Definition" lands in the `.d.ts`: less precise than the original line, and present,
which the alternative was not. The test that has checked the source maps since 0.4.66 now
checks for the absence of the other kind too.

## 0.5.41

### Fixed: three documents describing output the tool no longer produces, or never did

- **edf-plus-annotations.md said "`--info` reports the amount of data, not the span."** It
  prints `Duration 3s (3 records of 1s)` and, on the line directly under it, `Time span 11s
  (includes discontinuities)` — for exactly the kind of file that section is about. The claim
  was true before that line existed and outlived it. A test reads both lines out of a real
  `--info` run and fails if the sentence comes back.
- **cli-reference.md showed the pre-0.5.22 `--stdout` hang-up message**, without the "of
  102,400" that 0.5.22 added so the number means something.
- **recipes.md's survey block showed a row no recording can produce.** `night-02.edf EDF 3 2
  10 20`: two channels at 10 Hz over three seconds is thirty rows, not twenty. The recording
  it was captured from is two seconds long. The first row was missing `LARGE_OUTPUT`, which a
  3,196,800-row estimate always raises. Both rows are now real output from the recipe above
  them.

## 0.5.40

### Fixed: two names for one recording made the run stop being a batch

`edf2csv one.edf alias.edf --out o`, where `alias.edf` is a symbolic link to `one.edf`, names
two things. It is converted once, which is right. But the shape of the run was decided by the
count that survived deduplication rather than by the count that was named, so it collapsed to
one — and `--out` stopped being a parent. The files landed in `o/` instead of `o/one/`, and
`--json` printed one indented document where two recordings would have given JSON Lines. The
same flags over two genuinely different recordings gave the other shape.

cli-reference says of that exact command that it writes `out/one`, and the comment above the
count has said since 0.4.20 that "a batch is what you asked for, not what happened to be
there" — the principle was written down and then applied to the wrong number. It reads the
named inputs now.

One recording named once is unchanged, and so is everything about which name the output takes.

## 0.5.39

### Fixed: three lost events reported as "No event was lost"

Only the first annotation channel carries a record's timekeeping TAL. The decoder flagged the
first TAL of *every* annotation channel as timekeeping — so in a file with two of them, an
unreadable first entry in the second channel was an ordinary event being dropped and counted
as a lost timekeeping entry.

The file then converted with this:

```
warning: 3 data records carry a timekeeping annotation that could not be read, so they do
         not say where in time they sit.
         No event was lost — a timekeeping annotation states a record's start time and is
         never exported. Times are derived from the records that could be read.
```

Both sentences false, about the same three records. That file's timekeeping is perfectly
readable, and three events were lost — silently, since the one warning raised said in as many
words that nothing had been.

0.5.29 taught the reader which channel carries timekeeping; the decoder is told now too. The
same file reports "3 annotation entries were unreadable and could not be exported", which is
what happened.

## 0.5.38

### Fixed: the API reference's `buildPlan` recipe halved the row estimate it exists to predict

`buildPlan` answers "what would a conversion produce", and api.md gives a recipe for feeding
it record start times by hand: take `recordStarts` from `readAnnotations()` and use
`index * recordDuration` where an entry is `null`.

That last part assumes the recording begins at zero. `convert` places an unreadable record at
`origin + index * recordDuration`, where the origin comes from the first record that does
state one. On `lost-timekeeping-d.edf` — first timekeeping TAL unreadable, the rest saying 1.5
and 2.5 — the recipe puts record 0 at 0 rather than 0.5, so planning a window of
`{ start: 0.5, duration: 1 }` estimates 2 rows. The conversion writes 4.

Which is the one thing this API is for: a plan that disagrees with the conversion by half is
worse than no plan, because it looks like an answer.

The recipe now reads `readOrigin()` and fills from it, as the conversion does, and is a
complete program rather than a fragment — so the example runner added in 0.4.76 executes it
too. A test builds the array that way, plans the same window, converts the same recording, and
requires the estimate, the resolved range and the rows on disk to agree.

## 0.5.37

### Fixed: the page listing what `--info` cannot report was wrong about most of it

"`--info` reads the header and builds a conversion plan without touching the data records or
the annotation channel. It therefore surfaces every structural, calibration and output-shape
warning, but it can't raise the ones that only become visible while converting:
`ANNOTATION_DECODE_FAILED`, `NO_ANNOTATIONS`, `STALE_OUTPUT`, and the two `DISCONTINUOUS`
variants that come from inspecting record timestamps."

It reads the annotation channel for every EDF+ recording — the whole of it for a
discontinuous file, the first few records of a continuous one — and its own source comment in
`showInfo` says so at length. Run against the fixtures, `--info` raises
`ANNOTATION_DECODE_FAILED` and three of the four timestamp-derived `DISCONTINUOUS` variants.
The `DISCONTINUOUS` section three hundred lines down on the same page says "`--info` raises
`DISCONTINUOUS` too, since it has to read those record times".

The section now says what it reads and what it therefore raises, and names the three it
genuinely cannot: `NO_ANNOTATIONS` and `STALE_OUTPUT`, which are about files being written,
and the EDF+C contradiction, which is noticed while the full record-start array is built
rather than while the origin is found.

A test converts four fixtures with `--info --json`, collects the codes, and fails if any of
them appears in the page's list of what `--info` cannot raise.

## 0.5.36

### Fixed: every `toStdout` conversion left a listener on `process.stdout`

The CSV writer attaches an `'error'` listener so a stream failure surfaces as a message
rather than an asynchronous throw, and never took it off. Most of those streams are the
writer's own and go away with it. One does not: `process.stdout`. A library caller converting
twelve recordings with `toStdout` left twelve listeners on it and got Node's
`MaxListenersExceededWarning` on the eleventh — a leak warning that was, for once, describing
a real leak.

Taken off when the writer is finished with the stream. After it has finished ending it, not
before: releasing first meant an `EACCES` arriving during that final `end()` had no listener
left and went out as an unhandled `'error'` event, a raw stack trace, which is precisely what
the listener exists to prevent. Fifteen conversions now leave the count where they found it.

### Fixed: `readRecords({ chunkBytes: NaN })` failed from inside Node

`RangeError: The value of "size" is out of range` out of `Buffer.alloc`, with no mention of
the option that caused it — while a fractional `startRecord` two lines earlier gets a typed
`EdfError` naming the field. Every other option there is checked; this one reached the
allocator. `0`, negatives, `NaN` and `Infinity` are now an `EdfError` that says which option
it is about. `chunkBytes: 1` still reads a whole record, as documented.

## 0.5.35

### Fixed: four documents disagreeing with the tool or with themselves

- **`CITATION.cff` declared 0.4.19** while package.json said 0.5.34 — 107 releases behind. It
  is the file a citation is generated from, so it is the one version number that ends up in
  somebody else's bibliography rather than only on a page here. A test holds it to
  package.json now.
- **warnings-and-errors.md said `DISCONTINUOUS` "covers five related conditions"** and listed
  five; the code raises six. The missing one is the EDF+C file whose own records disagree
  about its continuity, which appeared nowhere on the page despite being the condition with
  the most careful implementation behind it — the tolerance it compares against is what
  0.4.41 exists for.
- **correctness.md opened with "Eight separate claims"** over a sentence reading "covers seven
  different things, verified seven different ways". Consecutive lines.
- **api.md said `require("edf2csv")` "won't work".** It works on any Node that can require an
  ESM graph, since nothing here uses top-level `await` — verified on 22.16 and 24.4. It does
  fail on the older Node 20 releases that predate that support, which are inside the declared
  range, so the page now says that and points at `await import()` as the portable form.

## 0.5.34

### Fixed: `--info` over a folder left its warnings unattributable

The table goes to stdout and the warnings to stderr, which is the point of the split — you
can save one without the other. Over a folder it also meant several warnings in a row on
stderr with nothing saying which recording raised any of them. Two recordings, two warnings,
and no way to pair them up short of running the tool again one file at a time; the tables
that would have identified them went to the other stream.

Each warning names its recording now, the way a batch conversion's have since 0.4.20. A
single recording has nothing to be confused with, so it says exactly what it always said.

## 0.5.33

### Fixed: the library accepted a `layout` the command line rejects

`edf2csv rec.edf --layout tall` has always been a usage error. `convert(path, { layout:
'tall' })` took it, wrote the wide layout, and handed back a plan whose `layout` read
`'tall'` — so a programmatic caller with a typo got a conversion that was not the one they
asked for, described by a plan that agreed with the typo rather than with the files.

`assertOptions` checks every other option that has a shape, and rejects each before a
directory is created. `layout` arrived in 0.5.0 and never joined them. It has now, with the
same wording the CLI uses.

## 0.5.32

### Fixed: `--info` was refused over output it does not write

Both destination guards applied to it. A folder holding `rec.edf` beside `rec/inner.edf` gave
`edf2csv study --info --out yy` exit 2 and "would be converted into yy/rec/inner, which is
inside yy/rec — where rec.edf is converted", printing nothing about either recording. Two
recordings whose names collide got the overwrite refusal the same way.

Both messages assert a conversion and an overwrite that `--info` does not perform. The
identical command without `--out` described both files happily, which is the tell: the guards
were reading a plan nobody was going to execute.

And the refused command is the useful one. `--info --out` is how you ask what a run would
produce before committing to it, so a collision is precisely the thing you would want it to
show you rather than decline to look. It describes them now; the conversion is refused exactly
as before.

## 0.5.31

### Fixed: the API reference's sample-time recipe disagreed with the tool by half a second

api.md's streaming example computes each record's start as `index * recordDuration`, and the
caveat under it named EDF+D as the only case needing the record starts from
`readAnnotations()`. It assumes two things, and EDF+ guarantees neither.

The second is that the first record sits at zero, which a *continuous* file is free not to do.
`fractional-start.edf` is EDF+C with records at 0.5, 1.5 and 2.5 seconds — contiguous, and
half a second later than the arithmetic says. The recipe times its first sample at 0.000;
`convert()` writes 0.500 for that sample. The annotation onsets in the same file keep their
true values, so an analysis built on the recipe puts every event half a second away from the
samples it describes.

The tool has recovered that offset since 0.4.9 and `src/convert/timing.ts` describes the
failure at length; the recipe was the one place still doing it the old way. It now reads
`readOrigin()` — the cheap version, at most sixteen records rather than the whole annotation
channel — and a test runs the recipe against `convert()` on that fixture and requires every
timestamp to match.

## 0.5.30

### Fixed: `npm pack` on a clean checkout produced a package with no code in it

Four files, no `dist/`, no bin, nothing importable — and `npm pack` reported success. Anyone
packing the repository, or installing it from a git URL, got a package that installs cleanly
and does nothing.

`prepublishOnly` builds, and runs only for `npm publish`. `npm pack` goes round it, as does a
git-URL install. Published versions were therefore always fine, which is exactly why this
could sit there unnoticed: the one path that was covered is the one everybody sees.

A `prepack` script builds now, which is the hook both `npm pack` and `npm publish` run. The
tarball goes from 4 files to 76; installed into a fresh directory it answers `npx edf2csv
--version`, exports its 28 names, and converts a recording.

A test holds the shape rather than the tarball, since packing inside the suite would mean
running a build inside a build: `files` says what ships, `bin`/`exports`/`types` say what has
to be in it, and `prepack` is what makes the second true when the first is read.

## 0.5.29

### Fixed: an annotation channel with no room in it hid the timekeeping in the channel after it

EDF+ puts the timekeeping TAL first in the first annotation channel, and the reader took that
literally: `annotationSignals[0]`, whether or not it can hold a byte. A writer that declares
an annotation channel and gives it zero samples per record leaves a zero-byte slot, and
nothing is read from a zero-byte slot — so a three-record EDF+D whose second annotation
channel carried perfectly readable timekeeping reported "3 of 3 data records carry no
readable timekeeping annotation" and timed itself from zero.

A channel with no room carries nothing, so it is not the one the TAL is in. `EdfFile` gains
`timekeepingSignal`, the first annotation channel with room, and both the origin read and the
full annotation pass ask it rather than counting from zero. Events were never affected: those
are collected from every annotation channel, which is why the same file under EDF+C looked
perfectly fine and gave no hint.

## 0.5.28

### Fixed: an EDF+C file contradicting continuity went unreported when its first record sat at zero

The continuous branch derives an origin from the first record that states one, builds the
contiguous timeline from it, and compares every record against where continuity puts it. It
returned early when that origin came out as exactly 0 — correct about the times, since
contiguous starts from zero are what timing from zero already produces, and wrong to skip the
comparison on the way past.

So a file whose records say 0, 5 and 10 on one-second records said nothing, while the same
file shifted by one second, saying 1, 6 and 11, warned that two of its three records start
somewhere other than where continuity puts them. Same contradiction, same two records; where
record 0 happens to sit decides nothing about it.

The zero case now takes the same path and returns after the check rather than before it. No
fixture that is genuinely contiguous was newly called a liar, including the fractional-record
one that 0.4.41's tolerance exists for.

## 0.5.27

### Fixed: the batch summary said everything converted while the exit code said otherwise

A folder holding one recording beside a sub-directory without read permission printed
"Converted 1 of 1 recordings." and exited 1. The line agreed with itself and with nothing
else.

That sentence is the one the directory walk's own comment quotes as the thing it fixed: "a
folder holding three recordings, one of them inside a sub-directory without read permission,
converted two and said Converted 2 of 2 recordings — a total that agreed with itself and with
nothing else." What was fixed then was the error line and the exit code. The unreadable paths
were added to the failure count on the line *after* the summary printed, so the summary went
on saying everything worked.

Counted before it prints now, and counted separately from the recordings, because an
unreadable path is not one of them — how many it held is exactly what nobody knows:

```
Converted 1 of 1 recordings; 1 path could not be read.
```

A batch where a recording genuinely fails to convert still reads "Converted 2 of 3
recordings; 1 failed", and a clean batch is unchanged.

## 0.5.26

### Fixed: 0.5.20's memory test asserted a heap size only one machine has

It converted 200 output tables under a 48 MB cap, which the fixed code does on macOS with
Node 24 and does not on Linux with Node 22. So the release workflow failed and 0.5.25 did not
reach npm — a test turning a garbage-collector difference into a red build, which is worse
than no test.

How much heap a conversion needs is not portable, and the separating cap is not either: the
pre-fix code dies at 64 MB here and needs considerably more on the runner. The test runs both
counts at 96 MB now — 40 tables, the size 0.5.6 was measured at and which always fitted, and
200, the size that did not — so what it asserts is the property, that the second costs no more
than the first. The exact figures are in the 0.5.20 entry, where a measurement belongs, rather
than in an assertion that is only true on one machine.

Verified the way it should have been: a fresh clone, `npm ci`, all 261 tests passing.

## 0.5.25

### Fixed: records that overlap in time went unreported, because the check looked for reversal

There are two ways a discontinuous recording can make `time_s` step backwards, and only one
was being looked for.

The obvious one is a record that starts before the record before it. The other is a record
that starts before the record before it *ends*. Starts of 0, 0.5 and 1.0 on one-second
records are strictly increasing, so nothing fired — and the rows still came out 0.25, 0.5,
0.75, 0.5, because the first record's samples run to 0.75 while the second begins at 0.5. A
device re-sending a buffer produces exactly this.

Both are reported now, with the same advice, since the reader has no more to say about one
than the other: every sample is written, in file order, with the time the file gives it.
Contiguity is not overlap — a continuous recording has `starts[i] === starts[i-1] + duration`
exactly — so the comparison is made strict by a fraction of the finest interval the recording
can express, and no ordinary file is called overlapping.

`DISCONTINUOUS` now covers five conditions; the page said four, having said three until
0.5.17.

## 0.5.24

### Fixed: the correctness page described a method it says two hundred lines later was abandoned

"The comparison runs at `--decimals 20`, the most `--decimals` accepts, so what is being
compared is two computations of a value rather than one of them against its printed form."

It does not. Since 0.4.32 both sides dump their doubles and the 64 bits are compared; nothing
goes through a CSV, and `compare.py` mentions `--decimals` once, in the past tense, to say it
used to. The same page explains that change further down. Reading a printed cell back cannot
be exact at any precision — a cell is a rounded rendering, so parsing it gives the nearest
double to those digits rather than the double that was computed, which is exactly why the
method was replaced.

Two more on the same page:

- It gave the derived precision cap as 20. It has been 100 since 0.4.74, and the sentence was
  making an argument about a magnetometer needing more places than a volt channel — the
  argument the ceiling was raised for.
- It said `--decimals 20` prints `0.195360195360195` "from both forms". It prints
  `0.19536019536019536003`, and the specification's literal ordering prints
  `0.19536019536019466614` — they first differ at the fifteenth decimal. Which is the
  difference that section exists to describe, so the sentence was undercutting its own point
  with a number neither form produces.

## 0.5.23

### Fixed: the `time_s` precision rule was documented as it worked before 0.4.55

Two pages still described the old bound.

output-files.md said the search for a terminating expansion stops at nine places, and its
table listed 1024 Hz as getting seven decimals and being rounded. The bound has been fifteen
since 0.4.55; 1024 Hz gets ten and is exact, since 1/1024 terminates at ten. Two of the three
columns wrong on one row, in a table whose whole subject is that these numbers are derived
rather than chosen. The closing paragraph then explained a cap that no longer exists.

warnings-and-errors.md said times are "written to at most nine decimal places, which
separates everything up to a gigahertz", and illustrated `TIME_RESOLUTION` with a warning at
10 GHz — a rate that terminates at ten places and is written exactly, and does not warn. The
replacement shows the rate that does: 3e15 Hz, whose reciprocal never terminates.

A test now recomputes every row of that table from `timeDecimals`, including the exact-or-
rounded column, which it derives rather than reads. Every power of two through 32768 Hz
terminates inside fifteen places, so the table gains 4096 Hz as well.

## 0.5.22

### Fixed: 0.5.12 called a finished conversion unfinished

Whether the conversion stopped early and whether the reader stopped reading are different
questions, and 0.5.12 answered the first with the second. Any `--stdout` run whose reader
closed the pipe got "The recording was not converted in full."

For a large recording that is true. For one whose CSV outruns the 64 KiB pipe buffer but fits
inside a single flush — 10,000 rows, 166 KB — it is not: every row is formatted and handed
over, and only then does the final write meet the closed pipe. The conversion finished. The
delivery did not.

The estimate's row count is exact, so the two can be told apart, and now are. A run that
stopped short says how far it got out of how many; a run that finished says it finished and
that not all of it arrived. Both still exit 0, because piping to `head` is an ordinary thing
to type and not a failure.

## 0.5.21

### Fixed: 0.5.10 silenced the warning it was meant to keep

`VALUE_RESOLUTION` fired on every channel of an ordinary EEG at `--decimals 2`, which made
`--decimals 2 --strict` impossible on any recording, so 0.5.10 stopped raising it whenever
`--decimals` was given.

That is the wrong question. It suppressed the real case along with the false one: at
`--decimals 20`, a channel whose quantization step is 1e-106 printed every code it had as
`0.00000000000000000000` — total collapse, nothing recoverable — and said nothing at all.

The question is not who chose the precision. It is whether *any* precision this can print
would separate consecutive codes. A channel needing 3 places and given 2 is a trade the
caller made knowingly. A channel needing 108 places has no trade available, and that is true
whatever `--decimals` says.

Asked of the ceiling now. An ordinary EEG stays quiet at any `--decimals`; the gravimeter
warns at every `--decimals` and when the precision is derived. The message says "less than
any number of decimals this can print", since naming a number was what made it sound like a
setting.

## 0.5.20

### Fixed: 0.5.6 shared one of the two per-table buffers and left the other

That version made memory stop following the number of output tables, and tested it at forty
rates. At two hundred it still died: an 855 KB recording with 200 sampling rates ran out of
heap under a 48 MB cap.

Two things were sized per table and only one of them was shared. The line buffer got a
budget split across the groups — with a 64 KiB floor under each, which at 200 groups is 12.8
MB, so the floor became the whole quantity. And `createWriteStream` was left at its own
default `highWaterMark`, which is 64 KiB per stream: another 12.8 MB that the change never
looked at. Forty groups made both invisible at 5 MB apiece; two hundred made them 25 MB
together.

The floor is 8 KiB now and the stream buffer shares the same budget. The memory test runs at
200 groups rather than 40, since 40 was the count that hid this.

An eight-hour single-rate conversion runs at the same speed, and the forty-rate case from
0.5.6 still completes under a 32 MB cap.

## 0.5.19

### Fixed: the long layout's tie order broke where two rates land a ULP apart

0.5.9 made channels sharing an instant come out in the order the file declares them, and
tested that on the double. Two exact divisions of the same instant need not give the same
double. A 0.3 s record holding 12 and 4 samples is 40 Hz and 13.333… Hz: sample 9 of the fast
channel is 9/40 = 0.22500000000000000555, sample 3 of the slow one is 3/13.333… =
0.22499999999999997780. Equality does not see that, so those two rows fell out in numeric
order — `slow` before `fast`, once, in the middle of a file that was otherwise right.

Two rows are at one time exactly when they carry the same `time_s`, which is the only
definition a reader of the CSV can apply, so that is the test now. A relative epsilon keeps
the common case to one numeric comparison; the formatted times are only compared for
candidates already within a hair of each other. Deciding on the text rather than a tolerance
also means the column can never step backwards to satisfy an ordering rule. An eight-hour
three-rate conversion runs no slower.

### Changed: the layout harness reports why, not just that

`npm run layouts` said "long refused what wide accepted" and nothing else, which sent me
looking for a defect that turned out to be a transient filesystem failure under load. It
carries the tool's own message now. A harness that reports a disagreement without the
evidence for it costs more than it saves.

## 0.5.18

### Fixed: argument order decided a recording's output directory, and whether the run happened

`edf2csv study study/night-01/rec.edf --out o` and the same two arguments swapped are the
same request. They disagreed.

A recording reached both directly and through a named folder has one path and two names: the
folder gives it its position inside the folder, `night-01/rec`, and naming the file gives it
its bare `rec`. The tie-break that settles which name survives compares paths — and these
paths are identical — so it fell through to whichever spelling the loop met first. Argument
order.

That renamed the output directory. Worse, with a sibling `study/rec.edf` also present, the
bare name collides with it: one order converted both recordings and exited 0, the other was
refused with "would both be converted into o/rec, so one would overwrite the other" and exit
2. Same files, same flags, same intent.

The nested name wins now. It is what the folder promised — "the layout is kept: recordings in
sub-folders come out in sub-folders" — and it is the one that does not collide, since
collapsing a recording to its bare name is what puts it on top of a sibling. Both orders now
convert both recordings, and both name them the same thing.

The existing tie-break for two *paths* to one recording, which prefers a real name over a
link and sorts the rest, is unchanged; this is the case one path with two names, which it did
not reach.

## 0.5.17

### Fixed: a recording timestamped far in the negative direction lost two thirds of its rows, silently

A double spaces its values further apart the larger they get. Near 1e16 seconds the gap
between representable numbers is two seconds, so adding a one-second sample interval leaves
the number unchanged and every sample in a record lands on one instant. The tool has a guard
for that, and a warning, and times the recording from zero instead so every row survives.

The guard took the signed maximum of the record start times, seeded with zero. An
all-negative recording therefore never got past the seed: the check ran on an origin of 0,
which any interval can carry, and passed. The collapse happened anyway, because the spacing
of doubles grows with magnitude and not with value — -1e16 defeats a one-second interval
exactly as +1e16 does.

A twelve-row discontinuous recording wrote four rows, exit 0, nothing said. Its byte-for-byte
positive mirror wrote all twelve and explained why. Same file, same arithmetic, opposite
sign, and the silent one was the one losing data — which is the precise failure `unusableOrigin`
was written to prevent, described in its own comment.

Measured by distance from zero now. A fixture holds it, and it took two attempts to write:
the first was continuous, and a continuous file takes its record times from continuity, so
its declared onsets never reach the guard at all. Discontinuity is what makes them
load-bearing.

Also documents the condition, which was not on the warnings page. That page said
`DISCONTINUOUS` "covers three related conditions" and listed three; the code raises four.

## 0.5.16

### Added: `npm run layouts`, which checks the claim `--layout long` is built on

Every page says the same thing about it: a different shape, not different data. That is what
makes it an honest answer to a mixed-rate recording rather than a second way to be wrong, and
for thirteen versions nothing ran it. In those thirteen versions the long layout shipped four
defects — a byte audit counting one writer per rate group, then the same again for the
compressed stream, then a channel order taken from the sampling rate rather than from the
file, then a promise of sorted rows a discontinuous recording can break. Three of the four
were found by reading code, not by converting anything.

So this converts. Every fixture crossed with six option sets that move the window and the
precision, both layouts, compared per channel: the wide column read down its rows against
that channel's rows in the long table, as an ordered sequence of value cells.

Deliberately not joined on time. The two layouts write `time_s` at different precisions by
design — the long one shares the finest any rate needs, since one column cannot mean three
things — so a time-keyed comparison compares the formatting rather than the data, and at nine
decimal places it collapses distinct sub-nanosecond samples into one key. The first version
of this harness did exactly that and reported 42 disagreements that were all its own.

Confirmed capable of failing before being kept: making the long layout skip one sample per
record is caught on the first recording, as a channel holding 8 values one way and 6 the
other. It is the correctness page's eighth claim, and the page states the sweep's shape
rather than a total, since the totals move with the fixture set — a test holds the shape
against the harness.

## 0.5.15

### Fixed: `--stdout` on a recording with no signal table, which both layouts got wrong

A recording holding only EDF+ annotations produces no rate groups, and neither layout had an
answer for that.

The wide one said "--stdout needs exactly one table, but this recording produces 0, one for
each sampling rate its channels use ()" — an empty parenthetical, a count of zero described
as one-per-rate, advice to narrow to one of no rates with `--channels`, and advice to reach
for `--layout long`.

Which wrote zero bytes to stdout. Not a header row, nothing, exit 0, alongside a warning that
"the signal files hold their headers and no data" — there were no files, and there was no
header. So the wide layout's advice routed you into a silently empty result.

Both refuse now, the way `--stdout --annotations-only` already did, since it is the same
situation reached by a different route. A `--channels` selection that leaves nothing carrying
samples gets its own sentence, because the fix is a different one.

## 0.5.14

### Fixed: "Nothing is written" was true of every error in that section but one

warnings-and-errors.md opens its fatal-read section with "These stop the conversion. Nothing
is written. All of them exit 1." That holds for all of them except the one described at the
end of the same section: a recording that shrinks *during* the conversion, because the
amplifier is still writing it or something is replacing it underneath.

By then rows are on disk. A 2.88-million-row conversion cut short at record 24,600 leaves
2,451,013 of them in a `signals.csv` that ends on a row boundary and opens exactly like a
finished one. Nothing about the file reveals which it is — which is the whole reason to say
so, and the section said the opposite.

The tool itself was already right: the message ends "What was written to "out" before it
failed is incomplete and should not be used." I had added a second line saying the same
thing before checking, and took it out again. The page is what needed fixing.

A test holds it, and holds it honestly: truncating the recording *before* the run proves
nothing, since the header read notices, warns, and converts the records that are there. It
has to shrink while being read, so the test cuts it from inside `onProgress` — and asserts
the cut actually happened, so it cannot quietly stop testing anything.

## 0.5.13

### Fixed: the test suite reached for a website dependency, and every publish since 0.5.1 failed

0.5.1 stopped the link checker carrying its own copy of the site's slug rule and had it
import `slugify` from `website/src/lib/markdown.js` instead. That file imports `marked`.

The package has no dependencies, deliberately, and `npm test` runs with none installed —
which is a claim the correctness page makes in as many words. So the release workflow failed
on `Cannot find package 'marked'` for 0.5.1 through 0.5.12, and npm stayed on 0.5.0 while
twelve tags, twelve GitHub releases and twelve sets of green local tests said otherwise. It
passed here because this machine has the website's `node_modules` sitting next to the
package's.

`slugify` is its own module now, `website/src/lib/slug.js`, importing nothing. The renderer
imports it and re-exports it; the test imports it directly. Both callers share the function
without sharing a dependency graph.

Verified the way it should have been the first time: a fresh clone, `npm ci`, no website
`node_modules` anywhere, all 253 tests passing.

## 0.5.12

### Fixed: the summary claimed a conversion for a reader that stopped reading

`edf2csv recording.edf --stdout | head -1` announced "Wrote 52,507 rows to stdout" for a
102,400-row recording of which the reader took one line. That number is neither total. It is
however many rows had been formatted before the closed pipe was noticed — a figure with no
meaning outside the implementation, presented as the result of the run.

Piping to `head` is an ordinary thing to type and not a failure, so it still exits 0. It is
not a conversion either, so it no longer gets a conversion's summary: it says the reader
closed the pipe, after how many rows had been written, and that the recording was not
converted in full. How many reached the reader cannot be known from this side. That it
stopped early can.

`ConvertResult` gains `readerHungUp` for callers who need to tell the two apart.

### Fixed: `--gzip` dropped the unit from every line of the summary

```
Wrote out
  signals.csv.gz      300
  annotations.csv.gz    3
  channels.csv.gz       1
```

The unit was attached to names ending in `.csv`, and `.csv.gz` does not, so the counts stood
on their own with nothing saying what they counted — beside an uncompressed run of the same
recording that says `300  rows`. A compressed CSV's rows are still rows.

## 0.5.11

### Fixed: six documentation claims that contradicted the tool or each other

- **cli-reference explained the derived decimal ceiling as 20.** It has been 100 since
  0.4.74. The sentence was reasoning about a magnetometer needing more places than a
  microvolt EEG and then giving the number that no longer applies — and 20 is still right
  for `--decimals`, which made the two easy to conflate. Both are now stated, with what each
  bounds.
- **The `--decimals` error example could never be printed.** It showed
  `--decimals must be a whole number between 0 and 20, got "16"`. 16 is inside 0 to 20.
- **The exit-code list said "more than one input file" is a usage error.** Batch conversion
  of several files is a documented feature of the same page.
- **api.md gave `ConversionError.code` two different value sets** thirty lines apart: seven
  in the table, four in the prose.
- **The README's headline CSV sample was not output the tool can produce.** A 256 Hz
  recording writes `time_s` to eight places, because 1/256 terminates at eight; the sample
  showed six, and values to match. It is a real conversion now.
- **recipes.md showed a fifth `sleep-study.edf`** — four channels, 42.2 MB, plain EDF —
  where the rest of the site shows one recording. 0.4.78 fixed exactly this and the guard it
  added never looked at that page: it held a hard-coded list of three, and matched only the
  exact spelling `File       sleep-study.edf`, while recipes wrote `./sleep-study.edf`.

The guard now reads every page in `website/content` and accepts either spelling. A check
against drift with a hard-coded list of where drift can happen is a check against the drift
you already found.

Also: the correctness page's captured `npm test` block claimed 39 suites where the runner
reports 48. That number was the one thing in the block nothing was reading; it is counted
from the files now, like the test counts beside it.

## 0.5.10

### Fixed: `VALUE_RESOLUTION` reported `--decimals` back at the person who typed it

The warning 0.4.74 added is about a ceiling: a channel whose quantization step is below
1e-98 needs more decimal places than `toFixed` will print, so consecutive digital codes come
out as the same text. The check asked "does this channel need more decimals than it is
getting", which is also true — deliberately — every time `--decimals` is used to ask for
fewer.

So an ordinary EEG at `--decimals 2` raised it on every channel. And because `--strict`
turns any diagnostic into a non-zero exit, `--decimals 2 --strict` could not succeed on any
recording at all: the flag and the flag were in a fight.

Raised only when the precision was derived now. `--decimals` is a choice, and the tool takes
it at its word. The ceiling case is unchanged, and still warns, because nobody chose 100.

## 0.5.9

### Fixed: the long layout ordered tied channels by sampling rate, not by the file's order

Documented as "within one time in the order the file declares its channels", which is also
what `channels.csv` lists and what the wide layout's columns do. What it actually did was
descending sampling rate: rate groups are sorted largest first, because that is how the wide
layout names its files, and emitting a tie one group at a time let that leak into the rows.

A recording declaring `slow, medium, fast` wrote `fast, medium, slow` at every instant where
all three had a sample. Most recordings hide it by declaring their fastest channels first,
which is why the fixtures did not catch it — a new one, `ascending-rates.edf`, declares them
the other way round.

Now every channel due at one instant is collected and emitted in signal-index order, which
is the file's own order and the only one a reader can predict. Checked across all 41
convertible fixtures: each channel's sequence of values is identical between the two
layouts.

### Fixed: `onProgress` reported more bytes written than the file being written

`bytesWritten` summed each group's writer. The long layout's groups share one, so a
three-rate conversion reported three times the real figure — a progress meter that runs past
the end.

## 0.5.8

### Fixed: 0.5.4 fixed half of the stdout audit and left the compressed half

`--stdout --layout long --gzip` still failed, and louder than before. On a 40-rate recording
it claimed "606684 of 622240 bytes did not reach the destination" over a compressed stream
that decompresses to every row, and printed Node's `MaxListenersExceededWarning` to stderr
on the way past ten listeners.

Same arithmetic as 0.5.4, different shape, which is why it survived the fix. Uncompressed,
the audit adds up each writer's byte count — a sum, fixed by counting distinct writers.
Compressed, it subscribes to the compressor's `data` events — and the subscription was made
once per rate group, on the one compressor they share, so every chunk was counted once per
group.

Subscribed once per stream now. The stream is byte-identical to what `--out --gzip` writes.

## 0.5.7

### Fixed: a folder that could not be read was reported as a folder holding nothing

Both got the same exit 2 and the same sentence — "No EDF or BDF recordings found in
/data/locked" — printed directly beneath a line saying the folder could not be read. The two
lines contradicted each other, and the exit code sided with the wrong one.

Exit 2 is this tool's code for "the command itself was wrong". The command was fine; the
filesystem refused. A script reading the status was being told to fix its arguments when
what needed fixing was a permission, and the sentence stated a fact the run was in no
position to state: nothing was found because nothing was looked at.

An unreadable path now exits 1 and says so — "whether it holds recordings is unknown". An
empty folder is still exit 2 and still says it is empty, which it can, having looked.

## 0.5.6

### Fixed: memory followed the number of output tables, not the size of the recording

Every rate group opened its own writer at the 1 MiB flush threshold, so pending output was
group count times a megabyte before anything drained. A 6.5 MB recording with forty sampling
rates therefore needed forty megabytes of buffer and died with a raw V8 heap out-of-memory —
exit 134, a native stack, nothing written, no catchable error for a library caller — under a
96 MB cap. The site advertises 48 MB.

Nothing about that recording is large. The fan-out is: an EDF header can declare thousands of
channels, and a research montage really does mix a dozen rates. The one number that mattered
was the one the design was not looking at.

The budget is one buffer for the conversion now, split across the tables, with a floor so a
run does not turn into a flush per row. Single-rate recordings — nearly all of them — keep
exactly the buffer they had, and forty tables cost 2.5 MB instead of 40. The same 6.5 MB
recording completes under a 32 MB cap, and its CSVs are byte-identical to a run with a
gigabyte. Throughput on an eight-hour single-rate conversion is unchanged.

The long layout was never affected: it shares one writer across the groups, which is what
0.5.0 had to do to keep its rows in order.

## 0.5.5

### Fixed: three things `--stdout` said about itself that were not true

**The help forbade what the tool does.** `--help` and the README both described `--stdout`
as "(single-rate recordings only)" — twenty lines above the paragraph, in the same help text,
explaining that `--layout long` is how a mixed-rate recording streams. 0.5.0 lifted the
restriction and left the line describing it.

**`--out` and `--checksum` were accepted and dropped in silence.** `--out` named a directory
that was never created, so a run that wrote nowhere looked like it had written somewhere.
`--checksum` was worse than useless: the hash is computed before the first record is read,
which is a second full pass over the input, and the only file it is ever written to is the
`metadata.json` that `--stdout` does not write. A recording large enough to want a checksum
is large enough to notice being read twice for nothing. Both are usage errors now, which is
what `--stdout --json` and `--stdout --annotations-only` already were.

**A folder holding one recording was refused as "1 recordings".** "--stdout writes a single
CSV, so it cannot take 1 recordings" — ungrammatical, and wrong on its face, since one
recording is exactly what it can take. What it cannot take is a folder, whose contents are
not known until it is walked. It says that instead, and names the recording inside so you can
run that.

## 0.5.4

### Fixed: `--stdout --layout long` failed with a disk-full error on a file that was complete

The command the `--layout` documentation gives — `edf2csv recording.edf --stdout --layout
long > signals.csv` — exited 1 on every mixed-rate recording, saying "64086 of 96129 bytes
did not reach the destination" and advising that the disk was almost certainly full. The
file on disk was complete, every row present.

`--stdout` audits itself: a filesystem that fills up mid-write returns a short count rather
than an error, and stdout has nothing written after it to trip over, so the run compares how
far the file grew against how many bytes it handed over. That count was taken once per rate
group. 0.5.0's long layout gives every group the same writer, so a three-rate recording
counted its 32,043 bytes three times, was credited with 96,129, and concluded that two
thirds of them had been lost.

Counted once per writer now. It only bit when stdout was redirected to a regular file, which
is the one case the audit applies to and exactly what the documentation shows — through a
pipe the audit declines, so the feature looked fine everywhere it was demonstrated
interactively.

## 0.5.3

### Fixed: the long layout promised sorted rows for a file it cannot sort

0.5.0 said, flatly, "rows come out sorted by `time_s`" — on two pages and in its own release
notes. The promise rests on something true but conditional: every sample of a record falls
inside that record's span, so writing records in file order gives times in order.

A discontinuous recording is free to store its records in a different order than it
timestamps them. Nothing in EDF+ forbids it. Then the rows come out 10s, 5s, 0s, and the
tool was already warning that they would — "2 data records start earlier than the record
before it. Rows are written in file order, so the time column will not increase
monotonically" — while the page for the new feature promised the opposite.

The claim is qualified now, in both places, and points at the warning. What has not changed
is the part that matters: every sample is written, once, in file order, with the time the
file gives it. A fixture, `records-backwards.edf`, holds all of that — including the check
that the times really do go backwards, so the test cannot quietly stop testing anything.

## 0.5.2

### Fixed: the disk-full tests destroyed any other run on the machine

`test/stdout-audit.test.js` needs a filesystem of a known small size, so it makes one with
`hdiutil`. The image and the volume were constants — `/tmp/edf2csv-audit.dmg` and
`/Volumes/edf2csvaudit` — and every run began by detaching that volume and deleting that
image, whoever they belonged to.

So two runs at once did not queue, they destroyed each other. Three concurrent copies of the
file fail 10 of their 12 tests, the second run pulling the disk out from under the first
mid-write. This is not exotic: `node --test` runs test files in parallel, re-running a suite
before the last one has finished is ordinary, and CI machines run more than one job. It
surfaced here as a single mystery failure in an otherwise green run, which is the worst way
for it to surface — a flaky test costs more than the one it fails, because it makes every
other result a question.

The image and volume are named for the process now, and the mount point is read from
`hdiutil` rather than assumed: macOS renames a volume whose name is already taken —
`edf2csvaudit 1` — so assuming the path meant a colliding run would have quietly written
into the other run's volume. Four concurrent copies now pass all sixteen and leave nothing
mounted.

## 0.5.1

### Fixed: 0.5.0 shipped a feature and told none of the pages that argue for it

`--layout long` is the answer to a question six pages ask, and every one of them still said
the split into a file per rate was the only outcome. sampling-rates.md spends a section
listing the three ways a wide table can fill the cells a slow channel never recorded, and
never mentioned the fourth option, which is not to make the table wide. faq.md's "why did I
get several signals files" gave no way to get one. cli-reference listed "more than one
sampling rate" as a flat exit-2 condition for `--stdout` — which `--layout long` makes false,
while the tool's own error message for that case already names the flag.

All six now say so, with real output. A test holds the rule: a page that tells the reader a
mixed-rate recording becomes several files has to also tell them about the layout that does
not.

### Fixed: the link checker had its own idea of where links point

Added in 0.4.67 with its own copy of the site's slug rule — lowercase, then every run of
non-alphanumerics to a hyphen. The site's keeps hyphens as themselves, so `## --layout` is
`#--layout` on the page and was `#layout` here. It would have called the correct links added
above broken, and it would have passed a link to `#layout` that resolves to nothing.

It imports `slugify` from `website/src/lib/markdown.js` now, which is the function that
generates the ids, so a link checker and the links agree by construction.

## 0.5.0

### Added: `--layout long`, so a mixed-rate recording can be one table

Until now a recording whose channels run at different rates came out as several files, one
per rate, and that was the honest answer to a real problem: a 100 Hz channel and a 1 Hz
channel share no rows, so a single wide table holding both means either ninety-nine empty
cells in every hundred or inventing the samples to fill them. This tool exists not to invent
them.

The long layout is the other honest answer. One file, three columns — `time_s`, `channel`,
`value` — and one row per sample. Each sample carries its own time, so nothing has to line
up, every rate goes in one table, and not a value is invented:

```
time_s,channel,value
0.000,EEG Fpz-Cz,0.061
0.000,EEG Pz-Oz,0.061
0.000,Resp oro-nasal,0.000244
0.000,Temp rectal,37.00073
0.010,EEG Fpz-Cz,1.648
```

Rows come out sorted by `time_s`. That is not free — the groups are merged rather than
written one after another, since every sample of a record falls inside that record's span,
so taking the earliest next sample across the groups leaves the whole file in order. Sorting
three million rows afterwards would be the reader's problem, and a large one.

It is also the one layout `--stdout` can stream for a mixed-rate recording, because there is
only ever one table. `--stdout` on such a file used to have nothing to offer but
`--channels`; its error now says so.

Some details that follow from one table:

- `time_s` shares a precision across rates — the finest any of them needs — because one
  column cannot mean three things. A file mixing 256 Hz and 1 Hz writes both at eight places.
- One writer, not one per rate group. Separate buffers over one stream would reach the file
  in whatever order they happened to fill, which is not the order the rows were produced in.
- `--info` reports the long figures when `--layout long` is given, so the estimate always
  describes the command you typed. The estimate sweep now crosses every fixture with the
  long layout too: 308 predictions, rows exact and bytes never under.
- The cost is size. A long row repeats the time and the channel name on every sample, so the
  same recording runs two to three times larger. `--gzip` recovers most of it, since a
  repeated channel name is what compression is best at. An eight-hour recording converts
  under a 64 MB heap cap either way.

`--layout wide` is the default and unchanged.

## 0.4.78

### Fixed: `sleep-study.edf` was four different recordings across the site

The same filename appears on the landing page, in getting-started, in cli-reference and in
edf-format, and each showed `--info` output for a different file: 28800 records of EDF+ at
100/10/1 Hz, three records of plain EDF at 256/128/1 Hz, 29550 records at 25.1 MB, and three
records carrying a real patient identifier. A reader working through the pages in order was
told the name meant something different each time.

Worse than untidy in one place: getting-started showed a three-second recording, then said
"on a long recording, `--info` tells you four things before you spend any disk", then told
the reader to run `--start 30m --duration 5m` on it — a window that file does not have.

The two channel-table blocks are regenerated from the recording 0.4.77 made reproducible, so
they are that file's real output. The identification-fields example in edf-format is a
different recording and now has a different name, `telemetry-psg.edf`, with a line saying
why: it carries the EDF+ specification's own example patient header, and `sleep-study.edf`
is anonymised, so it cannot demonstrate what that section is about.

The test from 0.4.77 now checks every page: any block that opens with `File       sleep-study.edf`
must match what the tool prints for that recording.

## 0.4.77

### Fixed: the landing page showed an annotations.csv the recording could not produce

The page says every terminal block and CSV sample on it is real output from one synthetic
sleep recording, and the recipe for that recording lived in a comment. Which made the claim
unfalsifiable in practice: checking it meant rebuilding a 19 MB file by hand from prose. The
page drifted twice anyway — a row figure in 0.4.67, a `UTC` suffix in 0.4.68 — and this
found a third. Its `annotations.csv` sample shows `Sleep stage W` at onset 0. The recording
had an annotation channel with no events in it at all, so the real file is a header row and
nothing else.

The recipe is a module now, `test/fixtures/sleep-study.mjs`, and the recording carries the
sleep staging a sleep study carries. A test rebuilds it, runs `--info`, and compares the
output against the page character for character; then converts two seconds of it and checks
each CSV sample really is how that file starts. Samples that are abridged say so with an
ellipsis and are left alone — which the `metadata.json` sample did not, while showing
`"version": "0.1.0"`. It is now visibly an extract.

## 0.4.76

### Added: the API reference's examples are run, not just displayed

Every `js` block on the page is now extracted, pointed at a real recording, and executed.
Only paths and the package specifier are rewritten; the code is otherwise exactly what the
page shows, and each block runs against the first fixture that carries every channel it
names. A rename, a moved option, a return shape that changed — the kind of drift that leaves
a page looking perfectly fine — now fails a test instead.

The `parseTimeSpec` example is checked differently, because running it proves nothing: it
asserts its results in comments rather than printing them. Those four claimed values are
parsed out of the page and compared against what the function returns.

Both were confirmed capable of failing before being kept — one by renaming an import on the
page, the other by changing a claimed `0.25` to `0.5`.

## 0.4.75

### Fixed: the buffer-reuse warning described something the obvious test disproves

api.md calls the reused batch buffer "the one contract in the API that fails silently if you
get it wrong", and then described it as "kept[0], kept[1] and kept[2] are all identical, and
all hold the last batch read." Neither half survives being checked. `kept[0] === kept[1]` is
false — each iteration hands out its own `Uint8Array` — so a reader who tests the warning
the obvious way is told it does not apply and keeps the references. And they do not all hold
the last batch: the final batch is usually short, so an early view shows the last batch's
bytes for as far as they go and the *previous* batch's beyond that. A seam between two
batches, which produces plausible numbers rather than an error.

The section now says what is actually shared — distinct views, one buffer, all at offset
zero — and what a stale view holds afterwards. A test reads a fixture in batches with a
short tail and asserts all of it, so the description and the reader cannot drift apart.

Also corrects `decimalsForSignal`'s documented default, which 0.4.74 moved from 20 to 100
and this page still gave as 20.

## 0.4.74

### Fixed: the decimal ceiling was 20 on a false premise, and cost a magnetometer 69% of its codes

Decimals are derived per channel as `ceil(-log10(step)) + 2`, which is meant to guarantee
what output-files.md states outright: no two distinct digital codes round to the same text.
The result was clamped to 20, and the comment beside the clamp explained that 20 was the
most `toFixed` will accept. It is not. `toFixed` accepts 100; 101 is a `RangeError`.

The gap was not academic, and it landed on the exact channel type the comment named as the
reason for the ceiling. A magnetometer spanning ±1e-16 T over a 16-bit converter steps by
3.05e-21 and needs 23 places. At 20 every value landed on a 1e-20 grid — about three digital
codes to a printed value — so 69% of the samples could not be recovered by the arithmetic
the FAQ gives for recovering them. The conversion exited 0 and printed no warning.

The ceiling is now 100. Reaching it takes a step below 1e-98, which an 8-character physical
bound can still express (`1e-99` is five characters), and a channel that does now raises
`VALUE_RESOLUTION` rather than losing precision in silence — the same failure
`TIME_RESOLUTION` reports one column over, and reported the same way: every sample is
written, in order, and the physical values are computed at full precision either way.

The round-trip sweep did not catch this because its physical pairs bottomed out at ±0.0001,
a finest step of about 3e-9, nowhere near a clamped channel. It now includes a
magnetometer's range and runs 13,440 cells over 840 calibrations. Against the old ceiling it
fails, which is what makes it worth having.

Ordinary channels are untouched: ±250 µV over 12 bits still gets 3, a ±5 mV ECG still gets
5. `--decimals` still accepts 0 to 20, which is a bound on a number a person picks by hand
rather than a bound on what the format can express.

## 0.4.73

### Fixed: `--info --annotations-only --gzip` named files the run would not write

It said "Would write annotations.csv and channels.csv"; the run wrote `annotations.csv.gz`
and `channels.csv.gz`. Those two sentences were string literals, and the gzip test below
them reads the group file names — of which there are none under `--annotations-only`, which
is what makes it that branch. So the same command was described one way by `--info` and
another by the summary of the run that followed it, and a script that opened the name it was
given got ENOENT.

The plan now records whether the output is compressed instead of that being inferred from
file names that may not exist, and both sentences take their suffix from it. `--info` is
read to find out what a run leaves behind; naming a file it will not create is the one thing
it must not do.

## 0.4.72

### Fixed: the correctness page stated a sweep size the sweep had outgrown

It said `npm run estimate` runs "192 predictions over 34 recordings". It runs 216 over 39.
The sweep's size is the fixture count crossed with its option sets, four fixtures had been
added since the number was written, and nothing connected the two — so the page drifted
silently, on the one page whose subject is not drifting.

The figures are corrected, and a test now recomputes them from the same constants the
harnesses use: the estimate sweep's recording count against the fixture directory, the
round-trip sweep's calibrations and cells against the three arrays it crosses. Adding a
fixture or a sweep dimension now fails a test instead of quietly making the page wrong.

## 0.4.71

### Added: `--bom`, for the one reader that needs it

Excel on Windows opens a CSV with no byte order mark in the system code page rather than
UTF-8, so anything outside ASCII arrives wrong. `µV` is the common case — EDF headers are
Latin-1 in practice and exporters write the micro sign as the single byte `B5`, which UTF-8
stores as two, and Excel renders as `Âµ`. Annotation text in French, German or Japanese goes
the same way.

`--bom` starts each CSV with `EF BB BF`, which tells Excel the file is UTF-8. It covers
`signals.csv`, `channels.csv` and `annotations.csv`, and their `.csv.gz` forms — the mark
goes inside the compressed stream. `metadata.json` never gets one: `JSON.parse` rejects a
leading U+FEFF, so a mark there would break every reader of the file to help a program that
will not open it anyway.

Off by default, because the mark is not invisible to everything. pandas strips it either
engine, checked against 3.0.5. Python's own `csv` module over a plain `open()` does not, and
neither does `fs.readFileSync(path, 'utf8')` — the first column name comes back as
`\ufefftime_s` and a lookup of `time_s` misses. Readers that want it gone ask for
`utf-8-sig`. So: `--bom` when the destination is Excel, plain when it is a script.

The estimate counts the three bytes, since it promises never to read under what gets
written. A new fixture, `latin1-labels.edf`, carries `µV` and an accented label written the
way an exporter writes them, and the estimate harness now runs 216 predictions over 39
recordings.

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
