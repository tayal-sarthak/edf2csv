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
      `${windows.toLocaleString('en-US')} windows checked over ${names.length} recordings.`,
  );
  console.log('Narrowing a conversion returned exactly the part it names.');
}
