# Changelog

Notable changes to edf2csv. Versions follow [semantic versioning](https://semver.org); while the
major version is 0, a minor bump may contain breaking changes.

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
