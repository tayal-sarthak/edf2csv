/*
  Writes a small index of the documentation for the landing page to import.

  The documentation pages themselves are prerendered to static HTML, so the browser
  bundle has no reason to carry 37,000 words of Markdown. It needs the titles and
  descriptions for the sidebar and the card grid, and nothing else.
*/

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitFrontmatter } from '../src/lib/markdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = path.join(here, '..', 'content');
const OUT_FILE = path.join(here, '..', 'src', 'generated', 'docs-index.json');

export function readDocs() {
  return readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const raw = readFileSync(path.join(CONTENT_DIR, name), 'utf8');
      const { meta, body } = splitFrontmatter(raw);
      const slug = name.replace(/\.md$/, '');
      return {
        slug,
        title: meta.title ?? slug,
        description: meta.description ?? '',
        order: Number(meta.order ?? 999),
        body,
      };
    })
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

function main() {
  /*
    A build that indexed nothing is not a build with nothing to index.

    This writes the sidebar and the card grid, and it reported what it wrote — "docs-index: 11
    pages" — without ever asking whether that number was zero. An empty `content/`, a
    frontmatter split that stopped splitting, a directory read from the wrong place: each of
    them produces `[]`, a site whose documentation is missing entirely, and a CI job that goes
    green because `vite build` succeeded. The convention this repository applies to every other
    check that can measure nothing: a status meaning "did not run" must not be the status
    meaning "agreed".
  */
  const found = readDocs();
  if (found.length === 0) {
    process.stderr.write(
      `docs-index: no pages found in ${CONTENT_DIR}. The site would build without its ` +
        'documentation, so this stops here.\n',
    );
    process.exit(2);
  }
  const docs = found.map(({ slug, title, description, order }) => ({
    slug,
    title,
    description,
    order,
  }));

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(docs, null, 2)}\n`);
  console.log(`docs-index: ${docs.length} pages`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
