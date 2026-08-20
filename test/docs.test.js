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
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

  it('puts no figure on the landing page the documentation does not support', async () => {
    /*
      The landing page ends with four numbers in large type — 16,943 verified values, 1.4
      seconds, a 48 MB heap cap, zero dependencies — and every one of them is a claim about
      what was measured. They are written in Landing.jsx; what justifies them is written on
      the correctness page, and nothing connected the two, so the marketing figure could
      drift from the measured one in either direction without anything noticing.

      That has already happened twice on this site to numbers that did have a source: a row
      count in 0.4.67 and a byte count in 0.5.150. These are the figures with no source at
      all, which makes them the ones most able to go stale quietly.

      The zero is checked against the package rather than the prose, since "no runtime
      dependencies" is a fact about package.json and nowhere else.
    */
    const jsx = await read('website/src/components/Landing.jsx');
    const block = /const FACTS = \[([\s\S]*?)\];/u.exec(jsx);
    assert.ok(block, 'the landing page no longer has a FACTS block');

    const facts = [...block[1].matchAll(/value: '([^']+)', label: '([^']+)'/gu)];
    assert.equal(facts.length, 4, `expected four figures, found ${facts.length}`);

    const page = await read('website/content/correctness.md');
    for (const [, value, label] of facts) {
      if (/dependenc/u.test(label)) {
        const manifest = JSON.parse(await read('package.json'));
        assert.equal(
          Object.keys(manifest.dependencies ?? {}).length,
          Number(value),
          `the landing page claims ${value} runtime dependencies`,
        );
        continue;
      }
      // "1.4s" on the page, "1.4 seconds" in the prose; the digits are the claim.
      const digits = value.replace(/[^\d.,]/gu, '');
      assert.ok(
        page.includes(digits),
        `the landing page shows "${value}" (${label}) and correctness.md never states ${digits}`,
      );
    }
  });

  it('runs every sweep it offers as evidence', async () => {
    /*
      A sweep nobody runs is a claim nobody checks. `npm test` covers the suite and not the
      harnesses, which is why 0.6.58 gave them a CI job of their own — and then 0.7.9 added
      `npm run terminal`, wrote it up on the correctness page as the tenth claim, and did not
      wire it in. It sat unrun for three releases, guarding the one surface that had already
      produced two defects precisely because nothing exercised it.

      The workflow comment counts them too, and said seven while the page named eight. Same
      failure as the claims heading below: a number in prose that the thing it describes has
      outgrown.
    */
    const page = await read('website/content/correctness.md');
    const workflows = await readdir(path.join(ROOT, '.github/workflows'));
    let yaml = '';
    for (const file of workflows) yaml += await read(path.join('.github/workflows', file));

    // Housekeeping, not evidence: these support a sweep rather than being one.
    const support = new Set(['build', 'fixtures', 'clean', 'prepare']);
    const named = [...new Set([...page.matchAll(/npm run ([a-z:]+)/gu)].map((m) => m[1]))]
      .filter((name) => !support.has(name))
      .sort();
    assert.ok(named.length >= 8, `expected the sweeps to still be named, found ${named.length}`);

    const scripts = JSON.parse(await read('package.json')).scripts;
    const unrun = named.filter((name) => {
      if (yaml.includes(`npm run ${name}`)) return false;
      // The job steps invoke the harness directly so a failure names the invariant, not the
      // script, so the script's own command line is what has to be looked for.
      const direct = /node (test\/\S+\.mjs)/u.exec(scripts[name] ?? '');
      return !(direct && yaml.includes(direct[1]));
    });
    assert.deepEqual(unrun, [], `named as evidence but no workflow runs ${unrun.join(', ')}`);

    // And the count the workflow states about itself.
    const words = { six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
    const stated = /names (\w+) sweeps as how this project knows/u.exec(yaml);
    assert.ok(stated, 'the sweeps comment is gone or reworded');
    assert.equal(
      words[stated[1]],
      named.length,
      `the workflow says ${stated[1]} sweeps and the page names ${named.length}: ${named.join(', ')}`,
    );

    /*
      And CONTRIBUTING.md, which the first version of this test did not look at — so the very
      omission it was written for was still sitting in a third file when it went green. It is
      the list a contributor actually runs before opening a pull request; a sweep missing from
      it is a sweep nobody outside CI ever runs.
    */
    const contributing = await read('CONTRIBUTING.md');
    const listed = [...contributing.matchAll(/^npm run ([a-z:]+)/gmu)].map((m) => m[1]).sort();
    assert.deepEqual(
      named.filter((name) => !listed.includes(name)),
      [],
      `named as evidence but absent from CONTRIBUTING.md: ${named.filter((n) => !listed.includes(n)).join(', ')}`,
    );

    const howMany = /The (\w+) sweeps are separate/u.exec(contributing);
    assert.ok(howMany, 'the sweeps paragraph in CONTRIBUTING.md is gone or reworded');
    assert.equal(words[howMany[1]], named.length, `CONTRIBUTING.md says ${howMany[1]} sweeps`);

    /*
      "CI runs the first N on every push" — a claim about this list's order, so it is checked
      against the workflow rather than against the count. Everything before crossvalidate runs
      on push; crossvalidate needs pyEDFlib and has its own weekly job.
    */
    const onPush = /CI runs the first (\w+) on every push/u.exec(contributing);
    assert.ok(onPush, 'the "CI runs the first N" sentence is gone or reworded');
    const pushJob = yaml.slice(yaml.indexOf('  sweeps:'), yaml.indexOf('  tarball:'));
    const runOnPush = named.filter((name) => {
      const direct = /node (test\/\S+\.mjs)/u.exec(scripts[name] ?? '');
      return pushJob.includes(`npm run ${name}`) || (direct && pushJob.includes(direct[1]));
    });
    assert.equal(
      words[onPush[1]],
      runOnPush.length,
      `CONTRIBUTING.md says CI runs the first ${onPush[1]}; the sweeps job runs ${runOnPush.length}`,
    );
  });

  it('crosses the estimate sweep with every option that changes what is written', async () => {
    /*
      Claim 5 said the byte count is verified "across every fixture crossed with every option
      combination", and the sweep crossed eight sets that did not include `--bom`. That flag
      has its own arm of the byte arithmetic — three bytes per file, added once per table —
      and nothing exercised it, under a sentence saying everything was.

      Three bytes is exactly the size that hides: a one-row conversion is a few dozen bytes,
      so three unaccounted for is the difference between an estimate that holds and one that
      reads under, which is the single direction this claim promises it never goes.

      Checked against the flags rather than against a number, since the point is coverage.

      Read from the CLI's own option table rather than from a list written out here, which is
      the correction this test needed itself. It named six flags and passed while `--channels`
      went uncrossed — the option that decides which signal files exist at all, since removing
      a rate from the conversion removes its file — and `--end`, which resolves its bound by
      different arithmetic from the `--duration` beside it. A hand-kept list of flag names is
      the thing `OPTIONS` in cli.ts already has a comment about: it is a copy, and it will be
      missing the next one. Derived, a new flag fails this until somebody classifies it.
    */
    const sweep = await read('test/fuzz/estimate.mjs');
    const crossed = new Set([...sweep.matchAll(/'(--[a-z-]+)'/gu)].map((m) => m[1]));

    // Every option that cannot change a signal file's bytes, and why it cannot. Anything not
    // here has to be crossed.
    const notAboutSignalBytes = {
      '--info': 'is the estimate itself',
      '--out': 'names the destination, not what goes in it',
      '--annotations-only': 'leaves no signal files, and signal bytes are what this is about',
      '--checksum': 'adds a field to metadata.json, which the estimate does not cover',
      '--jobs': 'converts several recordings at once and changes none of them',
      '--force': 'decides whether an existing directory may be written into',
      '--quiet': 'changes what is printed',
      '--json': 'changes the shape of what is printed',
      '--strict': 'changes the exit code',
      '--stdout': 'writes no directory to measure',
      '--help': 'prints instead of converting',
      '--version': 'prints instead of converting',
    };

    const source = await read('src/cli.ts');
    const table = source.slice(
      source.indexOf('const OPTIONS = {'),
      source.indexOf('} as const;', source.indexOf('const OPTIONS = {')),
    );
    const declared = [...table.matchAll(/^ {2}'?([a-z-]+)'?: \{/gmu)].map((m) => `--${m[1]}`);
    assert.ok(declared.length > 15, `read ${declared.length} options out of cli.ts, expected all`);

    for (const flag of declared) {
      if (flag in notAboutSignalBytes) continue;
      assert.ok(crossed.has(flag), `the estimate sweep never crosses ${flag}`);
    }

    // And the page must not describe that set as more than it is.
    const page = await read('website/content/correctness.md');
    const claim = /5\. \*\*`--info` predicts what a conversion writes\.\*\*(.*)/u.exec(page);
    assert.ok(claim, 'claim 5 is gone or reworded');
    assert.doesNotMatch(
      claim[1],
      /every option combination/u,
      'claim 5 promises every option combination; the sweep crosses a fixed list',
    );
  });

  it('crosses the layout sweep with every option that changes a value', async () => {
    /*
      Claim 7 is that the two layouts hold the same samples, and the sweep behind it crossed
      six option sets: four windows, a precision, and none. `--channels` was not among them,
      and it is the one option that changes the shape of both layouts at once — it decides how
      many rates are in the conversion, which in the wide layout removes a file and in the long
      layout changes what the single shared `time_s` column has to mean. 0.7.17 found that
      second effect by reading; nothing was running it.

      Derived from the CLI's option table, like the estimate sweep's, with its own list of what
      cannot change a value and why. This sweep compares decoded cells per channel, so the
      options that change the bytes on disk without changing a number are excluded here and
      crossed there instead.
    */
    const sweep = await read('test/fuzz/layouts.mjs');
    const crossed = new Set([...sweep.matchAll(/'(--[a-z-]+)'/gu)].map((m) => m[1]));

    const cannotChangeAValue = {
      '--info': 'converts nothing',
      '--out': 'names the destination',
      '--layout': 'is the axis this sweep compares along',
      '--annotations-only': 'leaves no signal values to compare',
      '--gzip': 'changes the bytes on disk, not the numbers in them',
      '--bom': 'puts three bytes in front of them',
      '--checksum': 'adds a field to metadata.json',
      '--jobs': 'converts several recordings at once and changes none of them',
      '--force': 'decides whether an existing directory may be written into',
      '--quiet': 'changes what is printed',
      '--json': 'changes the shape of what is printed',
      '--strict': 'changes the exit code',
      '--stdout': 'writes no directory to read back',
      '--help': 'prints instead of converting',
      '--version': 'prints instead of converting',
    };

    const source = await read('src/cli.ts');
    const table = source.slice(
      source.indexOf('const OPTIONS = {'),
      source.indexOf('} as const;', source.indexOf('const OPTIONS = {')),
    );
    const declared = [...table.matchAll(/^ {2}'?([a-z-]+)'?: \{/gmu)].map((m) => `--${m[1]}`);
    assert.ok(declared.length > 15, `read ${declared.length} options out of cli.ts, expected all`);

    for (const flag of declared) {
      if (flag in cannotChangeAValue) continue;
      assert.ok(crossed.has(flag), `the layout sweep never crosses ${flag}`);
    }
  });

  it('describes every fixture it says it describes', async () => {
    /*
      The section is headed "The fixtures and what each one covers" and its opening sentence
      says each one pins down a thing a straightforward reader gets wrong. It held fifteen
      rows against fifty files on disk — so thirty-five fixtures, several of them written for
      defects this page describes elsewhere, were evidence nobody could look up.

      Checked from the generated directory rather than from a list, because that is what the
      claim is about: a fixture added without a row is exactly the drift this catches.
    */
    const page = await read('website/content/correctness.md');
    const files = (await readdir(path.join(ROOT, 'test/fixtures/generated'))).filter((f) =>
      /\.(edf|bdf)$/u.test(f),
    );
    assert.ok(files.length > 40, `expected the fixture set, found ${files.length}`);

    const section = page.slice(page.indexOf('## The fixtures and what each one covers'));
    const table = section.slice(0, section.indexOf('\n## ', 1));
    const undescribed = files.filter((name) => !table.includes(`\`${name}\``)).sort();
    assert.deepEqual(undescribed, [], `fixtures with no row: ${undescribed.join(', ')}`);
  });

  it('counts its own claims correctly', async () => {
    /*
      "## Eight separate claims" sat over a list of nine, and the paragraph below it says in
      so many words that the heading "did not keep up until 0.4.34" — which was true again
      the next time a claim was added, and stayed true through every release since.

      The same failure as the test counts two tests down: a number on the correctness page
      that the page itself disproves. This one is cheaper to check, since both the claim and
      its evidence are in the same file.
    */
    const page = await read('website/content/correctness.md');
    const words = {
      three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
      nine: 9, ten: 10, eleven: 11, twelve: 12,
    };

    const heading = /^## (\w+) separate claims$/mu.exec(page);
    assert.ok(heading, 'the claims heading is gone or reworded');
    const claimed = words[heading[1].toLowerCase()];
    assert.ok(claimed, `"${heading[1]}" is not a number word this test knows`);

    // The numbered list under that heading, which ends at the next `## `.
    const section = page.slice(page.indexOf(heading[0]));
    const list = section.slice(0, section.indexOf('\n## ', 1));
    const items = [...list.matchAll(/^(\d+)\. \*\*/gmu)].map((m) => Number(m[1]));
    assert.deepEqual(
      items,
      Array.from({ length: items.length }, (unused, i) => i + 1),
      'the claims are misnumbered',
    );
    assert.equal(claimed, items.length, `the heading says ${heading[1]} and the list has ${items.length}`);

    // And the sentence under it, which states the same number twice more.
    const sentence = /Correctness here covers (\w+) different things, verified (\w+) different ways/u.exec(page);
    assert.ok(sentence, 'the sentence restating the count is gone');
    assert.equal(words[sentence[1]], items.length, `"covers ${sentence[1]}"`);
    assert.equal(words[sentence[2]], items.length, `"verified ${sentence[2]} different ways"`);
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

    /*
      The lockfile records it in two places, and had drifted further than CITATION.cff ever
      did: 0.5.51 against a package at 0.6.8, fifty-eight releases. Nothing breaks — `npm ci`
      does not read the field and `npm install` rewrites it — but it is the same version
      claimed by the same tree, and a reader checking out a tag finds it disagreeing with the
      tag. The guard above exists because that file drifted 107 releases; this one costs two
      more lines.
    */
    const lock = JSON.parse(await read('package-lock.json'));
    assert.equal(lock.version, manifest.version, 'package-lock.json is at a different version');
    assert.equal(lock.packages['']?.version, manifest.version, 'the lockfile root entry differs');

    /*
      And the date it was released, which the file did not carry at all.

      `date-released` is where every citation format gets its year. Without it GitHub's "Cite
      this repository" produced an APA line with no year in it and a BibTeX entry with no
      `year` field — from the one file in this repository whose entire purpose is being
      correct in somebody else's bibliography.

      Shape, not freshness: a real calendar date, in the format CFF 1.2.0 asks for, and not in
      the future. A stale date is a smaller problem than an absent one, and no check here can
      tell "the release was yesterday" from "the field was forgotten".
    */
    const released = /^date-released:\s*(.+)$/mu.exec(citation);
    assert.ok(released, 'CITATION.cff declares no date-released');
    const day = released[1].trim();
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/u, `date-released is not YYYY-MM-DD: ${day}`);
    const parsed = new Date(`${day}T00:00:00Z`);
    assert.ok(!Number.isNaN(parsed.getTime()), `date-released is not a real date: ${day}`);
    assert.ok(parsed.getTime() <= Date.now(), `date-released is in the future: ${day}`);
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
    const changelog = await read('docs/CHANGELOG.md');
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
    /*
      The phrase list is the weak part, and it has now let three of these through: 0.6.26 (the
      warnings table said "several output files", one word off "several signals files"), 0.6.51
      (the --stdout recipe said "produce exactly one") and 0.6.45's neighbours. A guard that
      matches wording rather than meaning only catches the wordings someone thought of, so the
      ones that got past it are added here as they are found rather than left for the next sweep.
    */
    const claims = /one file per rate|per sampling rate|several signals files|several output files|no single `signals\.csv`|more than one table|produce exactly one|needs exactly one table/iu;
    for (const page of [
      'sampling-rates.md',
      'output-files.md',
      'faq.md',
      'getting-started.md',
      'cli-reference.md',
      'warnings-and-errors.md',
      'recipes.md',
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

  it('lets a TypeScript caller name every type the API hands them', async () => {
    /*
      Types vanish at runtime, so the import test above — which loads dist/index.js and reads
      properties off it — cannot see a missing `export type` at all. Three were missing:
      `ConversionError.code` is a `ConversionErrorCode`, `ConversionPlan.estimate` is an
      `OutputEstimate`, and `selectChannels()` returns a `ChannelSelection`. All three were
      exported from their own modules and none from the package root, so a caller could hold
      the value, and read it, and not write down what it was — no function taking it, no
      Record keyed by it, no exhaustive switch over it. `EdfErrorCode` and `DiagnosticCode`,
      the two siblings of the first, had been exported since they existed.

      Type-checked rather than asserted against a list, because the failure this catches is a
      consumer's compile error and nothing short of a compiler produces one.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-types-'));
    try {
      await writeFile(
        path.join(work, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            module: 'nodenext',
            moduleResolution: 'nodenext',
            target: 'es2022',
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            baseUrl: work,
            paths: { edf2csv: [path.join(ROOT, 'dist/index.d.ts')] },
          },
          files: ['probe.ts'],
        }),
      );
      await writeFile(
        path.join(work, 'probe.ts'),
        [
          "import { selectChannels, buildPlan, parseHeader, EdfFile } from 'edf2csv';",
          'import type {',
          '  ConversionErrorCode, OutputEstimate, ChannelSelection, ConversionError,',
          '  ConversionPlan, ConvertResult, WrittenFile, Diagnostic, DiagnosticCode,',
          '  EdfErrorCode, EdfSignal, EdfHeader, Annotation, Scaler, ResolvedRange,',
          "} from 'edf2csv';",
          '',
          '// Each binding is the declared type of something the API returns or exposes.',
          'declare const err: ConversionError;',
          'declare const plan: ConversionPlan;',
          'declare const result: ConvertResult;',
          'declare const file: EdfFile;',
          'const code: ConversionErrorCode = err.code;',
          'const estimate: OutputEstimate = plan.estimate;',
          'const picked: ChannelSelection = selectChannels([], []);',
          'const written: WrittenFile[] = result.files;',
          'const signal: EdfSignal | undefined = file.dataSignals[0];',
          'const header: EdfHeader = file.header;',
          'const range: ResolvedRange = plan.range;',
          'const notes: Diagnostic[] = plan.diagnostics;',
          'const kind: DiagnosticCode = notes[0]!.code;',
          'declare const bad: EdfErrorCode;',
          'declare const event: Annotation;',
          'declare const scaler: Scaler;',
          'declare const parsed: ReturnType<typeof parseHeader>;',
          'declare const made: ReturnType<typeof buildPlan>;',
          'export { code, estimate, picked, written, signal, header, range, kind, bad, event, scaler, parsed, made };',
        ].join('\n'),
      );

      const tsc = path.join(ROOT, 'node_modules/.bin/tsc');
      const { stdout, stderr } = await run(tsc, ['-p', path.join(work, 'tsconfig.json')]).catch(
        (error) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) }),
      );
      assert.equal(`${stdout}${stderr}`.trim(), '', `a consumer cannot name part of the API:\n${stdout}${stderr}`);
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

    /*
      The fuzz sweep the same way, and it is the one whose second number moves: the claim is
      "1,200 runs over 300 corrupted recordings", which is the file count times how many ways
      each file is run. That list lived inline in the harness, so adding a fifth invocation
      made the page wrong by 300 runs with nothing to say so — and five were added at once.
    */
    const mutate = await import(path.join(ROOT, 'test/fuzz/mutate.mjs'));
    const damaged = /([\d,]+) runs over ([\d,]+) corrupted recordings/gu;
    const fuzzed = [...page.matchAll(damaged)];
    assert.ok(fuzzed.length >= 2, 'the page no longer states the fuzz sweep size');
    for (const [, runs, recordings] of fuzzed) {
      assert.equal(Number(recordings.replaceAll(',', '')), mutate.DEFAULT_FILES);
      assert.equal(
        Number(runs.replaceAll(',', '')),
        mutate.DEFAULT_FILES * mutate.INVOCATIONS.length,
        `the page states ${runs} runs; the sweep makes ${mutate.INVOCATIONS.length} per file`,
      );
    }

    /*
      And the figure the three-times ceiling rests on. "The worst any fixture produces is
      1.73x" was written in a comment and on this page and measured by nothing: the sweep
      summed the ratios for an average and threw the maximum away, so a fixture reading 2.9x
      high would have passed under the ceiling with both statements wrong and the headroom
      they describe gone. The sweep enforces it now, and the two numbers meet here.
    */
    const estimateSweep = await import(path.join(ROOT, 'test/fuzz/estimate.mjs'));
    const worst = /the worst any fixture produces is ([\d.]+)x/u.exec(page);
    assert.ok(worst, 'the page no longer states the worst over-estimate');
    assert.equal(
      Number(worst[1]),
      estimateSweep.WORST_SEEN,
      `the page says ${worst[1]}x and the sweep enforces ${estimateSweep.WORST_SEEN}x`,
    );
    assert.ok(
      estimateSweep.WORST_SEEN < estimateSweep.LOOSEST,
      'the wall has to stand above the worst the sweep has seen',
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

  it('states the accuracy figures the cross-check\'s own recordings contain', async () => {
    /*
      "Across the 75 generated recordings, 16,943 sample values were bit-for-bit identical"
      is this tool's headline accuracy claim. It opens the README, it is claim 1 on the
      correctness page, and 16,943 is one of the four figures on the landing page in large
      type. It is also the only claim nobody can re-run without installing pyEDFlib, which
      makes it the one most able to go stale unnoticed — and its recordings are not the
      fixture set, so none of the counts the neighbouring test pins has any bearing on it.

      What pyEDFlib is needed for is whether the values AGREE. How many there are to compare
      is arithmetic on the headers of recordings this repository generates itself:
      `samplesPerRecord * recordCount` summed over the data channels, and the annotations the
      reader finds. Both come out on the nose, so all three figures can be held to the files
      they describe on a machine with no Python at all.

      The generator is deterministic and writes 300 KB in a fifth of a second.
    */
    const { generate, OUT_DIR } = await import(path.join(ROOT, 'test/crossvalidate/generate.mjs'));
    const { EdfFile } = await import(path.join(ROOT, 'dist/index.js'));
    const written = generate();
    assert.ok(written.length > 10, `the cross-check generator wrote ${written.length} recordings`);

    let samples = 0;
    let events = 0;
    for (const name of (await readdir(OUT_DIR)).filter((n) => /\.(edf|bdf)$/iu.test(n))) {
      const file = await EdfFile.open(path.join(OUT_DIR, name));
      try {
        for (const signal of file.dataSignals) {
          samples += signal.samplesPerRecord * file.recordCount;
        }
        if (file.annotationSignals.length > 0) {
          events += (await file.readAnnotations()).annotations.length;
        }
      } finally {
        await file.close();
      }
    }

    const page = (await read('website/content/correctness.md')).replace(/\s+/gu, ' ');
    const readme = (await read('README.md')).replace(/\s+/gu, ' ');
    const jsx = await read('website/src/components/Landing.jsx');
    const numbers = (text, pattern) =>
      [...text.matchAll(pattern)].map((m) => Number((m[1] ?? m[2]).replaceAll(',', '')));

    /*
      Matched on the cross-check's own phrasings rather than on any "N recordings": the
      fixture set and the batch sweep both state counts of their own on the same page, and
      the batch sweep's is how many files a seed happened to scatter, which is nobody's
      business to pin.
    */
    const counts = [
      ...numbers(page, /([\d,]+) generated recordings/gu),
      ...numbers(page, /bit for bit,[^.]*?across ([\d,]+) recordings/gu),
      ...numbers(readme, /([\d,]+) generated recordings/gu),
    ];
    assert.ok(counts.length >= 4, `the pages state the cross-check's size ${counts.length} times`);
    for (const count of counts) {
      assert.equal(count, written.length, `a page says ${count} recordings; it reads ${written.length}`);
    }

    const stated = [
      ...numbers(page, /([\d,]+) sample values|Compared ([\d,]+) sample values/gu),
      ...numbers(readme, /([\d,]+) sample values/gu),
      ...numbers(jsx, /value: '([\d,]+)', label: 'sample values/gu),
    ];
    assert.ok(stated.length >= 4, `the sample count is stated ${stated.length} times`);
    for (const value of stated) {
      assert.equal(value, samples, `a page says ${value} sample values; the recordings hold ${samples}`);
    }

    const annotations = numbers(page, /([\d,]+) annotations/gu);
    assert.ok(annotations.length >= 2, 'the page no longer states the annotation count');
    for (const value of annotations) {
      assert.equal(value, events, `a page says ${value} annotations; the recordings hold ${events}`);
    }
  });

  it('lays the header out the way the parser reads it', async () => {
    /*
      `edf-format.md` prints the byte layout twice — a table for the fixed header and a fence
      for the field-major signal headers — and it is the page somebody uses to check a file by
      hand or to write a reader of their own. The parser prints it a third time, in the comment
      at the top of `header.ts`, and reads it a fourth, in the offsets passed to `dec` and
      `readField`. Four copies of one table, and nothing joining any of them.

      That is the failure `OPTIONS` in cli.ts carries a comment about — "a second copy of twenty
      flag names is a copy that will be missing the next one" — with the difference that a wrong
      offset here is not a missing entry but a wrong instruction: a reader following the page
      would take a label where a transducer string is, which is the exact mistake the page's own
      last paragraph warns about.

      Matched as sets of (offset, width) rather than field by field, since the names are prose
      on one side and identifiers on the other. A pair that appears in one and not the other is
      what there is to catch.
    */
    const FIXED_HEADER_BYTES = 256;
    const source = await read('src/edf/header.ts');
    const page = await read('website/content/edf-format.md');

    // What the parser actually reads: `dec(buf, 168, 8)` for the fixed header.
    const reads = new Set(
      [...source.matchAll(/\bdec\(buf, (\d+), (\d+)\)/gu)].map((m) => `${m[1]}:${m[2]}`),
    );
    assert.ok(reads.size >= 9, `found ${reads.size} fixed-header reads, expected the whole table`);

    /*
      Compared by containment rather than by equality, because one row is read twice: the
      version field is eight bytes on the page, and the parser reads bytes 1 to 7 of it again
      on their own, to recognise BDF's `BIOSEMI` magic. So every read has to fall inside a row
      the page documents, and every row has to have a read starting at it — which says both
      of the things worth saying, and lets a field be read in parts.
    */
    const rows = [...page.matchAll(/^\| (\d+) \| (\d+) \| ([^|]+)\|/gmu)]
      .map((m) => ({ at: Number(m[1]), width: Number(m[2]), name: m[3].trim() }))
      // The section below breaks the version field into its own bytes; its rows have the
      // same shape, and every one of them sits inside the version row above.
      .filter((row) => row.at + row.width <= FIXED_HEADER_BYTES);
    assert.ok(rows.length >= 10, `the fixed-header table has ${rows.length} rows`);

    for (const read of reads) {
      const [at, width] = read.split(':').map(Number);
      assert.ok(
        rows.some((row) => row.at <= at && at + width <= row.at + row.width),
        `the parser reads ${width} bytes at ${at}, which the page's table does not cover`,
      );
    }
    for (const row of rows) {
      assert.ok(
        [...reads].some((read) => Number(read.split(':')[0]) === row.at),
        `the page documents "${row.name}" at ${row.at} and nothing reads it`,
      );
    }

    // And the comment at the top of the parser, which prints the same table a third time.
    const comment = source.slice(0, source.indexOf('*/'));
    const commented = [...comment.matchAll(/^ \*\s+(\d+)\s+(\d+)\s{2,}\S/gmu)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
    assert.deepEqual(
      [...new Set(commented)].sort(),
      rows.map((row) => `${row.at}:${row.width}`).sort(),
      "header.ts's own layout comment and the page's table are different layouts",
    );

    /*
      The signal headers, which are the half people get wrong: field-major, so the label of
      signal i is at `256 + i * 16` and its physical minimum at `256 + ns * 104 + i * 8`.
      `readField(104, 8, i)` is that second one.
    */
    const perSignal = new Set(
      [...source.matchAll(/\breadField\((\d+), (\d+), i\)/gu)].map((m) => `${m[1]}:${m[2]}`),
    );
    assert.ok(perSignal.size >= 9, `found ${perSignal.size} signal-header reads`);

    const fence = /```\noffset 256([\s\S]*?)```/u.exec(page);
    assert.ok(fence, 'the signal-header layout is gone from the page');
    const drawn = ['0:16'];
    for (const line of fence[1].split('\n')) {
      const at = /\+ns\*(\d+)\s+ns \*\s*(\d+) bytes/u.exec(line);
      if (at) drawn.push(`${at[1]}:${at[2]}`);
    }
    // The last row closes the record, and the ten of them have to add up to the 256 bytes a
    // signal header takes — which is the arithmetic that makes field-major work at all.
    const last = drawn[drawn.length - 1].split(':').map(Number);
    assert.equal(last[0] + last[1], 256, `the signal header runs to ${last[0] + last[1]} bytes`);
    assert.deepEqual(
      drawn.sort(),
      [...perSignal].sort(),
      'the signal-header layout and the fields the parser reads are different layouts',
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

      Three commands, not one. This ran only the first for eleven versions, and the same slip
      was sitting two pages over the whole time, in a stronger form: the MIXED_SAMPLING_RATES
      section demonstrated its "it describes the conversion, not the file" rule with

          edf2csv sleep-study.edf --channels "EEG Fpz-Cz"   # one file, no warning

      which raises the row-limit warning — eight hours at 100 Hz is 2.88 million rows — and
      the line below it, annotated with the rate warning alone, raises it too. A comment in a
      shell block saying what a command prints is the same kind of claim as a pasted output
      block, and this is the check for it.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-warnblock-'));
    const shown = [];
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const recording = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      for (const [page, extra] of [
        ['website/content/getting-started.md', []],
        ['website/content/warnings-and-errors.md', ['--channels', 'EEG Fpz-Cz']],
        ['website/content/warnings-and-errors.md', ['--channels', 'EEG Fpz-Cz,Temp rectal']],
      ]) {
        const { stderr } = await run(process.execPath, [CLI, recording, '--info', ...extra]);
        shown.push({
          page,
          extra,
          printed: stderr.split('\n').filter((line) => line.startsWith('warning: ')),
        });
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }

    /*
      Scoped to the block, not to the page.

      warnings-and-errors has a section per code, so every warning either command raises is
      quoted somewhere on it whatever the example says — page-wide containment passes over a
      block claiming the opposite of what its command does. The block is the claim.
    */
    const blockHolding = (text, needle) => {
      for (const fence of text.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)) {
        if (fence[1].split('\n').some((line) => line.trim().replace(/\s+#\s.*$/u, '') === needle)) {
          return fence[1];
        }
      }
      return null;
    };
    const blockAfter = (text, sentence) => {
      const at = text.indexOf(sentence);
      if (at < 0) return null;
      return /```[a-z]*\n([\s\S]*?)```/u.exec(text.slice(at))?.[1] ?? null;
    };

    for (const { page, extra, printed } of shown) {
      assert.ok(printed.length >= 1, `expected a warning from --info ${extra.join(' ')}`);
      const text = await read(page);
      const quoted = extra.length === 0
        ? blockAfter(text, 'Anything the tool noticed is printed after the table')
        : blockHolding(text, `edf2csv sleep-study.edf --channels "${extra[1]}"`);
      assert.ok(quoted, `${page}: no block shows what --info ${extra.join(' ')} prints`);
      const flat = quoted.replace(/\s+/gu, ' ');
      for (const line of printed) {
        assert.ok(
          flat.includes(line.replace(/\s+/gu, ' ').trim()),
          `${page}: the block for --info ${extra.join(' ')} does not show: ${line}`,
        );
      }
    }

    // And the point that block is making: the rate warning follows the conversion, not the
    // file. One channel of a three-rate recording raises it; two rates of it raise it once.
    const rates = (line) => line.includes('different sampling rates');
    assert.ok(!shown[1].printed.some(rates), 'one channel is one file, and raises no rate warning');
    assert.equal(shown[2].printed.filter(rates).length, 1, 'two rates, one rate warning');
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

  it('heads the channel table with the columns --info actually prints', async () => {
    /*
      `--info`'s channel table is the most-quoted block on this site: four pages print its
      heading row, and the test below compares the header *fields* above it — File, Format,
      Duration, Channels — and stops there. The row naming the columns was written out by hand
      in src/cli/report.ts and again on each of those pages, and nothing connected them.

      It matters more than a heading row usually would, because these names are referred to by
      name elsewhere: the CLI reference tells you to "match against the label from the `LABEL`
      column of `--info`, not the `COLUMN` name", advice that is only followable while those
      two words are the ones on screen.

      Compared as a sequence of names rather than as text: the column widths come from the
      recording, so the spacing differs between one page's example and another's.
    */
    const { stdout } = await run(process.execPath, [
      CLI, path.join(ROOT, 'test/fixtures/generated/ascending-rates.edf'), '--info',
    ]);
    const heading = stdout.split('\n').find((line) => line.startsWith('#  '));
    assert.ok(heading, '--info no longer prints a channel table');
    const printed = heading.trim().split(/\s+/u);
    assert.ok(printed.length >= 5, `that does not look like a heading row: ${heading}`);

    let checked = 0;
    for (const name of (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    )) {
      const text = await read(path.join('website/content', name));
      for (const line of text.split('\n')) {
        if (!line.startsWith('#  ') || !line.includes('COLUMN')) continue;
        checked++;
        assert.deepEqual(
          line.trim().split(/\s+/u),
          printed,
          `${name} heads the --info table with columns it does not print`,
        );
      }
    }
    assert.ok(checked >= 3, `expected the table on several pages, found ${checked}`);
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

  it('lists every flag whose value the command line refuses on its own', async () => {
    /*
      "**Exit 2** covers anything decided before touching data", says the reference, and then
      lists what that is. The list named `--decimals` and not `--jobs` or `--layout`, which are
      validated the same way and in the same place — `--jobs 0` and `--layout tall` have both
      been usage errors for longer than the paragraph naming only the third of them. The
      `--stdout` combinations were half there too: the one about tables, and not `--json`,
      `--out`, `--checksum`, `--force`, a folder or a second recording, all of which the tool
      refuses before it reads a byte.

      Derived from the usage text rather than from a list kept here, so a flag added tomorrow
      with a value it checks fails this until the reference mentions it: every long option that
      takes a value is given one nothing could mean, and the ones that answer with exit 2 are
      the ones that have to be named.

      Two values, not one, and the second is asserted of every flag rather than only of the
      ones that answer. `!!not-a-value!!` is nonsense to seven of the eight and a perfectly
      good directory name to `--out`, so the one flag that was not checking its value was the
      one this probe could not reach: `--out ""` went through to `mkdir('')` and came back as
      a conversion failure. An empty string is the value a shell hands an option by accident —
      `--out "$DEST"` with `DEST` unset — and there is no option here it could mean anything
      to, so every one of them has to refuse it.
    */
    const reference = await read('website/content/cli-reference.md');
    const section = /\*\*Exit 2\*\* covers([\s\S]*?)\n\*\*Exit 1\*\*/u.exec(reference);
    assert.ok(section, 'the exit 2 list is gone from the reference');

    const usage = (await run(process.execPath, [CLI, '--help'])).stdout;
    // `      --start <time>     Begin at...` — long options that take a value.
    const flags = [...usage.matchAll(/(--[a-z-]+) </gu)].map((m) => m[1]);
    assert.ok(flags.length >= 6, `expected the usage to list options with values: ${flags}`);

    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-exit2-'));
    const refused = [];
    /** Flags that took an empty value for an answer. See the second value below. */
    const emptyAccepted = [];
    try {
      for (const flag of flags) {
        for (const value of ['!!not-a-value!!', '']) {
          const code = await run(
            process.execPath,
            [CLI, path.join(ROOT, 'test/fixtures/generated/mixed-rates.edf'), '--info', flag, value],
            { cwd: work },
          ).then(() => 0, (error) => error.code);
          if (code === 2 && !refused.includes(flag)) refused.push(flag);
          if (value === '' && code !== 2) emptyAccepted.push(`${flag} "" exited ${code}`);
        }
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }

    assert.deepEqual(emptyAccepted, [], 'an empty value is not a value any of these can act on');
    assert.ok(refused.length >= 6, `expected several flags to check their value: ${refused}`);
    for (const flag of refused) {
      assert.ok(
        section[1].includes(`\`${flag}\``),
        `${flag} refuses a value it cannot act on, and the exit 2 list does not mention it`,
      );
    }

    // And the combinations --stdout refuses, which are decided from the command line alone.
    for (const [flag, extra] of [
      ['--json', []], ['--out', ['x']], ['--checksum', []], ['--force', []],
    ]) {
      const code = await run(
        process.execPath,
        [CLI, path.join(ROOT, 'test/fixtures/generated/tiny.edf'), '--stdout', flag, ...extra],
      ).then(() => 0, (error) => error.code);
      assert.equal(code, 2, `--stdout ${flag} is no longer a usage error`);
      assert.ok(
        section[1].includes(`\`${flag}\``),
        `--stdout ${flag} is a usage error the exit 2 list does not mention`,
      );
    }
  });

  it('quotes the no-such-channel refusal with the advice where the tool puts it', async () => {
    /*
      "Every refusal takes that shape — `error:` on the first line, the advice indented under
      it — so stderr can be grepped for `^error:` and find all of them", says the reference,
      four hundred lines below its own copy of this one:

          error: No channel named "ECQ". Did you mean "ECG"?
          Run with --info to list the channels in this file.

      Flush left, where the tool indents by seven. The FAQ had it the same way. That indent is
      not decoration: it is what says the second line belongs to the first rather than being a
      second error, and a reader building a `grep '^error:'` from these blocks would count two.

      Run rather than matched, since the message these pages quote is one the tool composes.
    */
    const names = (await readdir(path.join(ROOT, 'website/content'))).filter((n) =>
      n.endsWith('.md'),
    );
    const recording = path.join(ROOT, 'test/fixtures/generated/mixed-rates.edf');
    let checked = 0;
    for (const page of names) {
      const text = await read(`website/content/${page}`);
      for (const [, block, term] of text.matchAll(
        /```(?:text)?\n(error: No channel named "([^"]+)"[\s\S]*?)```/gu,
      )) {
        checked++;
        const spoken = await run(process.execPath, [CLI, recording, '--info', '--channels', term])
          .then(() => '', (error) => String(error.stderr));
        assert.equal(block.trimEnd(), spoken.trimEnd(), page);
      }
    }
    assert.ok(checked >= 2, `expected the pages to quote this refusal, found ${checked}`);
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

    /*
      And the members of the classes, not only the class names.

      `EdfFile` is one entry in that list, so satisfying the check above says nothing about its
      twenty-two members — which is how `sha256()` and `modifiedAtOpenMs` stayed undocumented
      until 0.6.35 and 0.6.36. Both are public, both carry a rule a caller cannot guess, and
      neither appeared on the page in any form.

      Read off the prototype rather than the `.d.ts`, so it follows the shipped object.
    */
    for (const [name, value] of Object.entries(api)) {
      if (typeof value !== 'function' || !/^[A-Z]/u.test(name)) continue;
      const members = [
        ...Object.getOwnPropertyNames(value.prototype),
        ...Object.getOwnPropertyNames(value),
      ].filter((m) => !['constructor', 'prototype', 'length', 'name'].includes(m) && !m.startsWith('#'));
      const undocumented = members.filter((m) => !page.includes(m));
      assert.deepEqual(undocumented, [], `api.md never mentions ${name}.${undocumented.join(`, ${name}.`)}`);
    }
  });

  it('packs a tarball that holds the code it says it does', async () => {
    /*
      `npm pack` on a clean checkout produced a four-file tarball with no `dist/` in it — no
      bin, nothing importable — and reported success. `prepublishOnly` builds, but it runs
      only for `npm publish`; `npm pack` and an install from a git URL both went round it.
      Published versions were fine, which is exactly why it could sit there.

      Checked from the file list rather than by packing, which would mean running a build
      inside the test suite: `files` says what ships and `bin`/`exports`/`types` say what has
      to be in it, and `prepare` is what guarantees the second exists when the first is read.
    */
    const manifest = JSON.parse(await read('package.json'));
    /*
      `prepare`, not `prepack`.

      `prepack` builds for `npm pack` and `npm publish` and for nothing else. npm runs
      `prepare` for those too, and also when the package is installed from a git URL or from
      a checkout — the two cases `prepack` left with no build at all, so `npm i
      github:tayal-sarthak/edf2csv` installed a package whose `bin` pointed at a dist/cli.js
      that was never written. `prepare` covers every case `prepack` did and those as well.
    */
    assert.ok(
      /(^|&&\s*)npm run build/u.test(manifest.scripts.prepare ?? ''),
      'prepare must build, or a git install ships a bin pointing at nothing',
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
      '.gitattributes', '.github', '.gitignore', 'CITATION.cff', 'CONTRIBUTING.md', 'LICENSE',
      'README.md', 'SECURITY.md', 'docs', 'package-lock.json', 'package.json', 'src', 'test',
      'tsconfig.json', 'vercel.json', 'website',
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
    /*
      And no page states a version inside one of those samples.

      output-files.md's transcript said `"version": "0.2.0"` while the package was at 0.6.127 —
      125 releases, on the document the comment above calls "what someone reads before writing
      code against it". The keys were guarded and the values in them were not, so it sat there.
      A sample cannot state a release without going stale on the next one, and there is nothing
      here for it to say: `"..."` is what the landing page's copy of the same object has always
      shown, and it is honest at every version.
    */
    for (const page of await readdir(path.join(ROOT, 'website/content'))) {
      if (!page.endsWith('.md')) continue;
      const text = await read(path.join('website/content', page));
      const stated = [...text.matchAll(/"name":\s*"edf2csv",?\s*"?\n?\s*"version":\s*"([^"]*)"/gu)];
      for (const [, version] of stated) {
        assert.equal(version, '...', `${page} states a version inside a tool object: ${version}`);
      }
    }

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

  it('batches the recording it describes the way it says it does', async () => {
    /*
      "The final batch is usually short — the 18.7 MB recording this page reads gives two 8 MB
      batches and a 2.7 MB one" is the sentence that explains why a stale view ends up a seam
      between two batches rather than simply the last one. It is the whole reason the section
      exists, and three numbers about a specific recording at the default read budget.

      Nothing produced any of them. The test that pins the reused-buffer contract uses a
      different recording at `chunkBytes: 5000`, on purpose — it wants a short tail and does not
      care where — so raising `DEFAULT_CHUNK_BYTES` to 16 MB would give this recording two
      batches, leave the page describing three, and pass.
    */
    const page = await read('website/content/api.md');
    const stated = /the ([\d.]+) MB recording this page reads gives (\w+) ([\d.]+) MB batches and a ([\d.]+) MB one/u.exec(page);
    assert.ok(stated, 'the page no longer describes how that recording batches');
    const words = { two: 2, three: 3, four: 4 };
    const [, statedSize, fullCount, fullSize, tailSize] = stated;

    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-batches-'));
    try {
      const { writeSleepStudy } = await import(path.join(ROOT, 'test/fixtures/sleep-study.mjs'));
      const recording = writeSleepStudy(path.join(work, 'sleep-study.edf'));
      const { EdfFile } = await import(path.join(ROOT, 'dist/index.js'));

      const bytes = (await stat(recording)).size;
      assert.equal(
        (bytes / 1024 ** 2).toFixed(1),
        Number(statedSize).toFixed(1),
        `the page calls it a ${statedSize} MB recording`,
      );

      const file = await EdfFile.open(recording);
      const sizes = [];
      // The default budget, which is the thing the sentence is about.
      for await (const batch of file.readRecords()) sizes.push(batch.data.length);
      await file.close();

      const full = words[fullCount];
      assert.ok(full, `"${fullCount}" is not a count this test can read`);
      assert.equal(sizes.length, full + 1, `the page says ${fullCount} full batches and a tail`);
      for (const size of sizes.slice(0, full)) {
        assert.equal(
          (size / 1024 ** 2).toFixed(2),
          Number(fullSize).toFixed(2),
          `the page says the full batches are ${fullSize} MB`,
        );
      }
      assert.equal(
        (sizes[sizes.length - 1] / 1024 ** 2).toFixed(1),
        Number(tailSize).toFixed(1),
        `the page says the tail is ${tailSize} MB`,
      );
      assert.ok(sizes[sizes.length - 1] < sizes[0], 'and that the tail is the short one');
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('reads the dates its own table says it reads', async () => {
    /*
      "85 to 99 mean 1985 to 1999, and 00 to 84 mean 2000 to 2084" is the most-quoted rule about
      this format, and edf-format prints a table of three worked examples under it. Nothing ran
      them.

      Half the rule was exercised by nothing at all. Every assertion on a parsed year was on a
      date below 85 — `05.06.09` is 2009 — so moving the pivot to 86, or the base to 1901,
      leaves the whole suite green while `01.01.85` reads as 1986-01-01 against a page that says
      1985. The 1900s branch is the one that only fires on the oldest recordings there are,
      which are exactly the files nobody has to hand to notice.

      Read out of the page rather than written here, so a worked example added to it is run.
    */
    const { parseHeader } = await import(path.join(ROOT, 'dist/index.js'));
    const { writeEdf } = await import(path.join(ROOT, 'test/fixtures/edf-writer.mjs'));
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-century-'));

    // A plain EDF, so the rule alone decides: an EDF+ Startdate would settle it instead.
    const parsed = async (raw) => {
      const at = path.join(work, `${raw.replaceAll('.', '')}.edf`);
      writeEdf({
        path: at, startDate: raw, startTime: '00.00.00', numRecords: 1, recordDuration: 1,
        signals: [
          { label: 'ch', dimension: 'uV', physMin: -1, physMax: 1, digMin: -1, digMax: 1,
            samplesPerRecord: 2, gen: () => 0 },
        ],
      });
      const { header } = parseHeader(await readFile(at), 1024);
      return header.startDateTime;
    };

    try {
      const page = await read('website/content/edf-format.md');
      const worked = [...page.matchAll(/^(\d{2}\.\d{2}\.\d{2}) {2}-> {2}(\d{4}-\d{2}-\d{2})$/gmu)];
      assert.ok(worked.length >= 3, `expected the worked dates, found ${worked.length}`);
      for (const [, raw, expected] of worked) {
        const read1 = await parsed(raw);
        assert.equal(read1?.toISOString().slice(0, 10), expected, `the page says ${raw} is ${expected}`);
      }

      // And the pivot itself, from the sentence above the table.
      const rule = /\*\*(\d+) to (\d+) mean (\d{4}) to (\d{4}), and (\d+) to (\d+) mean (\d{4}) to (\d{4})\*\*/u.exec(page);
      assert.ok(rule, 'the page no longer states the century rule');
      const [, lowFrom, , lowYear, , , highTo, , highYear] = rule;
      assert.equal(
        (await parsed(`01.01.${lowFrom}`))?.getUTCFullYear(),
        Number(lowYear),
        `the page says ${lowFrom} is ${lowYear}`,
      );
      assert.equal(
        (await parsed(`01.01.${highTo}`))?.getUTCFullYear(),
        Number(highYear),
        `the page says ${highTo} is ${highYear}`,
      );
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('accepts exactly the time units it says it accepts, each worth what it is called', async () => {
    /*
      Sixteen spellings of four units, and the reference lists all sixteen. The tool's own
      message named four of them — "Use h, m, s, or ms" — and nothing checked any of the
      values. `hrs: 3600` is a number in a table: set it to 360 and `--start 2hrs` converts
      from twelve minutes in, the reference is wrong, and the whole suite is green. A window
      that is quietly the wrong length is the mistake this option may not make.

      Both directions on the list, and the value derived from the name rather than read out of
      the table, so the table is checked against what its own keys mean.
    */
    const { UNIT_SECONDS } = await import(path.join(ROOT, 'dist/convert/time-range.js'));
    const { parseTimeSpec } = await import(path.join(ROOT, 'dist/index.js'));

    const page = await read('website/content/cli-reference.md');
    const sentence = /Recognised units are ([^\n]*?)\. Note that/u.exec(page);
    assert.ok(sentence, 'the reference no longer lists the units');
    const listed = [...sentence[1].matchAll(/`([a-z]+)`/gu)].map((m) => m[1]);
    assert.deepEqual(
      listed.filter((unit) => !(unit in UNIT_SECONDS)),
      [],
      'the reference lists a unit the parser does not take',
    );
    assert.deepEqual(
      Object.keys(UNIT_SECONDS).filter((unit) => !listed.includes(unit)),
      [],
      'the parser takes a unit the reference does not list',
    );

    // What one of each is worth, from the spelling: ms before m, since it starts with one.
    const worth = (unit) => {
      if (unit === 'ms') return 0.001;
      if (unit.startsWith('h')) return 3600;
      if (unit.startsWith('m')) return 60;
      if (unit.startsWith('s')) return 1;
      return null;
    };
    for (const unit of Object.keys(UNIT_SECONDS)) {
      const expected = worth(unit);
      assert.ok(expected !== null, `"${unit}" is not a spelling of any unit this checks`);
      assert.equal(UNIT_SECONDS[unit], expected, `"${unit}" is worth ${UNIT_SECONDS[unit]}s`);
      assert.equal(parseTimeSpec(`2${unit}`, '--start'), 2 * expected, `--start 2${unit}`);
    }

    // And the message a mistyped unit gets, which named four of the sixteen.
    assert.throws(
      () => parseTimeSpec('5x', '--start'),
      (error) => /Use h, m, s or ms, or their long forms/u.test(error.message),
      'the unknown-unit message no longer points at the long forms',
    );
  });

  it('lists every filesystem failure it says it translates', async () => {
    /*
      "Filesystem failures are translated into plain language rather than passed through as
      system codes", says the OUTPUT_UNWRITABLE section, and then names them. `describeFsError`
      knew six codes and fell through to Node's own text for everything else — so the sentence
      was a claim about a list nobody was comparing, and the code it missed was ENOENT, which a
      destination under a dangling symbolic link produces. The page also reworded one of the
      six ("a file rather than a directory" for "a file, not a directory"), which is how a list
      copied by hand drifts from the thing it copies.

      Both directions, since either is a way of being wrong: a phrase the tool can print that
      the page does not name, and a phrase the page names that nothing prints.
    */
    const source = await read('src/convert/run.ts');
    const body = /function describeFsError[\s\S]*?\n\}/u.exec(source);
    assert.ok(body, 'describeFsError is gone or renamed');
    const spoken = [...body[0].matchAll(/return '([^']+)'/gu)].map((m) => m[1]);
    assert.ok(spoken.length >= 6, `expected the translations, found ${spoken.length}`);

    const page = await read('website/content/warnings-and-errors.md');
    const sentence = /in the words the message uses: ([^\n]*?)\.\n/u.exec(page);
    assert.ok(sentence, 'the translated-failures list is gone from the page');
    const listed = sentence[1].split('; ');

    assert.deepEqual(
      listed.filter((phrase) => !spoken.includes(phrase)),
      [],
      'the page names a translation nothing produces',
    );
    assert.deepEqual(
      spoken.filter((phrase) => !listed.includes(phrase)),
      [],
      'the tool prints a translation the page does not list',
    );
  });

  it('documents the columns channels.csv and annotations.csv actually have', async () => {
    /*
      The same argument the metadata.json guard above is written on, applied to the two output
      files it does not cover. output-files.md gives each of them a row-per-column table, and
      that table is what somebody reads before writing code against the file — a column added
      to the writer and not to the page reads as a column that does not exist, and one removed
      reads as a column they can rely on.

      metadata.json got a guard because its shape had drifted once. These two never had one at
      all, and channels.csv has fourteen columns written out by hand in two places.
    */
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');

    const base = await mkdtemp(path.join(tmpdir(), 'edf2csv-columns-'));
    let headers;
    try {
      const out = path.join(base, 'out');
      // A recording with annotations and more than one rate, so both files are written and
      // `output_file` has something to say.
      await run(process.execPath, [
        CLI, path.join(ROOT, 'test/fixtures/generated/discontinuous.edf'),
        '--out', out, '--quiet',
      ]);
      headers = Object.fromEntries(
        await Promise.all(
          ['channels.csv', 'annotations.csv'].map(async (name) => [
            name,
            (await readFile(path.join(out, name), 'utf8')).split('\n')[0].split(','),
          ]),
        ),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }

    const page = await read('website/content/output-files.md');
    for (const [name, columns] of Object.entries(headers)) {
      // The table under the file's own heading, up to the next one.
      const from = page.indexOf(`## ${name}`);
      assert.ok(from > 0, `${name} has no section in output-files.md`);
      const section = page.slice(from, page.indexOf('\n## ', from + 1));
      /*
        Two columns sharing one row is how the page writes a pair whose explanation is the
        same sentence — `| \`physical_min\`, \`physical_max\` | ... |` — so a row is read as
        the set of names in its first cell rather than as one name.
      */
      const documented = [...section.matchAll(/^\| ((?:`[a-z_]+`(?:, )?)+) \|/gmu)]
        .flatMap((m) => m[1].split(', '))
        .map((cell) => cell.replaceAll('`', ''));
      assert.deepEqual(
        documented,
        columns,
        `${name}'s documented columns are not the ones it writes`,
      );
    }
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

  it('wraps every line it wraps at all to eighty columns', async () => {
    /*
      Eighty is what a terminal is unless someone has changed it, and `--help` had six lines
      of 81 to 86. What those lines cost is not aesthetic: the option list is three aligned
      columns, and a wrapped line puts its tail under the flag names, so the alignment that
      makes the table readable is exactly what breaks first. The longest line the tool printed
      was worse and newer — the unknown-option hint added in 0.6.115 ran to 95.

      What this checks is narrower than what it used to say it checked, and wider than what it
      actually did. It was titled "prints nothing that needs a terminal wider than eighty
      columns" and ran six refusals against one fixture. The tool prints thirty-six distinct
      lines longer than that, and every one of them is a first line — the one following
      `error: ` or `warning: `, which `printableLines` leaves whole on purpose, because it is
      the line a log gets grepped for and a break in the middle of it costs more than the
      overrun. So the old title described a promise the design deliberately does not make, and
      passed only because the six messages it sampled happened to begin short.

      The promise that is real is about the lines that are wrapped: `--help`, and every
      continuation under a diagnostic or an error. Those go through `wrap`, nothing enforces
      the width but reading the output back, and six samples of it was not reading much. Every
      fixture converted, plus every refusal the command line has, is a few hundred of them.
    */
    const WIDTH = 80;
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-width-'));
    try {
      await cp(path.join(ROOT, 'test/fixtures/generated'), work, { recursive: true });
      const recordings = (await readdir(work)).filter((f) => /\.(edf|bdf)$/u.test(f));
      assert.ok(recordings.length > 40, 'fixtures should be generated before this runs');

      const refusals = [
        ['--chanels'], ['--decimals', '21'], ['--decimals', 'abc'], ['--layout', 'tall'],
        ['--jobs', '0'], ['--jobs', 'abc'], ['--channels', 'nope'], ['--channels', '#x'],
        ['--channels', '#99'], ['--channels', ''], ['--channels', 'signal_0'],
        ['--stdout', '--checksum'], ['--stdout', '--annotations-only'], ['--start', 'abc'],
        ['--start', '1h1h'], ['--start', '99999'], ['--start', '5x'], ['--duration', '-5'],
        ['--start', '1', '--end', '0'], ['--end', '00:99:00'], ['--info', '--stdout'],
      ];

      const problems = [];
      let continuations = 0;
      const measure = (text, what) => {
        for (const line of text.split('\n')) {
          // A first line is exempt by design; see printableLines. Everything else was wrapped.
          if (line === '' || /^(?:error|warning|note): /u.test(line)) continue;
          continuations++;
          // A word wider than the column is left to overrun rather than broken, and the long
          // words here are paths — the point of printing one is that it can be copied back
          // out. The recordings are named bare from `work` so only a destination reaches this.
          if (line.length > WIDTH && !line.includes(work)) {
            problems.push(`${what}: ${line.length} columns: ${line}`);
          }
        }
      };

      const { stdout: help } = await run(process.execPath, [CLI, '--help']);
      measure(help, '--help');

      const printed = async (args) => {
        const result = await run(process.execPath, [CLI, ...args, '--out', 'o'], {
          cwd: work,
          maxBuffer: 64 << 20,
        }).catch((error) => error);
        await rm(path.join(work, 'o'), { recursive: true, force: true });
        return String(result.stderr ?? '');
      };

      // Every fixture, for the diagnostics: the hints are where the prose is.
      for (const name of recordings) measure(await printed([name]), name);
      // Every refusal the command line has, for the advice under each one.
      for (const args of refusals) measure(await printed(['tiny.edf', ...args]), args.join(' '));

      assert.deepEqual(problems, [], problems.join('\n'));
      assert.ok(continuations > 200, `only ${continuations} wrapped lines were measured`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('names every field the JSON calls something metadata.json calls something else', async () => {
    /*
      "Field names match `metadata.json` wherever the two describe the same thing, so a survey
      and a conversion can be read by the same code." Three of them do not:

          --json summary        metadata.json
          records               recording.data_records
          annotations           conversion.annotations_written
          warnings              notes

      Every one carries the same value — checked below rather than asserted — so somebody who
      took the sentence at its word and reached for `doc["notes"]` after reading a summary, or
      for `data_records` after reading one, gets a KeyError from a document that has the number
      under another name. The sentence is what was wrong, since the field names are published
      in tables on this page and moving one would break every reader that has them.

      The guard is in two halves. The values of the three pairs have to stay equal, because the
      mapping the page now prints is only useful while they describe the same thing. And a
      field appearing in the JSON that `metadata.json` has no name for at all must be one of
      the handful that genuinely has no counterpart — so a new field cannot slip in and quietly
      become a fourth mismatch.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-fields-'));
    try {
      const recordings = ['truncated.edf', 'annotations.edf', 'discontinuous.edf', 'records-backwards.edf'];
      const surveyOnly = new Set();
      const summaryOnly = new Set();

      const leaves = (value, into) => {
        if (Array.isArray(value)) for (const item of value) leaves(item, into);
        else if (value && typeof value === 'object') {
          for (const [key, item] of Object.entries(value)) {
            into.add(key);
            leaves(item, into);
          }
        }
        return into;
      };

      for (const name of recordings) {
        const source = path.join(ROOT, 'test/fixtures/generated', name);
        const out = path.join(work, name);
        const survey = JSON.parse((await run(process.execPath, [CLI, source, '--info', '--json'])).stdout);
        const summary = JSON.parse(
          (await run(process.execPath, [CLI, source, '--out', out, '--json'], { maxBuffer: 64 << 20 })).stdout,
        );
        const metadata = JSON.parse(await readFile(path.join(out, 'metadata.json'), 'utf8'));

        // The pairs the page now prints as a mapping, and the reason it can.
        assert.equal(summary.records, metadata.recording.data_records, `${name}: records`);
        assert.equal(
          summary.annotations,
          metadata.conversion.annotations_written,
          `${name}: annotations`,
        );
        assert.deepEqual(
          summary.warnings.map((w) => w.code),
          metadata.notes.map((n) => n.code),
          `${name}: warnings against notes`,
        );

        const named = leaves(metadata, new Set());
        for (const key of leaves(survey, new Set())) if (!named.has(key)) surveyOnly.add(key);
        for (const key of leaves(summary, new Set())) if (!named.has(key)) summaryOnly.add(key);
      }

      // What metadata.json genuinely has no name for: the channel table, which belongs to
      // channels.csv and uses its column names; the estimate, which describes a conversion
      // that has not happened; and the three facts about a run that has.
      assert.deepEqual(
        [...surveyOnly].sort(),
        ['column', 'digital_max', 'digital_min', 'estimate', 'exceeds_spreadsheet_limit',
          'first_sample_seconds', 'label', 'output_file', 'physical_max', 'physical_min',
          'prefiltering', 'samples_per_record', 'signal_index', 'time_span_seconds',
          'transducer', 'unit', 'warnings'].sort(),
        'a survey field has appeared that metadata.json has no name for',
      );
      assert.deepEqual(
        [...summaryOnly].sort(),
        ['annotations', 'elapsed_ms', 'output_dir', 'records', 'warnings'].sort(),
        'a summary field has appeared that metadata.json has no name for',
      );

      // And the page has to print the mapping, not a promise that there is none to print.
      const page = await read('website/content/cli-reference.md');
      assert.ok(
        !/Field names match `metadata\.json` wherever the two describe the same thing/u.test(page),
        'the page is back to claiming the names always match',
      );
      for (const phrase of ['recording.data_records', 'conversion.annotations_written', '`notes`']) {
        assert.ok(page.includes(phrase), `the JSON section does not map ${phrase}`);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('says where the time slice it recommends does not work', async () => {
    /*
      The same question as the pivot below, asked of the default layout.

          signals = pd.read_csv("sleep_csv/signals_100hz.csv", index_col="time_s")
          signals.loc[3600:3630]     # the 30 seconds starting one hour in

      A label slice needs the index to increase and to name one row, and the page said
      `time_s` "is an ordinary float index in seconds, which makes `.loc[start:stop]` a plain
      numeric slice" with nothing after it. Records stored out of chronological order make the
      column decrease — `KeyError: Cannot get right slice bound for non-monotonic index` — and
      records that overlap put one instant on two rows — `Cannot get left slice bound for
      non-unique label`. Both are recordings the conversion warns about, and the same page
      already spells this out for the `merge_asof` three sections down, for the sorting half
      of it only. The two slices above and below it said nothing.

      Checked in the wide layout, which is what those recipes read, and on the properties
      pandas actually requires rather than through pandas, which the suite does not have.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-slice-'));
    try {
      const names = (await readdir(path.join(ROOT, 'test/fixtures/generated'))).filter((f) =>
        /\.(edf|bdf)$/u.test(f),
      );
      assert.ok(names.length > 40, 'fixtures should be generated before this runs');

      const unsliceable = new Set();
      let tables = 0;
      for (const name of names) {
        const out = path.join(work, name);
        const result = await run(
          process.execPath,
          [CLI, path.join(ROOT, 'test/fixtures/generated', name), '--out', out],
          { maxBuffer: 64 << 20 },
        ).catch((error) => error);

        let written;
        try {
          written = (await readdir(out)).filter((f) => /^signals.*\.csv$/u.test(f));
        } catch {
          continue;
        }
        for (const file of written) {
          const rows = (await readFile(path.join(out, file), 'utf8')).trimEnd().split('\n');
          if (rows.length < 3) continue;
          tables++;

          /*
            Monotonicity, and deliberately not uniqueness. pandas slices a repeated label
            happily as long as the index is sorted — a channel sampling faster than the column
            can separate writes several rows at one instant and the slice returns all of them,
            which is right. It is the decrease that leaves pandas unable to find a bound, and
            an overlap raises the non-unique message only because it is out of order too.
          */
          const times = rows.slice(1).map((row) => Number(row.slice(0, row.indexOf(','))));
          if (!times.some((t, i) => i > 0 && t < times[i - 1])) continue;

          unsliceable.add(name);
          assert.match(
            String(result.stderr ?? ''),
            /^warning: /mu,
            `${name}/${file} cannot be sliced on time_s and the conversion said nothing`,
          );
        }
      }

      assert.ok(tables > 40, `only ${tables} signal tables were examined`);
      assert.deepEqual(
        [...unsliceable].sort(),
        ['records-backwards.edf', 'records-overlapping.edf'],
        'the set of recordings that cannot be sliced on time_s has changed',
      );

      // And the page that slices has to say when the slice raises, for both halves of it.
      const recipes = await read('website/content/recipes.md');
      assert.ok(recipes.includes('.loc[start:stop]'), 'the slice recipe is gone or reworded');
      for (const phrase of ['non-monotonic index', 'non-unique label']) {
        assert.ok(
          new RegExp(phrase.replace(/ /gu, '\\s+'), 'u').test(recipes),
          `recipes.md slices on time_s and does not say it can raise on a ${phrase}`,
        );
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it('says where the pivot it recommends does not work', async () => {
    /*
      Three pages hand the same call back for turning the long layout into a wide frame:

          wide = long.pivot(index='time_s', columns='channel', values='value')

      `pivot` needs the pair to name one sample, and two recordings do not manage it. A
      channel sampling faster than the time column can separate writes consecutive rows with
      the same `time_s`, and a recording whose data records overlap writes a later record over
      an earlier one's span. Both then have two rows sharing a time and a channel, and pandas
      answers with `ValueError: Index contains duplicate entries, cannot reshape` — not a wrong
      frame, an exception, on a one-line recipe offered as "one call away".

      The conversion already warns about both shapes, and the faster-than-the-column warning
      even gives the answer: tell those rows apart by position rather than by time. What was
      missing was any connection between the warning and the recipe, on any of the three pages
      that print it.

      The duplicate pairs are counted here rather than in pandas, which the suite does not
      have: the check is whether `time_s` and `channel` identify a row, which is the same
      question `pivot` asks.
    */
    const work = await mkdtemp(path.join(tmpdir(), 'edf2csv-pivot-'));
    try {
      const names = (await readdir(path.join(ROOT, 'test/fixtures/generated'))).filter((f) =>
        /\.(edf|bdf)$/u.test(f),
      );
      assert.ok(names.length > 40, 'fixtures should be generated before this runs');

      const breaks = [];
      let tables = 0;
      for (const name of names) {
        const out = path.join(work, name);
        const result = await run(
          process.execPath,
          [CLI, path.join(ROOT, 'test/fixtures/generated', name), '--out', out, '--layout', 'long'],
          { maxBuffer: 64 << 20 },
        ).catch((error) => error);
        let table;
        try {
          table = await readFile(path.join(out, 'signals.csv'), 'utf8');
        } catch {
          continue; // no signal table to reshape
        }
        tables++;

        const seen = new Set();
        let duplicated = false;
        for (const row of table.trimEnd().split('\n').slice(1)) {
          const first = row.indexOf(',');
          const last = row.lastIndexOf(',');
          const key = `${row.slice(0, first)} ${row.slice(first + 1, last)}`;
          if (seen.has(key)) {
            duplicated = true;
            break;
          }
          seen.add(key);
        }
        if (!duplicated) continue;

        breaks.push(name);
        // A reader who cannot pivot has to be able to find out why from the run itself.
        assert.match(
          String(result.stderr ?? ''),
          /^warning: /mu,
          `${name} has two rows sharing a time and a channel and the conversion said nothing`,
        );
      }

      assert.ok(tables > 40, `only ${tables} long tables were reshaped`);
      assert.deepEqual(
        breaks.sort(),
        ['records-overlapping.edf', 'repeating-fast.edf'],
        'the set of recordings that cannot be pivoted has changed',
      );

      // Every page that prints the recipe has to print the exception with it.
      const pages = ['cli-reference.md', 'faq.md', 'sampling-rates.md', 'output-files.md',
        'getting-started.md', 'recipes.md', 'edf-plus-annotations.md', 'correctness.md'];
      let offered = 0;
      for (const name of pages) {
        const page = await read(`website/content/${name}`);
        if (!page.includes('pivot(index=')) continue;
        offered++;
        // Whitespace-tolerant: the sentence is wrapped, and on one page the phrase spans
        // the break.
        assert.ok(
          /Index\s+contains\s+duplicate\s+entries/u.test(page),
          `${name} recommends pivot and does not say when it raises`,
        );
      }
      assert.equal(offered, 3, `expected three pages to show the pivot recipe, found ${offered}`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
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
