/**
 * Random folder trees of recordings, converted as a batch.
 *
 *     npm run fuzz:batch            # 12 trees, the default seed
 *     npm run fuzz:batch -- 42 40   # a different seed, more trees
 *
 * The batch paths are where the recent bugs have been, and they are hard to reason about:
 * a folder is walked, links are followed, destinations are derived from names, and the
 * conversions may run in any order across several processes. Rather than guess which
 * arrangement breaks, this builds arrangements and checks four things that must hold
 * whatever the shape of the tree:
 *
 *   1. Serial and parallel produce the same directories. A difference between them is what
 *      a race looks like from outside, and that is how the nesting collision fixed in
 *      0.4.14 was found — one run made `<out>/rec`, another made `<out>/rec/inner`.
 *   2. Each recording's output equals converting that recording on its own. A batch may
 *      reorder or parallelise the work; it may not change a byte of it.
 *   3. The closing count matches the directories actually produced, so "Converted 5 of 5"
 *      is a fact rather than a hope.
 *   4. Whatever the run reports, it never half-converts in silence: a non-zero exit has to
 *      come with a message.
 *
 * The trees mix nesting, names with spaces and non-ASCII characters, mixed-case extensions,
 * symlinks, and files that are not recordings at all. Runs are deterministic: the same seed
 * builds the same tree, so a failure reproduces.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const CLI = path.join(ROOT, 'dist', 'cli.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'generated');

const POOL = [
  'tiny.edf',
  'annotations.edf',
  'mixed-rates.edf',
  'discontinuous.edf',
  'biosemi.bdf',
  'degenerate-range.edf',
].map((name) => path.join(FIXTURES, name));

/** Names chosen to collide with each other and with directory names. */
const NAMES = ['rec', 'night', 'a b', 'sub.dir', 'Ünïcodé', 'UPPER', 'x'];

function random(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** Directories holding a conversion, relative to the output root. */
function converted(root) {
  const found = [];
  const walk = (dir, relative) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const here = path.join(relative, entry.name);
      if (readdirSync(full).some((name) => name.startsWith('signals'))) found.push(here);
      else walk(full, here);
    }
  };
  walk(root, '');
  return found.sort();
}

export function fuzzTrees(seed = 1, trees = 12) {
  const rnd = random(seed);
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (values) => values[int(0, values.length - 1)];

  const problems = [];
  let recordings = 0;
  let directories = 0;

  for (let round = 0; round < trees; round++) {
    const base = mkdtempSync(path.join(tmpdir(), 'edf2csv-trees-'));
    try {
      const study = path.join(base, 'study');
      mkdirSync(study, { recursive: true });

      const dirs = [study];
      for (let d = 0; d < int(0, 3); d++) {
        const dir = path.join(pick(dirs), `${pick(NAMES)}-${d}`);
        mkdirSync(dir, { recursive: true });
        dirs.push(dir);
      }

      const placed = [];
      for (let f = 0; f < int(2, 7); f++) {
        const target = path.join(pick(dirs), `${pick(NAMES)}-${f}${pick(['.edf', '.EDF', '.bdf'])}`);
        writeFileSync(target, readFileSync(pick(POOL)));
        placed.push(target);
      }
      writeFileSync(path.join(study, 'notes.txt'), 'not a recording');
      if (rnd() < 0.4) {
        try {
          symlinkSync(placed[0], path.join(study, `link-${round}.edf`));
        } catch {
          // A filesystem without symlinks is not what this is testing.
        }
      }
      recordings += placed.length;

      const run = (out, extra) => {
        try {
          return {
            code: 0,
            stderr: execFileSync(process.execPath, [CLI, study, '--out', out, ...extra], {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            }),
          };
        } catch (error) {
          return { code: error.status, stderr: String(error.stderr ?? '') };
        }
      };

      const serial = run(path.join(base, 'serial'), []);
      const parallel = run(path.join(base, 'parallel'), ['--jobs', '3']);

      // 4. A failure has to say something.
      for (const [label, result] of [['serial', serial], ['parallel', parallel]]) {
        if (result.code !== 0 && result.stderr.trim() === '') {
          problems.push(`round ${round}: ${label} exited ${result.code} without a word`);
        }
      }

      const fromSerial = converted(path.join(base, 'serial'));
      const fromParallel = converted(path.join(base, 'parallel'));
      directories += fromSerial.length;

      // 1. Order and concurrency may not change which directories appear.
      if (JSON.stringify(fromSerial) !== JSON.stringify(fromParallel)) {
        problems.push(
          `round ${round}: serial produced ${JSON.stringify(fromSerial)}, ` +
            `parallel ${JSON.stringify(fromParallel)}`,
        );
      }

      // 3. The closing count is a fact.
      const claimed = /Converted (\d+) of \d+ recordings/u.exec(serial.stderr);
      if (claimed && Number(claimed[1]) !== fromSerial.length) {
        problems.push(
          `round ${round}: reported "Converted ${claimed[1]}" but produced ${fromSerial.length} directories`,
        );
      }

      // 2. A batch may reorder the work; it may not change it.
      for (const relative of fromSerial) {
        const stem = relative.split(path.sep).filter(Boolean);
        const source = placed.find(
          (file) => path.relative(study, file).replace(/\.[^.]*$/u, '') === stem.join(path.sep),
        );
        if (!source) continue;

        const alone = path.join(base, 'alone', stem.join('_'));
        try {
          execFileSync(process.execPath, [CLI, source, '--out', alone, '--quiet'], { stdio: 'ignore' });
        } catch {
          continue;
        }
        for (const name of readdirSync(alone)) {
          // metadata.json carries the time of the conversion, which differs by design.
          if (name === 'metadata.json') continue;
          const batched = readFileSync(path.join(base, 'serial', ...stem, name));
          if (!batched.equals(readFileSync(path.join(alone, name)))) {
            problems.push(`round ${round}: ${relative}/${name} differs from converting it alone`);
          }
        }
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  return { problems, recordings, directories, trees };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] ?? 1);
  const trees = Number(process.argv[3] ?? 12);
  const { problems, recordings, directories } = fuzzTrees(seed, trees);

  process.stdout.write(
    `\n${trees} folder trees, ${recordings} recordings, ${directories} conversions (seed ${seed}).\n`,
  );
  if (problems.length > 0) {
    process.stdout.write(`${problems.length} problems:\n`);
    for (const problem of [...new Set(problems)].slice(0, 10)) {
      process.stdout.write(`  ${problem}\n`);
    }
    process.exit(1);
  }
  process.stdout.write('Serial and parallel agreed, and every batch matched converting alone.\n');
}
