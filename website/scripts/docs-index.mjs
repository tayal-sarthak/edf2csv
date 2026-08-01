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
  const docs = readDocs().map(({ slug, title, description, order }) => ({
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
