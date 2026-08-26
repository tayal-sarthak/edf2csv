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
 *   1. Serial and parallel produce the same directories, holding the same bytes. A difference
 *      between them is what a race looks like from outside, and that is how the nesting
 *      collision fixed in 0.4.14 was found — one run made `<out>/rec`, another made
 *      `<out>/rec/inner`. The bytes matter separately: `--jobs 1` converts in this process and
 *      anything more forks a child whose command line is rebuilt by hand, so the two runs are
 *      not the same code and a flag lost in that rebuild changes only the contents.
 *   2. Each recording's output equals converting that recording on its own. A batch may
 *      reorder or parallelise the work; it may not change a byte of it.
 *   3. The closing count matches the directories actually produced, so "Converted 5 of 5"
 *      is a fact rather than a hope.
 *   4. Whatever the run reports, it never half-converts in silence: a non-zero exit has to
 *      come with a message.
 *   5. Nothing is written outside the directory that was named. Every check above reads the
 *      output roots, so a conversion that landed beside them was somewhere none of them was
 *      looking.
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

/**
 * Option sets, one per tree, cycling.
 *
 * Property 2 — a batch may reorder the work but may not change it — was only ever asked with
 * no options at all, and a batch is the one path that rebuilds the command line by hand:
 * `convertInChild` writes the flags out again for a forked process, from three lists of flag
 * names, and the changelog carries three separate defects from exactly that (`--out ./-nightly`
 * split into two arguments, the recording parsed as an option because its path began with a
 * dash, `--strict` handed to a child that is not the run). None of them could have been caught
 * by a sweep that never passed a flag.
 *
 * One set per round rather than the cross product: a tree is expensive and the shapes are
 * random, so cycling covers every option across a run and gives each one a different tree
 * every time the seed changes. `--annotations-only` is left out because it writes no signal
 * files, and every property here is about the directories those produce.
 */
const OPTIONS = [
  [],
  ['--gzip'],
  ['--bom'],
  ['--layout', 'long'],
  ['--decimals', '5'],
  ['--start', '1'],
  ['--start', '0.5', '--end', '1.5'],
  ['--duration', '1'],
  ['--channels', '#0'],
  ['--checksum'],
  ['--gzip', '--layout', 'long'],
  ['--bom', '--decimals', '2'],
];

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

      const extra = OPTIONS[round % OPTIONS.length];
      const serial = run(path.join(base, 'serial'), extra);
      const parallel = run(path.join(base, 'parallel'), ['--jobs', '3', ...extra]);

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

      /*
        Nor what is in them, which this compared only the names of.

        The two runs are not the same code. `--jobs 1` converts in this process; anything more
        forks a child per recording and rebuilds its command line by hand, from three lists of
        flag names in `convertInChild`. A flag missing from one of those lists produces a
        parallel run with the right directories and the wrong numbers in them, and the check
        above passes on a directory listing.

        Not hypothetical: deleting `decimals` from that list leaves this sweep reporting that
        serial and parallel agreed, over a batch converted at a precision nobody asked for.
        Caught here on the first tree that carries the flag.
      */
      for (const relative of fromSerial) {
        if (!fromParallel.includes(relative)) continue;
        const here = path.join(base, 'serial', relative);
        const there = path.join(base, 'parallel', relative);
        for (const name of readdirSync(here)) {
          // metadata.json carries the time of the conversion, which differs by design.
          if (name === 'metadata.json') continue;
          let other;
          try {
            other = readFileSync(path.join(there, name));
          } catch {
            problems.push(`round ${round}: ${relative}/${name} is missing from the parallel run`);
            continue;
          }
          if (!readFileSync(path.join(here, name)).equals(other)) {
            problems.push(
              `round ${round} [${extra.join(' ') || 'no options'}]: ${relative}/${name} ` +
                `differs between serial and parallel`,
            );
          }
        }
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
          execFileSync(process.execPath, [CLI, source, '--out', alone, '--quiet', ...extra], {
            stdio: 'ignore',
          });
        } catch {
          continue;
        }
        for (const name of readdirSync(alone)) {
          // metadata.json carries the time of the conversion, which differs by design.
          if (name === 'metadata.json') continue;
          const batched = readFileSync(path.join(base, 'serial', ...stem, name));
          if (!batched.equals(readFileSync(path.join(alone, name)))) {
            problems.push(
              `round ${round} [${extra.join(' ') || 'no options'}]: ${relative}/${name} ` +
                `differs from converting it alone`,
            );
          }
        }
      }
      /*
        5. Nothing was written outside the directory that was named.

        A batch derives one destination per recording from the path each was found at,
        relative to the folder the caller pointed at, and joins that onto `--out`. Whether
        that relative path can begin with `..` is a question about the walk — a symlink
        pointing out of the tree, a name that normalises oddly, a root and a recording on
        different volumes — and the answer decides whether `--out` is a destination or a
        suggestion. Nothing had ever looked. Every check here reads the output roots, so a
        conversion that landed beside them, or back inside the recordings, was somewhere
        none of them was looking.

        Asked of the whole round: every file that looks like a conversion has to be under
        one of the three roots this round created, and `study/` has to come back holding
        only the recordings that were put in it.
      */
      const roots = ['serial', 'parallel', 'alone'].map((name) => path.join(base, name));
      const strays = [];
      const sweep = (dir) => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            sweep(full);
          } else if (/^(?:signals|channels|annotations)\..*csv|^metadata\.json$/u.test(entry.name)) {
            if (!roots.some((root) => full === root || full.startsWith(root + path.sep))) {
              strays.push(path.relative(base, full));
            }
          }
        }
      };
      sweep(base);
      if (strays.length > 0) {
        problems.push(
          `round ${round} [${extra.join(' ') || 'no options'}]: written outside every ` +
            `destination named: ${strays.slice(0, 5).join(', ')}`,
        );
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
  // Nothing converted is not everything agreeing; see the comment in estimate.mjs.
  if (directories === 0) {
    process.stdout.write('No recording was converted, so nothing was compared.\n');
    process.exit(1);
  }
  /*
    The count and the list count the same thing, and the list says what it left.

    This printed `problems.length` — every problem — and then listed `new Set(problems)` cut
    to ten. Two different populations under one number: "37 problems:" above four lines left
    a reader unable to tell whether four kinds had been found or fourteen, and a run with
    eleven distinct kinds hid the eleventh with nothing to say so. Every other sweep here
    either states the total the list is drawn from or counts what it drops; this was the one
    that did neither, on the only report anyone reads when it fails.
  */
  if (problems.length > 0) {
    const distinct = [...new Set(problems)];
    const shown = distinct.slice(0, 10);
    process.stdout.write(`${problems.length} problems, ${distinct.length} of them distinct:\n`);
    for (const problem of shown) process.stdout.write(`  ${problem}\n`);
    if (distinct.length > shown.length) {
      process.stdout.write(`  ... and ${distinct.length - shown.length} more kinds\n`);
    }
    process.exit(1);
  }
  process.stdout.write('Serial and parallel agreed, and every batch matched converting alone.\n');
}
