---
title: How correctness is verified
description: What edf2csv checks, how it is compared against pyEDFlib, why the conversion formula is arranged the way it is, and what is not claimed
order: 7
---

## Eight separate claims

Correctness here covers eight different things, verified eight different ways. The list grew
past the "three" this section used to promise as the batch, fuzz and estimate harnesses were
added, and the heading did not keep up until 0.4.34.

1. **The arithmetic is right.** The physical values edf2csv computes match the values a reference implementation computes, to the last bit. Checked against [pyEDFlib](https://github.com/holgern/pyedflib) by `npm run crossvalidate`, which dumps the doubles from 75 generated recordings and compares the 64 bits of each against pyEDFlib's: **16,943 values and 120 annotations, all in agreement**.
2. **The parser reads the format correctly, including the parts real files get wrong.** Checked against generated EDF and BDF files whose byte layout and expected contents are written out in code, so the expected answer is known independently of the code under test.
3. **A batch converts each recording exactly as converting it alone would.** Random folder trees are converted serially and in parallel, and both must produce the same directories with the same bytes. Checked by `npm run fuzz:batch`.
4. **A damaged file is reported, never a crash.** Real recordings are corrupted byte by byte and converted; every one must exit 0, 1 or 2 with something to say, and never a stack trace. Checked by `npm run fuzz`: **1,200 runs over 300 corrupted recordings, all reported cleanly** at the default seed, and more on request (`npm run fuzz -- 42 2000`).
5. **`--info` predicts what a conversion writes.** The row count is exact and the byte count never reads low, across every fixture crossed with every option combination. Checked by `npm run estimate`: **376 predictions over 50 recordings**, sizes reading 16% high on average, which is the direction a size estimate has to err in.
6. **The digital codes can be recovered from the CSV.** The documentation says the written decimals are always fine enough to get the original integer back, and offers the arithmetic for doing it. Checked by `npm run roundtrip`: **13,440 cells over 840 calibrations**, EDF and BDF, every one recovering the code the file holds.
7. **The two layouts hold the same samples.** `--layout long` is a different shape, not different data, which is what makes it an honest answer to a mixed-rate recording. Checked by `npm run layouts`: **50 recordings crossed with six option sets**, converted both ways, compared per channel as an ordered sequence of value cells — every sequence identical.
8. **The executable behaves as documented.** Exit codes, what goes to stdout versus stderr, refusing to overwrite, failing on a mistyped channel name. Checked by running the built CLI as a subprocess.

The second and eighth are what `npm test` runs; the third through seventh are the fuzz, estimate, round-trip and layout commands. The first needs pyEDFlib, so it is a separate command — the package itself has no dependencies and `npm test` keeps it that way:

```bash
pip install pyedflib
npm run crossvalidate
```

```
Compared 16,943 sample values bit for bit, and 120 annotations, across 75 recordings.
Every value agreed.
```

Without pyEDFlib installed it says so and exits 0 rather than pretending to have checked anything.

A quarter of the recordings are BDF rather than EDF, where a sample is three bytes instead of two. The 24-bit path is where a reader is most likely to be quietly wrong: the sign has to be extended by hand, and a value that comes out unsigned is not obviously wrong to look at — it is a large positive number where a large negative one belongs. Half of them carry EDF+ or BDF+ events, so the annotation reader is compared too, including an event with no duration and one whose duration is zero. On that one point the two disagree by design: pyEDFlib reports a missing duration as `-1.0`, edf2csv leaves the cell empty, on the grounds that a duration nobody recorded is not a duration of minus one second.

The recordings it generates are not the test fixtures. Those target the things real files get wrong, and pyEDFlib refuses several of them outright — a truncated file, a header whose digital range is a single point. What this needs is the opposite: ordinary well-formed recordings across a wide spread of calibrations, with digital spans from `-1..1` to `-32768..32767` and physical spans from `0.0001` to `99999`, giving gains from about 1e-9 to about 1e5. Both endpoints of the digital range appear in every recording, since `digitalMin` and `digitalMax` are the two points the header actually calibrates and where a mapping derived slightly differently disagrees most.

The comparison does not go through the CSV at all. Both sides dump their doubles and the 64 bits are compared, so what is being compared is two computations of a value rather than one of them against its printed form. Reading a printed cell back cannot be exact whatever precision it was printed at — a cell is a rounded rendering, so parsing it gives the nearest double to those digits rather than the double that was computed. Until 0.4.32 this ran at `--decimals 20` and did exactly that, which is described below; this paragraph described it too, for twenty versions after it stopped being true.

To confirm the check can fail, put a one-part-in-a-million error into the gain and rerun it:

```
x018.edf signals.csv "sig18" sample 0: pyEDFlib -249.99999999999997, edf2csv -250.000251
```

Shifting every annotation onset by a millisecond does the same for the event half:

```
x010.edf annotation 0: onset 0.25 vs 0.251
```

Either exits 1.

## Batches

```bash
npm run fuzz:batch              # 12 folder trees, the default seed
npm run fuzz:batch -- 42 40     # a different seed, more trees
```

```
12 folder trees, 49 recordings, 49 conversions (seed 1).
Serial and parallel agreed, and every batch matched converting alone.
```

Converting a folder is the hardest part of this tool to reason about: the tree is walked, links are followed, destinations are derived from file names, and the conversions may run in any order across several processes. Rather than guess which arrangement breaks, this builds arrangements — nesting, names with spaces and non-ASCII characters, mixed-case extensions, symlinks, files that are not recordings — and checks four things that must hold whatever shape comes out:

1. **Serial and parallel produce the same directories.** A difference between them is what a race looks like from outside.
2. **Each recording's output equals converting it alone.** A batch may reorder the work; it may not change a byte of it.
3. **The closing count matches the directories produced**, so "Converted 5 of 5" is a fact.
4. **A non-zero exit comes with a message**, never a silent half-conversion.

The first of those is how the collision fixed in 0.4.14 was found: one run produced `<out>/rec`, another `<out>/rec/inner`, from the same command over the same files. Putting that bug back makes this fail in two independent rounds and exit 1.

## The two layouts

```bash
npm run layouts
```

```
275 conversions compared over 50 recordings (595 channel sequences, 25 refused by both).
Both layouts hold the same samples, in the same order, per channel.
```

The conversion and channel-sequence counts move with the fixture set and with which windows a given recording can honour, which is why the claim above is stated as the sweep's shape rather than as a total. The recording count between them is the fixture set itself, so it is the same number claim 7 states and the same one the estimate and batch sweeps report; a test holds the three to it. What must not move is the last line.

`--layout long` writes one table of `time_s,channel,value` where the default writes a column per channel and a file per rate. Every page describing it says the same thing: a different shape, not different data. That is the claim, and until 0.5.16 nothing ran it — during which the long layout shipped four defects, three of them found by reading rather than by running.

Each fixture is converted both ways, crossed with option sets that move the window and the precision, and compared per channel: the column read down its rows in the wide table against the rows for that channel in the long one, as an ordered sequence of value cells.

Deliberately not joined on time. The two layouts write `time_s` at different precisions by design — the long one shares the finest any rate needs, since one column cannot mean three things — so a time-keyed comparison compares the formatting rather than the data, and at nine decimal places it collapses distinct sub-nanosecond samples into one key. The first version of this harness did exactly that and reported 42 disagreements that were all its own.

It is confirmed capable of failing: making the long layout skip one sample per record is caught on the first recording, as a channel with 8 values in one layout and 6 in the other.

## Damaged files

```bash
npm run fuzz              # 300 recordings, the default seed
npm run fuzz -- 99 800    # a different seed, more of them
```

```
1200 runs over 300 corrupted recordings (seed 1).
Every one exited cleanly with something to say.
```

A header is thirty-odd fields parsed out of bytes, and the ways one can be wrong are not a list anybody can write down. A test asserts the cases its author thought of, which are the cases the code already handles. Mutating real recordings asks a different question — is there *any* arrangement of bytes that gets past the checks — and it has the advantage of not sharing the author's assumptions.

Damage is weighted toward the first kilobyte, where the fixed header and the start of the signal headers live, because that is where one byte changes the meaning of everything after it. A corrupted sample is only a different number; a corrupted sample count is a promise about the file's shape that the file no longer keeps. Each file is run four ways: `--info`, `--info --json`, a conversion, and a conversion with `--gzip`, which puts a compressor between the writer and the file and has its own failure routes.

Runs are deterministic, so a crash found on one machine reproduces on another.

It was confirmed capable of failing before being trusted: made to return an exit code outside 0, 1 and 2, it names the recording, the arguments and the message, and exits 1.

Below is how to reproduce the pyEDFlib comparison on your own recordings.

## The cross-check against pyEDFlib

pyEDFlib is the Python binding around EDFlib, the C library written by the author of the EDF+ specification. EDFbrowser uses the same library. It's the closest thing this format has to a reference implementation.

On the 75 generated recordings this ships with, 16,943 sample values came out of edf2csv and out of pyEDFlib bit-for-bit identical, along with 120 annotations. Run `npm run crossvalidate` to reproduce it.

### What bit-for-bit means

Both tools produce IEEE 754 double-precision floats. Bit-for-bit identical means the 64 bits are the same 64 bits: not equal to within a tolerance, not `numpy.allclose`, not agreeing to twelve decimal places. Zero differing bits, across every sample compared.

The distinction is practical. A tolerance-based check has to pick a tolerance, and any tolerance loose enough to pass hides every bug smaller than itself. If a future change to the reading path swaps two bytes, sign-extends a 24-bit sample incorrectly, or reorders the arithmetic, an exact comparison fails immediately.

Until 0.4.32 this page described that method and `npm run crossvalidate` did not use it. The checker converted with `--decimals 20` and parsed the cells back, which cannot be exact whatever the tolerance — a cell is a rounded decimal rendering, so reading it gives the nearest double to the printed digits rather than the double that was computed. It then accepted anything within `abs(reference) * 1e-9` and skipped empty cells without counting them. The checker now runs the dumper below and compares the 64 bits, and it is confirmed capable of failing: flipping the lowest mantissa bit of every scaled value is caught on the first sample of every recording, including cases the decimal rendering cannot show — `-1.0` against `-1.0000000000000002`, which the old tolerance passed without comment.

Exact agreement is only possible because edf2csv performs the calibration in the same order EDFlib does, which is the subject of the next section.

### Running the comparison yourself

The comparison has to happen on doubles, not on CSV text, because CSV is rounded on the way out. Dump the doubles from edf2csv with the programmatic API, then read the same channel with pyEDFlib and compare bit patterns.

Save this as `dump-doubles.mjs`:

```js
// Dump one channel's physical values as raw float64, for comparison with pyEDFlib.
import { writeFileSync } from 'node:fs';
import { EdfFile, makeScaler } from 'edf2csv';

const [input, channelIndex, output] = process.argv.slice(2);
const file = await EdfFile.open(input);
const signal = file.dataSignals[Number(channelIndex)];
const scale = makeScaler(signal);

const values = [];
for await (const batch of file.readRecords()) {
  for (let r = 0; r < batch.recordCount; r++) {
    for (let i = 0; i < signal.samplesPerRecord; i++) {
      values.push(scale(file.sampleAt(batch, r, signal, i)));
    }
  }
}
await file.close();

writeFileSync(output, Buffer.from(Float64Array.from(values).buffer));
console.log(`${values.length} samples from "${signal.label}" -> ${output}`);
```

Run it on channel 0:

```bash
npm install edf2csv
node dump-doubles.mjs recording.edf 0 channel0.f64
```

Then compare in Python:

```python
import numpy as np
import pyedflib

f = pyedflib.EdfReader("recording.edf")
try:
    reference = f.readSignal(0)   # float64, physical units
finally:
    f.close()

ours = np.fromfile("channel0.f64", dtype=np.float64)

assert ours.shape == reference.shape, (ours.shape, reference.shape)
same = ours.view(np.uint64) == reference.view(np.uint64)
print(f"{same.sum()} of {same.size} values bit-for-bit identical")
print("first difference:", None if same.all() else int(np.argmax(~same)))
```

Comparing the `uint64` view rather than the floats is deliberate: it's a comparison that approximate agreement can't satisfy.

The checked-in version of this dumper is `test/crossvalidate/dump-doubles.mjs`, which does every channel at once and is what `npm run crossvalidate` runs, so the method printed here and the one that executes are the same code.

Two caveats. This comparison isn't part of `npm test`, because it needs a Python environment. And pyEDFlib refuses EDF+D files outright, so a discontinuous recording can't be cross-checked this way at all. For those files the check is against the generated fixtures, where the expected sample values are known by construction.

## The conversion formula and its arrangement

EDF stores samples as integers. Each channel's header gives two calibration points — digital minimum to physical minimum, and digital maximum to physical maximum — and the physical value is the straight line through them. The specification writes it like this:

```
gain     = (physicalMax - physicalMin) / (digitalMax - digitalMin)
physical = (digital - digitalMin) * gain + physicalMin
```

edf2csv evaluates the algebraically identical rearrangement EDFlib uses:

```
offset   = physicalMax / gain - digitalMax
physical = gain * (offset + digital)
```

The two forms are algebraically identical but not numerically identical. Floating-point addition and multiplication aren't associative, so the two forms take different paths to the same real number.

### What the two forms do differently

Take a channel calibrated at plus or minus 800 uV stored over the digital range -2048 to 2047, the ordinary 12-bit case that appears in many public EEG datasets. The digital span is 4095, so the gain is 1600/4095 and the exact physical value for digital 0 is 800/4095.

The specification's literal ordering computes `(0 - (-2048)) * gain` first. That intermediate is `800.1953601953602`, a number near 800. It then subtracts `physicalMin`, which is -800, leaving a result near 0.195. Subtracting two numbers of similar magnitude to get a small one is catastrophic cancellation: the absolute error carried by the large intermediate, invisible at a magnitude of 800, ends up in the low digits of a result whose magnitude is 0.195.

EDFlib's ordering computes `offset` once at setup. Here it works out to exactly `0.5`, and `0.5 + digital` is a small number a double represents exactly. There's then a single multiplication — one inexact operation in the whole computation rather than three, and no cancellation.

| | Value at digital 0 |
| --- | --- |
| Exact value, 800/4095 | `0.19536019536019536` |
| `gain * (offset + digital)` | `0.19536019536019536` |
| `(digital - digitalMin) * gain + physicalMin` | `0.19536019536019467` |

One arrangement returns the correctly rounded value and the other doesn't.

### Across the whole digital range

Digital 0 isn't a cherry-picked worst case. Save this as `rounding.mjs` and run it with `node rounding.mjs`:

```js
// A +/-800 uV channel stored over the digital range -2048..2047.
const physMin = -800, physMax = 800, digMin = -2048, digMax = 2047;

const gain = (physMax - physMin) / (digMax - digMin);
const offset = physMax / gain - digMax;

const specLiteral = (d) => (d - digMin) * gain + physMin;
const edf2csvForm = (d) => gain * (offset + d);

// The exact value for digital d is (2d + 1) * 800 / 4095, computed here in
// arbitrary precision and then rounded once to the nearest double.
const exact = (d) => {
  const bits = 300n;
  const n = BigInt(2 * d + 1) * 800n;
  const sign = n < 0n ? -1 : 1;
  const scaled = ((n < 0n ? -n : n) << bits) / 4095n;
  return sign * (Number(scaled) / 2 ** Number(bits));
};

let specWrong = 0, oursWrong = 0;
for (let d = digMin; d <= digMax; d++) {
  if (specLiteral(d) !== exact(d)) specWrong++;
  if (edf2csvForm(d) !== exact(d)) oursWrong++;
}

console.log('digital 0, exact       ', exact(0));
console.log('digital 0, edf2csv     ', edf2csvForm(0));
console.log('digital 0, spec-literal', specLiteral(0));
console.log('intermediate, edf2csv     ', offset + 0);
console.log('intermediate, spec-literal', (0 - digMin) * gain);
console.log(`codes not correctly rounded: spec-literal ${specWrong}, edf2csv ${oursWrong}, of 4096`);
```

```
digital 0, exact        0.19536019536019536
digital 0, edf2csv      0.19536019536019536
digital 0, spec-literal 0.19536019536019467
intermediate, edf2csv      0.5
intermediate, spec-literal 800.1953601953602
codes not correctly rounded: spec-literal 2077, edf2csv 20, of 4096
```

Of the 4096 possible digital codes on this channel, the specification's literal ordering returns something other than the correctly rounded value for 2077 of them, and at worst it's 32 units in the last place away. The arrangement edf2csv uses is exact for 4076 codes and never more than one unit in the last place away.

The remaining 20 come from the gain itself. `gain` is the result of a division and is already rounded to a double before any sample is converted, so the computed result is the correctly rounded product of an already-rounded gain, which permits a final error of one unit in the last place and no more. Removing it would mean carrying the gain in higher precision, which no reader of this format does, and which would break exact agreement with every other tool.

### Where this does and doesn't show up

On an ordinary microvolt channel you won't see the difference in a CSV.

edf2csv chooses each channel's decimal precision from its quantization step, so no two adjacent digital codes can round to the same text. For a plus or minus 800 uV channel the step is 0.39 uV and the precision works out to three decimals, which prints `0.195` either way. Forcing the maximum `--decimals` accepts, 20, is where the two forms part company: edf2csv prints `0.19536019536019536003` and the specification's literal ordering prints `0.19536019536019466614`, first differing at the fifteenth decimal. That is the difference this section is about, and three decimals is why an ordinary conversion never shows it.

It matters for four reasons:

- **It's what makes exact comparison possible.** Bit-identity with pyEDFlib is a property you either have or don't. Accepting a 32-unit error means the strongest available check degrades to a tolerance check, and a tolerance check can't tell a rounding difference from a genuine bug.
- **The doubles are visible through the API.** `makeScaler` returns the value, not a formatted string, so anything built on the programmatic API gets the full double.
- **Not every channel is in microvolts.** A channel calibrated in volts has a quantization step near 1e-7 and gets many more decimal places; a magnetometer in tesla more again, which is why the derived precision runs to 100 — the most `toFixed` will print. The further right the printed digits go, the closer the discrepancy gets to visible.
- **It's free.** The better arrangement is one line, evaluated once per channel.

### The cases where the formula doesn't apply

Real headers are sometimes self-contradictory. In each case the code does something defined rather than producing `NaN` or `Infinity` and letting it flow into the CSV.

| Header condition | Behaviour |
| --- | --- |
| `digitalMin` equals `digitalMax` | The mapping is undefined, so the scaler yields `NaN` and those cells are written empty rather than filled with a stand-in number. A `DEGENERATE_DIGITAL_RANGE` warning is raised. |
| Gain is zero | Every sample legitimately converts to the same value, so that value is written. |
| Gain is not finite | The physical span overflowed a double, so there is no mapping at all: the cells are left empty and `UNUSABLE_PHYSICAL_RANGE` is raised. |
| The derived offset overflows to non-finite | Only possible for an absurd calibration. The code falls back to the specification's literal ordering, which is less accurate but finite. |
| `physicalMin` above `physicalMax` | Converted exactly as the header specifies, polarity inversion included, with an `INVERTED_PHYSICAL_RANGE` warning. Correcting the header would mean guessing about the recording. |

The first and last of these have fixtures and tests of their own, listed below.

## Streaming doesn't change the numbers

Conversion is streamed: data records are read in batches sized by a byte budget, so a 4 GB file and a 4 MB file use the same working set. A 40 MB EDF producing a 159 MB CSV converts in about 1.4 seconds with the Node heap capped at 48 MB.

Buffered reading is a common source of silent corruption, because a sample can straddle a chunk boundary. The suite tests this directly by reading the same file twice, once with a one-byte read budget and once with a one-megabyte budget, and asserting the two sample sequences are deeply equal. A one-byte budget puts a boundary between essentially every pair of bytes in the file, so if record boundary handling depended on buffering at all, that test couldn't pass.

## The fixtures and what each one covers

The fixtures are EDF and BDF files built by `test/fixtures/generate.mjs`, using a small purpose-built writer in `test/fixtures/edf-writer.mjs`. Each one pins down one thing that real recordings do and that a straightforward reader gets wrong.

Most fixtures use a generator where the digital value equals the sample's global index, so the expected output can be stated by hand rather than derived from the code being tested.

| Fixture | What it contains | What it pins down |
| --- | --- | --- |
| `tiny.edf` | 2 channels at 10 Hz, 2 records, one in uV and one in mV | The baseline. Every value is checkable by hand. Its start date of `05.06.09` also pins the two-digit year rule: 2009, not 1909. |
| `mixed-rates.edf` | EEG at 256 Hz, ECG at 128 Hz, temperature at 1 Hz, 3 records | Rate grouping. Three seconds gives 768, 384 and 3 rows in three files. The slow channel keeps its three genuine readings. |
| `annotations.edf` | EDF+C with three events: one with a duration, one without, one starting mid-record | TAL decoding, and that a missing duration stays empty rather than becoming zero. |
| `discontinuous.edf` | EDF+D whose records sit at 0 s, 1 s and 10 s | The nine-second gap survives as a jump in `time_s`, record start times are recovered from the annotation channel, and the timekeeping TAL isn't mistaken for an event. |
| `annotations-front-loaded.edf` | 10 records, but every event crammed into record 0 with onsets at 0.5 s, 5.5 s and 8.5 s | Nothing in the specification obliges a writer to store an event in the record its onset falls in. A time window has to find the event by onset, not by which record holds its bytes. |
| `annotations-only.edf` | EDF+C with an annotations channel and no signal channels at all | A file that converts to events and nothing else, raising `NO_SIGNAL_CHANNELS`. |
| `truncated.edf` | Header declares 10 records, only 4 were written | The file is trusted over its own header. Four records are converted and `RECORD_COUNT_MISMATCH` is raised. |
| `unknown-records.edf` | Declared record count of -1, 4 records present | The specification permits -1 for a recording still in progress. `RECORD_COUNT_UNKNOWN` is raised and the real count is used. |
| `fractional-recdur.edf` | 25 samples per 0.1 s record | A rate of 250 Hz derived from a fractional record duration, rather than assuming one-second records. |
| `quirky-labels.edf` | Two channels sharing the label `T8-P8`, a channel labelled `-`, and a channel with physical minimum above maximum | Duplicate labels get suffixed with the signal number, an odd but unique label is left alone, and an inverted range is honoured rather than corrected. Its plus or minus 800 uV calibration is the one used in the rounding test above. |
| `rate-slug-collision.edf` | Two channels whose sampling rates both round to `0hz` in a filename, over an eleven-day record duration | Distinct rates get distinct files. Sharing a name meant two write streams on one path, interleaving both channels' rows under a header naming one of them. |
| `degenerate-range.edf` | Three channels: one with digital minimum equal to digital maximum, one with physical minimum equal to physical maximum, and one ordinary | The two degenerate cases must not be treated alike. The undefined mapping writes empty cells and a warning, never `NaN` as text or a stand-in number; the flat-but-defined mapping still writes its constant value; the ordinary channel is untouched by either. |
| `biosemi.bdf` | 24-bit BDF, including sample values no 16-bit field could hold | Three-byte samples, record sizing at three bytes per sample, and correct sign extension of negative 24-bit values. |
| `biosemi-plus.bdf` | BDF+D, whose markers are spelled `BDF+D` and `BDF Annotations` | BioSemi's spelling of the EDF+ markers is recognised and normalised, and gaps and events are recovered from a discontinuous BDF file. |

The suite also opens files that aren't EDF at all, and a path that doesn't exist, and asserts that both fail with a typed error and a readable message rather than a raw errno or a stack trace.

## Why the fixtures are generated rather than committed

`test/fixtures/generated/` is in `.gitignore`. The files are built fresh by `npm run fixtures`, which `npm test` runs for you. There are four reasons.

**Every edge case is legible.** What makes `truncated.edf` truncated is a line reading `truncateRecords: 4` next to a header that declares 10. With a committed binary you'd have to reverse-engineer the file to learn what it was testing.

**They can be changed.** Adjusting an edge case means editing a number and rerunning. With committed binaries, the test suite ends up shaped by whichever files someone happened to have rather than by which cases matter.

**Real recordings carry patient identification in the header.** EDF's header has dedicated fields for patient identification and recording identification. A fixture taken from a real study puts whatever those fields contain into a public git history permanently. Generated fixtures have synthetic headers, and the one file that needs a realistically formatted EDF+ patient line uses the example from the specification document rather than a real one.

**The repository stays small and text-only.** The whole fixture set regenerates in well under a second, and the generator is deterministic: the sample generators are a ramp and a sine, with no randomness and no timestamps, so regenerating produces byte-identical files. You can verify that:

```bash
npm run fixtures
shasum -a 256 test/fixtures/generated/* > before.txt
npm run fixtures
shasum -a 256 test/fixtures/generated/* > after.txt
diff before.txt after.txt && echo "byte identical"
```

The same `.gitignore` also reserves `test/fixtures/downloaded/` for large real recordings pulled on demand for the cross-check work. Those are never committed either.

## Running the suite yourself

You need Node 20 or newer, and nothing else. The package has no dependencies, and the only development dependencies are TypeScript and the Node type definitions.

```bash
git clone https://github.com/tayal-sarthak/edf2csv.git
cd edf2csv
npm install
npm test
```

`npm test` compiles the TypeScript, regenerates the fixtures, and runs the six test files with Node's built-in test runner. There's no test framework to install and no configuration file to read. It takes about twenty seconds on a laptop, almost all of it in three places: `cli.test.js` spawns the built binary as a subprocess for every case and interrupts a thirty-file batch to watch it stop, `large.test.js` builds and reads multi-gigabyte recordings, and `stdout-audit.test.js` creates and mounts a small disk image to fill it up. The rest — the parser, the conversion planning, the CSV contents, the documentation checks — runs in about a second between them:

```
ℹ tests 316
ℹ suites 53
ℹ pass 316
ℹ fail 0
```

The 316 tests are split across six files by what they exercise:

| File | Tests | What it covers |
| --- | --- | --- |
| `test/edf.test.js` | 43 | Header parsing, diagnostics, digital-to-physical conversion, chunked reading, BDF, EDF+ annotation decoding |
| `test/convert.test.js` | 92 | Time specifications, option checking, column naming, channel selection, rate grouping, and the contents of the written CSV files |
| `test/cli.test.js` | 139 | The built executable: exit codes, stdout versus stderr, overwrite refusal, unwritable destinations, invocation through a symlink as `npx` does |
| `test/docs.test.js` | 29 | That this documentation and the source agree on their lists of codes, flags and exit codes |
| `test/stdout-audit.test.js` | 7 | A destination that fills up, for `--stdout` and for `--out`, which needs a filesystem of a known small size and so is kept apart |
| `test/large.test.js` | 6 | Recordings of a few gigabytes, built sparse, kept apart for the same reason |

To run one file, build and generate first, then point the runner at it:

```bash
npm run build && npm run fixtures
node --test test/edf.test.js
```

To run a single group of tests, filter by name:

```bash
node --test --test-name-pattern="conversion" test/edf.test.js
```

The CLI tests run the real built binary as a subprocess and inspect its exit code and streams, so they check the contract a script depends on rather than an internal function. That includes one easily broken case: `npx` invokes the tool through a symlink, and an entry-point check that compares the symlink path against the module's own resolved path would make the command exit 0 having done nothing. A test creates a symlink and asserts the tool actually runs.

## What is not verified

**edf2csv does no signal processing.** No filtering, no notch removal, no detrending, no re-referencing, no artifact rejection, no downsampling, no unit conversion, no interpolation. Microvolts stay microvolts. If your analysis needs a 0.5 Hz high pass, edf2csv won't apply one, and no test here says anything about how such a filter should behave.

**The correctness claim is about the conversion, not about the recording.** If a channel's header declares a calibration that doesn't match the amplifier that produced it, edf2csv converts it faithfully with the wrong calibration. It reports when the header is internally contradictory, and it prints the declared ranges in `--info` and `channels.csv` so you can check them, but it has no way to know what the hardware actually did.

**No claim is made about clinical fitness.** This isn't a medical device, it has no regulatory clearance of any kind, and it isn't validated for diagnosis, patient management or any clinical decision. It's MIT licensed, which means it's provided as is and without warranty. Read the license before using it anywhere that matters.

**The cross-check covers the recordings it covers.** EDF is an old and loosely followed format, and writers do surprising things. Bit identity was established on the recordings used for testing plus the generated fixtures. A file from a writer nobody in this project has seen may still be read in a way you disagree with. That's why the tool raises warnings, and why `--info` reads the header without converting anything.

**Timing is taken from the file.** Sample times are derived from the record duration in the header and, for EDF+D recordings, from the timestamps in the annotation channel. There's no correction for amplifier clock drift, and no attempt to reconcile the header's start time with any external clock.

**Nothing here verifies your pipeline.** A conversion that's bit-exact is still only the first step. `metadata.json` records the tool version, the source file, the time window converted and, with `--checksum`, a SHA-256 of the input, so a result can be traced back to the exact bytes it came from.
