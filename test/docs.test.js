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

/** The members of an exported string-union type, read from its declaration. */
async function unionMembers(file, name) {
  const source = await read(file);
  const declaration = new RegExp(`export type ${name} =([\\s\\S]*?);`, 'u').exec(source);
  assert.ok(declaration, `could not find "export type ${name}" in ${file}`);
  return [...declaration[1].matchAll(/'([A-Z_]+)'/gu)].map((m) => m[1]);
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

      The shape is checked, not the values: the sample describes an 8-hour sleep study that
      is not in this repository, and rewriting it to match a two-record fixture would make it
      a worse explanation.
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
