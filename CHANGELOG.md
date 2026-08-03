# Changelog

Notable changes to edf2csv. Versions follow [semantic versioning](https://semver.org); while the
major version is 0, a minor bump may contain breaking changes.

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
