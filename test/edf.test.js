/** Parser-level tests: headers, scaling, annotations, and the diagnostics each raises. */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdtemp, readFile, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EdfError,
  EdfFile,
  decimalsForSignal,
  makeScaler,
} from '../dist/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'generated');
const fixture = (name) => path.join(FIXTURES, name);

const open = [];
const temporaries = [];
async function load(name) {
  const file = await EdfFile.open(fixture(name));
  open.push(file);
  return file;
}
after(async () => {
  for (const file of open) await file.close();
  for (const dir of temporaries) await rm(dir, { recursive: true, force: true });
});

const codes = (file) => file.diagnostics.map((d) => d.code);

describe('header parsing', () => {
  it('reads the fixed header of a plain EDF file', async () => {
    const file = await load('tiny.edf');
    assert.equal(file.header.version, '0');
    assert.equal(file.header.signalCount, 2);
    assert.equal(file.header.recordDuration, 1);
    assert.equal(file.recordCount, 2);
    assert.equal(file.header.isEdfPlus, false);
    assert.equal(file.header.continuity, null);
    assert.equal(file.durationSeconds, 2);
  });

  it('pins the two-digit year to 1985-2084 as the spec requires', async () => {
    const file = await load('tiny.edf');
    // "05.06.09" is 2009, not 1909 — anything below 85 belongs to the 2000s.
    assert.equal(file.header.startDateTime.toISOString(), '2009-06-05T12:34:56.000Z');
  });

  it('says when a header states two different start dates', async () => {
    /*
      EDF+ requires the recording identification field's `Startdate` to be the header's start
      date, and where it is, its four digits settle the century. Where it is not, one of the two
      is wrong, there is no way to tell which, and the file's one statement of when the
      recording happened has lost its corroboration.

      Nothing said so. `--info` printed `Recorded 2002-03-02` two lines above
      `Recording Startdate 05-MAR-2002`, and `--strict` exited 0 — on a header that contradicts
      itself in a way the specification forbids, and which every other self-contradicting header
      field in this parser reports.
    */
    const { parseHeader } = await import('../dist/index.js');
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-twodates-'));
    temporaries.push(scratch);
    const written = (name, startDate, recording) => {
      const at = path.join(scratch, `${name}.edf`);
      writeEdf({
        path: at, reserved: 'EDF+C', startDate, startTime: '22.15.00', recording,
        numRecords: 1, recordDuration: 1,
        signals: [
          { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000,
            digMax: 1000, samplesPerRecord: 2, gen: () => 1 },
        ],
      });
      return at;
    };
    const raised = async (file) =>
      parseHeader(await readFile(file), 1024).diagnostics.filter(
        (d) => d.code === 'START_DATE_MISMATCH',
      );

    const wrongDay = await raised(written('day', '02.03.02', 'Startdate 05-MAR-2002 X X X'));
    assert.equal(wrongDay.length, 1, JSON.stringify(wrongDay));
    assert.match(wrongDay[0].message, /"02\.03\.02"/u, wrongDay[0].message);
    assert.match(wrongDay[0].message, /"05-MAR-2002"/u, wrongDay[0].message);

    // A different month and a different year, each on their own.
    assert.equal((await raised(written('month', '02.03.02', 'Startdate 02-APR-2002 X X X'))).length, 1);
    assert.equal((await raised(written('year', '02.03.02', 'Startdate 02-MAR-1998 X X X'))).length, 1);

    // And the dates that agree, in either century, say nothing — nor does a file with no
    // Startdate to compare against, nor one whose month is not a month.
    for (const [name, date, recording] of [
      ['same', '02.03.02', 'Startdate 02-MAR-2002 X X X'],
      ['old', '02.03.84', 'Startdate 02-MAR-1984 X X X'],
      ['ahead', '02.03.85', 'Startdate 02-MAR-2085 X X X'],
      ['none', '02.03.02', 'X X X X'],
      ['junk', '02.03.02', 'Startdate 02-XXX-2002 X X X'],
    ]) {
      assert.deepEqual(await raised(written(name, date, recording)), [], name);
    }
  });

  it('takes the century from the year an EDF+ file writes in full', async () => {
    /*
      The date field is `dd.mm.yy`, so the rule above is the only thing that can decide the
      century — on a plain EDF file. An EDF+ one writes the year again, in four digits, in the
      recording identification field, which the specification requires to agree with the date
      field. Nothing here read it.

      So a 1984 sleep study digitised into EDF+ was reported as recorded in 2084, and a
      recording made in 2085 as 1985, each on a file that states the year plainly four fields
      earlier. A century is not a rounding: `start_datetime_local` is what output-files points
      at for turning `time_s` into an absolute instant, and it is what every citation of when
      the data was taken comes from.
    */
    const { parseHeader } = await import('../dist/index.js');
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-century-'));
    temporaries.push(scratch);
    const dated = (name, startDate, recording) => {
      const at = path.join(scratch, `${name}.edf`);
      writeEdf({
        path: at,
        reserved: 'EDF+C',
        startDate,
        startTime: '10.20.30',
        recording,
        numRecords: 1,
        recordDuration: 1,
        signals: [
          { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000,
            digMax: 1000, samplesPerRecord: 2, gen: () => 1 },
        ],
      });
      return at;
    };
    const year = async (file) =>
      parseHeader(await readFile(file), 1024).header.startDateTime?.getUTCFullYear() ?? null;

    // Both centuries the rule gets wrong, and both are stated in full by the file.
    assert.equal(await year(dated('old', '02.03.84', 'Startdate 02-MAR-1984 X X X')), 1984);
    assert.equal(await year(dated('new', '02.03.85', 'Startdate 02-MAR-2085 X X X')), 2085);

    // The rule still decides everything else: no Startdate, a Startdate that contradicts the
    // date field, and one whose year does not end in the digits the header wrote.
    assert.equal(await year(dated('bare', '02.03.84', 'X X X X')), 2084);
    assert.equal(await year(dated('other-day', '02.03.84', 'Startdate 05-MAR-1984 X X X')), 2084);
    assert.equal(await year(dated('other-year', '02.03.84', 'Startdate 02-MAR-1998 X X X')), 2084);
    assert.equal(await year(dated('junk', '02.03.84', 'Startdate 02-XXX-1984 X X X')), 2084);

    // And an agreeing Startdate on a date the rule already gets right changes nothing.
    assert.equal(await year(dated('agree', '02.03.02', 'Startdate 02-MAR-2002 X X X')), 2002);
  });

  it('derives per-channel sampling rates, including from fractional record durations', async () => {
    const file = await load('fractional-recdur.edf');
    assert.equal(file.header.recordDuration, 0.1);
    assert.equal(file.dataSignals[0].samplingRate, 250);
  });

  it('reads labels, units and calibration for every signal', async () => {
    const file = await load('mixed-rates.edf');
    assert.deepEqual(
      file.dataSignals.map((s) => [s.label, s.physicalDimension, s.samplingRate]),
      [
        ['EEG Fpz-Cz', 'uV', 256],
        ['ECG', 'mV', 128],
        ['Temp rectal', 'degC', 1],
      ],
    );
  });

  it('separates annotation channels from signal channels', async () => {
    const file = await load('annotations.edf');
    assert.equal(file.header.continuity, 'EDF+C');
    assert.equal(file.dataSignals.length, 1);
    assert.equal(file.annotationSignals.length, 1);
    assert.equal(file.annotationSignals[0].label, 'EDF Annotations');
  });
});

describe('diagnostics', () => {
  it('warns about differing sampling rates', async () => {
    const file = await load('mixed-rates.edf');
    // The file-level diagnostic describes the recording, and is what a caller reading a
    // header without planning a conversion gets. A conversion reports its own; see convert.test.js.
    assert.ok(codes(file).includes('MIXED_SAMPLING_RATES'));
  });

  it('warns that an EDF+D recording is discontinuous', async () => {
    const file = await load('discontinuous.edf');
    assert.equal(file.header.continuity, 'EDF+D');
    assert.ok(codes(file).includes('DISCONTINUOUS'));
  });

  it('trusts the file over the header when the record count disagrees', async () => {
    const file = await load('truncated.edf');
    assert.equal(file.header.declaredRecordCount, 10);
    assert.equal(file.recordCount, 4, 'only four records were actually written');
    assert.ok(codes(file).includes('RECORD_COUNT_MISMATCH'));
  });

  it('accounts for every byte after the header, as records or as a remainder', async () => {
    /*
      `TRAILING_BYTES` is one of the eight warnings the reference page gives a section to, and
      nothing under test/ had ever raised it: the only occurrences of the name were the docs
      cross-check, which reads the pages and confirms a code documented somewhere is documented
      everywhere. That is a check on prose.

      What it and `RECORD_COUNT_MISMATCH` divide between them is the file: `recordCount` is
      `floor(dataBytes / recordBytes)` and the remainder is what this reports, so a byte is
      either inside a record that gets converted or named as ignored, and never both or
      neither. The boundary is a whole record — one byte short of it is a remainder, one byte
      into it is a record the header did not declare — and it is the boundary a reader has to
      trust when a recording was cut short mid-write.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-trailing-'));
    temporaries.push(dir);
    const { appendFileSync, copyFileSync } = await import('node:fs');
    const base = fixture('tiny.edf');
    // Two channels of ten samples per record, two bytes each: 40 bytes to a record.
    const RECORD = (await load('tiny.edf')).header.recordBytes;
    assert.equal(RECORD, 40, 'the fixture changed shape, so the sizes below mean something else');
    const grown = async (extra) => {
      const at = path.join(dir, `plus${extra}.edf`);
      copyFileSync(base, at);
      if (extra > 0) appendFileSync(at, Buffer.alloc(extra));
      const file = await EdfFile.open(at);
      open.push(file);
      return { file, trailing: file.diagnostics.find((d) => d.code === 'TRAILING_BYTES') };
    };

    for (const [extra, records, remainder] of [
      [0, 2, 0], [1, 2, 1], [RECORD - 1, 2, RECORD - 1],
      [RECORD, 3, 0], [RECORD + 1, 3, 1], [2 * RECORD, 4, 0],
    ]) {
      const { file, trailing } = await grown(extra);
      assert.equal(file.recordCount, records, `+${extra} bytes should be ${records} records`);
      if (remainder === 0) {
        assert.equal(trailing, undefined, `+${extra} bytes must raise nothing`);
      } else {
        assert.ok(trailing, `+${extra} bytes must be reported`);
        assert.match(
          trailing.message,
          new RegExp(`^${remainder} byte${remainder === 1 ? '' : 's'} after the last complete`, 'u'),
          trailing.message,
        );
      }
      // Nothing is lost and nothing is counted twice: the records converted plus the bytes
      // reported as ignored are exactly what follows the header.
      assert.equal(
        file.recordCount * RECORD + remainder,
        file.fileSize - file.header.headerBytes,
        `+${extra} bytes: the file is not fully accounted for`,
      );
    }
  });

  it('accepts a record count of -1, which the spec permits', async () => {
    const file = await load('unknown-records.edf');
    assert.equal(file.header.declaredRecordCount, -1);
    assert.equal(file.recordCount, 4);
    assert.ok(codes(file).includes('RECORD_COUNT_UNKNOWN'));
  });

  it('flags duplicate labels and inverted physical ranges', async () => {
    const file = await load('quirky-labels.edf');
    assert.ok(codes(file).includes('DUPLICATE_LABEL'));
    assert.ok(codes(file).includes('INVERTED_PHYSICAL_RANGE'));
  });

  it('counts the duplicate positions it does not name', async () => {
    /*
      Nothing bounds how many channels share a label — EDF labels are free text and a montage
      may repeat one across every channel it has — and this message named all of them with a
      plain `join`, so twenty positions came out as a 110-character parenthetical and two
      hundred as an 1,100-character one, with the sentence that matters at the front of it.

      Every other list of something the file controls goes through `listed`, which shows eight
      and counts the rest: the rate warning, the leftover-file warning, the record indices in
      the timekeeping warning, and `EMPTY_LABEL` in this same parser. This was the last one
      still rolling its own.

      The ordinary duplicate is two channels, and `listed` renders those unchanged, so both
      ends are checked here.
    */
    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-dup-'));
    temporaries.push(scratch);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');

    const shared = (count) => {
      const at = path.join(scratch, `dup-${count}.edf`);
      writeEdf({
        path: at,
        numRecords: 1,
        recordDuration: 1,
        signals: Array.from({ length: count }, () => ({
          label: 'T8-P8', dimension: 'uV', physMin: -100, physMax: 100,
          digMin: -1000, digMax: 1000, samplesPerRecord: 2, gen: () => 100,
        })),
      });
      return at;
    };

    const two = await EdfFile.open(shared(2));
    const twenty = await EdfFile.open(shared(20));
    try {
      const of = (file) =>
        file.diagnostics.find((d) => d.code === 'DUPLICATE_LABEL').message;
      assert.match(of(two), /\(positions 0, 1\)/u, of(two));
      assert.match(of(twenty), /\(positions 0, 1, 2, 3, 4, 5, 6, 7 and 12 more\)/u, of(twenty));
      assert.ok(of(twenty).length < 120, `the message runs to ${of(twenty).length} characters`);
    } finally {
      await two.close();
      await twenty.close();
    }
  });

  it('says when it moved the start instant off the second the header names', async () => {
    /*
      `23.59.60` is how UTC writes a leap second, and the parser admits it on purpose: refusing
      would throw away a date that is otherwise perfectly good over one second. What it does
      with it is `Math.min(ss, 59)`, because `Date.UTC(..., 60)` rolls into the next minute and
      would move the instant fifty-nine seconds further.

      Keeping the nearest instant is right. Keeping it in silence was not — `--info` printed
      `Recorded 2020-01-01 23:59:59` and metadata.json recorded the same for a header saying
      something else, with `--strict` exiting 0. Every other header field this tool cannot
      represent exactly reports itself, and this is the one `time_s` is documented as being
      added to.

      Every other out-of-range field in these two is refused outright and raises
      START_TIME_UNREADABLE: hour 24, minute 60, day 0, month 13, the twenty-ninth of a
      February that has twenty-eight days. The sixtieth second was the only one that was both
      accepted and changed.
    */
    const { parseHeader } = await import('../dist/index.js');
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-leap-'));
    temporaries.push(scratch);
    const at = (time) => {
      const file = path.join(scratch, `t${time.replaceAll('.', '')}.edf`);
      writeEdf({
        path: file,
        startDate: '01.01.20',
        startTime: time,
        numRecords: 1,
        recordDuration: 1,
        signals: [
          { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000,
            digMax: 1000, samplesPerRecord: 2, gen: () => 1 },
        ],
      });
      return file;
    };

    const leap = parseHeader(await readFile(at('23.59.60')), 1024);
    assert.ok(
      leap.diagnostics.some((d) => d.code === 'LEAP_SECOND_START'),
      `a sixtieth second raised ${leap.diagnostics.map((d) => d.code).join(', ') || 'nothing'}`,
    );
    assert.equal(leap.header.startDateTime?.toISOString(), '2020-01-01T23:59:59.000Z');
    assert.equal(leap.header.startTimeRaw, '23.59.60', 'the field itself is echoed as written');
    const said = leap.diagnostics.find((d) => d.code === 'LEAP_SECOND_START');
    assert.match(said.message, /"23\.59\.60"/u, 'the message quotes what the header says');

    // The second before it is an ordinary time and says nothing.
    const ordinary = parseHeader(await readFile(at('23.59.59')), 1024);
    assert.deepEqual(
      ordinary.diagnostics.filter((d) => d.code === 'LEAP_SECOND_START'),
      [],
    );
    assert.equal(ordinary.header.startDateTime?.toISOString(), '2020-01-01T23:59:59.000Z');

    /*
      And the fields that are refused rather than moved keep being refused — at an hour where
      the refusal is the only thing refusing them.

      The parser bounds every field and then builds the date and checks it did not roll over,
      which is a second guard for anything that changes the day: hour 24, month 13, the
      thirty-second of a month. Minutes and seconds do not change the day. `10.60.00` rolls to
      11:00 on the same date and passes the round-trip check completely, so the bound is the
      only thing between the file and a start time an hour later than it says — and the bound
      was tested at `23.60.00`, which rolls midnight and would have been caught either way.
      Widen `mi > 59` to `mi > 60` and every test still passes while a header saying 10:60
      reports 11:00.
    */
    for (const time of ['24.00.00', '23.60.00', '10.60.00', '10.59.61', '10.60.61']) {
      const refused = parseHeader(await readFile(at(time)), 1024);
      assert.equal(refused.header.startDateTime, null, `${time} is not a time`);
      assert.ok(refused.diagnostics.some((d) => d.code === 'START_TIME_UNREADABLE'), time);
      assert.ok(!refused.diagnostics.some((d) => d.code === 'LEAP_SECOND_START'), time);
    }

    /*
      And the round-trip check itself, which the paragraph above names and nothing exercised.

      Every date below passes the bounds — the day is 1 to 31 and the month 1 to 12 — and is
      still not a date. `Date.UTC` does not refuse them; it rolls them forward, so the guard
      that compares the month and day back is the only thing between the header and a day it
      does not name. Take it out and all 419 tests pass while `31.02.85` reports
      `1985-03-03`, `31.04.85` reports `1985-05-01` and `29.02.23` reports `2023-03-01` —
      each with no warning at all, in the field the documented recipe for an absolute instant
      depends on.
    */
    const on = (date) => {
      const file = path.join(scratch, `d${date.replaceAll('.', '')}.edf`);
      writeEdf({
        path: file,
        startDate: date,
        startTime: '12.00.00',
        numRecords: 1,
        recordDuration: 1,
        signals: [
          { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000,
            digMax: 1000, samplesPerRecord: 2, gen: () => 1 },
        ],
      });
      return file;
    };
    for (const date of ['31.02.85', '31.04.85', '29.02.23', '30.02.24', '31.06.85', '31.09.85']) {
      const refused = parseHeader(await readFile(on(date)), 1024);
      assert.equal(refused.header.startDateTime, null, `${date} is not a date`);
      assert.ok(refused.diagnostics.some((d) => d.code === 'START_TIME_UNREADABLE'), date);
    }
    // The days beside them are dates, including the one leap day that exists.
    for (const [date, instant] of [
      ['28.02.85', '1985-02-28T12:00:00.000Z'],
      ['29.02.24', '2024-02-29T12:00:00.000Z'],
      ['30.04.85', '1985-04-30T12:00:00.000Z'],
      ['31.03.85', '1985-03-31T12:00:00.000Z'],
    ]) {
      const read = parseHeader(await readFile(on(date)), 1024);
      assert.equal(read.header.startDateTime?.toISOString(), instant, date);
      assert.ok(!read.diagnostics.some((d) => d.code === 'START_TIME_UNREADABLE'), date);
    }

    // The neighbours of both, which are times and stay times.
    for (const [time, instant] of [
      ['10.59.59', '2020-01-01T10:59:59.000Z'],
      ['23.59.59', '2020-01-01T23:59:59.000Z'],
      ['00.00.00', '2020-01-01T00:00:00.000Z'],
    ]) {
      const read = parseHeader(await readFile(at(time)), 1024);
      assert.equal(read.header.startDateTime?.toISOString(), instant, time);
    }
  });

  it('flags a digital range that cannot be scaled', async () => {
    const file = await load('degenerate-range.edf');
    assert.ok(codes(file).includes('DEGENERATE_DIGITAL_RANGE'));
  });
});

describe('errors', () => {
  it('reports a missing file without leaking a raw errno', async () => {
    await assert.rejects(() => EdfFile.open(fixture('does-not-exist.edf')), (error) => {
      assert.ok(error instanceof EdfError);
      assert.equal(error.code, 'UNREADABLE');
      assert.match(error.message, /no such file/);
      return true;
    });
  });

  it('refuses a file that is not EDF at all', async () => {
    await assert.rejects(
      () => EdfFile.open(fileURLToPath(import.meta.url)),
      (error) => error instanceof EdfError,
    );
  });

  it('reports a recording it is not allowed to read as one it cannot read', async () => {
    /*
      `stat` needs the parent directory searchable and says nothing about the file's own mode,
      so a recording with no read permission passed it and failed at the open two lines later,
      which was not wrapped. It escaped as Node's own error: the CLI printed
      `error: EACCES: permission denied, open '...'` where a missing file prints `Cannot read
      "...": no such file`, and the library threw a plain Error whose `code` was `EACCES`.

      api.md says `UNREADABLE` covers "a permission failure" and to branch on `code`, never on
      the message — which for the commonest permission failure there is fell through to the
      consumer's generic handler.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-noread-'));
    temporaries.push(dir);
    const denied = path.join(dir, 'denied.edf');
    await copyFile(fixture('annotations.edf'), denied);
    await chmod(denied, 0o000);

    // Root reads a mode-000 file regardless, so there would be nothing to assert.
    const readable = await EdfFile.open(denied).then(
      (file) => file.close().then(() => true),
      () => false,
    );
    if (readable) return;

    await assert.rejects(() => EdfFile.open(denied), (error) => {
      assert.ok(error instanceof EdfError, `${error.name}: not an EdfError`);
      assert.equal(error.code, 'UNREADABLE');
      assert.match(error.message, /Cannot read .*: permission denied/u);
      return true;
    });

    // Restored so the temporary directory can be removed on the way out.
    await chmod(denied, 0o644);
  });

  it('refuses the two headers whose refusals nothing had ever asked for', async () => {
    /*
      `INVALID_SIGNAL_COUNT` and `INVALID_RECORD_DURATION` are two of the eight fatal errors.
      Both are named in the exported union, both have a section in warnings-and-errors.md
      quoting the exact line they print, and neither had ever been raised by anything in this
      suite — the only occurrence of either name under test/ was the docs cross-check, which
      reads the pages and confirms a code documented somewhere is documented everywhere. That
      is a check on prose. Nothing had ever handed the parser a header that produces one.

      Which is measurable rather than a worry: weaken both guards — `signalCount < 0` and
      `!(recordDuration >= 0)`, the off-by-one either would be written as — and all 384 tests
      still pass. What gets through then is not caught further down so much as mislabelled. A
      record duration of zero makes every rate in the file `samples / 0`, and the run ends on

          error: --start 0s is at or past the end of this 0s recording.

      naming an option the command line never carried, about a recording whose real problem is
      four bytes in its header.
    */
    const { parseHeader } = await import('../dist/index.js');
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-refusals-'));
    temporaries.push(scratch);
    const source = path.join(scratch, 'one.edf');
    writeEdf({
      path: source,
      numRecords: 1,
      recordDuration: 1,
      signals: [
        { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000,
          digMax: 1000, samplesPerRecord: 2, gen: () => 500 },
      ],
    });
    const original = await readFile(source);

    // The last twelve bytes of the fixed header: duration of a data record, then the
    // number of signals. Same layout the parser reads them from.
    const RECORD_DURATION = [244, 8];
    const SIGNAL_COUNT = [252, 4];
    const patched = ([at, width], field) => {
      const bytes = Buffer.from(original);
      bytes.write(field.padEnd(width).slice(0, width), at, 'latin1');
      return bytes;
    };

    for (const [at, field, code, message] of [
      [SIGNAL_COUNT, '0', 'INVALID_SIGNAL_COUNT', 'Header declares 0 signals; expected at least 1.'],
      [SIGNAL_COUNT, '-1', 'INVALID_SIGNAL_COUNT', 'Header declares -1 signals; expected at least 1.'],
      [RECORD_DURATION, '0', 'INVALID_RECORD_DURATION',
        'Header declares a data record duration of 0s; expected a positive number.'],
      [RECORD_DURATION, '-1', 'INVALID_RECORD_DURATION',
        'Header declares a data record duration of -1s; expected a positive number.'],
      [RECORD_DURATION, '-0.001', 'INVALID_RECORD_DURATION',
        'Header declares a data record duration of -0.001s; expected a positive number.'],
    ]) {
      assert.throws(
        () => parseHeader(patched(at, field), original.length),
        (error) => error.code === code && error.message === message,
        `"${field}" at ${at[0]} was accepted, or refused in other words`,
      );
    }

    // And the smallest header either guard permits is still read: one signal, one second.
    const { header } = parseHeader(original, original.length);
    assert.equal(header.signals.length, 1);
    assert.equal(header.recordDuration, 1);
  });
});

describe('digital to physical conversion', () => {
  it('maps the calibration points exactly', async () => {
    const file = await load('tiny.edf');
    const signal = file.dataSignals[0]; // -100..100 uV over -1000..1000
    const scale = makeScaler(signal);
    assert.equal(scale(-1000), -100);
    assert.equal(scale(1000), 100);
    assert.equal(scale(0), 0);
    assert.equal(scale(1), 0.1);
  });

  it('is correctly rounded where the naive formula loses bits', async () => {
    // A +/-800 uV channel over a 12-bit range: the exact value for digital 0 is
    // 800/4095. Computing it as (d - digMin) * gain + physMin cancels away the low
    // bits and yields ...467 instead.
    const file = await load('quirky-labels.edf');
    const scale = makeScaler(file.dataSignals[0]);
    assert.equal(scale(0), 0.19536019536019536);
  });

  it('yields NaN when the digital range is degenerate, rather than inventing a value', async () => {
    // The header gives one calibration point twice, so there is no mapping and no
    // physical value to report. Returning the physical minimum would fill the column
    // with numbers that look like a flat recording to whoever opens the CSV next.
    const file = await load('degenerate-range.edf');
    const scale = makeScaler(file.dataSignals[0]);
    assert.ok(Number.isNaN(scale(0)));
    assert.ok(Number.isNaN(scale(123)));
  });

  it('still scales the channel beside a degenerate one', async () => {
    const file = await load('degenerate-range.edf');
    const ok = file.dataSignals.find((s) => s.label === 'ok');
    const scale = makeScaler(ok);
    assert.ok(Number.isFinite(scale(0)), 'a valid channel must be unaffected');
  });

  it('honours an inverted physical range rather than silently correcting it', async () => {
    const file = await load('quirky-labels.edf');
    const inverted = file.dataSignals.find((s) => s.label === 'inverted');
    const scale = makeScaler(inverted);
    assert.equal(scale(-1000), 100);
    assert.equal(scale(1000), -100);
  });

  it('chooses enough decimals to keep adjacent digital codes distinct', async () => {
    const file = await load('tiny.edf');
    const [uv, mv] = file.dataSignals;
    assert.equal(decimalsForSignal(uv), 3); // step 0.1
    assert.equal(decimalsForSignal(mv), 5); // step 0.001
  });

  it('agrees with itself about whether a channel hit the ceiling', async () => {
    /*
      Two functions and one formula. `decimalsForSignal` works out how many places a step needs
      and clamps it; `decimalsAreClamped` answers whether that clamp happened, and it worked the
      number out again with its own copy of `Math.ceil(-Math.log10(step)) + 2`.

      Their only job is to give the same answer, and nothing compared them. Change either `+ 2`
      and they part at the boundary — a channel whose precision really was capped is reported as
      not capped, VALUE_RESOLUTION goes unraised, and its codes print indistinguishable in
      silence, which is the exact thing that warning exists to say. Reachable, too: the ceiling
      is a hundred places, and an eight-character physical bound reaches it at `1e-99`.

      Asked without knowing the formula: `decimalsForSignal` takes the ceiling as an argument, so
      handing it one nothing can reach gives the unclamped answer, and "was it clamped" is
      whether the two differ.
    */
    const { decimalsAreClamped } = await import('../dist/edf/scale.js');
    const signal = (physicalMax) => ({
      index: 0, label: 'x', digitalMin: -1, digitalMax: 0, physicalMin: 0, physicalMax,
    });
    const cappedByTheCeiling = (s) =>
      decimalsForSignal(s, Number.MAX_SAFE_INTEGER) > decimalsForSignal(s);

    // Across the whole range a step can take, including both sides of the boundary.
    for (const exponent of [1, 0, -1, -3, -20, -96, -97, -98, -99, -100, -200, -300]) {
      const s = signal(10 ** exponent);
      assert.equal(
        decimalsAreClamped(s),
        cappedByTheCeiling(s),
        `a step of 1e${exponent} needs ${decimalsForSignal(s, Number.MAX_SAFE_INTEGER)} places`,
      );
    }

    // The boundary itself, named: a hundred places is the ceiling, so needing exactly a
    // hundred is not clamped and needing one more is.
    assert.equal(decimalsForSignal(signal(1e-98)), 100);
    assert.equal(decimalsAreClamped(signal(1e-98)), false);
    assert.equal(decimalsForSignal(signal(1e-99)), 100);
    assert.equal(decimalsAreClamped(signal(1e-99)), true);

    // And a channel with no step at all is neither: both decline it the same way.
    const flat = { index: 0, label: 'x', digitalMin: 5, digitalMax: 5, physicalMin: 0, physicalMax: 1 };
    assert.equal(decimalsForSignal(flat), 3);
    assert.equal(decimalsAreClamped(flat), false);
  });
});

describe('reading samples', () => {
  it('returns the digital values that were written', async () => {
    const file = await load('tiny.edf');
    const signal = file.dataSignals[0];
    const batches = [];
    for await (const batch of file.readRecords()) {
      for (let r = 0; r < batch.recordCount; r++) {
        for (let i = 0; i < signal.samplesPerRecord; i++) {
          batches.push(file.sampleAt(batch, r, signal, i));
        }
      }
    }
    // The fixture writes digital value === global sample index.
    assert.deepEqual(batches, Array.from({ length: 20 }, (_, i) => i));
  });

  it('produces the same samples no matter how small the read chunks are', async () => {
    const file = await load('mixed-rates.edf');
    const signal = file.dataSignals[0];
    const readAll = async (chunkBytes) => {
      const out = [];
      for await (const batch of file.readRecords({ chunkBytes })) {
        for (let r = 0; r < batch.recordCount; r++) {
          for (let i = 0; i < signal.samplesPerRecord; i++) out.push(file.sampleAt(batch, r, signal, i));
        }
      }
      return out;
    };
    assert.deepEqual(await readAll(1), await readAll(1 << 20));
  });

  it('names the option when chunkBytes is not a number of bytes', async () => {
    /*
      `chunkBytes: NaN` came back as `RangeError: The value of "size" is out of range` from
      inside Node's Buffer.alloc, with no mention of the option that caused it — while a
      fractional startRecord gets a typed EdfError naming the field. Every other option here
      is checked; this one reached the allocator.
    */
    const file = await load('tiny.edf');
    for (const value of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        async () => {
          for await (const unused of file.readRecords({ chunkBytes: value })) break;
        },
        (error) => {
          assert.equal(error.constructor.name, 'EdfError');
          assert.match(error.message, /chunkBytes must be a positive number of bytes/u);
          return true;
        },
        `chunkBytes: ${value}`,
      );
    }

    // A budget below one record still reads one record, which is what the docs promise.
    let records = 0;
    for await (const batch of file.readRecords({ chunkBytes: 1 })) records += batch.recordCount;
    assert.equal(records, 2);
    await file.close();
  });

  it('hands out views of one reused buffer, which is what the API reference says', async () => {
    /*
      api.md calls this the one contract that fails silently if you get it wrong, so the
      shape of it is worth pinning rather than describing. It also used to describe it
      loosely — "kept[0], kept[1] and kept[2] are all identical" — and the obvious test for
      that, object identity, returns false, which would talk a reader out of believing a
      warning that is true.
    */
    const file = await load('long-stream.edf');
    const kept = [];
    const copies = [];
    // 400 records of 512 bytes in 4608-byte batches: 44 full ones and a 2048-byte tail,
    // which is the arrangement the reference describes and the one that misleads.
    for await (const batch of file.readRecords({ chunkBytes: 5000 })) {
      kept.push(batch.data);
      copies.push(new Uint8Array(batch.data));
    }
    assert.ok(kept.length >= 3, `expected several batches, got ${kept.length}`);

    // Distinct objects, one buffer. Both halves of that matter to a caller.
    assert.notEqual(kept[0], kept[1], 'each iteration hands out its own view');
    assert.ok(
      kept.every((view) => view.buffer === kept[0].buffer && view.byteOffset === 0),
      'and every one of them looks at the same memory from the same place',
    );

    // The last batch is short, so what an early view shows afterwards is a seam: the last
    // batch's bytes for as far as they go, the previous batch's beyond that.
    const last = kept.at(-1);
    assert.ok(last.length < kept[0].length, 'the final batch is a partial one');
    assert.deepEqual(
      [...kept[0].subarray(0, last.length)],
      [...copies.at(-1)],
      'the head of a stale view is the last batch',
    );
    assert.deepEqual(
      [...kept[0].subarray(last.length)],
      [...copies.at(-2).subarray(last.length)],
      'and its tail is still the one before',
    );

    // Which is exactly what copying avoids, and why the reference tells you to copy.
    assert.notDeepEqual([...kept[0]], [...copies[0]]);
    await file.close();
  });
});

describe('BDF (BioSemi 24-bit)', () => {
  it('recognises the format from its version bytes', async () => {
    const file = await load('biosemi.bdf');
    assert.equal(file.header.isBdf, true);
    assert.equal(file.header.bytesPerSample, 3);
    assert.equal(file.header.signalCount, 2);
  });

  it('sizes data records by three bytes per sample', async () => {
    const file = await load('biosemi.bdf');
    // 2 signals * 8 samples * 3 bytes
    assert.equal(file.header.recordBytes, 48);
    assert.equal(file.recordCount, 2);
  });

  it('decodes 24-bit samples, including values no 16-bit field could hold', async () => {
    const file = await load('biosemi.bdf');
    const signal = file.dataSignals[1];
    const batch = (await file.readRecords().next()).value;
    const digital = [0, 1, 2, 3].map((i) => file.sampleAt(batch, 0, signal, i));
    assert.deepEqual(digital, [0, -1000000, -2000000, -3000000]);
    assert.ok(digital[3] < -32768, 'a 16-bit reader could not represent this sample');
  });

  it('understands BDF+ markers, which are spelled differently from EDF+', async () => {
    const file = await load('biosemi-plus.bdf');
    // The reserved field says "BDF+D" and the channel is "BDF Annotations".
    assert.equal(file.header.isBdf, true);
    assert.equal(file.header.isEdfPlus, true);
    assert.equal(file.header.continuity, 'EDF+D', 'normalised to a single continuity marker');
    assert.equal(file.annotationSignals.length, 1);
    assert.equal(file.dataSignals.length, 1);
  });

  it('recovers gaps and annotations from a discontinuous BDF+ file', async () => {
    const file = await load('biosemi-plus.bdf');
    const { annotations, recordStarts } = await file.readAnnotations();
    assert.deepEqual([...recordStarts], [0, 1, 20]);
    assert.deepEqual(annotations.map((a) => [a.onset, a.duration, a.text]), [[1.5, 0.25, 'Blink']]);
  });

  it('sign-extends negative 24-bit samples correctly', async () => {
    const file = await load('biosemi.bdf');
    const scale = makeScaler(file.dataSignals[1]);
    // -1000000 digital over a -8388608..8388607 range mapped to -262144..262144 uV
    assert.ok(scale(-1000000) < 0, 'must stay negative, not wrap to a huge positive');
    assert.ok(Math.abs(scale(-1000000) - -31249.9862) < 1e-3);
  });
});

describe('record bounds', () => {
  // A fractional index went straight into `headerBytes + record * recordBytes`, so
  // reading from 1.5 began half a record in and decoded every sample from the wrong
  // offset — returning channel 2's values under channel 1's signal, with no error.
  it('rejects a fractional record index rather than reading from mid-record', async () => {
    const file = await load('tiny.edf');
    for (const options of [{ startRecord: 1.5 }, { endRecord: 0.5 }]) {
      await assert.rejects(
        async () => {
          for await (const _ of file.readRecords(options)) break;
        },
        /whole record index/u,
        `should reject ${JSON.stringify(options)}`,
      );
    }
  });

  it('still clamps whole-number bounds that fall outside the file', async () => {
    const file = await load('tiny.edf');
    const read = async (options) => {
      let n = 0;
      for await (const batch of file.readRecords(options)) n += batch.recordCount;
      return n;
    };
    assert.equal(await read({ startRecord: -5 }), file.recordCount);
    assert.equal(await read({ endRecord: 99999 }), file.recordCount);
    assert.equal(await read({ startRecord: 1, endRecord: 1 }), 0);
  });
});

describe('EDF+ annotations', () => {
  it('decodes onset, duration and text', async () => {
    const file = await load('annotations.edf');
    const { annotations } = await file.readAnnotations();
    assert.deepEqual(
      annotations.map((a) => [a.onset, a.duration, a.text]),
      [
        [0.5, 1, 'Sleep stage W'],
        [1.25, null, 'Lights off'],
        [2, 0.5, 'Seizure onset'],
      ],
    );
  });

  it('keeps the bytes an annotation holds, whichever encoding wrote them', async () => {
    /*
      EDF+ says the annotation channel holds UTF-8, and this decoded it as UTF-8 and took what
      came back. What comes back for bytes that are not UTF-8 is U+FFFD, one per malformed
      sequence — so an event a recorder described `café` in latin1, which most of the older
      ones write, was exported as `caf\uFFFD`: a character the file does not contain, in a text
      column of a tool whose whole claim is that it does not invent one. Exit 0, no warning.

      The same byte in a channel label comes out `é`, because header text goes through
      `decodeLatin1`, whose point is that every byte becomes the code point of the same value.
      Two encodings for free text out of one file, differing only on the side that can invent.

      Decided rather than guessed: bytes that decode as UTF-8 are UTF-8 — including a genuine
      U+FFFD, which is `EF BF BD` and valid — and bytes that do not are read the way the rest
      of the parser reads bytes.
    */
    const { decodeRecordAnnotations } = await import('../dist/index.js');
    const T = String.fromCharCode(20);
    const Z = String.fromCharCode(0);
    const tal = (textBytes) =>
      Buffer.concat([
        Buffer.from(`+0${T}${T}${Z}+1${T}`, 'latin1'),
        Buffer.from(textBytes),
        Buffer.from(`${T}${Z}`, 'latin1'),
      ]);
    const only = (bytes) => decodeRecordAnnotations(tal(bytes), 0).annotations[0];

    // latin1: one byte per character, and 0xE9 is é.
    assert.equal(only(Buffer.from('café', 'latin1')).text, 'café');
    assert.equal(only(Buffer.from([0x53, 0xf6, 0x76, 0x6e])).text, 'Sövn');

    // utf-8 still decodes as utf-8, which is what the specification asks for.
    assert.equal(only(Buffer.from('café', 'utf8')).text, 'café');
    assert.equal(only(Buffer.from('δείγμα', 'utf8')).text, 'δείγμα');
    assert.equal(only(Buffer.from('スリープ', 'utf8')).text, 'スリープ');

    // And a replacement character the file really holds is left where it is.
    assert.equal(only(Buffer.from('a\uFFFDb', 'utf8')).text, 'a\uFFFDb');

    // Nothing anywhere comes back as a replacement character the file did not write.
    for (const bytes of [
      Buffer.from([0xe9]), Buffer.from([0x80]), Buffer.from([0xff, 0xfe]),
      Buffer.from([0x41, 0xc3]), Buffer.from([0xed, 0xa0, 0x80]),
    ]) {
      const text = only(bytes).text;
      assert.ok(!text.includes('\uFFFD'), `${[...bytes].join(' ')} decoded to ${JSON.stringify(text)}`);
      assert.equal(text.length, bytes.length, 'latin1 is one character per byte');
    }
  });

  it('leaves duration null when the annotation did not specify one', async () => {
    const file = await load('annotations.edf');
    const { annotations } = await file.readAnnotations();
    const lightsOff = annotations.find((a) => a.text === 'Lights off');
    assert.equal(lightsOff.duration, null, 'a missing duration is not the same as zero');
  });

  it('counts a duration it could not read rather than passing it off as absent', async () => {
    /*
      Both came out as `duration: null` and so as the same empty `duration_s` cell, which the
      documentation defines as meaning the file gave no duration. An event written with a
      duration of `abc` was therefore exported as an event that never had one, sitting beside
      a genuine one and indistinguishable from it, with nothing anywhere saying a field had
      been dropped.

      The event is still kept — the onset and the text are perfectly readable, and losing all
      three over one bad field is the wrong trade — but it is counted, and the conversion
      raises ANNOTATION_DECODE_FAILED for the count.
    */
    const { decodeRecordAnnotations } = await import('../dist/index.js');
    const T = String.fromCharCode(0x14);
    const D = String.fromCharCode(0x15);
    const Z = String.fromCharCode(0x00);
    const bytes = (text) => new TextEncoder().encode(text);

    const stated = decodeRecordAnnotations(
      bytes(`+0${T}${T}${Z}+0.25${D}abc${T}bad${T}${Z}+0.5${T}absent${T}${Z}`),
      0,
    );
    assert.equal(stated.unreadableDurations, 1, 'the unreadable one is counted');
    assert.deepEqual(
      stated.annotations.map((a) => [a.text, a.duration]),
      [['bad', null], ['absent', null]],
      'and both are still exported, since only the duration was unreadable',
    );

    // A TAL carrying several texts becomes several rows with the same empty cell, so the
    // count is of rows rather than of TALs.
    const many = decodeRecordAnnotations(bytes(`+1${D}x${T}one${T}two${T}three${T}${Z}`), 0);
    assert.equal(many.annotations.length, 3);
    assert.equal(many.unreadableDurations, 3);

    // Nothing is counted when the file simply said nothing, which is the common case and
    // must stay quiet.
    const quiet = decodeRecordAnnotations(bytes(`+2${T}plain${T}${Z}+3${D}1.5${T}timed${T}${Z}`), 0);
    assert.equal(quiet.unreadableDurations, 0);
    assert.equal(quiet.negativeDurations, 0);
    assert.deepEqual(quiet.annotations.map((a) => a.duration), [null, 1.5]);
  });

  it('reads a header number only where the header wrote one', async () => {
    /*
      `Number()` accepts a great deal more than EDF writes, and every one of those forms was a
      field this read as a number nobody had put there. A physical maximum of `0x64` came out
      as 100 — printed as `-100 to 100` in the channel table, written to channels.csv as
      `physical_max,100`, and used as the gain every sample on that channel was scaled by. A
      whole calibration invented out of four bytes that are not a decimal number, exit 0, no
      diagnostic anywhere. `0x02` in the signal-count field is a two-channel recording.

      The same mistake as `#0x2` reaching channel 2 through `--channels`, `--decimals 0o5`
      writing five places, and `--jobs 0x10` running sixteen, each of which has its own fix.
      Those were values somebody typed. These are the fields every number in the output is
      computed from.

      What the grammar has to keep is the exponent form: EDF gives a physical bound eight
      characters, and a magnetometer's range does not fit any other way. `1e30` is a header
      this tool has always read and a fixture depends on.
    */
    const { parseHeader } = await import('../dist/index.js');
    const scratch = await mkdtemp(path.join(tmpdir(), 'edf2csv-grammar-'));
    temporaries.push(scratch);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const source = path.join(scratch, 'plain.edf');
    writeEdf({
      path: source,
      numRecords: 1,
      recordDuration: 1,
      signals: [
        { label: 'ch1', dimension: 'uV', physMin: -100, physMax: 100, digMin: -1000,
          digMax: 1000, samplesPerRecord: 2, gen: () => 500 },
      ],
    });
    const original = await readFile(source);

    // Offsets from the layout at the top of header.ts: one signal, so its physical maximum is
    // 256 + 1 * 112, and the signal count is the last four bytes of the fixed header.
    const patched = (at, field) => {
      const bytes = Buffer.from(original);
      bytes.write(field.padEnd(8).slice(0, at === 252 ? 4 : 8), at, 'latin1');
      return bytes;
    };
    const PHYSICAL_MAX = 256 + 112;
    const SIGNAL_COUNT = 252;

    for (const [at, field, named] of [
      [PHYSICAL_MAX, '0x64', 'physical maximum (signal 0)'],
      [PHYSICAL_MAX, '0b1100100', 'physical maximum (signal 0)'],
      [PHYSICAL_MAX, '0o144', 'physical maximum (signal 0)'],
      [SIGNAL_COUNT, '0x02', 'number of signals'],
      [SIGNAL_COUNT, '0b10', 'number of signals'],
    ]) {
      assert.throws(
        () => parseHeader(patched(at, field), original.length),
        (error) =>
          error.code === 'BAD_HEADER_FIELD' &&
          error.message.includes(named) &&
          error.message.includes('is not a number'),
        `"${field}" at ${at} was read as a number`,
      );
    }

    /*
      The page lists four ways a header field is not a number, and one of them was under test.

      warnings-and-errors gives `BAD_HEADER_FIELD` a section, and it says the code is "raised
      when a numeric field is empty, when its contents don't parse as a finite number, when a
      field that must be a whole number is fractional, or when a signal declares a negative
      sample count". Everything above is the second of those. The other three each have their
      own sentence in the parser, each names the field, and none had ever been produced by
      anything here.
    */
    const RECORD_COUNT = 236;
    const SAMPLES_PER_RECORD = 256 + 216;
    for (const [at, field, expected] of [
      // Blank. Eight spaces is what a writer leaves when it has nothing to put there, and
      // `Number('')` is 0 — a physical maximum of zero, invented from an empty field.
      [PHYSICAL_MAX, '', /Header field "physical maximum \(signal 0\)" is empty\./u],
      // Fractional where the format says whole. Half a data record is not a count of them.
      [RECORD_COUNT, '1.5', /Header field "number of data records" must be a whole number \(found "1\.5"\)/u],
      // A negative sample count, which has its own sentence naming the signal and its label.
      [SAMPLES_PER_RECORD, '-1', /Signal 0 \("ch1"\) declares -1 samples per record\./u],
    ]) {
      assert.throws(
        () => parseHeader(patched(at, field), original.length),
        (error) => {
          assert.equal(error.code, 'BAD_HEADER_FIELD', `${JSON.stringify(field)}: ${error.message}`);
          assert.match(error.message, expected);
          return true;
        },
        `${JSON.stringify(field)} at ${at} was accepted`,
      );
    }

    // And the forms EDF does write are still read, exponent included.
    for (const field of ['100', '+100', '-100', '100.0', '1e30', '1E30', '.5']) {
      const { header } = parseHeader(patched(PHYSICAL_MAX, field), original.length);
      assert.equal(
        header.signals[0].physicalMax,
        Number(field),
        `"${field}" is a physical maximum EDF permits`,
      );
    }
  });

  it('never reads a padded duration field as a zero', async () => {
    /*
      `Number('   ')` is 0, the same rule that makes `Number('')` zero, one step along. So a
      TAL whose duration field held nothing but the writer's padding was exported as an event
      lasting exactly no time — `0.5,0,Spaces for a duration,0` — byte-identical in that
      column to the event below it whose file really did say `0`. An instantaneous event is a
      claim about the recording and no writer made it. Exit 0, no warning, nothing to read
      back that would show the difference.

      The empty field beside it has always been read as "the file stated no duration", and
      padding is that field with fill in it, so it takes the same answer. The genuine zero is
      asserted here too: an empty cell for every duration would satisfy the first half of this
      and lose the events that really are instantaneous.
    */
    const { decodeRecordAnnotations } = await import('../dist/index.js');
    const T = String.fromCharCode(0x14);
    const D = String.fromCharCode(0x15);
    const Z = String.fromCharCode(0x00);
    const bytes = (text) => new TextEncoder().encode(text);

    const padded = decodeRecordAnnotations(
      bytes(
        `+0${T}${T}${Z}` +
          `+0.5${D}   ${T}spaces${T}${Z}` +
          `+0.6${D}\t${T}tab${T}${Z}` +
          `+0.7${D}${T}nothing${T}${Z}` +
          `+0.8${D}0${T}a real zero${T}${Z}` +
          `+0.9${D}  2.5  ${T}padded but readable${T}${Z}`,
      ),
      0,
    );
    assert.deepEqual(
      padded.annotations.map((a) => [a.text, a.duration]),
      [
        ['spaces', null],
        ['tab', null],
        ['nothing', null],
        ['a real zero', 0],
        ['padded but readable', 2.5],
      ],
    );

    // Fill is an absent field, not an unreadable one: `abc` is a value this could not read
    // and is counted, whitespace is the writer filling a field it left empty and is not.
    assert.equal(padded.unreadableDurations, 0);
  });

  it('says when the header has no readable start instant', async () => {
    /*
      EDF gives the start date and time eight characters each and nothing enforces what goes
      in them. `--info` has always echoed the raw fields with "(unparseable)" beside them, but
      nothing was raised: the conversion exited 0, `--strict` passed, and metadata.json
      recorded `start_datetime_local: null` with no note against it — on the field
      output-files points at for turning `time_s` into a wall-clock instant.

      Every other unusable header field reports itself. This was the one that did not.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-startdate-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const channel = {
      label: 'ch', dimension: 'uV', physMin: -1, physMax: 1, digMin: -1, digMax: 1,
      samplesPerRecord: 2, gen: () => 0,
    };
    const bad = path.join(dir, 'bad.edf');
    writeEdf({
      path: bad, startDate: '32.13.99', startTime: '25.61.61', numRecords: 1,
      recordDuration: 1, signals: [channel],
    });

    const file = await EdfFile.open(bad);
    open.push(file);
    const raised = file.diagnostics.filter((d) => d.code === 'START_TIME_UNREADABLE');
    assert.equal(raised.length, 1, JSON.stringify(codes(file)));
    // The fields come back as the header has them, so the warning can be checked against it.
    assert.match(raised[0].message, /"32\.13\.99"/u, raised[0].message);
    assert.match(raised[0].message, /"25\.61\.61"/u, raised[0].message);
    assert.equal(file.header.startDateTime, null, 'and there really is no instant');

    // A readable header says nothing, or every recording would carry this.
    const fine = await load('tiny.edf');
    assert.ok(!codes(fine).includes('START_TIME_UNREADABLE'), codes(fine).join(', '));
    assert.ok(fine.header.startDateTime instanceof Date);
  });

  it('says when header text will be run by a spreadsheet rather than read', async () => {
    /*
      `=`, `+` and `@` start a formula in Excel, LibreOffice and Sheets whatever file the cell
      came from, and all four free-text header fields are written through verbatim into a CSV
      header row and into channels.csv. A channel labelled `=1+1` opens as a column headed 2.

      And `-`, which this left out with the reason written on the warnings page: "a lone `-` is
      a real convention for no unit ... and neither is evaluated unless what follows it parses
      as a formula". That is a condition, and nothing applied it — no field with a leading minus
      was flagged at all, so `-2+3` opened as a column headed 1 and `-A1` as the #NAME? a
      spreadsheet gives an unknown name, both in silence.

      The exception is the case it names, not the character: a lone `-` is left as text by every
      spreadsheet, and a field that is entirely a number reads as that number, which is what the
      header says. Anything else after the minus is arithmetic or a name.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-formula-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const channel = (label, dimension) => ({
      label, dimension, physMin: -1, physMax: 1, digMin: -1, digMax: 1,
      samplesPerRecord: 2, gen: () => 0,
    });
    const target = path.join(dir, 'formula.edf');
    writeEdf({
      path: target, numRecords: 1, recordDuration: 1,
      signals: [
        channel('=1+1', 'uV'),
        channel('plain', '@lookup'),
        channel('-2+3', 'uV'),
        channel('-A1', 'uV'),
        channel('-100', '-'),
        /*
          The same exception, one sign over, which it did not take. `+100` reads as 100 in
          every spreadsheet — Lotus compatibility converts a leading `+` or `-` to a formula
          only when what follows one parses as a formula — so it says what the header says,
          exactly as `-100` above does. It was warned about anyway, and under --strict that
          difference was an exit code.
        */
        channel('+100', '+1e3'),
        channel('+1+1', 'uV'),
      ],
    });

    const file = await EdfFile.open(target);
    open.push(file);
    const raised = file.diagnostics.filter((d) => d.code === 'FORMULA_LABEL');
    const named = (n) => raised.find((d) => d.message.startsWith(`Signal ${n}'s`));
    assert.match(named(0)?.message ?? '', /label starts with =/u, JSON.stringify(raised));
    assert.match(named(1)?.message ?? '', /unit starts with @/u, JSON.stringify(raised));
    assert.match(named(2)?.message ?? '', /label starts with -/u, JSON.stringify(raised));
    assert.match(named(3)?.message ?? '', /label starts with -/u, JSON.stringify(raised));
    // Signal 4 is `-100` with a unit of `-`: a number reads as that number and a lone dash is
    // text, so neither is a formula and neither is named. Signal 5 is the same pair written
    // with a plus, and takes the same answer.
    assert.equal(named(4), undefined, JSON.stringify(raised));
    assert.equal(named(5), undefined, JSON.stringify(raised));
    // Signal 6 is arithmetic behind the plus, which is what the exception is not for.
    assert.match(named(6)?.message ?? '', /label starts with \+/u, JSON.stringify(raised));
    assert.equal(raised.length, 5, JSON.stringify(codes(file)));
    assert.equal(file.header.signals[0]?.label, '=1+1', 'the field is written through unchanged');
    assert.equal(file.header.signals[4]?.label, '-100', 'and so is the one nothing was said about');

    // An ordinary recording never raises it.
    const fine = await load('tiny.edf');
    assert.ok(!codes(fine).includes('FORMULA_LABEL'), codes(fine).join(', '));
  });

  it('does not tell a file holding data that none was written', async () => {
    /*
      "The recording was probably interrupted before any data was written" is right about an
      empty file and wrong about the other way to reach this error: a header declaring records
      larger than the data present. A 606 KB file holding 589 KB of samples — more than half a
      million readings — was told no data was written, and the message carried no figures at
      all, so nothing in it could be checked against the file.
    */
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-partial-'));
    temporaries.push(dir);
    const { writeEdf } = await import('./fixtures/edf-writer.mjs');
    const { truncateSync } = await import('node:fs');
    const channels = 8;
    const perRecord = 4096;
    const partial = path.join(dir, 'partial.edf');
    writeEdf({
      path: partial, numRecords: 2, recordDuration: 30,
      signals: Array.from({ length: channels }, (unused, i) => ({
        label: `C${i}`, dimension: 'uV', physMin: -100, physMax: 100, digMin: -32768,
        digMax: 32767, samplesPerRecord: perRecord, gen: (n) => n % 1000,
      })),
    });
    const recordBytes = channels * perRecord * 2;
    const kept = Math.floor(recordBytes * 0.6);
    truncateSync(partial, 256 + channels * 256 + kept);

    await assert.rejects(() => EdfFile.open(partial), (error) => {
      assert.equal(error.code, 'NO_DATA_RECORDS');
      // Both numbers, because the interesting comparison is between them.
      assert.ok(error.message.includes(String(kept)), error.message);
      assert.ok(error.message.includes(String(recordBytes)), error.message);
      assert.doesNotMatch(error.hint, /before any data was written/u, error.hint);
      return true;
    });

    // A file that really does hold nothing keeps the sentence that is true of it.
    const empty = path.join(dir, 'empty.edf');
    writeEdf({
      path: empty, numRecords: 1, recordDuration: 1, truncateRecords: 0,
      signals: [{ label: 'a', dimension: 'uV', physMin: -1, physMax: 1, digMin: -1, digMax: 1,
        samplesPerRecord: 4, gen: () => 0 }],
    });
    await assert.rejects(() => EdfFile.open(empty), (error) => {
      assert.equal(error.code, 'NO_DATA_RECORDS');
      assert.match(error.hint, /before any data was written/u, error.hint);
      return true;
    });
  });

  it('does not count the padding after a TAL as a lost annotation', async () => {
    /*
      The spec pads the annotation slot with NUL, which the decoder skips because NUL is also
      what separates one TAL from the next. Writers pad with spaces instead, and a run of
      spaces after the last TAL is a non-empty chunk — so a file holding one perfectly
      readable event, exported in full, was told "2 annotation entries were unreadable and
      could not be exported", one per record. Nothing was lost, and under --strict that is a
      failed run over the whitespace at the end of a slot.
    */
    const { decodeRecordAnnotations } = await import('../dist/index.js');
    const T = String.fromCharCode(0x14);
    const Z = String.fromCharCode(0x00);
    const bytes = (text, width) => new TextEncoder().encode(text.padEnd(width, ' '));

    const padded = decodeRecordAnnotations(bytes(`+0${T}${T}${Z}+0.5${T}Lights off${T}${Z}`, 80), 0);
    assert.equal(padded.malformed, 0, 'trailing spaces are padding, not a lost entry');
    assert.deepEqual(padded.annotations.map((a) => a.text), ['Lights off']);

    // NUL padding, which always worked, still works.
    const nulPadded = decodeRecordAnnotations(
      new TextEncoder().encode(`+0${T}${T}${Z}+0.5${T}Lights off${T}${Z}`.padEnd(80, Z)),
      0,
    );
    assert.equal(nulPadded.malformed, 0);
    assert.deepEqual(nulPadded.annotations.map((a) => a.text), ['Lights off']);

    // A chunk of anything else that does not parse is a real loss, and is still counted —
    // that is the case the warning exists for.
    const junk = decodeRecordAnnotations(bytes(`+0${T}${T}${Z}zzz junk${Z}`, 80), 0);
    assert.equal(junk.malformed, 1, 'garbage is still reported');
  });

  it('counts a duration below zero without rewriting it', async () => {
    /*
      A length of time below zero is not one, and every use of it goes quietly wrong: the
      recipe the documentation gives for the samples an event covers is `onset_s +
      duration_s`, which for -3 ends the window three seconds before the event begins and
      selects nothing. It was exported with no comment of any kind.

      Kept as the file gave it — a zero invented here would be a number no writer wrote —
      and counted, which is what the warning is for. Counted separately from a duration that
      could not be read: this one parsed perfectly, and what is wrong with it is arithmetic.
    */
    const { decodeRecordAnnotations } = await import('../dist/index.js');
    const T = String.fromCharCode(0x14);
    const D = String.fromCharCode(0x15);
    const Z = String.fromCharCode(0x00);
    const bytes = (text) => new TextEncoder().encode(text);

    const decoded = decodeRecordAnnotations(
      bytes(`+0${T}${T}${Z}+0.1${D}-3${T}backwards${T}${Z}+0.2${D}0${T}instant${T}${Z}`),
      0,
    );
    assert.equal(decoded.negativeDurations, 1, 'only the negative one is counted');
    assert.equal(decoded.unreadableDurations, 0, 'it read fine; it is the value that is wrong');
    assert.deepEqual(
      decoded.annotations.map((a) => [a.text, a.duration]),
      [['backwards', -3], ['instant', 0]],
      'the value is preserved, and a duration of exactly zero is not negative',
    );
  });

  it('recovers the true start time of every record in a discontinuous file', async () => {
    const file = await load('discontinuous.edf');
    const { recordStarts } = await file.readAnnotations();
    // The nine-second gap between the second and third record must survive.
    assert.deepEqual([...recordStarts], [0, 1, 10]);
  });

  it('does not mistake a timekeeping TAL for an annotation', async () => {
    const file = await load('discontinuous.edf');
    const { annotations } = await file.readAnnotations();
    assert.equal(annotations.length, 0);
  });

  it('reads a file whose only content is annotations', async () => {
    const file = await load('annotations-only.edf');
    assert.equal(file.dataSignals.length, 0);
    const { annotations } = await file.readAnnotations();
    assert.deepEqual(annotations.map((a) => a.text), ['Start']);
    assert.ok(codes(file).includes('NO_SIGNAL_CHANNELS'));
  });

  it('fails instead of returning partial annotations after a short read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-short-read-'));
    temporaries.push(dir);
    const copy = path.join(dir, 'annotations.edf');
    await copyFile(fixture('annotations.edf'), copy);
    const file = await EdfFile.open(copy);
    open.push(file);

    await truncate(copy, file.fileSize - 1);
    await assert.rejects(
      () => file.readAnnotations(),
      (error) => error instanceof EdfError && /changed size/.test(error.message),
    );
  });
});
describe('the read budget', () => {
  it('sizes the buffer from the data rather than from the budget', async () => {
    // The budget is a ceiling on how much to read at once, and the buffer was however many
    // records would fit in it — whether or not the file had that many. An 848-byte fixture
    // read with a 512 MB budget allocated 536,870,880 bytes for its two records, and every
    // ordinary read of a small file reserved the full 8 MB default. Nothing was wrong with
    // the data; the memory just had nothing to do with it.
    const file = await EdfFile.open(fixture('tiny.edf'));
    try {
      for await (const batch of file.readRecords({ chunkBytes: 512 * 1024 * 1024 })) {
        assert.equal(
          batch.data.buffer.byteLength,
          file.recordCount * file.header.recordBytes,
          'the buffer is the size of what is being read',
        );
      }
    } finally {
      await file.close();
    }
  });

  it('reads a window without reserving room for the whole recording', async () => {
    const file = await EdfFile.open(fixture('long-stream.edf'));
    try {
      for await (const batch of file.readRecords({ startRecord: 10, endRecord: 12 })) {
        assert.equal(batch.data.buffer.byteLength, 2 * file.header.recordBytes);
        assert.equal(batch.recordCount, 2);
      }
    } finally {
      await file.close();
    }
  });
});
describe('what the header says against what it means', () => {
  it('keeps the declared header length beside the computed one', async () => {
    // api.md said "Every field is read straight from the 256-byte fixed header ... Nothing is
    // normalised except where noted", and headerBytes carried no note — while being the one
    // field that is computed rather than read. The computation is right: every record offset
    // comes from it, and believing a carelessly written length field would put every sample
    // at the wrong offset. What was missing is the field's own value, which is a fact about
    // the file and is what HEADER_BYTES_MISMATCH is comparing against.
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const dir = await mkdtemp(path.join(tmpdir(), 'edf2csv-hb-'));
    try {
      const bytes = Buffer.from(await readFile(fixture('tiny.edf')));
      Buffer.from('99      ', 'latin1').copy(bytes, 184);
      const patched = path.join(dir, 'short-header.edf');
      await writeFile(patched, bytes);

      const file = await EdfFile.open(patched);
      try {
        assert.equal(file.header.headerBytes, 768, 'two signals need 256 + 2 * 256');
        assert.equal(file.header.declaredHeaderBytes, 99, 'and the file says otherwise');
        assert.ok(file.diagnostics.some((d) => d.code === 'HEADER_BYTES_MISMATCH'));
      } finally {
        await file.close();
      }

      // A well-formed file has them equal, which is what makes the pair worth exposing.
      const ordinary = await EdfFile.open(fixture('tiny.edf'));
      assert.equal(ordinary.header.declaredHeaderBytes, ordinary.header.headerBytes);
      await ordinary.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});


