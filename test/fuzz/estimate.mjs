/**
 * What `--info` predicts against what a conversion writes.
 *
 *     npm run estimate                # every fixture, every option combination
 *     npm run estimate -- mixed-rates # just the ones whose name contains this
 *
 * Two properties, and they are not the same promise.
 *
 *   1. The row count is EXACT. "Would write 1,155 rows" is arithmetic on the header, and a
 *      conversion doing the same arithmetic must land on the same number. A row estimate that
 *      is merely close is a row estimate that is wrong.
 *
 *   2. The byte count NEVER UNDER-COUNTS. It is documented as an approximation, and it is
 *      one — most samples sit well inside the range their channel declares, so it reads
 *      high. Reading high is the direction a size estimate must err in: people use it to
 *      decide whether they have room. Reading low is a defect even though "approximate"
 *      would excuse it.
 *
 * Property (2) has one theoretical hole, noted in the code that produces the estimate:
 * nothing obliges a recording to keep its samples inside the digital range its header
 * declares, and one that does not maps outside the physical range too, so it could convert
 * larger than a bound taken from the header. No fixture here does that, so the check is
 * strict rather than carrying an allowlist — an exemption nobody has to earn is how a
 * regression gets in wearing the name of a known case.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, 'dist', 'cli.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'generated');

/** Option sets worth crossing with every fixture. Each must leave signal files to measure. */
const OPTIONS = [
  [],
  ['--decimals', '0'],
  ['--decimals', '12'],
  ['--start', '1'],
  ['--start', '1', '--duration', '1'],
  ['--gzip'],
  // The long layout has its own row and byte arithmetic; the promise is the same.
  ['--layout', 'long'],
  ['--layout', 'long', '--decimals', '12'],
];

function run(args) {
  try {
    return {
      code: 0,
      stdout: execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 1 << 26,
      }),
    };
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') };
  }
}

/** Rows and bytes actually written to the signal files in a directory. */
function written(directory) {
  let rows = 0;
  let bytes = 0;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith('signals')) continue;
    const file = path.join(directory, name);
    bytes += statSync(file).size;
    const raw = readFileSync(file);
    const text = name.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
    // The header is not a data row, and a trailing newline is not an empty one.
    rows += text.trimEnd().split('\n').length - 1;
  }
  return { rows, bytes };
}

export function sweepEstimates(filter = '') {
  const names = readdirSync(FIXTURES)
    .filter((n) => /\.(edf|bdf)$/iu.test(n))
    .filter((n) => n.includes(filter))
    .sort();

  const problems = [];
  let checked = 0;
  // The size margin is averaged over the runs it was measured on, which is not all of
  // them: --gzip output is smaller than the CSV by design and says nothing about the bound.
  let sized = 0;
  let overBy = 0;

  for (const name of names) {
    const source = path.join(FIXTURES, name);
    for (const options of OPTIONS) {
      const info = run([source, '--info', '--json', ...options]);
      if (info.code !== 0) continue;

      let estimate;
      try {
        estimate = JSON.parse(info.stdout).estimate;
      } catch {
        continue;
      }

      // No signal table to predict: since 0.6.0 the estimate is null there rather than zero.
      if (estimate.rows === null) continue;

      const base = mkdtempSync(path.join(tmpdir(), 'edf2csv-estimate-'));
      try {
        const out = path.join(base, 'out');
        if (run([source, '--out', out, '--quiet', ...options]).code !== 0) continue;

        const actual = written(out);
        checked++;

        const where = `${name} [${options.join(' ') || 'no options'}]`;
        if (estimate.rows !== actual.rows) {
          problems.push(`${where}: predicted ${estimate.rows} rows, wrote ${actual.rows}`);
        }

        // Compressed output is smaller than the CSV by design, so the byte bound is only
        // meaningful uncompressed.
        if (!options.includes('--gzip')) {
          if (estimate.bytes < actual.bytes) {
            problems.push(
              `${where}: predicted ${estimate.bytes} bytes, wrote ${actual.bytes} — under-counted`,
            );
          }
          if (actual.bytes > 0) {
            overBy += estimate.bytes / actual.bytes;
            sized++;
          }
        }
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  }

  return { problems, checked, names: names.length, sized, overBy };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, checked, names, sized, overBy } = sweepEstimates(process.argv[2] ?? '');

  process.stdout.write(`\n${checked} predictions over ${names} recordings.\n`);
  if (problems.length > 0) {
    process.stdout.write(`${problems.length} wrong:\n`);
    for (const problem of problems.slice(0, 20)) process.stdout.write(`  ${problem}\n`);
    process.exit(1);
  }
  const margin = sized > 0 ? overBy / sized : 1;
  process.stdout.write(
    `Every row count exact, and no byte count under the truth ` +
      `(sizes read ${((margin - 1) * 100).toFixed(0)}% high on average).\n`,
  );
}
