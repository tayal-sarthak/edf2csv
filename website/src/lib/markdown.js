/*
  Markdown helpers shared by the browser bundle and the build scripts.

  Nothing here touches the DOM or Vite-specific APIs, so the prerenderer can import
  it under plain Node and produce exactly the same HTML the app would.
*/

import { marked } from 'marked';
import { highlight } from './highlight.js';

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

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function decodeEntities(value) {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

/**
 * Render Markdown to the HTML the site ships: heading anchors applied and fenced
 * code already tokenised, so no client-side pass is needed to make a page readable.
 */
export function renderMarkdown(body) {
  let html = marked.parse(body);

  html = html.replace(/<(h[23])>([\s\S]*?)<\/\1>/g, (_whole, tag, inner) => {
    const id = slugify(decodeEntities(inner.replace(/<[^>]+>/g, '')));
    return `<${tag} id="${id}">${inner}</${tag}>`;
  });

  html = html.replace(
    /<pre><code(?: class="language-([\w-]+)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_whole, language, escaped) => {
      const source = decodeEntities(escaped);
      const cls = language ? ` class="language-${language}"` : '';
      return `<pre><code${cls} data-highlighted="true">${highlight(source, language ?? 'text')}</code></pre>`;
    },
  );

  return html;
}

/** Headings for an on-page table of contents. */
export function extractHeadings(body) {
  const headings = [];
  for (const line of body.split(/\r?\n/)) {
    const match = /^(#{2,3})\s+(.*)$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/`/g, '').trim();
    headings.push({ level: match[1].length, text, id: slugify(text) });
  }
  return headings;
}
