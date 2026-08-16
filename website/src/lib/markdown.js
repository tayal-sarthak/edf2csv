/*
  Markdown helpers shared by the browser bundle and the build scripts.

  Nothing here touches the DOM or Vite-specific APIs, so the prerenderer can import
  it under plain Node and produce exactly the same HTML the app would.
*/

import { marked } from 'marked';
import { highlight } from './highlight.js';
import { slugify } from './slug.js';

export { slugify };

marked.setOptions({ gfm: true, breaks: false });

/** Pull the leading frontmatter block off a Markdown file. */
export function splitFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    meta[pair[1]] = pair[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return { meta, body: raw.slice(match[0].length) };
}



const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * A slugifier that keeps ids unique within one document.
 *
 * Two headings can legitimately carry the same text: `NO_SAMPLES` is documented twice on
 * the warnings page, once as the warning a single empty channel raises and once as the
 * fatal error an entirely empty recording raises, and the page explains the distinction
 * in prose between them. Both became `id="no_samples"` — invalid HTML, and worse than
 * invalid, silently wrong: the contents entry for the fatal error scrolled to the
 * warning, and after 0.6.84 the permalink beside the second heading handed out a link
 * to the first.
 *
 * The first occurrence keeps the plain slug, so every link that already points at one
 * still lands where it did. Repeats are numbered.
 */
export function makeSlugger() {
  const used = new Map();
  return (text) => {
    const base = slugify(text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  };
}

/**
 * Render Markdown to the HTML the site ships: heading anchors applied and fenced
 * code already tokenised, so no client-side pass is needed to make a page readable.
 */
export function renderMarkdown(body) {
  let html = marked.parse(body);

  /*
    Headings get an id and a link to it.

    The ids have been there since the table of contents was added, and every warning
    code and flag on this site is addressable by one — but the only way to obtain the
    URL was to read the source or find the heading in the contents list at the top.
    Linking a colleague to the paragraph about a specific diagnostic is most of what
    reference documentation is for.

    The anchor is aria-hidden and out of the tab order: it duplicates a destination the
    heading itself already provides to anyone reading in order, so announcing eleven
    more "link, permalink" stops per page would cost more than it gives.
  */
  // The same slugger the table of contents uses, walking the same headings in the same
  // order, so the two cannot disagree about which heading is the numbered one.
  const slug = makeSlugger();
  html = html.replace(/<(h[23])>([\s\S]*?)<\/\1>/g, (_whole, tag, inner) => {
    const id = slug(decodeEntities(inner.replace(/<[^>]+>/g, '')));
    const anchor = `<a class="prose__anchor" href="#${id}" aria-hidden="true" tabindex="-1">#</a>`;
    return `<${tag} id="${id}">${inner}${anchor}</${tag}>`;
  });

  html = html.replace(
    /<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_whole, language, escaped) => {
      const source = decodeEntities(escaped);
      const cls = language ? ` class="language-${language}"` : '';
      return `<pre><code${cls} data-highlighted="true">${highlight(source, language ?? 'text')}</code></pre>`;
    },
  );

  /*
    `scope="col"` on header cells, which marked does not emit.

    The reference pages are mostly tables — every flag, every diagnostic code, every
    exit status — and a table whose headers claim no direction leaves a screen reader
    to guess which cells they govern. Every table here is the same shape, a single
    header row across the top, so the answer is always "the column below".
  */
  html = html.replaceAll('<th>', '<th scope="col">');

  return html;
}

/**
 * Headings for an on-page table of contents.
 *
 * Fenced code is skipped, because a `##` at the start of a line inside a fence is a comment
 * in half the languages this documentation quotes and a heading in none of them. Reading it
 * as one put a shell comment in the contents list, and — since this walk feeds a slugger that
 * numbers repeats — shifted the numbering for everything after it: a page with two `## Flags`
 * sections and a `## Flags` comment between them listed `flags`, `flags-2` and `flags-3` while
 * the page itself carried `flags` and `flags-2`, so the entry for the second section pointed at
 * nothing and the entry for the comment pointed at the second section. The same failure 0.6.87
 * fixed inside a page, arriving from the one heading walk that is not marked's.
 *
 * No page has such a line today, which is the only reason this has never shipped visibly, and
 * the build's anchor check would refuse it — after someone had written it.
 */
export function extractHeadings(body) {
  const headings = [];
  const slug = makeSlugger();
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    // Up to three spaces of indent, ``` or ~~~, per CommonMark.
    if (/^ {0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{2,3})\s+(.*)$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/`/g, '').trim();
    headings.push({ level: match[1].length, text, id: slug(text) });
  }
  return headings;
}
