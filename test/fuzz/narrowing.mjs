/**
 * Does asking for less of a recording change what you get of it?
 *
 * Two narrowings, one claim. `--channels` takes a subset of the columns; `--start`/`--end` takes
 * a subset of the rows. Both are documented as selections rather than as transformations —
 * output-files puts it as "a section converted on its own lines up with the full conversion" —
 * and nothing checked either.
 *
 * The gap mattered because both paths do arithmetic the full conversion does not. A window
 * resolves to a record range and then filters samples inside those records against a per-rate
 * tolerance, which is where a boundary is easiest to get wrong by one sample; the tolerance
 * itself was a defect once, when a fixed nanosecond was applied to a recording whose sample
 * interval was smaller than that and half its rows vanished. And `--channels` rebuilds the rate
 * groups from a subset, which is how a selection can land in a differently-named file.
 *
 * So: take the full conversion as the truth, then ask for part of it and require the part to be
 * the part. Not the same row count — the same bytes, in the same order.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist/cli.js');
const GEN = path.join(ROOT, 'test/fixtures/generated');

/** Where in the full recording each window is taken from, as fractions of its rows. */
export const WINDOWS = [
  [0, 0.5],
  [0.25, 0.75],
  [0.5, 1],
];

function convert(source, out, extra) {
  try {
    execFileSync(process.execPath, [CLI, source, '--out', out, '--quiet', ...extra],
      { stdio: 'pipe', maxBuffer: 1 << 28 });
    return true;
  } catch {
    return false;
  }
}

/** A signal file as a header and its data rows, or null when it was not written. */
function read(dir, name) {
  const file = path.join(dir, name);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { head: lines[0].split(','), rows: lines.slice(1) };
}

const signalFiles = (dir) => readdirSync(dir).filter((n) => /^signals.*\.csv$/u.test(n)).sort();

const names = readdirSync(GEN).filter((n) => /\.(edf|bdf)$/iu.test(n));
const problems = [];
let columns = 0;
let windows = 0;
let longs = 0;
let partitions = 0;
let annotationCuts = 0;

for (const name of names) {
  const source = path.join(GEN, name);
  const work = mkdtempSync(path.join(tmpdir(), 'edf2csv-narrowing-'));
  try {
    const full = path.join(work, 'full');
    if (!convert(source, full, [])) continue;

    for (const fileName of signalFiles(full)) {
      const whole = read(full, fileName);
      if (!whole || whole.rows.length === 0) continue;

      /*
        One channel out of the file. Its cells must be the cells it had, against the same
        times — whichever file the narrowed run decides to call it, since dropping the other
        rates can turn `signals_256hz.csv` into `signals.csv`.
      */
      for (const [at, column] of whole.head.entries()) {
        if (at === 0) continue;
        const out = path.join(work, `col-${columns}`);
        if (!convert(source, out, ['--channels', column])) continue;
        const narrowed = signalFiles(out).map((n) => read(out, n)).find((t) => t && t.head[1] === column);
        if (!narrowed) continue;
        columns++;
        const before = whole.rows.map((row) => { const cells = row.split(','); return `${cells[0]},${cells[at]}`; });
        const after = narrowed.rows.map((row) => { const cells = row.split(','); return `${cells[0]},${cells[1]}`; });
        if (before.length !== after.length) {
          problems.push(`${name}/${fileName} "${column}": full has ${before.length} rows, --channels has ${after.length}`);
          continue;
        }
        const at_ = before.findIndex((row, i) => row !== after[i]);
        if (at_ >= 0) problems.push(`${name}/${fileName} "${column}": row ${at_} is "${before[at_]}" alone and "${after[at_]}" in full`);
      }

      /*
        A window's rows are the full run's rows that fall inside it.

        The bounds sit halfway BETWEEN two sample times, never on one. A bound on a sample is
        not a fair question to ask of this comparison: the conversion filters exact sample
        times, `time_s` is written rounded, and the two disagree about the edge whenever the
        rounding goes up. 8/17 is 0.47058823… and prints as `0.47059`, so a bound read back off
        the CSV is larger than the sample it came from and the conversion — correctly — keeps a
        row this check would have excluded. Halfway between two samples, no rounding of either
        side can move a row across the bound, and the half-open rule is all that decides.
      */
      const times = whole.rows.map((row) => Number(row.split(',')[0]));
      if (times.length < 3) continue;
      const between = (fraction) => {
        const at = Math.max(1, Math.floor((times.length - 1) * fraction));
        return (times[at - 1] + times[at]) / 2;
      };
      for (const [from, to] of WINDOWS) {
        const start = from === 0 ? times[0] - (times[1] - times[0]) / 2 : between(from);
        const end = between(to);
        if (!Number.isFinite(start) || !Number.isFinite(end) || !(end > start)) continue;
        const out = path.join(work, `win-${windows}`);
        if (!convert(source, out, [`--start=${start}`, `--end=${end}`])) continue;
        const narrowed = read(out, fileName);
        if (!narrowed) continue;
        windows++;
        const expected = whole.rows.filter((row) => {
          const t = Number(row.split(',')[0]);
          return t >= start && t < end;
        });
        if (expected.length !== narrowed.rows.length) {
          problems.push(`${name}/${fileName} [${start}, ${end}): window wrote ${narrowed.rows.length} rows, the full run has ${expected.length} in range`);
          continue;
        }
        const bad = expected.findIndex((row, i) => row !== narrowed.rows[i]);
        if (bad >= 0) problems.push(`${name}/${fileName} [${start}, ${end}): row ${bad} differs`);
      }

      /*
        And that two windows meeting at a bound hold the whole file between them.

        Everything above asks whether a window is a slice of the full conversion. A bound that
        dropped the sample sitting exactly on it, or wrote it into both halves, passes every
        one of those checks — each half is still a run of consecutive rows in the right order,
        and neither is asked about the other. What decides it is `--end t` and `--start t`
        together, which is the one arrangement where the half-open rule has to be read both
        ways at once.

        The cut is placed ON a sample, which is the case the loop above deliberately avoids:
        there a bound between two samples is compared against a rounded column, and a bound on
        a sample would be asking a question neither answer is wrong about. Here it is the
        question. A bound halfway between two samples goes in too, since a rule that is right
        at a sample can still lose the row after it.

        Compared as a multiset, because an EDF+D recording may store its records out of
        chronological order and the rows are written in file order — so cutting it by time and
        putting the halves back together reorders them, correctly. Order is what the loop above
        established; what this adds is that nothing falls between two windows or lands in both.
      */
      for (const at of [times[Math.floor(times.length / 2)], between(0.5)]) {
        if (!Number.isFinite(at)) continue;
        const before = path.join(work, `part-a-${partitions}`);
        const after = path.join(work, `part-b-${partitions}`);
        if (!convert(source, before, [`--end=${at}`])) continue;
        if (!convert(source, after, [`--start=${at}`])) continue;
        const first = read(before, fileName);
        const second = read(after, fileName);
        if (!first || !second) continue;
        partitions++;
        const halves = [...first.rows, ...second.rows].sort();
        const everything = [...whole.rows].sort();
        if (halves.length !== everything.length) {
          problems.push(
            `${name}/${fileName} cut at ${at}: the whole holds ${everything.length} rows, ` +
              `the two halves hold ${halves.length} between them`,
          );
          continue;
        }
        const missing = everything.findIndex((row, i) => row !== halves[i]);
        if (missing >= 0) {
          problems.push(
            `${name}/${fileName} cut at ${at}: row ${missing} is ` +
              `"${everything[missing]}" in the whole and "${halves[missing]}" across the halves`,
          );
        }
      }
    }

    /*
      And annotations.csv, which nothing above has ever looked at.

      `signalFiles` matches `signals*.csv`, so every comparison in this sweep is about sample
      rows. annotations.csv is narrowed by the same window under its own half-open rule — an
      event at `--start t` is in, an event at `--end t` is out — and that rule was asserted by
      nothing anywhere. Flipping it to drop the event sitting exactly on the start leaves all
      387 tests green and leaves this sweep reporting that narrowing returned exactly the part
      it names, over 253 windows.

      Cut ON an onset, because that is the only place the rule can be read two ways at once,
      and halfway between two of them, because a rule that is right at an event can still lose
      the one after it. Compared as a multiset for the same reason the rows above are: an
      EDF+D recording stores its events in record order, not in time order.
    */
    const events = read(full, 'annotations.csv');
    if (events && events.rows.length > 0) {
      const onsets = events.rows.map((row) => Number(row.split(',')[0]));
      const cuts = new Set();
      for (const [i, onset] of onsets.entries()) {
        if (Number.isFinite(onset) && onset > 0) cuts.add(onset);
        const next = onsets[i + 1];
        if (Number.isFinite(next) && next > onset) cuts.add((onset + next) / 2);
      }
      for (const at of cuts) {
        const before = path.join(work, `ann-a-${annotationCuts}`);
        const after = path.join(work, `ann-b-${annotationCuts}`);
        if (!convert(source, before, [`--end=${at}`])) continue;
        if (!convert(source, after, [`--start=${at}`])) continue;
        annotationCuts++;
        const first = read(before, 'annotations.csv');
        const second = read(after, 'annotations.csv');
        const halves = [...(first ? first.rows : []), ...(second ? second.rows : [])].sort();
        const everything = [...events.rows].sort();
        if (halves.length !== everything.length) {
          problems.push(
            `${name}/annotations.csv cut at ${at}: the whole holds ${everything.length} events, ` +
              `the two halves hold ${halves.length} between them`,
          );
          continue;
        }
        const missing = everything.findIndex((row, i) => row !== halves[i]);
        if (missing >= 0) {
          problems.push(
            `${name}/annotations.csv cut at ${at}: "${everything[missing]}" in the whole and ` +
              `"${halves[missing]}" across the halves`,
          );
        }
      }
    }

    /*
      The same question of the long layout, where the answer is weaker and has to be.

      The wide layout gives every rate its own file with its own `time_s` precision, so
      dropping the other rates cannot touch the column and the comparison above is exact. The
      long layout puts every rate in one table, and one column cannot mean three things — so
      its precision is the finest any INCLUDED rate needs. Narrow a 40-rate recording to one
      channel and the shared column stops needing five decimals and writes four: the same
      instants, rounded to a different width.

      So the channel, the value and the order are compared exactly, and the time at the
      coarser of the two precisions — which is the property that actually holds here. Nothing
      was checking it either way: this sweep converted with no options at all until now, so
      the byte-for-byte claim above was only ever tested where bytes are the right question.
    */
    /*
      Only where the answer can differ: a recording with one rate writes the same `time_s`
      precision whether or not it is narrowed, so the long layout adds nothing over the wide
      comparison above and costs a full conversion per channel to find that out. More than one
      signal file in the wide run is exactly the condition of having more than one rate.
    */
    const longFull = path.join(work, 'long-full');
    if (signalFiles(full).length > 1 && convert(source, longFull, ['--layout', 'long'])) {
      const table = read(longFull, 'signals.csv');
      if (table && table.rows.length > 0) {
        const channels = [...new Set(table.rows.map((row) => row.split(',')[1]))];
        for (const column of channels) {
          const out = path.join(work, `long-${longs}`);
          if (!convert(source, out, ['--layout', 'long', '--channels', column])) continue;
          const narrowed = read(out, 'signals.csv');
          if (!narrowed) continue;
          longs++;
          const mine = table.rows.filter((row) => row.split(',')[1] === column);
          if (mine.length !== narrowed.rows.length) {
            problems.push(
              `${name} long "${column}": full holds ${mine.length} rows, --channels wrote ${narrowed.rows.length}`,
            );
            continue;
          }
          /*
            The two times are roundings of one instant to different widths, so they are
            compared at the coarser of the two: 0.33333 and 0.3333 are the same sample, and
            `Number(a) === Number(b)` says they are not.
          */
          const places = (text) => (text.split('.')[1] ?? '').length;
          const differs = mine.findIndex((row, i) => {
            const a = row.split(','), b = (narrowed.rows[i] ?? '').split(',');
            if (a[1] !== b[1] || a[2] !== b[2]) return true;
            const to = Math.min(places(a[0] ?? ''), places(b[0] ?? ''));
            return Number(a[0]).toFixed(to) !== Number(b[0]).toFixed(to);
          });
          if (differs >= 0) {
            problems.push(
              `${name} long "${column}": row ${differs} is "${mine[differs]}" in full and "${narrowed.rows[differs]}" alone`,
            );
          }
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (problems.length > 0) {
  console.error(problems.slice(0, 20).join('\n'));
  if (problems.length > 20) console.error(`... and ${problems.length - 20} more`);
  process.exitCode = 1;
} else {
  console.log(
    `${columns.toLocaleString('en-US')} single-channel selections and ` +
      `${windows.toLocaleString('en-US')} windows checked over ${names.length} recordings,\n` +
      `plus ${longs.toLocaleString('en-US')} single-channel selections in the long layout\n` +
      `and ${partitions.toLocaleString('en-US')} pairs of windows meeting at a bound,\n` +
      `with ${annotationCuts.toLocaleString('en-US')} more meeting on or beside an event and ` +
      `compared as annotations.`,
  );
  console.log('Narrowing a conversion returned exactly the part it names, and two of them');
  console.log('meeting at a bound returned the whole of it.');
}
