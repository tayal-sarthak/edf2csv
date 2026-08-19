/**
 * Whether `--stdout` writes the file it replaces.
 *
 *     npm run stream
 *
 * The reference calls it "Write the signal CSV to stdout instead of a directory", and every
 * recipe that pipes a conversion into `duckdb`, `gunzip` or a script depends on the two being
 * the same bytes. They are not the same code: `--out` opens a file stream per rate group and
 * closes it, `--stdout` writes one stream it does not own, through an audit wrapper that
 * counts bytes so a short write can be reported — the one destination with no second file
 * after it to trip over.
 *
 * Nothing was comparing them. The estimate sweep measures files on disk; layouts, narrowing
 * and round-trip all read directories; the batch sweep is about batches; the terminal sweep
 * checks the one case `--stdout` refuses. A stream that dropped its last flush, or gained a
 * byte order mark the file did not have, would be caught by none of them.
 *
 * So: every fixture `--stdout` accepts, crossed with the modes that change what it writes,
 * against the single signal file the same command writes to a directory. Compressed streams
 * are decompressed first, since gzip need not choose the same block boundaries twice.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'dist/cli.js');
const GEN = path.join(ROOT, 'test/fixtures/generated');

/**
 * The modes that change what reaches the stream.
 *
 * `--stdout` takes one table, so a mixed-rate recording only reaches it through `--layout
 * long` or a selection narrow enough to leave one rate. Both are here for that reason as
 * much as for their own.
 */
export const MODES = [
  [],
  ['--layout', 'long'],
  ['--gzip'],
  ['--layout', 'long', '--decimals', '2'],
  ['--start', '1'],
  ['--channels', '#0'],
  ['--bom'],
];

const names = readdirSync(GEN).filter((name) => /\.(edf|bdf)$/iu.test(name));
const problems = [];
let compared = 0;
let refused = 0;

for (const name of names) {
  const source = path.join(GEN, name);
  for (const mode of MODES) {
    let streamed;
    try {
      streamed = execFileSync(process.execPath, [CLI, source, '--stdout', ...mode], {
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch {
      // A mixed-rate recording in the wide layout, a file with no signal channels, a window
      // outside the data: all refused, all deliberately, and all tested elsewhere.
      refused++;
      continue;
    }

    const work = mkdtempSync(path.join(tmpdir(), 'edf2csv-stream-'));
    try {
      const out = path.join(work, 'out');
      try {
        execFileSync(process.execPath, [CLI, source, '--out', out, '--quiet', ...mode], {
          stdio: 'ignore',
        });
      } catch {
        problems.push(`${name} [${mode.join(' ') || 'no options'}]: streamed but would not convert`);
        continue;
      }

      const written = readdirSync(out).filter((file) => /^signals.*\.csv(\.gz)?$/u.test(file));
      if (written.length !== 1) {
        problems.push(
          `${name} [${mode.join(' ') || 'no options'}]: --stdout wrote one table and --out ` +
            `wrote ${written.length}`,
        );
        continue;
      }

      compared++;
      const onDisk = readFileSync(path.join(out, written[0]));
      // Decompressed first: gzip is free to choose different block boundaries for the same
      // bytes, and what is promised is the CSV inside, not the container around it.
      const here = mode.includes('--gzip') ? gunzipSync(streamed) : streamed;
      const there = mode.includes('--gzip') ? gunzipSync(onDisk) : onDisk;
      if (!here.equals(there)) {
        const at = [...there].findIndex((byte, i) => here[i] !== byte);
        problems.push(
          `${name} [${mode.join(' ') || 'no options'}]: the stream is ${here.length} bytes and ` +
            `${written[0]} is ${there.length}, first differing at ${at}`,
        );
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

if (problems.length > 0) {
  console.error(problems.slice(0, 20).join('\n'));
  if (problems.length > 20) console.error(`... and ${problems.length - 20} more`);
  process.exitCode = 1;
} else {
  console.log(
    `${compared} streams compared against the file they replace, over ${names.length} ` +
      `recordings (${refused} refused by --stdout).`,
  );
  console.log('Every stream held the bytes the directory holds.');
}
