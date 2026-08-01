---
title: How correctness is verified
description: What edf2csv checks, how it is checked against pyEDFlib, why the conversion formula is arranged the way it is, and what is not claimed
order: 7
---

## Three separate claims

Trusting a converter means trusting three different things, and they are verified in three different ways.

1. **The arithmetic is right.** The physical values edf2csv computes are the same values a reference implementation computes, to the last bit. This is checked against [pyEDFlib](https://github.com/holgern/pyedflib).
2. **The parser reads the format correctly, including the parts real files get wrong.** This is checked against generated EDF and BDF files whose byte layout and expected contents are written out in code, so the expected answer is known independently of the code under test.
3. **The executable behaves as documented.** Exit codes, what goes to stdout versus stderr, refusing to overwrite, failing loudly on a mistyped channel name. This is checked by running the built CLI as a subprocess.

The second and third are what `npm test` runs. The first is an external comparison against another tool, described below, along with how to reproduce it on your own recordings.

## The cross-check against pyEDFlib

pyEDFlib is the Python binding around EDFlib, the C library written by the author of the EDF+ specification. EDFbrowser uses the same library. It is the closest thing this format has to a reference implementation, which makes it the right thing to disagree with loudly if there is a disagreement at all.

On the recordings used for testing, 129,536 sample values came out of edf2csv and out of pyEDFlib bit-for-bit identical.

### What bit-for-bit actually means

Both tools produce IEEE 754 double-precision floats. Bit-for-bit identical means the 64 bits are the same 64 bits: not equal to within a tolerance, not `numpy.allclose`, not agreeing to twelve decimal places. Zero differing bits, across every sample compared.

This is a much stronger statement than "close", and the difference is not pedantry. A tolerance-based check has to pick a tolerance, and any tolerance loose enough to pass hides every bug smaller than itself. Exact equality has no such hiding place. If a future change to the reading path swaps two bytes, sign-extends a 24-bit sample incorrectly, or reorders the arithmetic, the comparison fails immediately rather than staying green until someone notices the numbers look slightly off.

Getting exact agreement is only possible because edf2csv performs the calibration in the same order EDFlib does. That is the subject of the next section, and it is the reason the arrangement of one line of arithmetic is worth several paragraphs.

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

Comparing the `uint64` view rather than the floats is deliberate. It is the comparison that cannot be satisfied by "nearly".

Two honest caveats. This comparison is not part of `npm test`, because it needs a Python environment and real recordings, and real recordings are not in the repository. And pyEDFlib refuses EDF+D files outright, so a discontinuous recording cannot be cross-checked this way at all: for those files the check is against the generated fixtures, where the expected sample values are known by construction.

## The conversion formula, and why its arrangement matters

EDF stores samples as integers. Each channel's header gives two calibration points, digital minimum to physical minimum and digital maximum to physical maximum, and the physical value is the straight line through them. The specification writes it like this:

```
gain     = (physicalMax - physicalMin) / (digitalMax - digitalMin)
physical = (digital - digitalMin) * gain + physicalMin
```

edf2csv evaluates the algebraically identical rearrangement EDFlib uses:

```
offset   = physicalMax / gain - digitalMax
physical = gain * (offset + digital)
```

Algebraically identical, numerically not. Floating point addition and multiplication are not associative, and the two forms take different paths to the same real number.

### What the two forms do differently

Take a channel calibrated at plus or minus 800 uV stored over the digital range -2048 to 2047, which is the ordinary 12-bit case and appears in many public EEG datasets. The digital span is 4095, so the gain is 1600/4095 and the exact physical value for digital 0 is 800/4095.

The specification's literal ordering computes `(0 - (-2048)) * gain` first. That intermediate is `800.1953601953602`, a number near 800. It then subtracts `physicalMin`, which is -800, leaving a result near 0.195. Subtracting two numbers of similar magnitude to get a small one is catastrophic cancellation: the absolute error carried by the large intermediate, invisible at a magnitude of 800, is now sitting in the low digits of a result whose magnitude is 0.195.

EDFlib's ordering computes `offset` once at setup. Here it works out to exactly `0.5`, and `0.5 + digital` is a small number that a double represents exactly. There is then a single multiplication. One inexact operation in the whole computation, not three, and no cancellation anywhere.

| | Value at digital 0 |
| --- | --- |
| Exact value, 800/4095 | `0.19536019536019536` |
| `gain * (offset + digital)` | `0.19536019536019536` |
| `(digital - digitalMin) * gain + physicalMin` | `0.19536019536019467` |

The last two digits are the whole story. One arrangement returns the correctly rounded value and the other does not.

### Across the whole digital range

Digital 0 is not a cherry-picked worst case. Save this as `rounding.mjs` and run it with `node rounding.mjs`:

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

Of the 4096 possible digital codes on this channel, the specification's literal ordering returns something other than the correctly rounded value for 2077 of them, and at worst it is 32 units in the last place away from the truth. The arrangement edf2csv uses is exact for 4076 codes and never more than one unit in the last place away.

Those remaining 20 are not a defect in the arrangement, and it is worth being precise about where they come from. `gain` is itself the result of a division and is already rounded to a double before any sample is converted. So the computed result is the correctly rounded product of an already-rounded gain, which permits a final error of one unit in the last place and no more. Removing that would mean carrying the gain in higher precision, which no reader of this format does, and which would break exact agreement with every other tool rather than improve it.

### Where this does and does not show up

Being straight about the practical size of this: on an ordinary microvolt channel you will never see the difference in a CSV.

edf2csv chooses each channel's decimal precision from its quantization step, so that no two adjacent digital codes can round to the same text. For a plus or minus 800 uV channel the step is 0.39 uV and the precision works out to three decimals, which prints `0.195` either way. Even forcing the maximum with `--decimals 15` prints `0.195360195360195` from both forms.

So why does it matter?

- **It is what makes exact comparison possible.** Bit-identity with pyEDFlib is a property you either have or you do not. Accepting a 32 unit error means the strongest available check degrades to a tolerance check, and a tolerance check cannot tell a rounding difference from a genuine bug.
- **The doubles are visible through the API.** `makeScaler` returns the value, not a formatted string. Anything built on the programmatic API gets the full double.
- **Not every channel is in microvolts.** A channel calibrated in volts has a quantization step near 1e-7 and gets many more decimal places, which is exactly why the precision cap is 15 rather than something tidier. The further right the printed digits go, the closer the discrepancy gets to visible.
- **It costs nothing.** The better arrangement is one line, evaluated once per channel. There is no reason to take the worse one.

### The cases where the formula does not apply

Real headers are sometimes self-contradictory, and the code says exactly what it does in each case rather than producing `NaN` or `Infinity` and letting it flow into the CSV.

| Header condition | Behaviour |
| --- | --- |
| `digitalMin` equals `digitalMax` | The mapping is undefined. Every sample is written as the physical minimum, and a `DEGENERATE_DIGITAL_RANGE` warning is raised so the channel is not quietly trusted. |
| Gain is zero or not finite | Every sample converts to the same value, so the physical minimum is written. |
| The derived offset overflows to non-finite | Only possible for an absurd calibration. The code falls back to the specification's literal ordering, which is less accurate but finite. |
| `physicalMin` above `physicalMax` | Converted exactly as the header specifies, polarity inversion included, with an `INVERTED_PHYSICAL_RANGE` warning. Silently "fixing" the header would be a guess about the recording. |

The first and last of these have fixtures and tests of their own, listed below.

## Streaming does not change the numbers

Conversion is streamed: data records are read in batches sized by a byte budget, so a 4 GB file and a 4 MB file use the same working set. A 40 MB EDF producing a 159 MB CSV converts in about 1.4 seconds with the Node heap capped at 48 MB.

Buffered reading is a classic source of silent corruption, because a sample can straddle a chunk boundary. The suite pins this directly by reading the same file twice, once with a one byte read budget and once with a one megabyte budget, and asserting the two sample sequences are deeply equal. A one byte budget puts a boundary between essentially every pair of bytes in the file. If record boundary handling depended on buffering at all, that test could not pass.

## The fixtures and what each one covers

The fixtures are EDF and BDF files built by `test/fixtures/generate.mjs`, using a small purpose-built writer in `test/fixtures/edf-writer.mjs`. Each one exists to pin down one thing that real recordings do and naive readers get wrong.

Most fixtures use a generator where the digital value equals the sample's global index, which means the expected output can be stated by hand rather than derived from the code being tested.

| Fixture | What it contains | What it pins down |
| --- | --- | --- |
| `tiny.edf` | 2 channels at 10 Hz, 2 records, one in uV and one in mV | The baseline. Every value is checkable by hand. Its start date of `05.06.09` also pins the two digit year rule: 2009, not 1909. |
| `mixed-rates.edf` | EEG at 256 Hz, ECG at 128 Hz, temperature at 1 Hz, 3 records | Rate grouping. Three seconds gives 768, 384 and 3 rows in three files. The slow channel keeps its three genuine readings. |
| `annotations.edf` | EDF+C with three events: one with a duration, one without, one starting mid-record | TAL decoding, and that a missing duration stays empty rather than becoming zero. |
| `discontinuous.edf` | EDF+D whose records sit at 0 s, 1 s and 10 s | The nine second gap survives as a jump in `time_s`, record start times are recovered from the annotation channel, and the timekeeping TAL is not mistaken for an event. |
| `annotations-front-loaded.edf` | 10 records, but every event crammed into record 0 with onsets at 0.5 s, 5.5 s and 8.5 s | Nothing in the specification obliges a writer to store an event in the record its onset falls in. A time window must find the event by onset, not by which record holds its bytes. |
| `annotations-only.edf` | EDF+C with an annotations channel and no signal channels at all | A file that converts to events and nothing else, raising `NO_SIGNAL_CHANNELS`. |
| `truncated.edf` | Header declares 10 records, only 4 were written | The file is trusted over its own header. Four records are converted and `RECORD_COUNT_MISMATCH` is raised. |
| `unknown-records.edf` | Declared record count of -1, 4 records present | The specification permits -1 for a recording still in progress. `RECORD_COUNT_UNKNOWN` is raised and the real count is used. |
| `fractional-recdur.edf` | 25 samples per 0.1 s record | A rate of 250 Hz derived from a fractional record duration, rather than assuming one second records. |
| `quirky-labels.edf` | Two channels sharing the label `T8-P8`, a channel labelled `-`, and a channel with physical minimum above maximum | Duplicate labels get suffixed with the signal number, an odd but unique label is left alone, and an inverted range is honoured rather than corrected. Its plus or minus 800 uV calibration is the one used in the rounding test above. |
| `degenerate-range.edf` | One channel with digital minimum equal to digital maximum, next to a normal one | The unscalable channel produces finite values and a warning, and does not contaminate the channel beside it. |
| `biosemi.bdf` | 24-bit BDF, including sample values no 16-bit field could hold | Three byte samples, record sizing at three bytes per sample, and correct sign extension of negative 24-bit values. |
| `biosemi-plus.bdf` | BDF+D, whose markers are spelled `BDF+D` and `BDF Annotations` | BioSemi's spelling of the EDF+ markers is recognised and normalised, and gaps and events are recovered from a discontinuous BDF file. |

The suite also opens files that are not EDF at all, and a path that does not exist, and asserts that both fail with a typed error and a readable message rather than a raw errno or a stack trace.

## Why the fixtures are generated rather than committed

`test/fixtures/generated/` is in `.gitignore`. The files are built fresh by `npm run fixtures`, which `npm test` runs for you. Four reasons.

**Every edge case is legible.** What makes `truncated.edf` truncated is a line reading `truncateRecords: 4` next to a header that declares 10. With a committed binary you would have to reverse engineer the file to learn what it was testing, and nobody does, so the fixture slowly stops meaning anything.

**They can be changed.** Adjusting an edge case is editing a number and rerunning. Committed binaries calcify: the test suite ends up shaped by whichever files someone happened to have, rather than by which cases matter.

**Real recordings carry patient identification in the header.** EDF's header has dedicated fields for patient identification and recording identification. A fixture taken from a real study puts whatever those fields contain into a public git history permanently, and git history is not something you can quietly clean up later. Generated fixtures have synthetic headers, and the one file that needs a realistically formatted EDF+ patient line uses the example from the specification document rather than a real one.

**The repository stays small and text-only.** The whole fixture set regenerates in well under a second, and the generator is deterministic: the sample generators are a ramp and a sine, with no randomness and no timestamps, so regenerating produces byte identical files. You can verify that yourself:

```bash
npm run fixtures
shasum -a 256 test/fixtures/generated/* > before.txt
npm run fixtures
shasum -a 256 test/fixtures/generated/* > after.txt
diff before.txt after.txt && echo "byte identical"
```

The same `.gitignore` also reserves `test/fixtures/downloaded/` for large real recordings pulled on demand for the cross-check work. Those are never committed either.

## Running the suite yourself

You need Node 20 or newer, and nothing else. There are no runtime dependencies and the only development dependencies are TypeScript and the Node type definitions.

```bash
git clone https://github.com/tayal-sarthak/edf2csv.git
cd edf2csv
npm install
npm test
```

`npm test` compiles the TypeScript, regenerates the fixtures, and runs the three test files with Node's built-in test runner. There is no test framework to install and no configuration file to read. It finishes in about a second on a laptop:

```
ℹ tests 79
ℹ suites 19
ℹ pass 79
ℹ fail 0
```

The 79 tests are split across three files by what they exercise:

| File | Tests | What it covers |
| --- | --- | --- |
| `test/edf.test.js` | 31 | Header parsing, diagnostics, digital to physical conversion, chunked reading, BDF, EDF+ annotation decoding |
| `test/convert.test.js` | 30 | Time specifications, column naming, channel selection, rate grouping, and the contents of the written CSV files |
| `test/cli.test.js` | 18 | The built executable: exit codes, stdout versus stderr, overwrite refusal, unwritable destinations, invocation through a symlink as `npx` does |

To run one file, build and generate first, then point the runner at it:

```bash
npm run build && npm run fixtures
node --test test/edf.test.js
```

To run a single group of tests, filter by name:

```bash
node --test --test-name-pattern="conversion" test/edf.test.js
```

The CLI tests run the real built binary as a subprocess and inspect its exit code and streams, so they check the contract a script depends on rather than an internal function that happens to be called by it. That includes an easily broken case worth knowing about: `npx` invokes the tool through a symlink, and an entry point check that compares the symlink path against the module's own resolved path would make the command exit 0 having done nothing at all. There is a test that creates a symlink and asserts the tool actually runs.

## What is not verified

An honest page has to be as clear about the boundary as about what is inside it.

**This is a converter, and it does no signal processing.** No filtering, no notch removal, no detrending, no re-referencing, no artifact rejection, no downsampling, no unit conversion, no interpolation. Microvolts stay microvolts. If your analysis needs a 0.5 Hz high pass, edf2csv will not apply one, and no test here says anything about how such a filter should behave.

**The correctness claim is about the conversion, not about the recording.** If a channel's header declares a calibration that does not match the amplifier that produced it, edf2csv will faithfully convert it with the wrong calibration. It will tell you when the header is internally contradictory, and it prints the declared ranges in `--info` and `channels.csv` so you can check them, but it has no way to know what the hardware actually did.

**No claim is made about clinical fitness.** This is not a medical device, it has no regulatory clearance of any kind, and it is not validated for diagnosis, patient management or any clinical decision. It is MIT licensed, which means it is provided as is and without warranty. Read the license before using it anywhere that matters.

**The cross-check covers the recordings it covers.** EDF is an old and loosely followed format, and writers do surprising things. Bit identity was established on the recordings used for testing plus the generated fixtures. A file from a writer nobody in this project has seen may still be read in a way you disagree with. That is precisely why the tool raises warnings instead of staying quiet, and why `--info` reads the header without converting anything: the first thing to do with an unfamiliar file is look at it.

**Timing is taken from the file.** Sample times are derived from the record duration in the header and, for EDF+D recordings, from the timestamps in the annotation channel. There is no correction for amplifier clock drift, and no attempt to reconcile the header's start time with any external clock.

**Nothing here verifies your pipeline.** A conversion that is bit-exact is still only the first step. `metadata.json` records the tool version, the source file, the time window converted and, with `--checksum`, a SHA-256 of the input, so that a result can be traced back to the exact bytes it came from. Whether the rest of the analysis is right is a separate question, and this tool cannot answer it.
