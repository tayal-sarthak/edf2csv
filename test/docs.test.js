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
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

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

    const summary = /ℹ tests (\d+)/u.exec(page);
    assert.ok(summary, 'the runner summary is gone from the page');
    assert.equal(Number(summary[1]), total, `the summary and the table disagree`);
    assert.match(page, new RegExp(`The ${total} tests are split`, 'u'), 'the prose disagrees too');
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
