---
title: Programmatic API
description: Read EDF headers, stream raw samples and run conversions from JavaScript or TypeScript, with the real signatures
order: 9
---

## What the package gives you

edf2csv is built as a command-line tool, but the parser and the converter underneath are exported so you can use them directly. Two entry points cover almost everything:

- `EdfFile.open(path)` opens a recording, gives you its header and diagnostics, and lets you stream raw samples without producing a CSV at all.
- `convert(path, options)` runs the same conversion the CLI runs, into a directory you choose, and hands back what was written along with every warning raised.

Everything else in the API is a supporting part of those two: the scaling function that turns digital codes into physical units, the annotation decoder, the planner that decides which channels go into which file.

The package is ESM only and needs Node 20 or newer. There's no CommonJS build. `require("edf2csv")` nevertheless works on any Node that can require an ESM graph — verified on 22.16 and 24.4 — because nothing here has top-level `await`. It fails on the older Node 20 releases that predate that, which are inside the supported range, so `await import("edf2csv")` is the form that works everywhere. TypeScript declarations ship with the package, so `import type` works without installing anything else — including `@types/node`, which the declarations deliberately avoid needing. Raw bytes are typed as `Uint8Array` rather than `Buffer` for that reason; a `Buffer` is still what arrives at runtime, since `Buffer` extends `Uint8Array`. The package has no dependencies.

```bash
npm install edf2csv
```

```js
import { EdfFile, convert, makeScaler } from 'edf2csv';
```

If your project is CommonJS, a dynamic import works from an async function:

```js
const { EdfFile } = await import('edf2csv');
```

## EdfFile.open: inspect a recording

```ts
class EdfFile {
  static open(path: string): Promise<EdfFile>;

  readonly path: string;
  readonly fileSize: number;
  /** Last-modified time when the file was opened, in ms; `metadata.json`'s `source.modified`. */
  readonly modifiedAtOpenMs: number;
  readonly header: EdfHeader;
  /** Records actually present in the file, which may differ from the header's claim. */
  readonly recordCount: number;
  readonly trailingBytes: number;
  readonly diagnostics: Diagnostic[];

  get dataSignals(): EdfSignal[];      // signals, excluding annotation channels
  get annotationSignals(): EdfSignal[];
  get timekeepingSignal(): EdfSignal | undefined;   // the first with room to hold a TAL
  readOrigin(): Promise<number | null>;
  scanOrigin(): Promise<{
    origin: number | null;
    malformed: number;                     // unreadable TALs that cost events
    malformedTimekeeping: number;          // unreadable TALs in first position, costing a record's time
    malformedTimekeepingWithText: number;  // counted in both of the above, never only one
  }>;
  get durationSeconds(): number;       // recordCount * header.recordDuration

  readRecords(options?: ReadRecordsOptions): AsyncGenerator<RecordBatch>;
  sampleAt(batch: RecordBatch, recordOffset: number, signal: EdfSignal, sampleIndex: number): number;
  offsetOf(batch: RecordBatch, recordOffset: number, signal: EdfSignal): number;
  annotationBytes(batch: RecordBatch, recordOffset: number, signal: EdfSignal): Uint8Array;
  sha256(): Promise<string>;           // hex digest over fileSize bytes; see below
  changedSinceOpen(): Promise<boolean>;  // against fileSize and modifiedAtOpenMs
  readAnnotations(): Promise<{
    annotations: Annotation[];
    recordStarts: (number | null)[];
    malformed: number;             // unreadable TALs that cost events
    malformedTimekeeping: number;  // unreadable TALs in first position, costing a record's time
    malformedTimekeepingWithText: number;  // counted in both of the above, never only one
    unreadableDurations: number;   // events kept whose stated duration is not a number
    negativeDurations: number;     // events kept whose stated duration is below zero
  }>;
  close(): Promise<void>;
}
```

`open` reads the header only. It doesn't touch the data records, so it returns immediately whatever the file's size. It opens a file handle that stays open, so **you must call `close()`**, ideally in a `finally` block. Calling `readRecords` or `readAnnotations` after `close()` throws an `EdfError` with code `UNREADABLE`.

Two properties need care. `recordCount` is derived from the actual file size, not from the header's declared count, so a truncated recording reports what's really there and raises a `RECORD_COUNT_MISMATCH` diagnostic. `trailingBytes` counts the bytes after the last complete record, which are ignored.

### Printing a channel table

```js
import { EdfFile, describeFormat, formatRate, formatWallClock } from 'edf2csv';

const file = await EdfFile.open('/data/recordings/sleep-study.edf');
try {
  console.log(describeFormat(file.header));
  console.log(`${file.recordCount} records of ${file.header.recordDuration}s`);
  console.log(`duration ${file.durationSeconds}s`);
  // formatWallClock, not toISOString: see EdfHeader below for why the Z would be a lie.
  console.log(`start ${formatWallClock(file.header.startDateTime) ?? 'unknown'}`);

  for (const signal of file.dataSignals) {
    console.log(
      `#${signal.index}`.padEnd(4) +
        signal.label.padEnd(14) +
        `${formatRate(signal.samplingRate)} Hz`.padEnd(10) +
        `${signal.physicalMin} to ${signal.physicalMax} ${signal.physicalDimension}`,
    );
  }

  for (const note of file.diagnostics) {
    console.log(`${note.severity}: [${note.code}] ${note.message}`);
  }
} finally {
  await file.close();
}
```

For a three second recording carrying EEG at 256 Hz, ECG at 128 Hz and a rectal thermistor at 1 Hz:

```text
EDF
3 records of 1s
duration 3s
start 1985-01-01T00:00:00.000Z
#0  EEG Fpz-Cz    256 Hz    -250 to 250 uV
#1  ECG           128 Hz    -5 to 5 mV
#2  Temp rectal   1 Hz      34 to 40 degC
warning: [MIXED_SAMPLING_RATES] Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
```

`describeFormat(header)` returns `"EDF"`, `"BDF"`, or one of `"EDF+ (continuous)"`, `"EDF+ (discontinuous)"`, `"BDF+ (continuous)"`, `"BDF+ (discontinuous)"` — a BDF+ file reports its own spelling, even though `continuity` normalises to the `EDF+` form. `formatRate(hz)` renders a rate without floating point noise: `256`, `0.5`, `12.5`.

`formatRates(rates)` renders several at once and guarantees that rates which differ read as differing. `formatRate` rounds to six decimals, which is what keeps 30 samples in a 0.1-second record on screen as `300` rather than `299.99999999999994` — but it also collapses `1e-6` and `1.25e-6` onto one string. When that happens every rate in the group switches to its shortest exact form. Use it wherever more than one rate is shown together; `--info` and the output filenames both do. `rateSlug` renders one rate with no set to separate it from, so it collapses that pair too and answers `0_000001hz` for both — while a recording carrying both is converted into `signals_0_000001hz.csv` and `signals_0_00000125hz.csv`. It is the spelling rule, not a prediction of a filename: to name the files a conversion writes, run the group's rates through `formatRates` first, which is what `buildPlan` does. Both go through one line, so a rendered rate is spelled the same way in either.

### EdfHeader

Every field is read straight from the 256-byte fixed header plus the per-signal block. Nothing is normalised except where noted.

```ts
interface EdfHeader {
  version: string;             // '0' for EDF, 'BIOSEMI' for BDF
  patientId: string;
  recordingId: string;
  startDateRaw: string;        // raw 'dd.mm.yy' as written in the file
  startTimeRaw: string;        // raw 'hh.mm.ss' as written in the file
  startDateTime: Date | null;  // null when the date/time fields are unusable
  headerBytes: number;          // computed from signalCount, not read from the field
  declaredHeaderBytes: number;  // what the field says, which need not match
  reserved: string;
  isEdfPlus: boolean;
  isBdf: boolean;              // BioSemi BDF/BDF+, 3 bytes per sample instead of 2
  continuity: 'EDF+C' | 'EDF+D' | null;
  declaredRecordCount: number; // as declared; -1 means the header does not say
  recordDuration: number;      // seconds, may be fractional
  signalCount: number;
  signals: EdfSignal[];        // includes annotation channels
  bytesPerSample: number;      // 2 for EDF, 3 for BDF
  recordBytes: number;         // size of one data record
}
```

`startDateTime` is a `Date` built with `Date.UTC`, which makes it a carrier for the file's wall-clock digits rather than a real instant — EDF records no timezone at all. Do not serialise it with `toISOString()`: the `Z` asserts UTC, and a reader converting to local time then shifts the recording by their own offset. Use [`formatWallClock`](#smaller-exports), which writes the digits without a zone. EDF stores a two-digit year, and the spec pins the century: 85 to 99 mean 1985 to 1999, 00 to 84 mean 2000 to 2084 — except on an EDF+ file whose recording identification field begins `Startdate dd-MMM-yyyy` and agrees with the date field, where the four-digit year there is used and a 1984 recording reads as 1984. Dates that can't be parsed, or that roll over (31.02, say), give `null` rather than a wrong instant, and `startDateRaw` and `startTimeRaw` still hold whatever the file wrote.

`continuity` normalises the BDF+ spelling: a file reserving `BDF+D` reports `'EDF+D'`, because the two mean the same thing.

`headerBytes` is the one field that is computed rather than read: 256 for the fixed header plus 256 per signal. Every data record offset is derived from it, so it has to be the size the layout actually uses — a writer that fills the length field in carelessly is common enough to have its own warning, `HEADER_BYTES_MISMATCH`, and believing the field over the arithmetic would put every sample at the wrong offset. `declaredHeaderBytes` carries what the field said, the same way `declaredRecordCount` does for the record count, so a caller auditing how a recording was written can see both.

### EdfSignal

```ts
interface EdfSignal {
  index: number;              // position in the file, 0-based, stable when labels collide
  label: string;
  transducer: string;
  physicalDimension: string;  // the unit, e.g. 'uV'
  physicalMin: number;
  physicalMax: number;
  digitalMin: number;
  digitalMax: number;
  prefiltering: string;
  samplesPerRecord: number;
  reserved: string;
  isAnnotations: boolean;     // true for 'EDF Annotations' / 'BDF Annotations'
  samplingRate: number;       // samplesPerRecord / recordDuration, in Hz
  byteOffsetInRecord: number; // where this signal's samples start inside one record
}
```

`header.signals` holds every signal including annotation channels. `file.dataSignals` and `file.annotationSignals` are the two halves, split on `isAnnotations`. `file.timekeepingSignal` is the one a record's start time is read from: EDF+ puts that TAL first in the first annotation channel, but a channel declared with zero samples per record has a zero-byte slot and can hold nothing, so it is the first channel with room rather than the first declared. Match on `index` rather than on `label` if you need to be certain which channel you've: labels are free text and aren't guaranteed unique.

### Diagnostic

Diagnostics are the non-fatal observations edf2csv makes about a file. They are the same objects the CLI prints as `warning:` lines and writes into `metadata.json`.

```ts
interface Diagnostic {
  code: DiagnosticCode;
  severity: 'warning';
  message: string;
  /** What the user can do about it. Omitted when there is nothing useful to say. */
  hint?: string;
}
```

`DiagnosticCode` is a closed union, so a `switch` over it type-checks:

```text
MIXED_SAMPLING_RATES       DISCONTINUOUS              RECORD_COUNT_UNKNOWN
RECORD_COUNT_MISMATCH      TRAILING_BYTES             DEGENERATE_DIGITAL_RANGE
DEGENERATE_PHYSICAL_RANGE  UNUSABLE_PHYSICAL_RANGE    INVERTED_PHYSICAL_RANGE
DUPLICATE_LABEL            EMPTY_LABEL                NO_ANNOTATIONS
ANNOTATION_DECODE_FAILED   COMMA_DECIMAL              LARGE_OUTPUT
NO_SIGNAL_CHANNELS         NO_SAMPLES                 STALE_OUTPUT
INPUT_CHANGED              EMPTY_WINDOW               TIME_RESOLUTION
VALUE_RESOLUTION           HEADER_BYTES_MISMATCH      NONPRINTABLE_LABEL
FORMULA_LABEL              START_TIME_UNREADABLE      LEAP_SECOND_START
START_DATE_MISMATCH        MISSING_EDF_PLUS_MARKER    STDOUT_UNSUPPORTED
```

`file.diagnostics` carries only the ones the header parser can raise. Conversion adds more, which is why `convert()` returns its own combined list.

A problem serious enough that no trustworthy output is possible throws instead. That's `EdfError`:

```ts
class EdfError extends Error {
  readonly code: EdfErrorCode;
  readonly hint: string | undefined;
}

type EdfErrorCode =
  | 'FILE_TOO_SMALL'
  | 'BAD_HEADER_FIELD'
  | 'NO_DATA_RECORDS'
  | 'INVALID_SIGNAL_COUNT'
  | 'INVALID_RECORD_DURATION'
  | 'NO_SAMPLES'
  | 'UNREADABLE';
```

`UNREADABLE` covers a missing file, a directory passed where a file was expected, a path that runs through a regular file (`rec.edf/inner`), something that is not a regular file at all such as a socket or a fifo, a permission failure, and a file that changed size while being read. It is also what a method throws on a file that has already been closed. Branch on `code`, never on the message text.

## Streaming samples

`readRecords` walks the data records in batches sized by a byte budget rather than loading the file. Peak memory is flat: a 4 GB recording and a 4 MB one use the same working set.

```ts
interface ReadRecordsOptions {
  startRecord?: number;  // inclusive, defaults to 0
  endRecord?: number;    // exclusive, defaults to the file's record count
  chunkBytes?: number;   // read budget per batch, defaults to DEFAULT_CHUNK_BYTES (8 MiB)
}

interface RecordBatch {
  firstRecordIndex: number;  // index of this batch's first record within the file
  recordCount: number;
  data: Uint8Array;          // recordCount * header.recordBytes bytes
}
```

Samples aren't decoded for you. `sampleAt(batch, recordOffset, signal, sampleIndex)` returns the raw digital integer, handling the two byte layouts EDF and BDF use (BDF's 24-bit little-endian values are sign-extended correctly). `recordOffset` is the record's position **within the batch**, from 0 to `batch.recordCount - 1`, not its index in the file. Add `batch.firstRecordIndex` when you need the absolute index.

To get physical units, build a scaler once per signal and apply it per sample.

```ts
type Scaler = (digital: number) => number;
function makeScaler(signal: EdfSignal): Scaler;
```

```js
import { EdfFile, makeScaler } from 'edf2csv';

const file = await EdfFile.open('/data/recordings/sleep-study.edf');
try {
  const signal = file.dataSignals.find((s) => s.label === 'EEG Fpz-Cz');
  if (!signal) throw new Error('channel not found');

  const scale = makeScaler(signal);
  const { recordDuration } = file.header;

  let count = 0;
  let sum = 0;
  let peak = 0;

  for await (const batch of file.readRecords()) {
    for (let r = 0; r < batch.recordCount; r++) {
      const recordStart = (batch.firstRecordIndex + r) * recordDuration;

      for (let i = 0; i < signal.samplesPerRecord; i++) {
        const digital = file.sampleAt(batch, r, signal, i);
        const microvolts = scale(digital);
        const timeSeconds = recordStart + i / signal.samplingRate;

        if (count < 3) console.log(timeSeconds.toFixed(8), digital, microvolts);
        count++;
        sum += microvolts;
        if (Math.abs(microvolts) > Math.abs(peak)) peak = microvolts;
      }
    }
  }

  console.log(`${count} samples, mean ${(sum / count).toFixed(3)}, peak ${peak.toFixed(3)}`);
} finally {
  await file.close();
}
```

```text
0.00000000 0 0.06105006105006105
0.00390625 74 9.096459096459096
0.00781250 147 18.00976800976801
768 samples, mean 0.061, peak 122.161
```

The `recordStart` arithmetic above assumes two things, and EDF+ guarantees neither.

It assumes the records are contiguous, which an EDF+D file is free not to be: only the per-record timekeeping annotation says where each one sits.

And it assumes the first record sits at zero, which a *continuous* file is also free not to. `fractional-start.edf` is EDF+C with records at 0.5, 1.5 and 2.5 seconds — perfectly contiguous, and half a second later than `index * recordDuration` says. The recipe above times its first sample at 0.000; `convert()` writes 0.500 for the same sample, and the annotation onsets in the same file keep their true values, so an analysis built on the recipe puts events half a second away from the samples they describe.

So: read `recordStarts` from `readAnnotations()` and use that array, for any EDF+ file rather than only for a discontinuous one. That is what the conversion does, which is why its `time_s` and its `annotations.csv` agree.

`EdfFile.readOrigin()` is the cheap version — it reads at most sixteen records rather than the whole annotation channel — and it is only enough for a **continuous** recording, where the records really are contiguous and one offset places all of them:

```js
// EDF+C only. On an EDF+D file this is wrong for every record after a gap.
const origin = (await file.readOrigin()) ?? 0;
const recordStart = origin + (batch.firstRecordIndex + r) * recordDuration;
```

Check `header.continuity` before reaching for it. On `discontinuous.edf`, whose records sit at 0, 1 and 10 seconds, that arithmetic puts the third record at 2 — nine seconds from where the file says it is, and from where `convert()` writes it. The conversion takes this shortcut for `EDF+C` and reads every record's own start time for `EDF+D`, which is the distinction this recipe was missing.

`makeScaler` evaluates `gain * (offset + digital)`, EDFlib's arrangement of the spec formula. The spec-literal ordering, `(digital - digitalMin) * gain + physicalMin`, loses low bits to cancellation on a channel spanning plus or minus 800 uV: digital 0 comes out as 0.19536019536019467 when the exact value is 0.19536019536019536. The arrangement used here keeps the intermediate small and returns the correctly rounded result, which is also bit-for-bit what pyEDFlib and EDFbrowser produce. When `digitalMax === digitalMin` there is no mapping at all, so the scaler returns `NaN` for every sample and the CSV writer leaves those cells empty. A gain of zero has two causes and they are not the same. A genuinely flat physical range — minimum equal to maximum — is a defined mapping, so `physicalMin` is returned and written normally. A range that is not flat whose gain *underflows* to zero, such as -1e-320 to 1e-320 over the full 16-bit range, has no mapping at all: 3e-325 is smaller than the smallest double, so `NaN` is returned and those cells are left empty, exactly as for an overflowed span. The header parser has raised `DEGENERATE_DIGITAL_RANGE`, `DEGENERATE_PHYSICAL_RANGE` or `UNUSABLE_PHYSICAL_RANGE` in each case. Check `Number.isNaN` if you consume `makeScaler` directly.

Two related helpers, used to pick CSV precision:

```ts
function quantizationStep(signal: EdfSignal): number;
function decimalsForSignal(signal: EdfSignal, max?: number): number;  // max defaults to 100
```

`quantizationStep` is the smallest physical change one digital unit can express. `decimalsForSignal` is two places past that step, capped at `max`, which is the precision at which no two adjacent digital codes round to the same text. A typical EEG channel lands on 3. The cap defaults to 100 because that is the most `toFixed` will print; it was 20 until 0.4.74, which cost a magnetometer channel most of its digital codes.

### The batch buffer is reused

This is the one contract in the API that fails silently if you get it wrong.

`readRecords` allocates a single buffer and refills it on every iteration. `batch.data` is a view into that same buffer, not a fresh copy. Once the loop turns over, anything you kept a reference to now shows the *next* batch's bytes.

```js
// WRONG. Every entry is a view of one buffer that keeps being overwritten.
const kept = [];
for await (const batch of file.readRecords()) {
  kept.push(batch.data);
}
// kept[0] no longer holds what it held when it was pushed.
```

The views are distinct objects over shared memory, which is worth stating precisely because the obvious test for it gives the wrong answer. `kept[0] === kept[1]` is **false** — each iteration hands you a new `Uint8Array`. What they have in common is `kept[0].buffer === kept[1].buffer`, all at offset 0, so what you are holding is three windows onto the same bytes.

Nor do they all end up equal. The final batch is usually short — the 18.7 MB recording this page reads gives two 8 MB batches and a 2.7 MB one — so after the loop `kept[0]` shows the last batch's bytes for as far as they go and the *previous* batch's bytes beyond that. It is neither the first batch nor the last but a seam between two, which is the kind of wrong that produces plausible-looking numbers rather than an error.

```js
// CORRECT. Copy what you intend to keep.
const kept = [];
for await (const batch of file.readRecords()) {
  kept.push(new Uint8Array(batch.data));
}
```

Use `new Uint8Array(batch.data)` rather than `batch.data.slice()`. `batch.data` is typed as a `Uint8Array`, and on a real `Uint8Array` those are the same thing — but the object you actually receive at runtime is a Node `Buffer`, whose `slice()` is an alias for `subarray()` and returns another view of the same memory rather than a copy. `new Uint8Array(...)` copies whichever of the two you are handed.

The same applies to anything derived from the buffer without copying, including `annotationBytes()`, which returns a `subarray` of it. Decoded values are safe: numbers returned by `sampleAt` are copies by nature, and strings produced from the bytes are too. The rule is only about buffers and buffer views.

Note also that a small `chunkBytes` doesn't change the results, only how often the buffer is refilled. The minimum batch is one record, so `chunkBytes: 1` still reads a whole record at a time. A value that is not a positive number — `0`, a negative, `NaN`, `Infinity` — is an `EdfError` naming the option, rather than a `RangeError` from inside `Buffer.alloc`.

## Reading annotations

```ts
interface Annotation {
  onset: number;             // seconds from the start of the recording
  duration: number | null;   // null when the TAL stated no duration that could be read
  text: string;
  recordIndex: number;       // the data record this annotation was stored in
  durationUnreadable?: true; // the file stated a duration and it is not a number
}
```

`readAnnotations()` returns every event in the file, the start time each record declares, and five counts of what could not be decoded — kept apart because each is a different loss. `malformed` counts unreadable TALs that cost events; `malformedTimekeeping` counts unreadable TALs that sat in first position, where a record's start time is stored, so what they cost is a position. Those two are **not** nested, and neither contains the other: a bare timekeeping TAL that fails is counted only in the second, so `malformed` can be 0 while `malformedTimekeeping` is 1 — which is what three of this repository's own fixtures do, and it makes `malformed - malformedTimekeeping` a negative number rather than a count of anything. What overlaps is `malformedTimekeepingWithText`: TALs in first position that carried events after the start time as well, which the format allows and writers do. Those lost both, so they are counted in *both* of the other two, and never in only one — `malformed + malformedTimekeeping - malformedTimekeepingWithText` is the number of TALs that failed; `unreadableDurations` counts events that were kept whole except for a duration the file stated and this could not read; and `negativeDurations` counts events whose duration read as a number below zero, which is not a length of time — the value is written out as the file gave it, so nothing about the row looks wrong.

`unreadableDurations` is why `duration` being `null` is not by itself the same as the file giving no duration. An event written with a duration of `abc` comes back with `duration: null`, indistinguishable from one that never had a duration — the count is what tells you it happened, and the conversion raises `ANNOTATION_DECODE_FAILED` for it.

```js
import { EdfFile } from 'edf2csv';

const file = await EdfFile.open('/data/recordings/sleep-study.edf');
try {
  if (file.annotationSignals.length === 0) {
    console.log('no annotation channel: this is plain EDF, not EDF+');
  } else {
    const { annotations, recordStarts, malformed } = await file.readAnnotations();
    console.log(`${annotations.length} annotations, ${malformed} unreadable`);

    for (const event of annotations) {
      console.log(event.onset, event.duration ?? '-', JSON.stringify(event.text), event.recordIndex);
    }
    console.log('record starts', [...recordStarts]);
  }
} finally {
  await file.close();
}
```

```text
3 annotations, 0 unreadable
0.5 1 "Sleep stage W" 0
1.25 - "Lights off" 1
2 0.5 "Seizure onset" 2
record starts [ 0, 1, 2 ]
```

Three things to know about this method.

It reads only the annotation channel, seeking straight to it inside each record instead of pulling whole records through memory. On a multi-gigabyte recording that's a few kilobytes of I/O rather than all of it.

It always scans the entire file, even when you only care about a window. Writers aren't required to store an annotation in the record its onset falls in, and some put every annotation in the first record, so reading only a window's records would drop events that belong in it.

The returned annotations are sorted by `onset`, then by `recordIndex`. `recordStarts` has one entry per data record, `null` where the record carried no readable timekeeping annotation. The timekeeping entry itself is never returned as an annotation, because it has an onset and no text.

For decoding annotation bytes yourself, `decodeRecordAnnotations(bytes, recordIndex)` handles one record's worth of the channel. Pair it with `file.annotationBytes(batch, recordOffset, signal)` if you're already streaming records and would rather not make a second pass. It returns a `DecodedRecordAnnotations`:

```ts
interface DecodedRecordAnnotations {
  recordStart: number | null;   // from the leading timekeeping TAL, null when unreadable
  annotations: Annotation[];
  malformed: number;                     // unreadable TALs that cost events
  malformedTimekeeping: number;          // unreadable TALs in first position, costing a record's time
  malformedTimekeepingWithText: number;  // counted in both of the above, never only one
  unreadableDurations: number;           // events kept whose duration is not a number
  negativeDurations: number;             // events kept whose duration is below zero
}
```

The five counts are what the warnings are raised from, and they are per record here: summing them across the records you decode gives what `readAnnotations` reports for the whole file.

## convert: run a full conversion

```ts
function convert(inputPath: string, options?: ConvertOptions): Promise<ConvertResult>;
```

This is exactly what the CLI calls. It opens the file, reads the annotation channel, builds a plan, creates the output directory, streams every rate group in a single pass over the data records, and writes `channels.csv`, `annotations.csv` when there's an annotation channel, and `metadata.json`.

### ConvertOptions

```ts
interface ConvertOptions {
  // channel and window selection
  channels?: readonly string[];   // labels, case-insensitive, or '#N' by position
  start?: number;                 // seconds on the recording's clock; may be negative
  duration?: number;              // seconds; mutually exclusive with `end`
  end?: number;                   // seconds; mutually exclusive with `duration`
  annotationsOnly?: boolean;      // skip the signal files entirely
  decimals?: number;              // fixed precision instead of per-channel

  // shape and encoding
  layout?: 'wide' | 'long';       // 'wide' (default), or one table of time_s/channel/value
                                  // any other value is an OptionError, as on the CLI
  gzip?: boolean;                 // compress every CSV, giving each a .csv.gz name
  bom?: boolean;                  // start each CSV with a UTF-8 byte order mark

  // output
  outputDir?: string;             // defaults to defaultOutputDir(inputPath)
  force?: boolean;                // overwrite an existing output directory
  checksum?: boolean;             // record a SHA-256 of the input in metadata.json
  toStdout?: boolean;             // stream the single table to stdout, write no files
  onProgress?: (progress: ConversionProgress) => void;

  // Quoted back in time-range errors so they name the value the caller gave, not its
  // parsed form. Optional; the parsed seconds are used when absent.
  startText?: string;
  endText?: string;
}

interface ConversionProgress {
  recordsDone: number;
  recordsTotal: number;   // endRecord - startRecord
  bytesWritten: number;
}
```

`start`, `duration` and `end` are plain numbers of seconds here, not the `5m` or `00:30:00` strings the CLI accepts. `start` and `end` may be negative, because they name a position on the recording's own clock and that clock can begin before zero; `duration` is a length and may not. Use `parseTimeSpec` if you want to accept those forms from your own users. Passing both `duration` and `end` throws a `TimeRangeError`, as does a window that starts at or past the end of the recording.

`onProgress` fires once per batch of records read, not once per record, so on a small file it may fire only once — and on a run that reads no data records for signals it never fires at all. That is four ordinary cases, not an edge: `annotationsOnly`, a recording with no signal channels, a window landing where the recording has no data, and a `channels` selection whose channels carry none. A caller driving a progress display should treat the promise returned by `convert` as the completion signal and `ConvertResult` as the account of what happened; `onProgress` reports work in flight, and those four runs have none to report. `bytesWritten` counts characters as the signal writers flush them, so it's zero until the first flush — and, for the same reason, the last value it reports is short of the finished file by whatever was still in the buffers when the final batch ended: up to one flush threshold per signal file, which is a megabyte each. A 400-record recording that writes 6,251,463 bytes reports 5,243,023. It is a progress signal, not a byte count; `ConvertResult.files` carries the rows actually written, and the files on disk carry the bytes.

`defaultOutputDir(inputPath)` gives the directory `convert` would choose on its own: the input filename with its extension replaced by `_csv`, next to the input. `defaultOutputDir('/data/recordings/sleep-study.edf')` is `/data/recordings/sleep-study_csv`.

### ConvertResult

```ts
interface ConvertResult {
  outputDir: string;
  files: WrittenFile[];      // { name: string; rows: number }
  readerHungUp: boolean;     // a toStdout reader closed the pipe before the end
  annotationCount: number;   // rows written to annotations.csv
  diagnostics: Diagnostic[]; // header, plan and stale-output diagnostics combined
  plan: ConversionPlan;
  file: EdfFile;             // already closed; header and diagnostics still readable
  elapsedMs: number;
}
```

`files` lists only the files that were written, in the order they were written: the signal CSVs first, then `annotations.csv` if the recording has an annotation channel, then `channels.csv`. `metadata.json` is always written but is deliberately not in the list.

`result.file` is closed before `convert` returns. Its `header`, `recordCount` and `diagnostics` are plain data and stay readable, but `readRecords` and `readAnnotations` on it throw `UNREADABLE`. Open the file yourself with `EdfFile.open` if you want to keep reading after converting.

`changedSinceOpen()` is the exception: it keeps working on a closed file, because `convert` asks it on the way out and caches the answer. So `await result.file.changedSinceOpen()` agrees with whether the result carries an `INPUT_CHANGED` diagnostic. (It returned `false` on a closed file until 0.4.38, which had the result contradicting itself.) Calling it on a file you closed yourself without ever asking throws `UNREADABLE`, since a closed descriptor cannot answer it.

`sha256()` is what `--checksum` uses: it hashes exactly the `fileSize` bytes that were there when the file was opened,
through the descriptor already on them, and returns the digest as hex. Reading the path again afterwards would describe
whatever answers to that name by then, which for a recording still being written is a different file. It needs the file
open, so call it before `close()`.

```js
import { EdfFile } from 'edf2csv';

const file = await EdfFile.open('/data/recordings/sleep-study.edf');
const digest = await file.sha256();          // hex, over file.fileSize bytes
await file.close();
```

`modifiedAtOpenMs` is the other half of that: the file's modification time when it was opened, in
milliseconds, and the value `changedSinceOpen()` compares against. It is kept as a raw number
rather than a `Date` on purpose — `new Date(ms).getTime()` truncates to whole milliseconds, and
comparing that against a later `fstat` carrying the filesystem's sub-millisecond precision
reported every undisturbed conversion as one whose input had changed underneath it.

### A conversion with options

```js
import { convert } from 'edf2csv';

const result = await convert('/data/recordings/sleep-study.edf', {
  outputDir: '/data/exports/epoch-42',
  force: true,
  channels: ['EEG Fpz-Cz', 'Temp rectal'],
  start: 1,
  duration: 1,
  checksum: true,
  onProgress: (p) => console.log(`records ${p.recordsDone}/${p.recordsTotal}`),
});

console.log(result.outputDir, `in ${result.elapsedMs}ms`);
for (const written of result.files) console.log(`  ${written.name} ${written.rows} rows`);
console.log('window', result.plan.range);
console.log('estimate', result.plan.estimate);

for (const note of result.diagnostics) {
  console.log(`${note.severity}: [${note.code}] ${note.message}`);
  if (note.hint) console.log(`         ${note.hint}`);
}
```

```text
/data/exports/epoch-42 in 14ms
  signals_256hz.csv 256 rows
  signals_1hz.csv 1 rows
  channels.csv 3 rows
window {
  startSeconds: 1,
  endSeconds: 2,
  startRecord: 1,
  endRecord: 2,
  isWholeRecording: false,
  recordingStartSeconds: 0,
  recordingEndSeconds: 3
}
estimate { rows: 257, bytes: 5172, exceedsSpreadsheetLimit: false }
warning: [MIXED_SAMPLING_RATES] Channels use 2 different sampling rates (256 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
```

Two channels were requested at two different rates, so two signal files came back. `channels.csv` still has a row for all three channels in the recording, with `converted` set to `no` for the one that was filtered out.

The warning names two rates rather than the file's three, because it describes the conversion rather than the recording: the header parser raises its own, which counts every channel and knows nothing about `channels`. `convert` drops that copy in favour of this one — see `withoutFileRateWarning`.

### Errors from convert

`convert` throws five distinct error types. All of them are exported, so `instanceof` works.

| Type | When |
| --- | --- |
| `EdfError` | The recording can't be read or its header is unusable. Has `code` and `hint`. |
| `ConversionError` | The output can't be written, the recording stopped being readable part way through, the request can't be carried out, or your own callback threw. `code` is `OUTPUT_EXISTS`, `OUTPUT_UNWRITABLE`, `INPUT_OUTPUT_COLLISION`, `INPUT_UNREADABLE`, `UNSUPPORTED_REQUEST`, `CALLBACK_FAILED` or `WRITE_FAILED`. |
| `OptionError` | An option is not a value this can act on: `decimals` outside 0 to 20 or not a whole number, a `start` or `end` that is not a finite number of seconds, a `duration` that is not a non-negative one, a `layout` that is neither `"wide"` nor `"long"`, a `channels` value that is not a list of channel names, or is a list that names nothing — an empty array, or one holding only blanks, which is what an empty string split on commas produces — an `outputDir` of `""`, or any of `annotationsOnly`, `gzip`, `bom`, `force`, `checksum` and `toStdout` given something other than a boolean — each is read as `=== true` where it is read, so `gzip: 1` wrote plain CSVs under plain names and `annotationsOnly: 'true'` wrote every signal the caller asked to leave out. The first argument is held to the same standard: an `inputPath` that is not a string — an option bag passed by mistake, an array of paths — is refused here rather than handed to `fs`, which answered `Cannot read "[object Object]"` as though the recording were the problem. `EdfFile.open` makes the same check on its own argument, so reading a header without converting gives the same answer to the same mistake. |
| `ChannelSelectionError` | A `channels` term matched nothing, or `#N` named a position the file doesn't have. |
| `TimeRangeError` | The requested window is empty, inverted, past the end, or over-specified. |

`CALLBACK_FAILED` means your `onProgress` threw. It carries the original error as `cause`, so the stack that matters survives, and the conversion stops — carrying on writing into a directory whose owner has just failed is not an improvement. Until 0.4.38 this came back as `WRITE_FAILED` reading `Writing to "out" failed: <your message>`, advising you to check a destination that was working perfectly.

`OptionError` is raised before the output directory is created, so a rejected option leaves nothing on disk. The command line has always rejected these values; until 0.4.33 the library did not, and `decimals: NaN` quietly wrote whole numbers into a column you had asked for decimals in.

```js
import { convert, EdfError, ConversionError, OptionError, ChannelSelectionError, TimeRangeError } from 'edf2csv';

try {
  await convert('/data/recordings/sleep-study.edf', { outputDir: '/data/exports/run-1' });
} catch (error) {
  if (error instanceof ConversionError && error.code === 'OUTPUT_EXISTS') {
    console.error('already converted; pass force: true to replace it');
  } else if (error instanceof EdfError) {
    console.error(`${error.code}: ${error.message}`);
    if (error.hint) console.error(error.hint);
  } else if (error instanceof ChannelSelectionError || error instanceof TimeRangeError) {
    console.error(error.message);
  } else {
    throw error;
  }
}
```

`ConversionError.code` is one of `OUTPUT_EXISTS`, `OUTPUT_UNWRITABLE`, `INPUT_OUTPUT_COLLISION` (an output file would resolve to the recording being read), `INPUT_UNREADABLE` (the reader failed after writing had begun), `UNSUPPORTED_REQUEST` (the flags cannot be carried out together), `CALLBACK_FAILED` (your `onProgress` threw) or `WRITE_FAILED`.

`ConversionErrorCode` is the type of that field, so a handler can be written down rather than only written: `function explain(code: ConversionErrorCode)`, a `Record<ConversionErrorCode, string>` of messages, or a `switch` the compiler checks for exhaustiveness. It was reachable but unnameable until 0.7.6, when `EdfErrorCode` and `DiagnosticCode` had both been exported since they existed.

`ChannelSelectionError` messages carry a suggestion when the term is close to a real label, and `EdfError` and `ConversionError` both carry a `hint` describing what to do. Both are worth surfacing to a user rather than swallowing.

`WRITE_FAILED` means files were partially written. They are left on disk, incomplete, and shouldn't be used.

## Planning without converting

`buildPlan` answers "what would a conversion produce" with no I/O beyond the header you already read. It's what powers the `--info` estimate.

```ts
function buildPlan(input: PlanInput, options?: PlanOptions): ConversionPlan;

interface PlanInput {
  signals: readonly EdfSignal[];
  recordDuration: number;
  recordCount: number;
  hasAnnotationChannel: boolean;
  recordStarts?: Float64Array | null;  // true record start times, for EDF+D files
}

interface ConversionPlan {
  groups: RateGroup[];
  layout: 'wide' | 'long';             // a column per channel, or time_s/channel/value
  gzip: boolean;                       // whether the CSVs will be written compressed
  range: ResolvedRange;
  columnNames: Map<number, string>;    // signal index to CSV column name
  writeSignals: boolean;
  diagnostics: Diagnostic[];
  estimate: { rows: number; bytes: number; exceedsSpreadsheetLimit: boolean };
}

interface RateGroup {
  rate: number;              // Hz, shared by every channel in the group
  samplesPerRecord: number;
  fileName: string;          // 'signals.csv', or 'signals_256hz.csv' when rates differ
  timeDecimals: number;      // decimals used for the time_s column
  channels: PlannedChannel[];
}

interface PlannedChannel {
  signal: EdfSignal;
  column: string;
  decimals: number;
}
```

`PlanOptions` is everything `ConvertOptions` needs before a byte is written — the selection (`channels`, `start`, `duration`, `end`, `annotationsOnly`, `decimals`) plus the shape and encoding (`layout`, `gzip`, `bom`), since those decide the file names, the row count and the estimate.

```js
import { EdfFile, buildPlan, SPREADSHEET_ROW_LIMIT } from 'edf2csv';

const file = await EdfFile.open('/data/recordings/sleep-study.edf');
try {
  const plan = buildPlan(
    {
      signals: file.header.signals,
      recordDuration: file.header.recordDuration,
      recordCount: file.recordCount,
      hasAnnotationChannel: file.annotationSignals.length > 0,
    },
    { start: 0, duration: 10 },
  );

  for (const group of plan.groups) {
    console.log(`${group.fileName}  ${group.rate} Hz  ${group.channels.length} channels`);
  }
  console.log(plan.estimate);

  if (plan.estimate.exceedsSpreadsheetLimit) {
    console.log(`over ${SPREADSHEET_ROW_LIMIT} rows: not openable in Excel or Numbers`);
  }
} finally {
  await file.close();
}
```

```text
signals_256hz.csv  256 Hz  1 channels
signals_128hz.csv  128 Hz  1 channels
signals_1hz.csv  1 Hz  1 channels
{ rows: 1155, bytes: 22749, exceedsSpreadsheetLimit: false }
```

`estimate.rows` is the total data rows across every signal file. `estimate.bytes` is an approximation of their combined size as CSV text, good enough to warn on and not meant to be exact — and under `gzip` not their size on disk at all, since it counts what the compressor is given rather than what it writes. `exceedsSpreadsheetLimit` is true when any single file would pass 1,048,576 rows including the header.

One caveat when planning a window on a discontinuous file: pass `recordStarts`. Without it the planner assumes records sit end to end, and a recording with a 95 second gap in the middle would have its window clipped to the amount of data rather than the span of time it covers. `convert` derives this array itself from the timekeeping annotations.

Doing it by hand means matching that derivation, and a record whose timekeeping TAL is unreadable is where the two can part company. `convert` places it at `origin + index * recordDuration`, where `origin` comes from the first record that does state one — not at `index * recordDuration`, which silently assumes the recording begins at zero:

```js
import { EdfFile, buildPlan } from 'edf2csv';

const file = await EdfFile.open('/data/recordings/sleep-study.edf');
try {
  const { recordStarts } = await file.readAnnotations();
  const origin = (await file.readOrigin()) ?? 0;
  const starts = Float64Array.from(recordStarts, (declared, index) =>
    declared ?? origin + index * file.header.recordDuration,
  );

  const plan = buildPlan(
    {
      signals: file.header.signals,
      recordDuration: file.header.recordDuration,
      recordCount: file.recordCount,
      hasAnnotationChannel: file.annotationSignals.length > 0,
      recordStarts: starts,
    },
    { start: 0.5, duration: 1 },
  );
  console.log(plan.estimate, plan.range.recordingStartSeconds);
} finally {
  await file.close();
}
```

On `lost-timekeeping-d.edf`, whose first record's TAL is unreadable while the rest say 1.5 and 2.5, filling from zero puts record 0 at 0 rather than 0.5. Planning `{ start: 0.5, duration: 1 }` against that estimates 2 rows; the conversion writes 4.

`ResolvedRange` describes the window that was chosen:

```ts
interface ResolvedRange {
  startSeconds: number;      // inclusive
  endSeconds: number;        // exclusive, clamped to the end of the recording
  startRecord: number;       // first data record touching the window
  endRecord: number;         // one past the last data record touching the window
  isWholeRecording: boolean;
  recordingStartSeconds: number; // earliest record start, including EDF+D timing
  recordingEndSeconds: number;   // end of the latest record, including EDF+D timing
}
```

## Smaller exports

Column naming and channel selection, if you want the CLI's matching rules without the conversion:

```ts
function buildColumnNames(signals: readonly EdfSignal[]): Map<number, string>;
function selectChannels(
  signals: readonly EdfSignal[],
  terms: readonly string[],
): { signals: EdfSignal[]; ambiguous: { term: string; matched: EdfSignal[] }[] };
```

Column names come from the whole file, not from the current selection, so a channel always gets the same column regardless of what else was requested. An empty label becomes `signal_<index>`, and a label shared by two channels gets a `_ch<index>` suffix on both. `selectChannels` matches case-insensitively on the exact label, accepts `#N` for a position, throws `ChannelSelectionError` on a term that matches nothing, and reports terms that matched several channels in `ambiguous` rather than silently returning extras.

Time parsing, if you want to accept the CLI's time forms:

```ts
function parseTimeSpec(input: string, optionName: string, allowNegative?: boolean): number;  // seconds
function resolveRange(options: {
  start?: number;
  duration?: number;
  end?: number;
  recordDuration: number;
  recordCount: number;
  recordStarts?: Float64Array | null;
}): ResolvedRange;
```

`optionName` is only used in the error message, so pass whatever your own interface calls the option. `allowNegative` defaults to false; pass true for a value that names a position rather than a length, since a recording timed from its first record's timekeeping annotation can begin before zero. The CLI passes it for `--start` and `--end` and withholds it for `--duration`.

```js
import { parseTimeSpec } from 'edf2csv';

parseTimeSpec('1h30m', '--start');    // 5400
parseTimeSpec('00:30:00', '--start'); // 1800
parseTimeSpec('250ms', '--start');    // 0.25
parseTimeSpec('90', '--start');       // 90, a bare number is seconds
parseTimeSpec('-1h30m', '--start', true); // -5400, the sign applies to the whole value
```

A value that is not text is refused rather than coerced — `parseTimeSpec(30, '--start')` throws
`TimeRangeError: --start must be given as text, not 30`. That is the shape a JSON config or a
form field arrives in, and the reason it is not read as 30 is the one `channels: 'ECG'` gives:
an accepting `Number(input)` also accepts `NaN`. Everything this function refuses is a
`TimeRangeError` naming the option and the value.

Header parsing, for bytes you already have in memory:

```ts
function parseHeader(buf: Uint8Array, fileSize: number): EdfHeaderInfo;

interface EdfHeaderInfo {
  header: EdfHeader;
  recordCount: number;   // implied by the real file size
  trailingBytes: number;
  diagnostics: Diagnostic[];
}
```

`buf` must hold at least `256 + signalCount * 256` bytes. `fileSize` is the size of the whole file, which is what lets the parser derive the real record count and compare it against the header's claim.

Constants and small utilities:

```ts
const DEFAULT_CHUNK_BYTES: number;      // 8 * 1024 * 1024
const SPREADSHEET_ROW_LIMIT: number;    // 1_048_576
const TOOL_VERSION: string;             // the version written into metadata.json
const ANNOTATIONS_LABEL: string;        // 'EDF Annotations'
const BDF_ANNOTATIONS_LABEL: string;    // 'BDF Annotations'

function formatRate(hz: number): string;             // 256, 0.5, 12.5
function formatRates(rates: readonly number[]): string[];  // distinct rates render distinctly
function describeFormat(header: EdfHeader): string;  // 'EDF+ (discontinuous)'
function rateSlug(rate: number): string;             // '256hz', '12_5hz' — one rate, alone
function defaultOutputDir(inputPath: string): string;
function formatWallClock(date: Date | null): string | null;  // '2002-03-02T23:10:00'
```

`formatWallClock` is the one to reach for when writing `startDateTime` out, and the reason is
worth stating. EDF records a date and a time and no timezone at all. `startDateTime` carries
those digits as a UTC `Date` so they round-trip unshifted, which makes it a container for the
wall clock rather than an instant — and serialising it with `toISOString()` appends a `Z`,
asserting UTC. A reader converting that to local time then moves the recording by their own
offset: 13:43:04 in the file becomes 08:43:04 in New York. `formatWallClock` drops the `Z`,
because the file genuinely does not say which zone it meant. It is what produces
`start_datetime_local` in `metadata.json` and the `Recorded` line in `--info`.

## Types exported for annotation

Every one of these is available through `import type { ... } from 'edf2csv'`:

`EdfHeader`, `EdfHeaderInfo`, `EdfSignal`, `RecordBatch`, `ReadRecordsOptions`, `Annotation`, `DecodedRecordAnnotations`, `Scaler`, `Diagnostic`, `DiagnosticCode`, `EdfErrorCode`, `ConversionErrorCode`, `ConvertOptions`, `ConvertResult`, `ConversionProgress`, `WrittenFile`, `ConversionPlan`, `PlanOptions`, `PlanInput`, `RateGroup`, `PlannedChannel`, `OutputEstimate`, `ChannelSelection`, `ResolvedRange`.

The classes `EdfFile`, `EdfError`, `ConversionError`, `ChannelSelectionError` and `TimeRangeError` are values, so they import normally and work with `instanceof`.
