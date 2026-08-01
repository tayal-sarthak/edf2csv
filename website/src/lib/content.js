import { marked } from 'marked';

/*
  Documentation lives as Markdown in website/content so it stays readable on its own,
  in an editor or on a repository page, without the site around it. Vite inlines the
  files at build time, so the published site is static with no fetch at runtime.
*/

const files = import.meta.glob('../../content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Pull the leading YAML-ish frontmatter block off a Markdown file. */
function splitFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw };

  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const value = pair[2].trim().replace(/^["'](.*)["']$/, '$1');
    meta[pair[1]] = value;
  }
  return { meta, body: raw.slice(match[0].length) };
}

marked.setOptions({ gfm: true, breaks: false });

export const pages = Object.entries(files)
  .map(([path, raw]) => {
    const slug = path.split('/').pop().replace(/\.md$/, '');
    const { meta, body } = splitFrontmatter(raw);
    return {
      slug,
      title: meta.title ?? slug,
      description: meta.description ?? '',
      order: Number(meta.order ?? 999),
      html: marked.parse(body),
    };
  })
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

export function pageBySlug(slug) {
  return pages.find((page) => page.slug === slug);
}

export function neighbours(slug) {
  const index = pages.findIndex((page) => page.slug === slug);
  return {
    previous: index > 0 ? pages[index - 1] : null,
    next: index >= 0 && index < pages.length - 1 ? pages[index + 1] : null,
  };
}
