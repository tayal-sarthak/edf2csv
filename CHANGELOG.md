# Changelog

Notable changes to edf2csv. Versions follow [semantic versioning](https://semver.org); while the
major version is 0, a minor bump may contain breaking changes.

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
