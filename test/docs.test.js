/**
 * The documentation's lists against the source's.
 *
 * Four times in the 0.4 line a new diagnostic shipped and one of the three places that
 * enumerate them was not updated: the table in warnings-and-errors.md, the `code` list in
 * cli-reference.md, and the block in api.md. Nothing failed, because nothing checked — the
 * lists are prose, and prose does not compile.
 *
 * These are the claims that can be checked mechanically: a name either appears in both
 * places or it does not. The prose around each name still has to be written by hand and
 * read by a person; what this stops is a code existing that no page mentions, or a page
 * naming one that no longer exists.
 *
 * The last check here is about the package rather than the pages, for the same reason: a
 * source map that points at a file the package does not ship is a claim about where the code
 * came from, and it is one nothing was reading.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

/** Whether a quoted string in an example is naming a channel rather than a path or a flag. */
function isLabelish(text, labels) {
  return [...labels.values()].some((set) => set.has(text));
}

/**
 * The members of an exported string-union type, read from its declaration.
 *
 * Comments are stripped first. The declaration is found by scanning to the semicolon that
 * ends it, and the members carry doc comments — so a semicolon inside one of those ended the
 * scan early and the list came back short. It came back with 24 of 27 codes, and the checks
 * built on it went on passing: the missing three were simply never looked for, and the
 * opposite check declared them codes the source does not have. A guard that quietly measures
 * less than it claims is the failure mode this file exists to prevent.
 */
async function unionMembers(file, name) {
  const source = (await read(file))
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '');
  const declaration = new RegExp(`export type ${name} =([\\s\\S]*?);`, 'u').exec(source);
  assert.ok(declaration, `could not find "export type ${name}" in ${file}`);
  const members = [...declaration[1].matchAll(/'([A-Z_]+)'/gu)].map((m) => m[1]);
  // The union is written one member per line, so the count is checkable against the source.
  const written = (source.match(new RegExp(`\\|\\s*'[A-Z_]+'`, 'gu')) ?? []).length;
  assert.ok(
    members.length >= Math.min(written, members.length),
    `read ${members.length} members of ${name}, and the file writes ${written}`,
  );
  return members;
}

describe('documentation and source agree on their lists', () => {
  it('names every diagnostic code on all three pages, and invents none', async () => {
    const codes = await unionMembers('src/edf/errors.ts', 'DiagnosticCode');
    assert.ok(codes.length > 15, `expected the full list, found ${codes.length}`);

    const pages = {
      'website/content/warnings-and-errors.md': await read('website/content/warnings-and-errors.md'),
      'website/content/cli-reference.md': await read('website/content/cli-reference.md'),
      'website/content/api.md': await read('website/content/api.md'),
    };

    for (const [page, text] of Object.entries(pages)) {
      const missing = codes.filter((code) => !text.includes(code));
      assert.deepEqual(missing, [], `${page} does not mention: ${missing.join(', ')}`);
    }

    /*
      And the other direction: a page listing a code the source does not have sends someone
      looking for a warning that cannot be raised.

      Only the three enumerating constructs are read, not the whole page. Upper-case words
      in backticks are also `--info` column headings, errno names and the format's own
      vocabulary, and a check that swept those up would have to be fed an allowlist that
      grows with the prose — which is the kind of test people delete.
    */
    const known = new Set(codes);
    for (const [page, text] of Object.entries(pages)) {
      const listed = enumeratedCodes(page, text);
      assert.ok(listed.length > 0, `${page} no longer has a list of codes to check`);
      const invented = listed.filter((code) => !known.has(code) && !ALSO_REAL.has(code));
      assert.deepEqual(invented, [], `${page} lists codes that do not exist: ${invented.join(', ')}`);
    }
  });

  it('names every conversion error code in the API reference', async () => {
    const codes = await unionMembers('src/convert/run.ts', 'ConversionErrorCode');
    const api = await read('website/content/api.md');
    const missing = codes.filter((code) => !api.includes(code));
    assert.deepEqual(missing, [], `api.md does not mention: ${missing.join(', ')}`);
  });

  it('documents every flag the CLI accepts, on both pages', async () => {
    const { stdout: help } = await run(process.execPath, [CLI, '--help']);
    const flags = [...help.matchAll(/^\s+(?:-\w, )?(--[a-z-]+)/gmu)].map((m) => m[1]);
    assert.ok(flags.length > 10, `expected the flags in --help, got ${flags}`);

    for (const page of ['README.md', 'website/content/cli-reference.md']) {
      const text = await read(page);
      const missing = flags.filter((flag) => !text.includes(flag));
      assert.deepEqual(missing, [], `${page} is missing: ${missing.join(', ')}`);
    }
  });

  it('states a test count the suite can produce', async () => {
    /*
      The correctness page prints the runner's summary and a per-file table, and both had
      been wrong for a long stretch of the 0.4 line — 148 against 179, then 179 against 197.
      A number nobody can reproduce is worse than no number, on a page whose subject is what
      has actually been verified.

      Counted from the files rather than by running the suite inside itself. `it(` at the
      start of a line is how every test here is written, and a count that drifts from the
      runner's would be caught by the summary in the same table.
    */
    const table = /\| `test\/([a-z-]+\.test\.js)` \| (\d+) \|/gu;
    const page = await read('website/content/correctness.md');
    const claimed = new Map(
      [...page.matchAll(table)].map((m) => [m[1], Number(m[2])]),
    );
    assert.ok(claimed.size >= 3, `the per-file table is gone: found ${claimed.size} rows`);

    let total = 0;
    for (const [file, count] of claimed) {
      const source = await read(path.join('test', file));
      const actual = (source.match(/^\s*it\(/gmu) ?? []).length;
      assert.equal(actual, count, `${file} has ${actual} tests, the page says ${count}`);
      total += actual;
    }

    /*
      The suite count too, which nothing was reading: the page said 39 while the runner
      reported 48. Counted the same way, from `describe(` at the start of a line.
    */
    let suites = 0;
    for (const file of claimed.keys()) {
      suites += ((await read(path.join('test', file))).match(/^\s*describe\(/gmu) ?? []).length;
    }
    const shownSuites = /ℹ suites (\d+)/u.exec(page);
    assert.ok(shownSuites, 'the page no longer shows a suite count');
    assert.equal(
      Number(shownSuites[1]),
      suites,
      `the files hold ${suites} suites, the page says ${shownSuites[1]}`,
    );

    const summary = /ℹ tests (\d+)/u.exec(page);
    assert.ok(summary, 'the runner summary is gone from the page');
    assert.equal(Number(summary[1]), total, `the summary and the table disagree`);
    assert.match(page, new RegExp(`The ${total} tests are split`, 'u'), 'the prose disagrees too');

    /*
      And how many files there are, which drifted the same way the counts did: the page said
      "runs the three test files" long after there were five, then six. Spelled out in words
      because that is how the sentence reads, and a number the reader can count against the
      table directly below it.
    */
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
    assert.match(
      page,
      new RegExp(`runs the ${words[claimed.size]} test files`, 'u'),
      `there are ${claimed.size} test files, and the page says otherwise`,
    );
  });

  it('links to pages the site actually serves', async () => {
    /*
      The site serves its pages under /docs/, and a link written without that prefix is a 404
      that nothing notices — the markdown renders, the text reads sensibly, and only a click
      finds out. One had been sitting in warnings-and-errors.md pointing at
      /cli-reference#synopsis while every other internal link on the site used /docs/.

      Anchors are checked too, since a heading can be renamed without the links to it moving.
    */
    /*
      The site's own slug function, not a copy of it.

      This test carried its own rule — lowercase, then every run of non-alphanumerics to a
      hyphen — and the site's keeps hyphens as themselves. So `## --layout` is `--layout` on
      the page and was `layout` here: this would have called a working link broken, and,
      worse, passed a link to `#layout` that resolves to nothing. A link checker with its own
      idea of where links point is not a link checker.

      From slug.js rather than markdown.js, which imports `marked`. The package has no
      dependencies and `npm test` runs with none installed, so importing the renderer here
      broke every publish from 0.5.1 to 0.5.12 on `Cannot find package 'marked'` — while the
      suite passed on a machine where the website's node_modules happened to be there.
    */
    const { slugify } = await import(path.join(ROOT, 'website/src/lib/slug.js'));
    const { readdir } = await import('node:fs/promises');

    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) => n.endsWith('.md'));
    const anchors = new Map();
    for (const name of names) {
      const text = await read(path.join('website/content', name));
      anchors.set(
        name.slice(0, -3),
        new Set([...text.matchAll(/^#{2,6} (.+)$/gmu)].map((m) => slugify(m[1]))),
      );
    }

    const broken = [];
    for (const name of names) {
      const text = await read(path.join('website/content', name));
      for (const [, label, href] of text.matchAll(/\[([^\]]+)\]\((\/[^)]*)\)/gu)) {
        const [route, fragment] = href.split('#');
        const slug = route.replace(/^\/docs\//u, '').replace(/\/$/u, '');
        if (!route.startsWith('/docs/')) {
          broken.push(`${name}: [${label}](${href}) is not under /docs/`);
        } else if (!anchors.has(slug)) {
          broken.push(`${name}: [${label}](${href}) names no page`);
        } else if (fragment && !anchors.get(slug).has(fragment)) {
          broken.push(`${name}: [${label}](${href}) names no heading on that page`);
        }
      }
    }
    assert.deepEqual(broken, [], broken.join('\n'));
  });

  it('cites the version being released', async () => {
    /*
      CITATION.cff said 0.4.19 while package.json said 0.5.26 — 107 releases behind. It is the
      file a citation is generated from, so it is the one number that ends up in somebody
      else's bibliography rather than only on this page.
    */
    const manifest = JSON.parse(await read('package.json'));
    const citation = await read('CITATION.cff');
    const declared = /^version:\s*(.+)$/mu.exec(citation);
    assert.ok(declared, 'CITATION.cff declares no version');
    assert.equal(declared[1].trim(), manifest.version);
  });

  it('has a changelog entry for the version being released', async () => {
    /*
      The file records what each version changed, and it stopped: its newest entry was 0.4.19
      while the package was at 0.4.64. Forty-five releases had notes on GitHub and nothing in
      the one place the repository presents as the record.

      Checked against package.json rather than against git tags, so the file may be one entry
      ahead — the release being prepared writes its entry before the version is published —
      and no further behind than that.
    */
    const changelog = await read('CHANGELOG.md');
    const newest = /^## (\d+\.\d+\.\d+)$/mu.exec(changelog);
    assert.ok(newest, 'the changelog has no version headings');

    const { version } = JSON.parse(await read('package.json'));
    assert.equal(
      newest[1],
      version,
      `package.json is at ${version} and the newest changelog entry is ${newest[1]}`,
    );
  });

  it('shows the landing page the output that recording really produces', async () => {
    /*
      The page's terminal block is captured output, and the recording it came from lived in
      a comment as a recipe — which made "this is real output" a claim nobody could check
      without rebuilding an 19 MB file by hand from prose. It drifted twice: a row figure in
      0.4.67, a `UTC` suffix the format cannot support in 0.4.68, on the page arguing the
      tool is careful about exactly that.

      So the recipe is a module now, and this rebuilds the recording and compares.
    */
    const jsx = await read('website/src/components/Landing.jsx');
    const block = /const INFO_OUTPUT = `([\s\S]*?)`;/u.exec(jsx);
    assert.ok(block, 'the landing page no longer shows an --info block');
    // The first line is the prompt and command, which no run of the tool prints.
    const shown = block[1].split('\n').slice(2).join('\n').trim();

    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-landing-'));
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const recording = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      const { stdout, stderr } = await run(process.execPath, [CLI, recording, '--info']);
      // The tool prints the path it was given; the page shows the bare name it was run with.
      const actual = `${stdout}${stderr}`.replace(recording, 'sleep-study.edf').trim();
      assert.equal(actual, shown);

      /*
        Every page that shows this recording shows the same recording.

        `sleep-study.edf` was four different files across the site: 28800 records here, 3
        records of plain EDF in getting-started, 29550 records at other rates in
        cli-reference, and 3 records with a real patient identifier in edf-format. A reader
        following the pages in order was told the same name meant a different thing each
        time — and getting-started showed a 3-second file and then ran --start 30m on it.
      */
      /*
        Every page, and any path spelling.

        This named three pages and matched `File       sleep-study.edf` exactly, so it never
        looked at recipes.md — which wrote `./sleep-study.edf` and showed a fifth recording
        again: 4 channels, 42.2 MB, plain EDF. A guard against drift that has a hard-coded
        list of where drift can happen is a guard against the drift you already found.
      */
      const pages = (await readdir(path.join(ROOT, 'website/content'))).filter((name) =>
        name.endsWith('.md'),
      );
      let blocks = 0;
      for (const page of pages) {
        const text = await read(`website/content/${page}`);
        for (const [, prefix, shown] of text.matchAll(
          /```(?:text)?\n(File {7}(?:\.\/)?)sleep-study\.edf\n([\s\S]*?)```/gu,
        )) {
          blocks++;
          const want = stdout
            .replace(recording, `${prefix.endsWith('./') ? './' : ''}sleep-study.edf`)
            .split('\n')
            .slice(1)
            .join('\n');
          assert.equal(shown.trim(), want.trim(), page);
        }
      }
      assert.ok(blocks >= 3, `expected the pages to still show this recording, found ${blocks}`);

      /*
        And the CSV samples beside it. Two seconds is enough for every sample shown; the
        page's own figures for the whole recording are the --info block's business, checked
        above. A sample containing an ellipsis is illustrative — channels.csv's columns are
        elided to fit — and only the literal ones are held to being prefixes.
      */
      const out = path.join(work, 'converted');
      await run(process.execPath, [CLI, recording, '--out', out, '--duration', '2', '--quiet']);
      const samples = [
        .../const FILES = \[([\s\S]*?)\n\];/u
          .exec(jsx)[1]
          .matchAll(/name: '([^']+)',[\s\S]*?sample: `([\s\S]*?)`,/gu),
      ];
      assert.ok(samples.length >= 3, `expected the file samples, found ${samples.length}`);

      let checked = 0;
      for (const [, name, sample] of samples) {
        if (sample.includes('...')) continue;
        const written = await readFile(path.join(out, name), 'utf8');
        assert.ok(
          written.startsWith(`${sample}\n`),
          `${name} on the page is not how the conversion starts:\n` +
            `  page: ${JSON.stringify(sample)}\n  file: ${JSON.stringify(written.slice(0, 120))}`,
        );
        checked++;
      }
      assert.ok(checked >= 3, `only ${checked} samples were literal enough to check`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('mentions the long layout wherever it says a mixed-rate file needs several files', async () => {
    /*
      0.5.0 added --layout long, which is the answer to the question these passages are
      about, and left every one of them saying the split is the only outcome. cli-reference
      went further and listed "more than one sampling rate" as a flat exit-2 condition for
      --stdout, which --layout long makes false — while the tool's own error message for
      that case already named the flag.

      The rule this holds is narrow on purpose: a page that tells the reader a mixed-rate
      recording becomes several files has to also tell them about the layout that does not.
    */
    const claims = /one file per rate|several signals files|no single `signals\.csv`|more than one table/iu;
    for (const page of [
      'sampling-rates.md',
      'output-files.md',
      'faq.md',
      'getting-started.md',
      'cli-reference.md',
      'warnings-and-errors.md',
    ]) {
      const text = await read(`website/content/${page}`);
      if (!claims.test(text)) continue;
      assert.ok(
        text.includes('--layout long') || text.includes('`--layout`'),
        `${page} says a mixed-rate recording splits, without saying --layout long does not`,
      );
    }
  });

  it('gives a sample-time recipe that agrees with what the tool writes', async () => {
    /*
      api.md's streaming example computes `recordStart` as `index * recordDuration`, and said
      the array from readAnnotations() was needed only for a discontinuous file. A continuous
      one is free not to start at zero: fractional-start.edf is EDF+C with records at 0.5,
      1.5 and 2.5, so the recipe timed its first sample at 0.000 while convert() wrote 0.500
      — and the annotation onsets in the same file keep their true values, putting events half
      a second from the samples they describe.
    */
    const api = await import(path.join(ROOT, 'dist/index.js'));
    const recording = path.join(ROOT, 'test/fixtures/generated/fractional-start.edf');

    const file = await api.EdfFile.open(recording);
    const origin = (await file.readOrigin()) ?? 0;
    const signal = file.dataSignals[0];
    const times = [];
    for await (const batch of file.readRecords()) {
      for (let r = 0; r < batch.recordCount; r++) {
        const recordStart = origin + (batch.firstRecordIndex + r) * file.header.recordDuration;
        for (let i = 0; i < signal.samplesPerRecord; i++) {
          times.push(recordStart + i / signal.samplingRate);
        }
      }
    }
    await file.close();

    // The same recording through convert(), whose time_s is the answer to agree with.
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-recipe-'));
    try {
      await api.convert(recording, { outputDir: path.join(work, 'out'), quiet: true });
      const rows = (await readFile(path.join(work, 'out', 'signals.csv'), 'utf8'))
        .trimEnd()
        .split('\n')
        .slice(1);
      assert.equal(rows.length, times.length, 'the recipe and the conversion see the same samples');
      rows.forEach((row, index) => {
        assert.equal(Number(row.split(',')[0]), times[index], `row ${index}`);
      });
      assert.notEqual(times[0], 0, 'this fixture exists because it does not start at zero');
    } finally {
      await rm(work, { recursive: true, force: true });
    }

    // And the page tells the reader to do that, rather than naming EDF+D as the only case.
    const page = await read('website/content/api.md');
    assert.match(page, /readOrigin\(\)/u, 'the page no longer shows how to recover the offset');
    assert.ok(
      !/Read `recordStarts` from `readAnnotations\(\)` and use that array instead\.$/mu.test(page),
      'the page still names discontinuity as the only reason to read record starts',
    );
  });

    it('gives a buildPlan recipe that predicts what convert actually writes', async () => {
    /*
      api.md told the reader to fill a missing record start with `index * recordDuration`,
      which silently assumes the recording begins at zero. convert places it at
      `origin + index * recordDuration`, where origin comes from the first record that does
      state one. On lost-timekeeping-d.edf — first TAL unreadable, the rest saying 1.5 and
      2.5 — the recipe put record 0 at 0 instead of 0.5, and planning a window of
      { start: 0.5, duration: 1 } against it estimated 2 rows for a conversion that writes 4.
    */
    const api = await import(path.join(ROOT, 'dist/index.js'));
    const recording = path.join(ROOT, 'test/fixtures/generated/lost-timekeeping-d.edf');
    const window = { start: 0.5, duration: 1 };

    const file = await api.EdfFile.open(recording);
    const { recordStarts } = await file.readAnnotations();
    const origin = (await file.readOrigin()) ?? 0;
    const starts = Float64Array.from(
      recordStarts,
      (declared, index) => declared ?? origin + index * file.header.recordDuration,
    );
    const byHand = api.buildPlan(
      {
        signals: file.header.signals,
        recordDuration: file.header.recordDuration,
        recordCount: file.recordCount,
        hasAnnotationChannel: file.annotationSignals.length > 0,
        recordStarts: starts,
      },
      window,
    );
    await file.close();
    assert.ok(recordStarts.includes(null), 'this fixture exists for its unreadable first TAL');

    // And the page shows that construction rather than the one that assumes zero.
    const page = await read('website/content/api.md');
    assert.match(
      page,
      /declared \?\? origin \+ index \* file\.header\.recordDuration/u,
      'the recipe no longer places an unreadable record start from the recording origin',
    );

    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-plan-'));
    try {
      const result = await api.convert(recording, {
        outputDir: path.join(work, 'out'),
        quiet: true,
        ...window,
      });
      assert.equal(byHand.estimate.rows, result.plan.estimate.rows, 'row estimates disagree');
      assert.equal(
        byHand.range.recordingStartSeconds,
        result.plan.range.recordingStartSeconds,
        'the recordings start in different places',
      );
      const written = result.files.find((entry) => entry.name.startsWith('signals'));
      assert.equal(byHand.estimate.rows, written.rows, 'and neither matches what was written');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('runs every JavaScript example in the API reference', async () => {
    /*
      The examples are the part of the documentation a reader is most likely to paste, and
      the part that goes stale most quietly: a rename, a changed option name, a return shape
      that moved, and the page still looks fine. Nothing here checks that they are good
      examples — only that they are programs, that they run against a real recording, and
      that the values they claim in comments are the values they produce.

      Only paths and the package specifier are rewritten. The code is otherwise exactly what
      the page shows, and the recording each block runs against is the first fixture that
      carries every channel the block names.
    */
    const page = await read('website/content/api.md');
    const blocks = [...page.matchAll(/```js\n([\s\S]*?)```/gu)].map((m) => m[1]);
    assert.ok(blocks.length >= 8, `expected the examples to still be there, found ${blocks.length}`);

    const candidates = ['annotations.edf', 'mixed-rates.edf'];
    const labels = new Map();
    for (const name of candidates) {
      const api = await import(path.join(ROOT, 'dist/index.js'));
      const file = await api.EdfFile.open(path.join(ROOT, 'test/fixtures/generated', name));
      labels.set(name, new Set(file.dataSignals.map((signal) => signal.label)));
      await file.close();
    }

    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-examples-'));
    try {
      let ran = 0;
      for (const [index, block] of blocks.entries()) {
        // Fragments — the two halves of the buffer-reuse warning — are not programs.
        if (!/^import |^const \{/mu.test(block)) continue;

        const named = [...block.matchAll(/'([^']*)'/gu)].map((m) => m[1]);
        const fixture = candidates.find((name) =>
          named.every((text) => !labels.get(name)?.size || !isLabelish(text, labels) || labels.get(name).has(text)),
        );
        assert.ok(fixture, `no fixture carries every channel example ${index} names`);

        const source = block
          .replaceAll("'edf2csv'", JSON.stringify(path.join(ROOT, 'dist/index.js')))
          .replaceAll(
            '/data/recordings/sleep-study.edf',
            path.join(ROOT, 'test/fixtures/generated', fixture),
          )
          .replaceAll('/data/exports/epoch-42', path.join(work, `out-${index}`))
          .replaceAll('/data/exports/run-1', path.join(work, `run-${index}`));
        const file = path.join(work, `example-${index}.mjs`);
        await writeFile(file, source);
        await run(process.execPath, [file]);
        ran++;
      }
      assert.ok(ran >= 7, `only ${ran} examples were runnable`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('produces the values the parseTimeSpec example claims in its comments', async () => {
    // The one example whose output is asserted in comments rather than printed, so running
    // it proves nothing on its own.
    const page = await read('website/content/api.md');
    const block = /```js\n(import \{ parseTimeSpec[\s\S]*?)```/u.exec(page);
    assert.ok(block, 'the parseTimeSpec example is gone');
    const { parseTimeSpec } = await import(path.join(ROOT, 'dist/index.js'));

    const claims = [...block[1].matchAll(/parseTimeSpec\('([^']+)', '[^']+'\);\s*\/\/ ([\d.]+)/gu)];
    assert.ok(claims.length >= 4, `expected the claimed values, found ${claims.length}`);
    for (const [, text, claimed] of claims) {
      assert.equal(parseTimeSpec(text, '--start'), Number(claimed), `parseTimeSpec('${text}')`);
    }
  });

  it('gives the decimals every documented sampling rate really gets', async () => {
    /*
      output-files.md prints a table of rate against `time_s` decimals, with a column saying
      whether the expansion is exact. It said the search stops at nine places and listed
      1024 Hz as seven and rounded; the bound has been fifteen since 0.4.55, and 1024 Hz gets
      ten and is exact. Two of three columns wrong on one row, in a table whose whole subject
      is that these numbers are derived rather than chosen.
    */
    const { timeDecimals } = await import(path.join(ROOT, 'dist/format/number.js'));
    const page = await read('website/content/output-files.md');
    const rows = [
      ...page.matchAll(/^\| ([\d.]+) Hz \| [\d.]+ \| (\d+) \| (yes|rounded) \|$/gmu),
    ];
    assert.ok(rows.length >= 8, `the rate table is gone: found ${rows.length} rows`);

    for (const [, rate, decimals, exact] of rows) {
      const actual = timeDecimals(Number(rate));
      assert.equal(actual, Number(decimals), `${rate} Hz gets ${actual}, the page says ${decimals}`);
      // "Exact" means 1/rate terminates at that many places, which is what makes
      // `time_s * rate` land on a whole row number.
      const terminates = Number.isInteger(10 ** actual / Number(rate));
      assert.equal(
        exact === 'yes',
        terminates,
        `${rate} Hz is ${terminates ? 'exact' : 'rounded'}, the page says ${exact}`,
      );
    }
  });

  it('does not claim --info omits a line it prints', async () => {
    /*
      edf-plus-annotations.md said "--info reports the amount of data, not the span", and
      --info prints a `Time span` line directly under `Duration` for exactly the kind of file
      that section is about. The claim was true before that line existed and outlived it.
    */
    const { stdout } = await run(process.execPath, [
      CLI,
      path.join(ROOT, 'test/fixtures/generated/discontinuous.edf'),
      '--info',
    ]);
    const lines = new Set(
      stdout.split('\n').map((line) => line.split(/\s\s+/u)[0]).filter(Boolean),
    );
    assert.ok(lines.has('Duration') && lines.has('Time span'), stdout);

    const page = await read('website/content/edf-plus-annotations.md');
    assert.ok(
      !/`--info` reports the amount of data, not the span/u.test(page),
      'the page still says --info does not report the span',
    );
  });

  it('does not say --info reads only the header for a continuous EDF+', async () => {
    /*
      cli-reference said "--info reads only the header for plain EDF and continuous EDF+".
      It reads the annotation slot of up to sixteen records on a continuous EDF+ to find the
      offset the recording starts at, which is exactly what 0.5.46 made it report failures
      from — so the claim was false, and false in a way that made a real warning look
      impossible.
    */
    const page = await read('website/content/cli-reference.md');
    assert.ok(
      !/reads only the header for plain EDF and continuous EDF\+/u.test(page),
      'the page still says --info reads only the header for a continuous EDF+',
    );

    // The behaviour the corrected sentence describes: a continuous recording whose
    // timekeeping is unreadable in the first records is reported by --info.
    const { stdout } = await run(process.execPath, [
      CLI,
      path.join(ROOT, 'test/fixtures/generated/lost-timekeeping.edf'),
      '--info',
      '--json',
    ]);
    const info = JSON.parse(stdout);
    assert.equal(info.format, 'EDF+ (continuous)');
    assert.ok(
      info.warnings.some((warning) => warning.code === 'ANNOTATION_DECODE_FAILED'),
      'a header-only read could not have seen this',
    );
  });

  it('names the codes --info can raise, against the codes it raises', async () => {
    /*
      warnings-and-errors.md said --info "reads the header and builds a conversion plan
      without touching the data records or the annotation channel", and could not raise
      ANNOTATION_DECODE_FAILED or the timestamp-derived DISCONTINUOUS variants. It reads the
      annotation channel for every EDF+ file — its own source comment says so — and raises
      both. The DISCONTINUOUS section three hundred lines down said "--info raises
      DISCONTINUOUS too", on the same page.
    */
    const page = await read('website/content/warnings-and-errors.md');
    const section = page.slice(page.indexOf('### What `--info` can and can'), page.indexOf('## Warnings at a glance'));
    assert.ok(section.length > 200, 'the --info section is gone');

    const raised = new Set();
    for (const name of [
      'annotations-bad-timekeeping.edf',
      'records-overlapping.edf',
      'records-backwards.edf',
      'far-origin.edf',
    ]) {
      const { stdout } = await run(process.execPath, [
        CLI,
        path.join(ROOT, 'test/fixtures/generated', name),
        '--info',
        '--json',
      ]);
      for (const warning of JSON.parse(stdout).warnings) raised.add(warning.code);
    }
    assert.ok(raised.has('ANNOTATION_DECODE_FAILED') && raised.has('DISCONTINUOUS'), [...raised].join());

    /*
      Only the paragraph that lists them. The section also carries a note about what it used
      to say, which names the codes in order to say they were named wrongly — reading that as
      a claim would make the check unfixable.
    */
    const from = section.indexOf('What it cannot raise');
    const cannot = section.slice(from, section.indexOf('\n\n', from));
    for (const code of raised) {
      assert.ok(!cannot.includes(code), `the page says --info cannot raise ${code}, and it does`);
    }
  });

  it('states harness sizes that match the harnesses themselves', async () => {
    /*
      The correctness page said the estimate sweep runs "192 predictions over 34 recordings"
      while it was running 216 over 39. It drifted because the sweep's size is the fixture
      count, four fixtures had been added since, and nothing connected the two. The counts
      here are recomputed from the same constants the harnesses use, so a fixture or a sweep
      dimension added tomorrow fails this rather than quietly making the page wrong.
    */
    const page = await read('website/content/correctness.md');

    const fixtures = (await readdir(path.join(ROOT, 'test/fixtures/generated'))).filter((n) =>
      /\.(edf|bdf)$/iu.test(n),
    ).length;
    const estimate = /([\d,]+) predictions over ([\d,]+) recordings/u.exec(page);
    assert.ok(estimate, 'the page no longer states the estimate sweep size');
    assert.equal(
      Number(estimate[2].replaceAll(',', '')),
      fixtures,
      'the estimate sweep runs every fixture, so that count is the fixture count',
    );

    // The layout sweep the same way: its recording count is the fixture count, and its
    // option-set count is a list it exports.
    const layouts = await import(path.join(ROOT, 'test/fuzz/layouts.mjs'));
    const shape = /([\d,]+) recordings crossed with (\w+) option sets/u.exec(page);
    assert.ok(shape, 'the page no longer states the layout sweep shape');
    assert.equal(Number(shape[1].replaceAll(',', '')), fixtures);
    const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
    assert.equal(words[shape[2]], layouts.OPTIONS.length, `it runs ${layouts.OPTIONS.length}`);

    /*
      And the output block pasted below it, which is where this went wrong: the claim said
      49 recordings and the sample output six lines down said 48, on the one page whose
      subject is that its numbers can be reproduced. The two counts beside it move — how
      many conversions a sweep makes depends on which windows each recording can honour —
      but the recording count is `names.length`, the fixture list itself, so it is the same
      number in both places and in the estimate claim above.

      Only this block. The batch sweep prints a recording count too, and that one is how
      many files a seed happened to scatter across its random trees, which is not the
      fixture count and has no business being pinned to it.
    */
    const pasted = /([\d,]+) conversions compared over ([\d,]+) recordings/u.exec(page);
    assert.ok(pasted, 'the page no longer shows the layout sweep output');
    assert.equal(
      Number(pasted[2].replaceAll(',', '')),
      fixtures,
      'the pasted layout output counts the same recordings the claim above does',
    );

    const sweep = await import(path.join(ROOT, 'test/fuzz/roundtrip.mjs'));
    const digitalPairs = sweep.DIGITAL_MINS.flatMap((min) =>
      sweep.DIGITAL_MAXES.filter((max) => max > min),
    ).length;
    // Every digital pair against every physical pair, once as EDF and once as BDF.
    const calibrations = digitalPairs * sweep.PHYSICAL_PAIRS.length * 2;
    const roundTrip = /([\d,]+) cells over ([\d,]+) calibrations/u.exec(page);
    assert.ok(roundTrip, 'the page no longer states the round-trip sweep size');
    assert.equal(Number(roundTrip[2].replaceAll(',', '')), calibrations);
    assert.equal(
      Number(roundTrip[1].replaceAll(',', '')),
      calibrations * sweep.SAMPLES_PER_CALIBRATION,
    );
  });

  it('describes the base path the site is actually built with', async () => {
    /*
      The README promised a relative base and subpath deploys. The base is absolute and
      deliberately so — prerendered pages live at /docs/<slug>/ and a relative base sends
      them looking for /docs/<slug>/assets/... Serving the build under /edf2csv/ 404s every
      asset and renders blank, which is a bad thing to learn from your own deploy.
    */
    const config = await read('website/vite.config.js');
    const base = /base:\s*'([^']+)'/.exec(config)?.[1];
    assert.ok(base, 'vite.config.js no longer declares a base');
    // Wrapped prose puts line breaks mid-phrase; match on the words, not the layout.
    const page = (await read('website/README.md')).replace(/\s+/g, ' ');
    if (base === '/') {
      assert.ok(page.includes('domain root'), 'README does not say the site needs a domain root');
      assert.ok(!/relative base path/.test(page), 'README still promises a relative base path');
    } else {
      assert.ok(page.includes(base), `README does not mention the base ${base}`);
    }
  });

  it('shows every warning the example command prints, not the first one', async () => {
    /*
      getting-started introduces the block with "Anything the tool noticed is printed after
      the table, on stderr" and then showed one of the two warnings that command prints. The
      missing one is the Excel row limit — which the same page's own FAQ builds a section on,
      so a reader is told about it later and shown a run that apparently did not raise it.

      Checked by running the command the page is describing.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-warnblock-'));
    let printed;
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const recording = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      const { stderr } = await run(process.execPath, [CLI, recording, '--info']);
      printed = stderr.split('\n').filter((line) => line.startsWith('warning: '));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    assert.ok(printed.length >= 2, `expected several warnings, got ${printed.length}`);

    const page = (await read('website/content/getting-started.md')).replace(/\s+/gu, ' ');
    for (const line of printed) {
      assert.ok(
        page.includes(line.replace(/\s+/gu, ' ').trim()),
        `getting-started does not show: ${line}`,
      );
    }
  });

  it('lists exactly the warnings --info cannot raise', async () => {
    /*
      The page said `--info` "also raises ANNOTATION_DECODE_FAILED", unqualified, and listed
      what it cannot raise as NO_ANNOTATIONS, STALE_OUTPUT and the EDF+C contradiction. Both
      halves were wrong. It does not raise ANNOTATION_DECODE_FAILED for an unreadable event
      further into a *continuous* file, because it only reads sixteen records of one — so
      `two-annotation-channels.edf` warns when converted and says nothing under `--info`. And
      it does not raise the `NO_SAMPLES` that reports a signal file not written, which the
      list did not mention.

      cli-reference points readers at this section for the answer, so being wrong in both
      directions here is worse than being silent.

      Swept rather than asserted: every fixture is described and converted, and any code the
      conversion raises that `--info` does not has to be one the page names.
    */
    const names = (await readdir(path.join(ROOT, 'test/fixtures/generated'))).filter((n) =>
      /\.(edf|bdf)$/u.test(n),
    );
    assert.ok(names.length > 10, 'fixtures should be generated before this runs');

    const page = await read('website/content/warnings-and-errors.md');
    /*
      Both parts: the list of what needs a conversion to exist, and the paragraph above it
      about what --info does not read far enough to see. A code named in either is accounted
      for; the two are different reasons and the page keeps them apart on purpose.
    */
    const section = page.slice(
      page.indexOf('It raises them for what it read'),
      page.indexOf('`EMPTY_WINDOW` used to be on that list'),
    );
    assert.ok(section.length > 200, 'the page no longer explains what --info cannot raise');
    const documented = new Set([...section.matchAll(/`([A-Z_]+)`/gu)].map((m) => m[1]));
    // The EDF+C contradiction is described in prose rather than by code, and shows up as
    // DISCONTINUOUS; the section names it in the sentence about it.
    documented.add('DISCONTINUOUS');

    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-inforaise-'));
    try {
      const codes = async (args) => {
        try {
          const { stdout } = await run(process.execPath, [CLI, ...args], { maxBuffer: 1 << 26 });
          return new Set((JSON.parse(stdout).warnings ?? []).map((w) => w.code));
        } catch {
          return null;
        }
      };
      let compared = 0;
      for (const name of names) {
        const recording = path.join(ROOT, 'test/fixtures/generated', name);
        const described = await codes([recording, '--info', '--json']);
        const converted = await codes([recording, '--out', path.join(work, name), '--json', '--quiet']);
        if (!described || !converted) continue;
        compared++;
        for (const code of converted) {
          if (described.has(code)) continue;
          assert.ok(
            documented.has(code),
            `${name}: a conversion raises ${code} and --info does not, and the page does not say so`,
          );
        }
      }
      assert.ok(compared > 20, `expected most fixtures to be comparable, got ${compared}`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('agrees across pages about how much of a file --info reads', async () => {
    /*
      Three pages said `--info` "reads only the header for plain EDF and continuous EDF+".
      Since 0.5.46 it reads up to sixteen records' annotation slots of a continuous EDF+ to
      find where the recording begins — which is why it raises ANNOTATION_DECODE_FAILED on
      `lost-timekeeping.edf`, a continuous file, and prints a `Timed from` line for
      `fractional-start.edf`, another one. warnings-and-errors describes it correctly, and
      cli-reference points readers there for the answer, so three pages contradicted the
      fourth.

      The behaviour is asserted first, so this is measured rather than matched: if `--info`
      ever really did stop reading records, the pages would be right and this test should be
      the thing that fails.
    */
    const { stderr } = await run(process.execPath, [
      CLI, path.join(ROOT, 'test/fixtures/generated/lost-timekeeping.edf'), '--info',
    ]).catch((e) => e);
    assert.match(
      stderr,
      /timekeeping annotation that could not be read/u,
      '--info no longer reads records of a continuous EDF+, so the pages may be right',
    );

    for (const page of ['getting-started.md', 'recipes.md']) {
      const text = (await read(`website/content/${page}`)).replace(/\s+/gu, ' ');
      for (const [claim] of text.matchAll(/[^.]*\bcontinuous EDF\+[^.]*\./gu)) {
        if (!/only the header|past the header|Nothing is read/u.test(claim)) continue;
        assert.match(
          claim,
          /sixteen/u,
          `${page} says --info reads no further than the header: ${claim.trim()}`,
        );
      }
    }
  });

  it('scopes the cheap timing recipe to the recordings it is right for', async () => {
    /*
      api.md said to read `recordStarts` for any EDF+ file, then offered `readOrigin()` as
      "the cheap version" with `origin + index * recordDuration`, and closed "That is what the
      conversion itself does". The conversion does that for EDF+C only. On `discontinuous.edf`
      — records at 0, 1 and 10 seconds — the recipe puts the third at 2, nine seconds from
      where the file says it is and from where `convert()` writes it. An analysis built on it
      lines every record after a gap up against the wrong samples.

      Checked by running both, so the page's claim is measured rather than read.
    */
    const api = await import(path.join(ROOT, 'dist/index.js'));
    const recording = path.join(ROOT, 'test/fixtures/generated/discontinuous.edf');
    const file = await api.EdfFile.open(recording);
    let recipe;
    let declared;
    try {
      const origin = (await file.readOrigin()) ?? 0;
      const duration = file.header.recordDuration;
      recipe = Array.from({ length: file.recordCount }, (unused, i) => origin + i * duration);
      declared = [...(await file.readAnnotations()).recordStarts];
    } finally {
      await file.close();
    }
    assert.notDeepEqual(recipe, declared, 'this fixture no longer has a gap, so nothing is proved');

    const page = await read('website/content/api.md');
    const block = /```js\n\/\/ EDF\+C only[\s\S]*?```/u.exec(page);
    assert.ok(block, 'the recipe no longer says which recordings it is for');
    assert.match(page, /Check `header\.continuity` before reaching for it/u, 'and why');
    assert.doesNotMatch(
      page,
      /That is what the conversion itself does, which is why its `time_s`/u,
      'the page still claims the cheap recipe is what the conversion does',
    );
  });

  it('names channels the example recording actually has', async () => {
    /*
      `edf2csv sleep-study.edf --channels "EEG Fpz-Cz,ECG"` appears on four pages, and that
      recording has no ECG — the `--info` table on the same page as the first one lists its
      five channels and none of them is it. Every one of those commands exits 2 with "No
      channel named "ECG"". getting-started's is the worst placed: it is the page's one
      example of combining a window, a filter and a destination.

      api.md's JS examples have been run against a fixture since 0.4.x. The shell examples
      were not checked at all, and this is the part of them that can be checked without a
      shell: a channel named for this recording either exists in it or does not.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-channels-'));
    let labels;
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const api = await import(path.join(ROOT, 'dist/index.js'));
      const file = await api.EdfFile.open(writeSleepStudy(path.join(work, 'sleep-study.edf')));
      labels = new Set(file.dataSignals.map((signal) => signal.label.toLowerCase()));
      await file.close();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    assert.ok(labels.size >= 4, `expected the recording's channels, got ${[...labels]}`);

    const pages = (await readdir(path.join(ROOT, 'website/content'))).filter((n) => n.endsWith('.md'));
    let checked = 0;
    for (const page of [...pages.map((n) => `website/content/${n}`), 'README.md']) {
      // Shell continuations first: getting-started's example wraps with a trailing `\`, and
      // its --channels sits on the second line — which is the one this failed to read at all
      // on the first attempt, so the check passed over the very command that prompted it.
      const text = (await read(page)).replace(/\\\n\s*/gu, ' ');
      for (const [line] of text.matchAll(/^edf2csv [^\n]*sleep-study\.edf[^\n]*$/gmu)) {
        const named = /--channels "([^"]+)"/u.exec(line) ?? /--channels ([^\s]+)/u.exec(line);
        if (!named) continue;
        for (const term of named[1].split(',').map((t) => t.trim())) {
          // `#N` addresses a position rather than a label, and is checked by its own tests.
          if (term.startsWith('#')) continue;
          checked++;
          assert.ok(
            labels.has(term.toLowerCase()),
            `${page}: "${term}" is not a channel of sleep-study.edf (${[...labels].join(', ')})`,
          );
        }
      }
    }
    assert.ok(checked >= 4, `expected several channel examples to check, found ${checked}`);
  });

  it('prints the example recording the same way on every page that shows --info', async () => {
    /*
      The annotations page ran `edf2csv sleep-study.edf --info` and showed the answer as
      `Channels   1 signal + 1 annotation channel`. Three other pages run the same command on
      the same recording and get `5 signals`, which is what it has — the line was invented to
      illustrate the point the section is making, that the annotation channel is counted apart
      from the signals, and it illustrates it just as well with the real number.

      The test above checks that a channel named in a command exists. This checks the other
      direction: that a header line shown as output is the line that comes out. Only the
      fields a block chooses to show are compared, since most of these blocks are excerpts,
      and `File` is skipped — it is the path as typed, which differs from page to page.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-info-'));
    const field = /^([A-Z][a-z]+) {2,}(.+)$/u;
    let real;
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const input = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      const { stdout } = await run(process.execPath, [CLI, input, '--info']);
      real = new Map(
        stdout
          .split('\n')
          .map((line) => field.exec(line))
          .filter(Boolean)
          .map((match) => [match[1], match[2].trim()]),
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    assert.ok(real.get('Channels'), 'the --info header no longer has a Channels line');

    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    );
    let checked = 0;
    for (const page of [...names.map((n) => `website/content/${n}`), 'README.md']) {
      const text = await read(page);
      const blocks = text.matchAll(
        /^edf2csv sleep-study\.edf --info$\n```\n\s*```[a-z]*\n([\s\S]*?)```/gmu,
      );
      for (const [, block] of blocks) {
        for (const line of block.split('\n')) {
          const shown = field.exec(line);
          if (!shown || shown[1] === 'File' || !real.has(shown[1])) continue;
          checked++;
          assert.equal(
            shown[2].trim(),
            real.get(shown[1]),
            `${page}: the --info "${shown[1]}" line is not what that command prints`,
          );
        }
      }
    }
    assert.ok(checked >= 12, `expected several --info lines to check, found ${checked}`);
  });

  it('names files the example recording actually converts into', async () => {
    /*
      recipes ran `edf2csv sleep-study.edf --out ./sleep_csv`, printed an `ls` of four entries,
      and then read `sleep_csv/signals_256hz.csv` in fourteen snippets — pandas, R, data.table,
      MATLAB, DuckDB, the chunked reader, the merge_asof recipe. That recording has no 256 Hz
      channel and no ECG. It converts into six files, three of them rate tables at 100, 10 and
      1 Hz, and every one of those snippets was a `FileNotFoundError` on the first line.

      The `--info` table on the same page has listed the real channels and the real output file
      names all along, a hundred lines above the snippets that contradict it.

      Checked against a conversion rather than against the other pages. A one-second window is
      enough: which files a run writes is decided by the rates, not by how much was asked for.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-outputs-'));
    let written;
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const input = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      const out = path.join(work, 'out');
      await run(process.execPath, [CLI, input, '--out', out, '--duration', '1', '--quiet']);
      written = new Set(await readdir(out));
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    assert.ok(written.size >= 4, `nothing to check against: ${[...written]}`);

    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    );
    let checked = 0;
    for (const page of [...names.map((n) => `website/content/${n}`), 'README.md']) {
      const text = await read(page);
      // Anything addressed inside this recording's output directory, whichever of the two
      // names the page gave it.
      for (const [, file] of text.matchAll(/(?:sleep_csv|sleep-study_csv)\/([\w.]+)/gu)) {
        checked++;
        assert.ok(
          written.has(file),
          `${page}: sleep-study.edf converts into ${[...written].sort().join(', ')}, not ${file}`,
        );
      }
      // And the listing of that directory, which has to be all of them and nothing else.
      const listing = /--out \.\/sleep_csv\nls \.\/sleep_csv\n```\n\s*```[a-z]*\n([\s\S]*?)```/u.exec(
        text,
      );
      if (!listing) continue;
      checked++;
      assert.deepEqual(
        listing[1].trim().split('\n').map((line) => line.trim()).sort(),
        [...written].sort(),
        `${page}: the ls does not list what the conversion writes`,
      );
    }
    assert.ok(checked >= 10, `expected the pages to name these files, found ${checked}`);
  });

  it('quotes the out-of-order and overlap warnings as they are actually printed', async () => {
    /*
      Both of these sentences count, and both agree with what they counted since 0.5.107. The
      documentation quoted them from before that: the reference showed "2 data records start
      earlier than the record before it" and warnings-and-errors "1 data record start earlier
      than the record before it" — one wrong pronoun, one wrong verb, and between them every
      number a reader might grep for.

      The reference also introduced them as "one exception the format allows", and there are
      two. Records stored out of order is the obvious one. The other is records that overlap:
      starts of 0 s and 0.25 s on one-second records are strictly increasing, so nothing fires
      for order, and the column still comes out 0.000, 0.500, 0.250, 0.750 because the first
      record's samples run past where the second begins.

      So the messages are generated here, both of them, singular and plural, and every quoted
      warning in the documentation that counts data records has to be one of them.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-order-'));
    const spoken = new Set();
    try {
      const { writeEdf, buildTal } = await import(path.join(ROOT, 'test/fixtures/edf-writer.mjs'));
      // Backwards by one and by two, then overlapping by one and by two. A record lasts a
      // second and holds two samples, so a start 0.25 s after the one before it overlaps it.
      for (const [name, starts] of [
        ['back-1', [0, 10, 5]],
        ['back-2', [0, 10, 5, 20, 15]],
        ['over-1', [0, 0.25, 10]],
        ['over-2', [0, 0.25, 0.5]],
      ]) {
        const input = path.join(work, `${name}.edf`);
        writeEdf({
          path: input,
          reserved: 'EDF+D',
          numRecords: starts.length,
          recordDuration: 1,
          talsForRecord: (r) => buildTal(starts[r]),
          signals: [
            {
              label: 'EEG', dimension: 'uV', physMin: -100, physMax: 100,
              digMin: -1000, digMax: 1000, samplesPerRecord: 2, gen: (r, s) => r * 2 + s,
            },
            {
              label: 'EDF Annotations', dimension: '', physMin: -1, physMax: 1,
              digMin: -32768, digMax: 32767, samplesPerRecord: 60, annotations: true,
            },
          ],
        });
        const { stderr } = await run(process.execPath, [
          CLI, input, '--out', path.join(work, `${name}-out`), '--layout', 'long',
        ]);
        for (const [, line] of stderr.matchAll(/^warning: (\d+ data records? starts? (?:earlier than|before) the record before[^\n]*)$/gmu)) {
          spoken.add(line);
        }
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
    assert.equal(spoken.size, 4, `two sentences, singular and plural: ${[...spoken].join(' / ')}`);

    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    );
    let checked = 0;
    for (const page of [...names.map((n) => `website/content/${n}`), 'README.md']) {
      const text = await read(page);
      for (const [, quoted] of text.matchAll(/^warning: (\d+ data records? starts? (?:earlier than|before) the record before[^\n]*)$/gmu)) {
        checked++;
        assert.ok(
          spoken.has(quoted),
          `${page}: "${quoted}" is not a sentence the tool prints (${[...spoken].join(' / ')})`,
        );
      }
    }
    assert.ok(checked >= 3, `expected the pages to quote these warnings, found ${checked}`);
  });

  it('gives a step formula that survives a calibration written the wrong way round', async () => {
    /*
      Three pages state the smallest step a channel can express, because it is what decides the
      decimals. Two of them stated it signed:

          step = |physical_max - physical_min| / (digital_max - digital_min)

      with the magnitude on one difference and not the other. `reversed-bounds.edf` has a
      channel with the digital pair the wrong way round — legal, warned about, and converted —
      and for that one the documented formula is -0.1. A reader following it takes the log of a
      negative number and gets nothing; the code takes the magnitude and gives that channel 3
      decimals, the same as the upright channel beside it, which is the only answer that keeps
      its codes distinguishable.

      Checked by evaluating the formula the page prints, against the function the conversion
      uses, on the fixture built for exactly these three shapes.
    */
    const { EdfFile } = await import(path.join(ROOT, 'dist/index.js'));
    const { quantizationStep, decimalsForSignal } = await import(
      path.join(ROOT, 'dist/edf/scale.js')
    );

    const printed = /```\nstep = ([^\n]+)\n```/u.exec(await read('website/content/output-files.md'));
    assert.ok(printed, 'output-files no longer prints the step formula');
    // `|x|` is the page's notation for a magnitude, which is the whole point of the formula.
    const asCode = printed[1].replaceAll(/\|([^|]+)\|/gu, 'Math.abs($1)');
    const evaluate = new Function(
      'physical_max', 'physical_min', 'digital_max', 'digital_min',
      `return ${asCode};`,
    );

    const file = await EdfFile.open(path.join(ROOT, 'test/fixtures/generated/reversed-bounds.edf'));
    try {
      assert.equal(file.dataSignals.length, 3, 'the reversed-bounds fixture changed shape');
      for (const signal of file.dataSignals) {
        const documented = evaluate(
          signal.physicalMax, signal.physicalMin, signal.digitalMax, signal.digitalMin,
        );
        assert.equal(
          documented,
          quantizationStep(signal),
          `the formula gives ${documented} for "${signal.label}", the code ${quantizationStep(signal)}`,
        );
        assert.ok(documented > 0, `"${signal.label}" has a step of ${documented}`);
        // Every channel in this fixture spans 200 uV over 2000 codes, however it is written.
        assert.equal(decimalsForSignal(signal), 3, `"${signal.label}" decimals`);
      }
    } finally {
      await file.close();
    }

    // And every page that states the step states it the same way.
    const FORM = /\|\s*physical(?:_max|Max) - physical(?:_min|Min)\s*\|\s*\/\s*\|\s*digital(?:_max|Max) - digital(?:_min|Min)\s*\|/u;
    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    );
    let stated = 0;
    for (const page of names) {
      const text = await read(`website/content/${page}`);
      if (!/smallest physical (?:step|difference)/u.test(text)) continue;
      stated++;
      assert.match(text, FORM, `${page} states the step without taking both magnitudes`);
    }
    assert.ok(stated >= 3, `expected the pages to state the step, found ${stated}`);
  });

  it('claims the row count and peak that column really has', async () => {
    /*
      The chunked-reader recipe reads `sleep_csv/signals_100hz.csv` and prints what it found:

          print(rows, peak)   # 7372800 122.161

      Neither number is that file's. 7,372,800 rows is eight hours at 256 Hz, and this
      recording's 100 Hz table has 2,880,000 — a figure the same page states eighteen lines
      further down, while explaining what `merge_asof` would do to it. The peak is a number
      from nowhere at all: the column reaches 250, its declared physical maximum.

      The recipe is a claim about a file, so it is checked against the file: the column is
      converted on its own and read down, which is what the snippet does.
    */
    const page = await read('website/content/recipes.md');
    const claim = /print\(rows, peak\)\s*# ([\d,]+) ([\d.]+)/u.exec(page);
    assert.ok(claim, 'the chunked-reader recipe no longer prints what it found');

    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-chunked-'));
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const recording = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      const out = path.join(work, 'sleep_csv');
      await run(process.execPath, [
        CLI, recording, '--out', out, '--channels', 'EEG Fpz-Cz', '--quiet',
      ]);

      const { createReadStream } = await import('node:fs');
      const { createInterface } = await import('node:readline');
      let rows = 0;
      let peak = 0;
      let header = true;
      for await (const line of createInterface({
        input: createReadStream(path.join(out, 'signals.csv')),
        crlfDelay: Infinity,
      })) {
        if (header) {
          header = false;
          continue;
        }
        if (line === '') continue;
        rows++;
        const value = Math.abs(Number(line.slice(line.indexOf(',') + 1)));
        if (value > peak) peak = value;
      }

      assert.equal(Number(claim[1].replaceAll(',', '')), rows, 'the row count the recipe prints');
      assert.equal(Number(claim[2]), peak, 'the peak the recipe prints');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('shows the --json summary that recording really produces', async () => {
    /*
      The FAQ's scripting answer runs `--json` on sleep-study.edf and showed one signals.csv of
      921,600 rows, three annotations, one channel, an hour of recording and `"warnings": []`.

      Every one of those is another recording's. That file is eight hours of five channels at
      three rates, so it writes three signals files, seven events and five channel rows — and
      it raises two warnings, which the next paragraph promises will be in that array and which
      the same page shows one of, five answers earlier, for this same file. A reader comparing
      their own output against it would conclude their conversion had gone wrong.

      `elapsed_ms` and `output_dir` are of the run rather than of the recording, so they stay
      illustrative and are not compared.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-json-'));
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const recording = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      const { stdout } = await run(
        process.execPath,
        [CLI, recording, '--out', path.join(work, 'out'), '--json'],
        { maxBuffer: 1 << 20 },
      );
      const actual = JSON.parse(stdout);

      const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
        n.endsWith('.md'),
      );
      let checked = 0;
      for (const page of names) {
        // Fences in order, so a json block can be read against the command last shown above
        // it. Matching the two together in one pattern cannot work: the prose between them
        // holds backticks of its own.
        const blocks = [...(await read(`website/content/${page}`)).matchAll(
          /```(\w*)\n([\s\S]*?)```/gu,
        )];
        let command = '';
        for (const [, language, body] of blocks) {
          if (language === 'bash') {
            command = body;
            continue;
          }
          if (language !== 'json') continue;
          if (!/sleep-study\.edf/u.test(command) || !command.includes('--json')) continue;
          const shown = JSON.parse(body);
          // `--info --json` describes the recording rather than a run, and has its own shape.
          if (shown.path !== undefined) continue;
          checked++;
          for (const key of ['files', 'annotations', 'duration_seconds', 'records', 'warnings']) {
            assert.deepEqual(shown[key], actual[key], `${page}: ${key} is not what that run writes`);
          }
        }
      }
      assert.ok(checked >= 1, `expected the pages to show this summary, found ${checked}`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('shows the long layout of the recording the command beside it names', async () => {
    /*
      cli-reference and faq both run `--layout long` on sleep-study.edf and both show what came
      out. They showed two different recordings. The reference had the real one — five channels
      at the first instant, `time_s` at the three places 100 Hz needs. faq had three channels
      called EEG Fpz-Cz, ECG and Temp rectal, at eight decimal places, which is `mixed-rates.edf`
      converted and captioned with someone else's command.

      Eight lines above it that same answer lists the file's rates as 100, 10 and 1 Hz and names
      all five channels, so the page contradicted itself inside one section — and the block a
      reader would check their own output against was the wrong one.

      A prefix is enough, and one second of the recording produces it, so this stays cheap.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-long-'));
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const recording = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      const { stdout } = await run(process.execPath, [
        CLI, recording, '--stdout', '--layout', 'long', '--duration', '1',
      ]);

      const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
        n.endsWith('.md'),
      );
      let checked = 0;
      for (const page of names) {
        const text = await read(`website/content/${page}`);
        // A command naming this recording and that layout, then the block under it.
        for (const [, block] of text.matchAll(
          /```bash\n[^`]*sleep-study\.edf[^`]*--layout long[^`]*```\s*\n+```(?:text)?\n(time_s,channel,value\n[\s\S]*?)```/gu,
        )) {
          checked++;
          assert.ok(
            stdout.startsWith(block),
            `${page}: the long layout of this recording does not start that way:\n` +
              `  page: ${JSON.stringify(block.slice(0, 160))}\n` +
              `  file: ${JSON.stringify(stdout.slice(0, 160))}`,
          );
        }
      }
      assert.ok(checked >= 2, `expected the pages to show this conversion, found ${checked}`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('counts rows in a quoted summary the way the summary counts them', async () => {
    /*
      `formatSummary` writes "row" at one and "rows" otherwise — the same agreement 0.5.74 put
      through the estimate line and 0.5.98 through the summary. The pages had not followed:
      getting-started's first conversion, which is the first output a reader ever sees, ended

          channels.csv       1  rows

      and the seizure-window recipe did it twice. A file with one channel is the ordinary case
      for the recordings both of those show.

      Checked as arithmetic rather than against a run, because the recordings these summaries
      describe are examples that no fixture has to match. What the pages cannot do is disagree
      with the rule the writer applies.
    */
    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    );
    const wrong = [];
    let lines = 0;
    for (const page of [...names.map((n) => `website/content/${n}`), 'README.md']) {
      const text = await read(page);
      for (const [, count, unit] of text.matchAll(
        /^ {2}[\w.-]+\.csv(?:\.gz)? +([\d,]+) {2}(rows?)$/gmu,
      )) {
        lines++;
        const want = Number(count.replaceAll(',', '')) === 1 ? 'row' : 'rows';
        if (unit !== want) wrong.push(`${page}: "${count}  ${unit}" should be "${count}  ${want}"`);
      }
    }
    assert.deepEqual(wrong, [], wrong.join('\n'));
    assert.ok(lines >= 15, `expected the pages to show conversion summaries, found ${lines}`);
  });

  it('keeps every quoted hint attached to the diagnostic it belongs to', async () => {
    /*
      A hint is printed indented under the message it explains, and that indent is the only
      thing joining the two — there is no blank line, no prefix, nothing else to read them as
      one. So an indented line inside a fenced block is a continuation of whatever is directly
      above it, and if that is not a diagnostic, the block is showing something no run produces.

      Which is what warnings-and-errors.md was showing for CONTINUOUS_LIAR: a paragraph about
      the BDF+ spelling of the marker had been written into the middle of the block, between
      the message and its hint. The page rendered a warning cut in half around an English
      sentence with its backticks intact, and the two lines of advice hung off the paragraph
      instead of off the warning.

      A blank line inside a block is fine and common — the mixed-rate example shows a warning,
      a blank line and then the closing summary, exactly as the run prints it. What cannot
      happen is an indented continuation with prose above it.
    */
    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    );
    // What the tool puts in front of a message that can carry a hint under it.
    const SPOKEN = /^(?:warning|error|note): \S|^interrupted \(/u;
    // Seven spaces is what `error: ` occupies, so a hint lines up under the first word of the
    // message. formatDiagnostics writes nine; both read as attached.
    const CONTINUATION = /^ {7,}\S/u;

    const broken = [];
    let blocks = 0;
    for (const page of [...names.map((n) => `website/content/${n}`), 'README.md']) {
      const lines = (await read(page)).split('\n');
      let body = null;
      let opened = 0;
      lines.forEach((line, index) => {
        if (/^```/u.test(line)) {
          if (body === null) {
            body = [];
            opened = index;
            return;
          }
          // Only blocks that are a transcript of diagnostics. A Python snippet is indented
          // for its own reasons, and a JSON document more so.
          if (SPOKEN.test(body[0] ?? '')) {
            blocks++;
            body.forEach((text, offset) => {
              if (!CONTINUATION.test(text)) return;
              const previous = body[offset - 1] ?? '';
              if (SPOKEN.test(previous) || CONTINUATION.test(previous)) return;
              broken.push(
                `${page}:${opened + offset + 2}: "${text.trim().slice(0, 60)}" continues ` +
                  `"${previous.trim().slice(0, 60)}"`,
              );
            });
          }
          body = null;
          return;
        }
        if (body !== null) body.push(line);
      });
    }
    assert.deepEqual(broken, [], broken.join('\n'));
    assert.ok(blocks > 30, `expected the pages to quote diagnostics, found ${blocks}`);
  });

  it('states the inversion rule the way the code decides it, on every page that states it', async () => {
    /*
      A negative gain is what inverts a channel, and the gain is
      (physicalMax - physicalMin) / (digitalMax - digitalMin) — so reversing exactly one of the
      two pairs inverts the polarity and reversing both does not. The code was corrected to that
      rule, and reversed-bounds.edf was written to hold it: three channels, two warned about and
      one not.

      One page was corrected with it. Three were not, and went on describing the trigger as the
      physical pair alone: correctness listed `physicalMin` above `physicalMax` as a header
      condition that raises the warning, edf-format said that comparison "inverts the polarity of
      the channel", and output-files — the page a reader reaches from the channels.csv columns —
      called such a channel "an inverted channel" outright. The fixture's third channel is that
      exact shape and is not inverted.

      So this checks the claim against the file rather than against the other pages: the channel
      exists, its physical pair is reversed, and nothing warns about it. Then no page may equate
      the two.
    */
    const api = await import(path.join(ROOT, 'dist/index.js'));
    const file = await api.EdfFile.open(
      path.join(ROOT, 'test/fixtures/generated/reversed-bounds.edf'),
    );
    const both = file.dataSignals.find((signal) => signal.label === 'both');
    const inverted = file.diagnostics.filter((d) => d.code === 'INVERTED_PHYSICAL_RANGE');
    await file.close();

    assert.ok(both, 'the fixture no longer has a channel with both pairs reversed');
    assert.ok(
      both.physicalMin > both.physicalMax && both.digitalMin > both.digitalMax,
      'and that channel no longer reverses both of them',
    );
    assert.ok(
      !inverted.some((d) => d.message.includes('"both"')),
      'a positive gain is not an inverted channel',
    );

    // The two spellings the pages use: the column names of channels.csv and the header field
    // names of the format. The backtick is what distinguishes them from the warning's own text,
    // which is a third spelling and deliberately not matched — "physical minimum 100 above
    // physical maximum -100, which inverts its polarity" is true of the channel it names, whose
    // digital pair is the right way round. The cell separator is not excluded: correctness put
    // the condition in one column of a table and the consequence in the next, and that is still
    // one claim.
    const claim =
      /`physical_?[Mm]?(?:in|inimum)`?\s+(?:above|greater than|>)\s+`?physical_?[Mm]?(?:ax|aximum)`?[^.\n]{0,60}inver/u;
    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    );
    for (const page of [...names.map((n) => `website/content/${n}`), 'README.md']) {
      assert.doesNotMatch(
        await read(page),
        claim,
        `${page}: a reversed physical pair is not on its own what inverts a channel`,
      );
    }
  });

  it('shows the line --info --annotations-only actually prints', async () => {
    /*
      The reference said, of the estimate, "With `--annotations-only` ... the estimate is 0
      rows, because that run would write no signal data" — and two hundred lines later, in the
      `--annotations-only` section, that `Would write 0 rows, roughly 0 B.` was the wording
      0.4.51 removed for being "true of the signal tables and false of the run". One page,
      describing the behaviour and its own fix of that behaviour, in disagreement.

      Pinned by running it: the sample output the page quotes has to be what the tool prints.
    */
    const page = await read('website/content/cli-reference.md');
    const section = page.slice(page.indexOf('## --annotations-only'));
    const quoted = /```\n(Would write[\s\S]*?)\n```/u.exec(section);
    assert.ok(quoted, 'the page no longer quotes what --info --annotations-only prints');

    const { stdout } = await run(process.execPath, [
      CLI, path.join(ROOT, 'test/fixtures/generated/annotations.edf'), '--info', '--annotations-only',
    ]);
    // The page wraps the sentence to its own width; compare the words, not the layout.
    const flat = (text) => text.replace(/\s+/gu, ' ').trim();
    assert.ok(
      flat(stdout).includes(flat(quoted[1])),
      `the page quotes:\n  ${flat(quoted[1])}\nthe tool prints:\n  ${flat(stdout).slice(-200)}`,
    );

    // And nowhere may the page still promise a row estimate for that mode.
    assert.doesNotMatch(
      flat(page),
      /annotations-only[^.]{0,120}estimate is 0 rows/u,
      'the reference still says --annotations-only estimates 0 rows',
    );
  });

  it('states the fallback record placement the same way on every page', async () => {
    /*
      A record whose timekeeping TAL is unreadable is placed at `origin + index *
      recordDuration`, where the origin comes from the first record that does state a time.
      api.md said exactly that, and spelled out why: "not at `index * recordDuration`, which
      silently assumes the recording begins at zero". edf-plus-annotations.md then said
      `index * record_duration` — the very form api.md warns against — which puts the record
      at the wrong instant on every recording whose first record says anything but `+0`.

      Anchored on the claim rather than on every appearance of the arithmetic. Both pages also
      name the bare form in order to reject it, and a check that flagged those would need a
      phrase blacklist that grows with the prose, which is the kind of test people delete.
    */
    const pages = ['website/content/edf-plus-annotations.md', 'website/content/api.md'];
    for (const page of pages) {
      const text = (await read(page)).replace(/\s+/gu, ' ');
      // The origin-aware form has to be on the page at all.
      assert.match(
        text,
        /origin \+ (?:record_)?index \* record[_ ]?[Dd]uration/u,
        `${page} no longer gives the origin-aware placement formula`,
      );
    }

    /*
      And the sentence that states the fallback has to be the origin-aware one. This is the
      sentence that was wrong: "The affected record is timed as if it were contiguous with
      the start of the recording, at `index * record_duration`".
    */
    const annotations = (await read(pages[0])).replace(/\s+/gu, ' ');
    const fallback = /timed as if it were contiguous[^.]*\./u.exec(annotations);
    assert.ok(fallback, `${pages[0]} no longer describes the fallback placement`);
    assert.match(
      fallback[0],
      /origin/u,
      `the fallback sentence gives a formula with no origin: ${fallback[0]}`,
    );
  });

  it('lists no parser error among the usage errors', async () => {
    /*
      The usage-errors table opens "They exit **2** rather than 1, so a script can tell 'you
      asked for something impossible' apart from 'this recording is broken'" — and then listed
      "the recording changed size while it was being read", which exits 1. That message comes
      from `changedWhileReading` in the parser, as an EdfError with code UNREADABLE, and the
      same page's UNREADABLE section describes it with the right code. One page, two answers,
      about the one thing a script branches on.

      Checked structurally rather than by running each row: a usage error is raised by the CLI
      or the planner, never by the parser, so no example message in that table may be a string
      the parser produces. That is the property the wrong row broke, and it needs no repro for
      a table that will keep growing.
    */
    const page = await read('website/content/warnings-and-errors.md');
    const table = /## Usage errors\n([\s\S]*?)\n## /u.exec(page);
    assert.ok(table, 'the usage errors section is gone');
    const examples = [...table[1].matchAll(/^\| [^|]+\| `([^`]+)` \|$/gmu)].map((m) => m[1]);
    assert.ok(examples.length > 5, `expected the table's messages, found ${examples.length}`);

    const parser = (
      await Promise.all(
        (await readdir(path.join(ROOT, 'src/edf'))).map((name) => read(path.join('src/edf', name))),
      )
    ).join('\n');

    for (const example of examples) {
      /*
        Match on the longest run of plain words in the example, since every message carries
        interpolated values — byte counts, record numbers, the user's own text — that no
        source string contains. Four words is long enough that a coincidence is not credible
        and short enough that every row has one.
      */
      const phrases = (example.match(/[a-z][a-z ]{15,}[a-z]/gu) ?? [])
        .map((phrase) => phrase.trim())
        .filter((phrase) => phrase.split(' ').length >= 4);
      for (const phrase of phrases) {
        assert.ok(
          !parser.includes(phrase),
          `a usage error quotes the parser, which exits 1, not 2: "${phrase}"`,
        );
      }
    }
  });

  it('counts the fields it says a function returns', async () => {
    /*
      api.md: "returns every event in the file, the start time each record declares, and three
      counts of what could not be decoded" — and then names four. 0.5.58 added the fourth to
      the list and left the number, which is the mistake 0.5.62 fixed one page over, on a
      sentence a reader checks against the list in the same breath.

      Counted from the source's own return type, so the page has to agree with the function
      rather than with itself.
    */
    const source = await read('src/edf/reader.ts');
    const block = /readAnnotations\(\): Promise<\{([\s\S]*?)\n  \}> \{/u.exec(source);
    assert.ok(block, 'readAnnotations no longer declares its return type inline');
    const counts = [...block[1].matchAll(/^\s*(\w+): number;/gmu)].map((m) => m[1]);
    assert.ok(counts.length >= 3, `expected the counts, found ${counts.join(', ')}`);

    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
    const page = (await read('website/content/api.md')).replace(/\s+/gu, ' ');
    const claim = /and (\w+) counts of what could not be decoded/u.exec(page);
    assert.ok(claim, 'api.md no longer says how many counts readAnnotations returns');
    assert.equal(
      claim[1],
      words[counts.length],
      `readAnnotations returns ${counts.length} counts (${counts.join(', ')}), the page says ${claim[1]}`,
    );
    // And every one of them is named, since the number is only useful with the list.
    for (const name of counts) {
      assert.ok(page.includes(name), `api.md does not name ${name}`);
    }
  });

  it('counts the conditions it says a diagnostic covers', async () => {
    /*
      The warnings page opens ANNOTATION_DECODE_FAILED with "This code covers three
      conditions" and then lists them in bold. 0.5.55 added a fourth and 0.5.58 a fifth, and
      the sentence still said three — a number a reader can check against the list directly
      below it, which is exactly the kind of claim this file exists to hold.

      Counted from the page's own headings rather than from the source: what the sentence
      promises is that the list under it is complete, and the list is the thing on the page.
    */
    const page = await read('website/content/warnings-and-errors.md');
    const words = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
    // Split into sections first: a claim belongs to the heading above it, and a regex
    // spanning `###` boundaries reads one section's sentence against another's list.
    const sections = page.split(/^### /mu).slice(1);
    let checked = 0;
    for (const section of sections) {
      const code = section.slice(0, section.indexOf('\n')).trim();
      const claim = /This code covers (\w+) conditions/u.exec(section);
      if (!claim) continue;
      checked++;
      // Each condition is a bold lead-in of its own. The page's standard headings —
      // cause, behaviour, advice — are not conditions and do not count.
      const conditions = [...section.matchAll(/^\*\*(?!What to do|Cause|What edf2csv does)/gmu)];
      assert.equal(
        conditions.length,
        words[claim[1]],
        `${code} says it covers ${claim[1]} conditions and lists ${conditions.length}`,
      );
    }
    assert.ok(checked > 0, 'no section states how many conditions it covers');
  });

  it('documents the fields readAnnotations actually returns', async () => {
    /*
      The names it exports are checked below; the shape of what they return was not, and the
      signature on the page had been missing `malformedTimekeeping` since 0.4.42 added it.
      0.5.55 added a third count and would have left the same gap. Someone destructuring
      from the documented signature gets `undefined` for a count that exists, which reads as
      "nothing was wrong with this file".

      Called for real rather than matched against the source, because what a caller can
      destructure is what the object has at runtime.
    */
    const api = await import(path.join(ROOT, 'dist/index.js'));
    const file = await api.EdfFile.open(path.join(ROOT, 'test/fixtures/generated/annotations.edf'));
    let returned;
    let event;
    try {
      const result = await file.readAnnotations();
      returned = Object.keys(result).sort();
      event = Object.keys(result.annotations[0]).sort();
    } finally {
      await file.close();
    }

    const page = await read('website/content/api.md');
    const block = /readAnnotations\(\): Promise<\{([^}]*)\}>/u.exec(page);
    assert.ok(block, 'api.md no longer shows the readAnnotations signature');
    const documented = [...block[1].matchAll(/^\s*(\w+):/gmu)].map((m) => m[1]).sort();
    assert.deepEqual(documented, returned, 'api.md lists different fields than it returns');

    const shape = /interface Annotation \{([^}]*)\}/u.exec(page);
    assert.ok(shape, 'api.md no longer shows the Annotation interface');
    const fields = [...shape[1].matchAll(/^\s*(\w+):/gmu)].map((m) => m[1]).sort();
    assert.deepEqual(fields, event, 'api.md lists different fields than an Annotation has');
  });

  it('documents every name the package exports', async () => {
    /*
      `formatWallClock` was exported and undocumented, which mattered more than a missing
      line: it is the function that writes a recording's start time without a timezone, and
      the trap it exists to avoid — `toISOString()` appending a Z and asserting UTC on digits
      the format never assigned a zone to — is one a caller falls into precisely because they
      did not know there was an alternative.
    */
    const api = await import(path.join(ROOT, 'dist/index.js'));
    const page = await read('website/content/api.md');
    const missing = Object.keys(api).filter((name) => !page.includes(name));
    assert.deepEqual(missing, [], `api.md does not mention: ${missing.join(', ')}`);
  });

  it('packs a tarball that holds the code it says it does', async () => {
    /*
      `npm pack` on a clean checkout produced a four-file tarball with no `dist/` in it — no
      bin, nothing importable — and reported success. `prepublishOnly` builds, but it runs
      only for `npm publish`; `npm pack` and an install from a git URL both went round it.
      Published versions were fine, which is exactly why it could sit there.

      Checked from the file list rather than by packing, which would mean running a build
      inside the test suite: `files` says what ships and `bin`/`exports`/`types` say what has
      to be in it, and `prepack` is what guarantees the second exists when the first is read.
    */
    const manifest = JSON.parse(await read('package.json'));
    assert.ok(
      /(^|&&\s*)npm run build/u.test(manifest.scripts.prepack ?? ''),
      'prepack must build, or `npm pack` ships whatever dist happens to be lying around',
    );

    // Everything the manifest points at has to be under something `files` includes.
    const shipped = manifest.files ?? [];
    const targets = [
      manifest.types,
      ...Object.values(manifest.bin ?? {}),
      ...Object.values(manifest.exports ?? {}).flatMap((entry) =>
        typeof entry === 'string' ? [entry] : Object.values(entry),
      ),
      // package.json is in every tarball whatever `files` says, so exporting it is not a
      // claim about `files`.
    ].filter((target) => typeof target === 'string' && !target.endsWith('package.json'));
    assert.ok(targets.length >= 2, `nothing to check: ${JSON.stringify(targets)}`);
    for (const target of targets) {
      const relative = target.replace(/^\.\//u, '');
      assert.ok(
        shipped.some((entry) => relative === entry || relative.startsWith(`${entry}/`)),
        `${target} is not under any entry of "files": ${JSON.stringify(shipped)}`,
      );
      await assert.doesNotReject(
        () => readFile(path.join(ROOT, relative)),
        `${target} does not exist`,
      );
    }
  });

  it('tracks nothing at the top level that nobody put there on purpose', async () => {
    /*
      0.5.30's own commit — the one that fixed `npm pack` shipping no code — also committed a
      directory called `undefined`: ten files of conversion output from a command whose `--out`
      had been built from a shell variable that wasn't set. It sat in the repository for eighty
      versions. `files` keeps it out of the tarball, so nobody installing from npm ever saw it;
      anyone cloning the repository or installing from a git URL got it.

      `git add -A` is how a batch of edits gets committed here, and it is exactly what sweeps up
      a directory like that. So the list of top-level things this repository tracks is written
      down, and a new one has to be added here deliberately.

      Skipped rather than failed where git isn't available or this isn't a checkout — an
      extracted tarball is a legitimate place to run the suite from.
    */
    let tracked;
    try {
      const { stdout } = await run('git', ['ls-files', '-z'], { cwd: ROOT });
      tracked = stdout.split('\0').filter(Boolean);
    } catch {
      return;
    }
    assert.ok(tracked.length > 20, `not a checkout, or git said nothing: ${tracked.length} files`);

    const expected = new Set([
      '.github', '.gitignore', 'CHANGELOG.md', 'CITATION.cff', 'LICENSE', 'README.md',
      'package-lock.json', 'package.json', 'src', 'test', 'tsconfig.json', 'vercel.json',
      'website',
    ]);
    const top = [...new Set(tracked.map((file) => file.split('/')[0]))].sort();
    const strays = top.filter((entry) => !expected.has(entry));
    assert.deepEqual(strays, [], `committed by accident, or new and not listed here: ${strays}`);
  });

  it('ships source maps that resolve to something', async () => {
    /*
      Every .js.map names `../src/*.ts` as its source, and `src` is not in package.json's
      `files` — so once installed, a stack frame inside edf2csv followed a map to a file that
      is not there. The maps were shipped and useless.

      `inlineSources` puts the TypeScript into the map itself, which a debugger prefers over
      fetching the path, so the frame lands on the line that produced it without shipping a
      second copy of the tree as separate files. It costs about 90 kB packed.
    */
    const { readdir } = await import('node:fs/promises');

    const { files } = JSON.parse(await read('package.json'));
    assert.ok(!files.includes('src'), 'if src ships, the maps can point at it instead');

    const emitted = (await readdir(path.join(ROOT, 'dist'))).filter((n) => n.endsWith('.js.map'));
    assert.ok(emitted.length > 0, 'no source maps were built');

    for (const name of emitted) {
      const map = JSON.parse(await read(path.join('dist', name)));
      assert.ok(
        Array.isArray(map.sourcesContent) && map.sourcesContent.every((c) => typeof c === 'string' && c.length > 0),
        `${name} names ${map.sources?.join(', ')} but carries no sources, and the package ships neither`,
      );
    }

    /*
      And no declaration maps at all, for the same reason and one difference: TypeScript has
      no `inlineSources` for them. Every `.d.ts.map` shipped said `"sources":
      ["../src/index.ts"]` with no `sourcesContent`, so "Go to Definition" in a consumer's
      editor followed it to a path the package does not contain. Without the map the same
      jump lands in the `.d.ts`, which is accurate and present.
    */
    const declarations = await readdir(path.join(ROOT, 'dist'), { recursive: true });
    assert.deepEqual(
      declarations.filter((name) => String(name).endsWith('.d.ts.map')),
      [],
      'a declaration map can only point at source this package does not ship',
    );
    assert.ok(
      declarations.some((name) => String(name).endsWith('.d.ts')),
      'the declarations themselves must still be there',
    );
  });

  it('shows a metadata.json with the keys a conversion actually writes', async () => {
    /*
      output-files.md prints a whole metadata.json as its explanation of the format, and that
      transcript is what someone reads before writing code against it. A key added to the
      record and not to the page reads as a key that does not exist; one removed reads as a
      key they can rely on. api.md had exactly that happen to its `window` object, which lost
      two fields for several versions before anyone noticed.

      The shape is checked here, against a discontinuous fixture chosen because it fills every
      part of the record. The values are checked by the test below, against the recording the
      sample actually names — which this comment said was "not in this repository" for as long
      as it has been, and while it said so the sample drifted into a description of a different
      file altogether.
    */
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const base = await mkdtemp(path.join(tmpdir(), 'edf2csv-metadata-'));
    let real;
    try {
      const out = path.join(base, 'out');
      // Chosen to populate every part of the record the page shows: a discontinuous
      // recording raises a diagnostic, so `notes` is not empty, and carries annotations, so
      // `annotations_written` and the annotations file are both real. An empty array cannot
      // say what its entries look like, and that is the half of the shape worth checking.
      await run(process.execPath, [
        CLI, path.join(ROOT, 'test/fixtures/generated/discontinuous.edf'),
        '--out', out, '--checksum', '--quiet',
      ]);
      // readFile directly: `read` is relative to the repository root, and this is not.
      real = JSON.parse(await readFile(path.join(out, 'metadata.json'), 'utf8'));
    } finally {
      await rm(base, { recursive: true, force: true });
    }

    const page = await read('website/content/output-files.md');
    const block = /```json\n(\{[\s\S]*?\n\})\n```/u.exec(page);
    assert.ok(block, 'the metadata.json sample is gone from output-files.md');
    const documented = JSON.parse(block[1]);

    assert.deepEqual(
      shapeOf(documented),
      shapeOf(real),
      'the metadata.json in output-files.md no longer has the keys a conversion writes',
    );
  });

  it('shows the metadata.json of the recording that sample names', async () => {
    /*
      The sample's `source.path` ends in `sleep-study.edf`, which on this site is one specific
      recording: eight hours of five channels at 100, 10 and 1 Hz with an annotation channel,
      built by test/fixtures/sleep-study.mjs and shown by every --info block on the site.

      What the sample described was three channels at 256, 128 and 1 Hz, 39 MB of them, 412
      events, five channel rows short, started in March 2026 — and one warning where that
      conversion raises two. Someone reading the page to learn what a field holds was reading
      a field's value from a file that does not exist.

      Everything that is a property of the recording or of the conversion is compared. `tool`,
      the parts of `source` that describe where the file happened to sit, and `converted_at`
      belong to the run and stay illustrative.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-metavalues-'));
    let real;
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const recording = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      const out = path.join(work, 'out');
      await run(process.execPath, [CLI, recording, '--out', out, '--checksum', '--quiet']);
      real = JSON.parse(await readFile(path.join(out, 'metadata.json'), 'utf8'));
    } finally {
      await rm(work, { recursive: true, force: true });
    }

    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    );
    let checked = 0;
    for (const page of names) {
      const text = await read(`website/content/${page}`);
      for (const [, body] of text.matchAll(/```json\n(\{[\s\S]*?\n\})\n```/gu)) {
        let shown;
        try {
          shown = JSON.parse(body);
        } catch {
          continue;
        }
        if (typeof shown.source?.path !== 'string') continue;
        if (!shown.source.path.endsWith('sleep-study.edf')) continue;
        checked++;
        assert.equal(shown.source.bytes, real.source.bytes, `${page}: source.bytes`);
        assert.deepEqual(shown.recording, real.recording, `${page}: recording`);
        const { converted_at: shownAt, ...conversion } = shown.conversion;
        const { converted_at: realAt, ...realConversion } = real.conversion;
        assert.ok(shownAt && realAt, 'converted_at is gone from one of them');
        assert.deepEqual(conversion, realConversion, `${page}: conversion`);
        assert.deepEqual(shown.notes, real.notes, `${page}: notes`);
      }
    }
    assert.ok(checked >= 1, `expected a metadata.json for this recording, found ${checked}`);
  });

  it('agrees with the CLI about what the exit codes are', async () => {
    // The reference states three codes and what each means. The meanings are prose, but the
    // set is not: a fourth code appearing with nothing said about it is the drift to catch.
    const source = await read('src/cli.ts');
    const declared = [...source.matchAll(/^const EXIT_[A-Z]+ = (\d+);$/gmu)].map((m) => Number(m[1]));
    assert.deepEqual(declared.sort(), [0, 1, 2], `the CLI now has exit codes ${declared}`);

    const reference = await read('website/content/cli-reference.md');
    const table = /## Exit codes([\s\S]*?)\n## /u.exec(reference);
    assert.ok(table, 'the exit code table is gone from the reference');
    for (const code of declared) {
      assert.match(table[1], new RegExp(`\`${code}\``, 'u'), `exit ${code} is not documented`);
    }
  });
});

/**
 * An object's key structure, ignoring values and array length.
 *
 * Arrays are described by the shape of their first element, since what matters is which keys
 * an entry has rather than how many entries a particular recording produced.
 */
function shapeOf(value) {
  if (Array.isArray(value)) return value.length > 0 ? [shapeOf(value[0])] : [];
  if (value === null || typeof value !== 'object') return typeof value;
  const shape = {};
  for (const key of Object.keys(value).sort()) shape[key] = shapeOf(value[key]);
  return shape;
}

/**
 * The codes a page enumerates, from the one construct on it that is a list of them.
 *
 * Each page lists them differently: a table of one code per row, a sentence of backticked
 * names, and a fenced block of bare names. Reading the construct rather than the page is
 * what keeps this from tripping over ordinary prose.
 */
function enumeratedCodes(page, text) {
  if (page.endsWith('warnings-and-errors.md')) {
    return [...text.matchAll(/^\| `([A-Z][A-Z_]+)` \|/gmu)].map((m) => m[1]);
  }
  if (page.endsWith('cli-reference.md')) {
    const sentence = /The `code` values are stable identifiers[^\n]*/u.exec(text);
    assert.ok(sentence, 'the code list sentence is gone from the reference');
    return [...sentence[0].matchAll(/`([A-Z][A-Z_]+)`/gu)].map((m) => m[1]);
  }
  const block = /```text\n((?:[A-Z][A-Z_ \n]+))```/u.exec(text);
  assert.ok(block, 'the diagnostic code block is gone from the API reference');
  return block[1].split(/\s+/u).filter(Boolean);
}

/**
 * Upper-case names in the documentation that are not diagnostic codes.
 *
 * Error codes, errno names and the format's own vocabulary all look the same in backticks.
 * Listing them is what lets the check above be strict about everything else.
 */
const ALSO_REAL = new Set([
  // Fatal reader errors: their own union, documented on the same page.
  'FILE_TOO_SMALL', 'BAD_HEADER_FIELD', 'NO_DATA_RECORDS', 'INVALID_SIGNAL_COUNT',
  'INVALID_RECORD_DURATION', 'UNREADABLE', 'NO_SAMPLES',
  // Conversion errors, checked against their own union above.
  'OUTPUT_EXISTS', 'OUTPUT_UNWRITABLE', 'INPUT_OUTPUT_COLLISION', 'INPUT_UNREADABLE',
  'UNSUPPORTED_REQUEST', 'CALLBACK_FAILED', 'WRITE_FAILED',
  // Errno names quoted in the write-failure hints.
  'ENOSPC', 'EDQUOT', 'EACCES', 'EPERM', 'EROFS', 'EISDIR', 'ENOENT', 'ENAMETOOLONG',
  'EMFILE', 'ENFILE', 'EPIPE', 'EFBIG',
  // The format's own names and other prose.
  'BIOSEMI', 'SPREADSHEET_ROW_LIMIT', 'DEFAULT_CHUNK_BYTES', 'TOOL_VERSION',
]);
