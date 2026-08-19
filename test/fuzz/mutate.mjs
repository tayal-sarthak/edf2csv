/**
 * Corrupt real EDF bytes and check that nothing ever crashes.
 *
 *     npm run fuzz            # 300 files, the default seed
 *     npm run fuzz -- 99 800  # a different seed, more files
 *
 * The property is narrow on purpose: whatever a damaged file contains, the tool must exit
 * 0, 1 or 2 and say something. It must not die with a V8 stack trace, and it must not hang.
 *
 * Why this and not more unit tests: a header is thirty-odd fields parsed out of bytes, and
 * the ways one can be wrong are not a list anybody can write down. A test asserts the cases
 * its author thought of, which are the cases the code already handles. Mutating real files
 * asks a different question — is there *any* arrangement of bytes that gets past the
 * checks — and it has the advantage of not sharing the author's assumptions.
 *
 * Damage is weighted toward the first kilobyte, where the fixed header and the start of the
 * signal headers live, because that is where a byte changes the meaning of everything after
 * it. A corrupted sample is just a different number; a corrupted sample count is a promise
 * about the file's shape that the file no longer keeps.
 *
 * A run is deterministic: the same seed produces the same files, so a crash reported on one
 * machine reproduces on another.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, 'dist', 'cli.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'generated');

/** Seeds worth damaging: plain EDF, EDF+ with events, mixed rates, EDF+D, and BDF. */
const SEEDS = [
  'tiny.edf',
  'annotations.edf',
  'mixed-rates.edf',
  'discontinuous.edf',
  'biosemi.bdf',
].map((name) => path.join(FIXTURES, name));

/**
 * What each corrupted file is put through.
 *
 * Four of these for a long time — a survey, its JSON, a conversion and a compressed one —
 * and the claim above them said a damaged file is reported rather than crashed, without
 * qualification. So the layout with its own row writer, the destination with no directory
 * behind it, the path that skips the signal writing altogether, the window resolver and the
 * plan rebuilt from a selection were all outside it. The long layout is the one that most
 * wanted covering: it has shipped four defects, every one of them because nothing exercised
 * it, and it is the writer a corrupt rate group reaches by a different route.
 *
 * Exported because the page states this count multiplied by the file count, and the two had
 * nothing joining them. A fifth invocation added tomorrow makes the page wrong by 300 runs.
 */
export const INVOCATIONS = [
  () => ['--info'],
  () => ['--info', '--json'],
  (dir, i) => ['--out', path.join(dir, `out${i}`), '--quiet'],
  // The compressed path puts a transform between the writer and the file, which is
  // its own set of failure routes; 0.3.1 shipped a crash that lived only there.
  (dir, i) => ['--out', path.join(dir, `gz${i}`), '--quiet', '--gzip'],
  (dir, i) => ['--out', path.join(dir, `long${i}`), '--quiet', '--layout', 'long'],
  // No directory behind it, so the failure paths that name one have nothing to name.
  () => ['--stdout'],
  (dir, i) => ['--out', path.join(dir, `ann${i}`), '--quiet', '--annotations-only'],
  // A window is record arithmetic on a header the damage may have made nonsense of.
  (dir, i) => ['--out', path.join(dir, `win${i}`), '--quiet', '--start', '0.5', '--end', '1.5'],
  // And a plan rebuilt from a selection, which is how a rate group lands in another file.
  (dir, i) => ['--out', path.join(dir, `ch${i}`), '--quiet', '--channels', '#0'],
];

/** Corrupted files per run, unless a different count is asked for. */
export const DEFAULT_FILES = 300;

/** Ways a corrupted run may end. Anything else is the bug this is looking for. */
const ALLOWED_EXITS = new Set([0, 1, 2]);

/** Signs that an error escaped rather than being reported. */
const ESCAPED = /at \w+ \(|node:internal|throw er;|Uncaught|triggerUncaughtException/u;

function random(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

export function fuzz(seed = 1, files = DEFAULT_FILES) {
  const rnd = random(seed);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

  const dir = mkdtempSync(path.join(tmpdir(), 'edf2csv-fuzz-'));
  const failures = [];
  let runs = 0;

  try {
    for (let i = 0; i < files; i++) {
      const source = SEEDS[int(0, SEEDS.length - 1)];
      const bytes = Buffer.from(readFileSync(source));

      for (let edit = 0, edits = int(1, 6); edit < edits; edit++) {
        const where =
          rnd() < 0.75 ? int(0, Math.min(bytes.length - 1, 1024)) : int(0, bytes.length - 1);
        const kind = rnd();
        bytes[where] =
          kind < 0.4 ? int(0x30, 0x39) // a digit, so a number field stays a number
            : kind < 0.6 ? 0x20 // a space, which is the padding these fields use
            : kind < 0.8 ? int(0, 255) // anything at all
            : kind < 0.9 ? 0x2d // a minus sign
            : 0x00; // NUL
      }

      const file = path.join(dir, `m${i}${path.extname(source)}`);
      writeFileSync(file, bytes);

      for (const build of INVOCATIONS) {
        const args = build(dir, i);
        runs++;
        let code = 0;
        let stderr = '';
        try {
          execFileSync(process.execPath, [CLI, file, ...args], {
            stdio: ['ignore', 'ignore', 'pipe'],
            timeout: 20_000,
          });
        } catch (error) {
          code = error.status;
          stderr = String(error.stderr ?? '');
        }
        if (!ALLOWED_EXITS.has(code) || ESCAPED.test(stderr)) {
          failures.push(
            `${path.basename(source)} -> ${path.basename(file)} ${args.join(' ')} exit ${code}\n` +
              stderr.split('\n').slice(0, 5).map((line) => `      ${line}`).join('\n'),
          );
        }
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return { runs, files, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] ?? 1);
  const files = Number(process.argv[3] ?? 300);
  const { runs, failures } = fuzz(seed, files);

  process.stdout.write(`\n${runs} runs over ${files} corrupted recordings (seed ${seed}).\n`);
  if (failures.length > 0) {
    process.stdout.write(`${failures.length} escaped instead of being reported:\n`);
    for (const failure of failures.slice(0, 10)) process.stdout.write(`  ${failure}\n`);
    process.exit(1);
  }
  process.stdout.write('Every one exited cleanly with something to say.\n');
}
