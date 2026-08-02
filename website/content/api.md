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

The package is ESM only and needs Node 20 or newer. There's no CommonJS build, so `require("edf2csv")` won't work. TypeScript declarations ship with the package, so `import type` works without installing anything else — including `@types/node`, which the declarations deliberately avoid needing. Raw bytes are typed as `Uint8Array` rather than `Buffer` for that reason; a `Buffer` is still what arrives at runtime, since `Buffer` extends `Uint8Array`. The package has no dependencies.

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
  readonly header: EdfHeader;
  /** Records actually present in the file, which may differ from the header's claim. */
  readonly recordCount: number;
  readonly trailingBytes: number;
  readonly diagnostics: Diagnostic[];

  get dataSignals(): EdfSignal[];      // signals, excluding annotation channels
  get annotationSignals(): EdfSignal[];
  get durationSeconds(): number;       // recordCount * header.recordDuration

  readRecords(options?: ReadRecordsOptions): AsyncGenerator<RecordBatch>;
  sampleAt(batch: RecordBatch, recordOffset: number, signal: EdfSignal, sampleIndex: number): number;
  offsetOf(batch: RecordBatch, recordOffset: number, signal: EdfSignal): number;
  annotationBytes(batch: RecordBatch, recordOffset: number, signal: EdfSignal): Uint8Array;
  readAnnotations(): Promise<{
    annotations: Annotation[];
    recordStarts: (number | null)[];
    malformed: number;
  }>;
  close(): Promise<void>;
}
```

`open` reads the header only. It doesn't touch the data records, so it returns immediately whatever the file's size. It opens a file handle that stays open, so **you must call `close()`**, ideally in a `finally` block. Calling `readRecords` or `readAnnotations` after `close()` throws an `EdfError` with code `UNREADABLE`.

Two properties need care. `recordCount` is derived from the actual file size, not from the header's declared count, so a truncated recording reports what's really there and raises a `RECORD_COUNT_MISMATCH` diagnostic. `trailingBytes` counts the bytes after the last complete record, which are ignored.

### Printing a channel table

```js
import { EdfFile, describeFormat, formatRate } from 'edf2csv';

const file = await EdfFile.open('/data/recordings/sleep-study.edf');
try {
  console.log(describeFormat(file.header));
  console.log(`${file.recordCount} records of ${file.header.recordDuration}s`);
  console.log(`duration ${file.durationSeconds}s`);
  console.log(`start ${file.header.startDateTime?.toISOString() ?? 'unknown'}`);

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

`describeFormat(header)` returns `"EDF"`, `"BDF"`, `"EDF+ (continuous)"` or `"EDF+ (discontinuous)"`. `formatRate(hz)` renders a rate without floating point noise: `256`, `0.5`, `12.5`.

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
  headerBytes: number;
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

`startDateTime` is a UTC `Date`. EDF stores a two-digit year, and the spec pins the century: 85 to 99 mean 1985 to 1999, 00 to 84 mean 2000 to 2084. Dates that can't be parsed, or that roll over (31.02, say), give `null` rather than a wrong instant, and `startDateRaw` and `startTimeRaw` still hold whatever the file wrote.

`continuity` normalises the BDF+ spelling: a file reserving `BDF+D` reports `'EDF+D'`, because the two mean the same thing.

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

`header.signals` holds every signal including annotation channels. `file.dataSignals` and `file.annotationSignals` are the two halves, split on `isAnnotations`. Match on `index` rather than on `label` if you need to be certain which channel you've: labels are free text and aren't guaranteed unique.

### Diagnostic

Diagnostics are the non-fatal observations edf2csv makes about a file. They are the same objects the CLI prints as `warning:` lines and writes into `metadata.json`.

```ts
interface Diagnostic {
  code: DiagnosticCode;
  severity: 'warning' | 'info';
  message: string;
  /** What the user can do about it. Omitted when there is nothing useful to say. */
  hint?: string;
}
```

`DiagnosticCode` is a closed union, so a `switch` over it type-checks:

```text
MIXED_SAMPLING_RATES   DISCONTINUOUS            RECORD_COUNT_UNKNOWN
RECORD_COUNT_MISMATCH  TRAILING_BYTES           DEGENERATE_DIGITAL_RANGE
DEGENERATE_PHYSICAL_RANGE                       INVERTED_PHYSICAL_RANGE
DUPLICATE_LABEL        EMPTY_LABEL              NONSTANDARD_UNIT
NO_ANNOTATIONS         ANNOTATION_DECODE_FAILED COMMA_DECIMAL
LARGE_OUTPUT           NO_SIGNAL_CHANNELS       NO_SAMPLES
STALE_OUTPUT           HEADER_BYTES_MISMATCH    NONPRINTABLE_LABEL
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

`UNREADABLE` covers a missing file, a directory passed where a file was expected, a permission failure, and a file that changed size while being read. Branch on `code`, never on the message text.

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

The `recordStart` arithmetic above assumes a continuous recording. For an EDF+D file the records aren't contiguous in time, and only the per-record timekeeping annotation says where each one sits. Read `recordStarts` from `readAnnotations()` and use that array instead.

`makeScaler` evaluates `gain * (offset + digital)`, EDFlib's arrangement of the spec formula. The spec-literal ordering, `(digital - digitalMin) * gain + physicalMin`, loses low bits to cancellation on a channel spanning plus or minus 800 uV: digital 0 comes out as 0.19536019536019467 when the exact value is 0.19536019536019536. The arrangement used here keeps the intermediate small and returns the correctly rounded result, which is also bit-for-bit what pyEDFlib and EDFbrowser produce. When the header contradicts itself (`digitalMax === digitalMin`, or a gain of zero) the scaler returns `physicalMin` for every sample, and the header parser has already raised `DEGENERATE_DIGITAL_RANGE` or `DEGENERATE_PHYSICAL_RANGE`.

Two related helpers, used to pick CSV precision:

```ts
function quantizationStep(signal: EdfSignal): number;
function decimalsForSignal(signal: EdfSignal, max?: number): number;  // max defaults to 15
```

`quantizationStep` is the smallest physical change one digital unit can express. `decimalsForSignal` is two places past that step, capped at `max`, which is the precision at which no two adjacent digital codes round to the same text. A typical EEG channel lands on 3.

### The batch buffer is reused

This is the one contract in the API that fails silently if you get it wrong.

`readRecords` allocates a single buffer and refills it on every iteration. `batch.data` is a view into that same buffer, not a fresh copy. Once the loop turns over, anything you kept a reference to now shows the *next* batch's bytes.

```js
// WRONG. Every entry ends up pointing at the same memory.
const kept = [];
for await (const batch of file.readRecords()) {
  kept.push(batch.data);
}
// kept[0], kept[1] and kept[2] are all identical, and all hold the last batch read.
```

```js
// CORRECT. Copy what you intend to keep.
const kept = [];
for await (const batch of file.readRecords()) {
  kept.push(new Uint8Array(batch.data));
}
```

Use `new Uint8Array(batch.data)` rather than `batch.data.slice()`. `batch.data` is typed as a `Uint8Array`, and on a real `Uint8Array` those are the same thing — but the object you actually receive at runtime is a Node `Buffer`, whose `slice()` is an alias for `subarray()` and returns another view of the same memory rather than a copy. `new Uint8Array(...)` copies whichever of the two you are handed.

The same applies to anything derived from the buffer without copying, including `annotationBytes()`, which returns a `subarray` of it. Decoded values are safe: numbers returned by `sampleAt` are copies by nature, and strings produced from the bytes are too. The rule is only about buffers and buffer views.

Note also that a small `chunkBytes` doesn't change the results, only how often the buffer is refilled. The minimum batch is one record, so `chunkBytes: 1` still reads a whole record at a time.

## Reading annotations

```ts
interface Annotation {
  onset: number;           // seconds from the start of the recording
  duration: number | null; // null when the TAL omitted a duration
  text: string;
  recordIndex: number;     // the data record this annotation was stored in
}
```

`readAnnotations()` returns every event in the file, the start time each record declares, and a count of entries that couldn't be decoded.

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

For decoding annotation bytes yourself, `decodeRecordAnnotations(bytes, recordIndex)` handles one record's worth of the channel and returns `{ recordStart, annotations, malformed }`. Pair it with `file.annotationBytes(batch, recordOffset, signal)` if you're already streaming records and would rather not make a second pass.

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
  start?: number;                 // seconds from the start of the recording
  duration?: number;              // seconds; mutually exclusive with `end`
  end?: number;                   // seconds; mutually exclusive with `duration`
  annotationsOnly?: boolean;      // skip the signal files entirely
  decimals?: number;              // fixed precision instead of per-channel

  // output
  outputDir?: string;             // defaults to defaultOutputDir(inputPath)
  force?: boolean;                // overwrite an existing output directory
  checksum?: boolean;             // record a SHA-256 of the input in metadata.json
  onProgress?: (progress: ConversionProgress) => void;
}

interface ConversionProgress {
  recordsDone: number;
  recordsTotal: number;   // endRecord - startRecord
  bytesWritten: number;
}
```

`start`, `duration` and `end` are plain numbers of seconds here, not the `5m` or `00:30:00` strings the CLI accepts. Use `parseTimeSpec` if you want to accept those forms from your own users. Passing both `duration` and `end` throws a `TimeRangeError`, as does a window that starts at or past the end of the recording.

`onProgress` fires once per batch of records read, not once per record, so on a small file it may fire only once. `bytesWritten` counts characters pushed to the signal writers, so it's zero until the first flush.

`defaultOutputDir(inputPath)` gives the directory `convert` would choose on its own: the input filename with its extension replaced by `_csv`, next to the input. `defaultOutputDir('/data/recordings/sleep-study.edf')` is `/data/recordings/sleep-study_csv`.

### ConvertResult

```ts
interface ConvertResult {
  outputDir: string;
  files: WrittenFile[];      // { name: string; rows: number }
  annotationCount: number;   // rows written to annotations.csv
  diagnostics: Diagnostic[]; // header, plan and stale-output diagnostics combined
  plan: ConversionPlan;
  file: EdfFile;             // already closed; header and diagnostics still readable
  elapsedMs: number;
}
```

`files` lists only the files that were written, in the order they were written: the signal CSVs first, then `annotations.csv` if the recording has an annotation channel, then `channels.csv`. `metadata.json` is always written but is deliberately not in the list.

`result.file` is closed before `convert` returns. Its `header`, `recordCount` and `diagnostics` are plain data and stay readable, but `readRecords` and `readAnnotations` on it throw `UNREADABLE`. Open the file yourself with `EdfFile.open` if you want to keep reading after converting.

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
  isWholeRecording: false
}
estimate { rows: 257, bytes: 6165, exceedsSpreadsheetLimit: false }
warning: [MIXED_SAMPLING_RATES] Channels use 3 different sampling rates (256 Hz, 128 Hz, 1 Hz).
         They are written to one file per rate so no channel is resampled.
```

Two channels were requested at two different rates, so two signal files came back. `channels.csv` still has a row for all three channels in the recording, with `converted` set to `no` for the one that was filtered out.

### Errors from convert

`convert` throws four distinct error types. All of them are exported, so `instanceof` works.

| Type | When |
| --- | --- |
| `EdfError` | The recording can't be read or its header is unusable. Has `code` and `hint`. |
| `ConversionError` | The output can't be written. `code` is `OUTPUT_EXISTS`, `OUTPUT_UNWRITABLE` or `WRITE_FAILED`. |
| `ChannelSelectionError` | A `channels` term matched nothing, or `#N` named a position the file doesn't have. |
| `TimeRangeError` | The requested window is empty, inverted, past the end, or over-specified. |

```js
import { convert, EdfError, ConversionError, ChannelSelectionError, TimeRangeError } from 'edf2csv';

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

`PlanOptions` is the selection half of `ConvertOptions`: `channels`, `start`, `duration`, `end`, `annotationsOnly`, `decimals`.

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
{ rows: 1155, bytes: 28095, exceedsSpreadsheetLimit: false }
```

`estimate.rows` is the total data rows across every signal file. `estimate.bytes` is an approximation of their combined size, good enough to warn on and not meant to be exact. `exceedsSpreadsheetLimit` is true when any single file would pass 1,048,576 rows including the header.

One caveat when planning a window on a discontinuous file: pass `recordStarts`. Without it the planner assumes records sit end to end, and a recording with a 95 second gap in the middle would have its window clipped to the amount of data rather than the span of time it covers. `convert` derives this array itself from the timekeeping annotations. To do it by hand, take `recordStarts` from `readAnnotations()` and fill a `Float64Array`, using `index * recordDuration` where an entry is `null`.

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
function parseTimeSpec(input: string, optionName: string): number;  // returns seconds
function resolveRange(options: {
  start?: number;
  duration?: number;
  end?: number;
  recordDuration: number;
  recordCount: number;
  recordStarts?: Float64Array | null;
}): ResolvedRange;
```

`optionName` is only used in the error message, so pass whatever your own interface calls the option.

```js
import { parseTimeSpec } from 'edf2csv';

parseTimeSpec('1h30m', '--start');    // 5400
parseTimeSpec('00:30:00', '--start'); // 1800
parseTimeSpec('250ms', '--start');    // 0.25
parseTimeSpec('90', '--start');       // 90, a bare number is seconds
```

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
function describeFormat(header: EdfHeader): string;  // 'EDF+ (discontinuous)'
function rateSlug(rate: number): string;             // '256hz', '12_5hz'
function defaultOutputDir(inputPath: string): string;
```

## Types exported for annotation

Every one of these is available through `import type { ... } from 'edf2csv'`:

`EdfHeader`, `EdfHeaderInfo`, `EdfSignal`, `RecordBatch`, `ReadRecordsOptions`, `Annotation`, `DecodedRecordAnnotations`, `Scaler`, `Diagnostic`, `DiagnosticCode`, `EdfErrorCode`, `ConvertOptions`, `ConvertResult`, `ConversionProgress`, `WrittenFile`, `ConversionPlan`, `PlanOptions`, `PlanInput`, `RateGroup`, `PlannedChannel`, `ResolvedRange`.

The classes `EdfFile`, `EdfError`, `ConversionError`, `ChannelSelectionError` and `TimeRangeError` are values, so they import normally and work with `instanceof`.
