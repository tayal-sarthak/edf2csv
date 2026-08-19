/**
 * Whether the digital codes can be recovered from the CSV, as the FAQ says they can.
 *
 *     npm run roundtrip
 *
 * The claim being checked, from website/content/faq.md: "The rounding recovers the original
 * integer exactly, because the written decimals are always fine enough to keep adjacent
 * digital codes distinct." That is a promise about the *derived* precision — the decimals
 * edf2csv chooses per channel from its calibration — and it is the reason the tool does not
 * offer a raw-digital output mode.
 *
 * So this writes recordings across the calibration space, converts them, applies the exact
 * arithmetic the FAQ prints, and compares against the digital values the reader returns.
 *
 * One thing to get right, which cost this file its first version: the gain must be read back
 * from channels.csv, not computed from the numbers the fixture was asked to write. EDF's
 * physical bound fields are 8 characters, so `-0.000001` is not what ends up in the file —
 * it is stored as `-0`. A harness that uses its own intent as the reference tests itself and
 * reports hundreds of failures that are all its own.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, 'dist', 'cli.js');

/*
  Exported so the size this sweep runs at can be recomputed rather than remembered. The
  correctness page states it, and a page that states a number a harness produces goes stale
  the moment the harness grows — which is what happened to the estimate sweep's own figures.
*/
export const DIGITAL_MINS = [-32768, -8192, -2048, -1000, -100, -1, 0];
export const DIGITAL_MAXES = [32767, 8191, 2047, 1000, 100, 1];
export const PHYSICAL_PAIRS = [
  [-250, 250], [-100, 100], [-5, 5], [-1, 1], [-0.5, 0.5],
  [-99999, 99999], [-0.0001, 0.0001], [0, 40], [34, 40],
  /*
    A magnetometer's range, which is where this sweep had a hole.

    The pairs above bottom out at ±0.0001, giving a finest step around 3e-9 — nowhere near
    a channel whose decimals get clamped. So the sweep passed while ±1e-16 T over 16 bits
    lost 69% of its codes. This pair reaches the clamp, which is the point of having it.
  */
  [-1e-16, 1e-16],
  /*
    And the same ranges written the wrong way round, which is a channel this tool converts on
    purpose and this sweep had never seen.

    A header is free to say `physical_min 100, physical_max -100`, and real ones do:
    INVERTED_PHYSICAL_RANGE reports it and the conversion goes ahead "exactly as the header
    specifies, inversion included". Every pair above ascends, and the digital pairs are
    filtered to ascend too, so every calibration this sweep had ever round-tripped had a
    positive gain — while the claim it stands behind is about recovering a digital code from
    a CSV cell, and the recipe for that divides by a gain whose sign it takes from the file.

    Rounding is where a sign is easiest to get wrong: `Math.round` breaks ties toward positive
    infinity, so a value landing halfway between two codes goes one way on an upright channel
    and the other way on its mirror image.
  */
  [250, -250], [100, -100], [1, -1], [40, 0], [1e-16, -1e-16],
];
/** Samples in the single record each calibration is written with. One cell each. */
export const SAMPLES_PER_CALIBRATION = 16;

/** The calibration as the file declares it, which is not always what was asked for. */
function calibrationOf(directory) {
  const lines = readFileSync(path.join(directory, 'channels.csv'), 'utf8').trimEnd().split('\n');
  const columns = lines[0].split(',');
  const values = lines[1].split(',');
  const field = (name) => Number(values[columns.indexOf(name)]);
  const gain =
    (field('physical_max') - field('physical_min')) / (field('digital_max') - field('digital_min'));
  return { gain, offset: field('physical_max') / gain - field('digital_max') };
}

export async function sweepRoundTrip() {
  const { writeEdf } = await import(path.join(ROOT, 'test/fixtures/edf-writer.mjs'));
  const { EdfFile } = await import(path.join(ROOT, 'dist/index.js'));

  const base = mkdtempSync(path.join(tmpdir(), 'edf2csv-roundtrip-'));
  const problems = [];
  let checked = 0;
  let calibrations = 0;

  try {
    for (const digMin of DIGITAL_MINS) {
      for (const digMax of DIGITAL_MAXES) {
        if (digMax <= digMin) continue;
        for (const [physMin, physMax] of PHYSICAL_PAIRS) {
          for (const bdf of [false, true]) {
            const file = path.join(base, bdf ? 'r.bdf' : 'r.edf');
            const span = digMax - digMin;
            // Sweep the declared range so both extremes and the middle are exercised.
            const gen = (unused, s) => digMin + Math.min(span, Math.round((s / 15) * span));
            writeEdf({
              path: file,
              numRecords: 1,
              recordDuration: 1,
              bdf,
              signals: [
                { label: 'ch', dimension: 'uV', physMin, physMax, digMin, digMax, samplesPerRecord: SAMPLES_PER_CALIBRATION, gen },
              ],
            });

            const out = path.join(base, 'out');
            rmSync(out, { recursive: true, force: true });
            try {
              execFileSync(process.execPath, [CLI, file, '--out', out, '--quiet'], { stdio: 'ignore' });
            } catch {
              // A calibration this rejects is reported elsewhere; nothing to round-trip.
              continue;
            }
            const table = readdirSync(out).find((n) => n.startsWith('signals'));
            if (!table) continue;
            calibrations++;

            const cells = readFileSync(path.join(out, table), 'utf8')
              .trimEnd()
              .split('\n')
              .slice(1)
              .map((row) => row.split(',')[1]);

            const edf = await EdfFile.open(file);
            const signal = edf.dataSignals[0];
            const original = [];
            for await (const batch of edf.readRecords()) {
              for (let i = 0; i < signal.samplesPerRecord; i++) {
                original.push(edf.sampleAt(batch, 0, signal, i));
              }
            }
            await edf.close();

            const { gain, offset } = calibrationOf(out);
            for (const [i, cell] of cells.entries()) {
              // An empty cell is a calibration with no mapping, reported as such; there is
              // no digital code to recover and nothing is claimed about one.
              if (cell === '') continue;
              checked++;
              const recovered = Math.round(Number(cell) / gain - offset);
              if (recovered !== original[i]) {
                problems.push(
                  `${bdf ? 'BDF' : 'EDF'} digital ${digMin}..${digMax}, physical ` +
                    `${physMin}..${physMax}: cell "${cell}" gives ${recovered}, file holds ${original[i]}`,
                );
              }
            }
          }
        }
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  return { problems, checked, calibrations };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { problems, checked, calibrations } = await sweepRoundTrip();

  process.stdout.write(`\n${checked} cells over ${calibrations} calibrations.\n`);
  if (problems.length > 0) {
    process.stdout.write(`${problems.length} did not recover:\n`);
    for (const problem of problems.slice(0, 20)) process.stdout.write(`  ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write('Every cell recovered the digital code the file holds.\n');
}
