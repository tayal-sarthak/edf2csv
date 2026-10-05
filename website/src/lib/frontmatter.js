/*
  Frontmatter splitting, kept apart from the renderer that uses it.

  `markdown.js` imports `marked`, which is a dependency of the *website* and not of the
  package. Anything that reaches markdown.js therefore needs `website/node_modules`, and
  `docs-index.mjs` reached it for this function alone — for a dozen lines of regex that
  need nothing at all. That made a build script, and any test that ran it, dependent on
  an install the root `npm ci` does not do: the same failure that stopped 0.5.1 through
  0.5.12 publishing, and the reason `slug.js` is its own module.

  So this is the second dependency-free half of markdown.js. markdown.js re-exports it,
  the way it re-exports `slugify`, so nothing that already imports it from there changes.
*/

/** Splits `---` frontmatter off a Markdown document. Keys are flat strings. */
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
