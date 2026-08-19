/**
 * Whether the two layouts hold the same samples.
 *
 *     npm run layouts
 *
 * `--layout long` is a different shape, not different data. That is the claim 0.5.0 made and
 * every page repeats: "the same samples in a different shape", "nothing invented". It went
 * unchecked for thirteen versions, during which the long layout shipped four defects — a
 * byte audit that counted one writer per rate group, then the same again for the compressed
 * stream, then a channel order taken from the rate rather than the file, then a promise of
 * sorted rows a discontinuous recording can break. Three of those four were found by reading
 * rather than by running.
 *
 * So this runs it. Every fixture, crossed with option sets that change the window and the
 * precision, converted both ways, and compared on the one thing that has to hold.
 *
 * Compared per channel, as an ordered sequence of value cells — deliberately not by joining
 * on time. The two layouts write `time_s` at different precisions by design (the long one
 * shares the finest any rate needs, since a single column cannot mean three things), so a
 * time-keyed comparison compares the formatting rather than the data, and at nine decimal
 * places it silently collapses distinct sub-nanosecond samples into one key. An earlier
 * version of this file did exactly that and reported 42 disagreements that were all its own.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, 'dist', 'cli.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'generated');

/** Option sets worth crossing with every fixture. Each must leave signal data to compare. */
export const OPTIONS = [
  [],
  ['--start', '0.5'],
  ['--start', '0.5', '--duration', '1'],
  ['--end', '1.5'],
  ['--start', '1', '--end', '2'],
  ['--decimals', '2'],
  ['--channels', '#0'],
  ['--channels', '#0', '--start', '0.5'],
];

/** A CSV header cell or channel cell, with the quoting csvRow put on it taken back off. */
function unquote(cell) {
  return cell.startsWith('"') ? cell.slice(1, -1).replaceAll('""', '"') : cell;
}

/**
 * Returns null on success, or what the tool said on failure.
 *
 * The message matters: a bare "long refused what wide accepted" sent me looking for a defect
 * that was a transient filesystem failure under load. A harness that reports a disagreement
 * without the evidence for it costs more than it saves.
 */
function convert(args) {
  try {
    execFileSync(process.execPath, [CLI, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    return null;
  } catch (error) {
    return String(error.stderr ?? error.message).trim().split('\n')[0] || 'no message';
  }
}

export function sweepLayouts() {
  const names = readdirSync(FIXTURES)
    .filter((name) => /\.(edf|bdf)$/iu.test(name))
    .sort();

  const problems = [];
  let compared = 0;
  let skipped = 0;
  let channels = 0;

  for (const name of names) {
    const source = path.join(FIXTURES, name);
    for (const options of OPTIONS) {
      const base = mkdtempSync(path.join(tmpdir(), 'edf2csv-layouts-'));
      const wide = path.join(base, 'wide');
      const long = path.join(base, 'long');
      try {
        // A recording or window the wide layout refuses is refused for a reason the other
        // harnesses cover; there is nothing here to compare.
        if (convert([source, '--out', wide, '--quiet', ...options]) !== null) {
          skipped++;
          continue;
        }
        const refusal = convert([source, '--out', long, '--layout', 'long', '--quiet', ...options]);
        if (refusal !== null) {
          problems.push(`${name} ${options.join(' ')}: long refused what wide accepted — ${refusal}`);
          continue;
        }
        compared++;

        /*
          A recording with no signal channels writes no table in either layout — only
          channels.csv and, if it has events, annotations.csv. There is nothing to compare,
          and demanding a file that neither layout was going to write is the harness being
          wrong rather than the tool.
        */
        const wideTables = readdirSync(wide).filter((n) => n.startsWith('signals'));
        const longTables = readdirSync(long).filter((n) => n.startsWith('signals'));
        if (wideTables.length === 0 && longTables.length === 0) {
          skipped++;
          compared--;
          continue;
        }
        if (longTables.length !== 1) {
          problems.push(
            `${name} ${options.join(' ') || '(no options)'}: the long layout wrote ` +
              `${longTables.length} tables, and one table is the whole point of it`,
          );
          continue;
        }

        // The long table, as a sequence of values per channel in the order it wrote them.
        const byChannel = new Map();
        const table = path.join(long, longTables[0]);
        for (const row of readFileSync(table, 'utf8').trimEnd().split('\n').slice(1)) {
          const firstComma = row.indexOf(',');
          const lastComma = row.lastIndexOf(',');
          const channel = unquote(row.slice(firstComma + 1, lastComma));
          const values = byChannel.get(channel) ?? byChannel.set(channel, []).get(channel);
          values.push(row.slice(lastComma + 1));
        }

        // Every wide column, down its rows, must be that channel's sequence exactly.
        for (const file of wideTables) {
          const lines = readFileSync(path.join(wide, file), 'utf8').trimEnd().split('\n');
          const columns = lines[0].split(',').slice(1).map(unquote);
          for (const [index, column] of columns.entries()) {
            channels++;
            const want = lines.slice(1).map((row) => row.split(',')[index + 1]);
            const got = byChannel.get(column) ?? [];
            if (want.length !== got.length) {
              problems.push(
                `${name} ${options.join(' ') || '(no options)'}: ${column} has ${want.length} ` +
                  `values wide and ${got.length} long`,
              );
              continue;
            }
            const at = want.findIndex((value, i) => value !== got[i]);
            if (at >= 0) {
              problems.push(
                `${name} ${options.join(' ') || '(no options)'}: ${column} value ${at} is ` +
                  `"${want[at]}" wide and "${got[at]}" long`,
              );
            }
          }
        }
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  }

  return { problems, compared, skipped, channels, recordings: names.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, compared, skipped, channels, recordings } = sweepLayouts();

  process.stdout.write(
    `\n${compared} conversions compared over ${recordings} recordings ` +
      `(${channels} channel sequences, ${skipped} refused by both).\n`,
  );
  if (problems.length > 0) {
    process.stdout.write(`${problems.length} disagreed:\n`);
    for (const problem of problems.slice(0, 20)) process.stdout.write(`  ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write('Both layouts hold the same samples, in the same order, per channel.\n');
}
