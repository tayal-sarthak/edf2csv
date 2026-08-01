/*
  Turns every documentation page into real static HTML at build time.

  A client-rendered app behind hash routes has exactly one URL as far as a crawler is
  concerned, so 37,000 words of documentation would be invisible to search engines and
  to the AI crawlers that answer questions like "how do I convert EDF to CSV". Each
  page here gets its own address, its own title and description, its own canonical
  link, and its full text present in the initial HTML with no JavaScript required.

  It also emits sitemap.xml, robots.txt, and llms.txt.
*/

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown, extractHeadings } from '../src/lib/markdown.js';
import { readDocs } from './docs-index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const DIST = path.join(ROOT, 'dist');

/**
 * Vercel exposes the production domain during a build, so canonical links and the
 * sitemap are correct without anyone hardcoding a hostname.
 */
const SITE_URL = (
  process.env.SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'https://edf2csv.vercel.app')
).replace(/\/$/, '');

const REPO = 'https://github.com/tayal-sarthak/edf2csv';

const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** The built CSS filename is content-hashed, so read it back out of the built index.html. */
function findAssets() {
  const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const css = /href="\.?\/?(assets\/[^"]+\.css)"/.exec(html)?.[1];
  if (!css) throw new Error('prerender: could not find the built stylesheet in dist/index.html');
  return { css: `/${css}` };
}

/** Restores the reader's theme before first paint, so a dark-mode reader never sees a white flash. */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('edf2csv-theme');if(t&&t!=='auto')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

function structuredData(doc) {
  return {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: doc.title,
    description: doc.description,
    url: `${SITE_URL}/docs/${doc.slug}`,
    isPartOf: {
      '@type': 'WebSite',
      name: 'edf2csv documentation',
      url: SITE_URL,
    },
    about: {
      '@type': 'SoftwareApplication',
      name: 'edf2csv',
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS, Linux, Windows',
      description:
        'Command-line converter from EDF, EDF+ and BDF biosignal recordings to CSV.',
      license: 'https://opensource.org/licenses/MIT',
      codeRepository: REPO,
    },
    license: 'https://opensource.org/licenses/MIT',
  };
}

function page(doc, docs, assets) {
  const index = docs.findIndex((entry) => entry.slug === doc.slug);
  const previous = index > 0 ? docs[index - 1] : null;
  const next = index < docs.length - 1 ? docs[index + 1] : null;
  const headings = extractHeadings(doc.body).filter((heading) => heading.level === 2);

  const sidebar = docs
    .map(
      (entry) =>
        `<a class="docs__link" href="/docs/${entry.slug}"${
          entry.slug === doc.slug ? ' aria-current="true"' : ''
        }>${escape(entry.title)}</a>`,
    )
    .join('\n          ');

  const toc = headings.length
    ? `<nav class="docs__toc" aria-label="On this page">
            <span class="docs__toc-title">On this page</span>
            ${headings
              .map((heading) => `<a href="#${heading.id}">${escape(heading.text)}</a>`)
              .join('\n            ')}
          </nav>`
    : '';

  const canonical = `${SITE_URL}/docs/${doc.slug}`;
  const jsonLd = JSON.stringify(structuredData(doc));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(doc.title)} - edf2csv</title>
    <meta name="description" content="${escape(doc.description)}" />
    <link rel="canonical" href="${canonical}" />
    <meta name="color-scheme" content="dark light" />

    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escape(doc.title)} - edf2csv" />
    <meta property="og:description" content="${escape(doc.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:site_name" content="edf2csv" />
    <meta name="twitter:card" content="summary" />

    <link rel="preload" as="font" type="font/woff2" href="/fonts/SpaceGrotesk.woff2" crossorigin />
    <link rel="preload" as="font" type="font/woff2" href="/fonts/JetBrainsMono.woff2" crossorigin />
    <link rel="stylesheet" href="${assets.css}" />
    <link rel="icon" href="/favicon.svg" />
    <script>${THEME_SCRIPT}</script>
    <script type="application/ld+json">${jsonLd}</script>
  </head>
  <body>
    <nav class="nav" data-scrolled="false">
      <div class="shell nav__inner">
        <a class="nav__brand" href="/">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 16h4l3-8 4 16 3-11 3 6h9" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          edf2csv
        </a>
        <div class="nav__links">
          <a href="/docs/getting-started" aria-current="true">Docs</a>
          <a class="nav__hide-sm" href="/docs/cli-reference">CLI</a>
          <a class="nav__hide-sm" href="/docs/correctness">Correctness</a>
          <a href="${REPO}" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </div>
    </nav>

    <main class="shell docs">
      <nav class="docs__nav" aria-label="Documentation">
          ${sidebar}
      </nav>

      <article class="prose">
        <h1>${escape(doc.title)}</h1>
        ${doc.description ? `<p class="prose__lede">${escape(doc.description)}</p>` : ''}
        ${toc}
${doc.html}
        <div class="doc-footer">
          ${previous ? `<a href="/docs/${previous.slug}">&larr; ${escape(previous.title)}</a>` : '<span></span>'}
          ${next ? `<a href="/docs/${next.slug}">${escape(next.title)} &rarr;</a>` : '<span></span>'}
        </div>
      </article>
    </main>

    <footer class="footer">
      <div class="shell footer__inner">
        <span>edf2csv is MIT licensed. It reads a file and writes files, nothing else.</span>
        <span><a href="${REPO}" target="_blank" rel="noreferrer">GitHub</a></span>
      </div>
    </footer>
  </body>
</html>
`;
}

/*
  A real 404 rather than a rewrite that serves the landing page at every wrong URL.
  A catch-all rewrite turns typos and dead links into soft 404s, which search engines
  treat as duplicate content and which hide broken links from whoever made them.
*/
function notFoundPage(docs, assets) {
  const links = docs
    .map((doc) => `<a class="docs__link" href="/docs/${doc.slug}">${escape(doc.title)}</a>`)
    .join('\n            ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page not found - edf2csv</title>
    <meta name="robots" content="noindex" />
    <meta name="color-scheme" content="dark light" />
    <link rel="stylesheet" href="${assets.css}" />
    <link rel="icon" href="/favicon.svg" />
    <script>${THEME_SCRIPT}</script>
  </head>
  <body>
    <nav class="nav"><div class="shell nav__inner">
      <a class="nav__brand" href="/">
        <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 16h4l3-8 4 16 3-11 3 6h9" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        edf2csv
      </a>
      <div class="nav__links"><a href="/docs/getting-started">Docs</a></div>
    </div></nav>
    <main class="shell" style="padding-block: 5rem 6rem; max-width: 720px;">
      <h1 class="section__title">That page is not here</h1>
      <p class="section__lede">The documentation is below, or start from the beginning.</p>
      <nav class="docs__nav" style="position: static;">
            ${links}
      </nav>
    </main>
  </body>
</html>
`;
}

function sitemap(docs) {
  const urls = [
    { loc: `${SITE_URL}/`, priority: '1.0' },
    ...docs.map((doc) => ({ loc: `${SITE_URL}/docs/${doc.slug}`, priority: '0.8' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((url) => `  <url>\n    <loc>${url.loc}</loc>\n    <priority>${url.priority}</priority>\n  </url>`)
  .join('\n')}
</urlset>
`;
}

function llmsTxt(docs) {
  return `# edf2csv

> Command-line converter from EDF, EDF+ and BDF biosignal recordings (EEG, sleep, ECG, EMG) to CSV. Runs locally with no network access, streams so memory does not grow with recording length, and never resamples channels or alters units.

Install and run with no permanent install:

\`\`\`bash
npx edf2csv recording.edf
\`\`\`

Key behaviour that distinguishes it from general purpose biosignal libraries:

- Channels recorded at different sampling rates are written to separate CSV files rather than being resampled onto a common grid. A 1 Hz channel in a 3 second recording produces 3 rows, not 768 interpolated values.
- EDF+D discontinuous recordings keep their real timing, so gaps appear as jumps in the time column rather than being closed up.
- Physical values are bit-for-bit identical to pyEDFlib on the recordings used for testing.
- Units are never converted. Microvolts stay microvolts.
- Malformed, truncated or self-contradicting files are reported in plain language rather than producing plausible looking wrong output.

## Documentation

${docs.map((doc) => `- [${doc.title}](${SITE_URL}/docs/${doc.slug}): ${doc.description}`).join('\n')}

## Source

- [Repository](${REPO}): MIT licensed, zero runtime dependencies, requires Node 20 or newer.
`;
}

const ROBOTS = `# edf2csv documentation. Indexing and citation are welcome.
User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0E0D0B"/><path d="M4 16h4l3-8 4 16 3-11 3 6h7" fill="none" stroke="#FFB020" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
`;

function main() {
  const assets = findAssets();
  const docs = readDocs().map((doc) => ({ ...doc, html: renderMarkdown(doc.body) }));

  for (const doc of docs) {
    const dir = path.join(DIST, 'docs', doc.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), page(doc, docs, assets));
  }

  writeFileSync(path.join(DIST, '404.html'), notFoundPage(docs, assets));
  writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap(docs));
  writeFileSync(path.join(DIST, 'robots.txt'), ROBOTS);
  writeFileSync(path.join(DIST, 'llms.txt'), llmsTxt(docs));
  writeFileSync(path.join(DIST, 'favicon.svg'), FAVICON);

  console.log(`prerender: ${docs.length} documentation pages, 404, sitemap, robots.txt, llms.txt`);
  console.log(`prerender: site url ${SITE_URL}`);
}

main();
