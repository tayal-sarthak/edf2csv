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
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { renderMarkdown, extractHeadings } from '../src/lib/markdown.js';
import { readDocs } from './docs-index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const DIST = path.join(ROOT, 'dist');

/**
 * The tool version this deploy was built beside, for SoftwareApplication.softwareVersion.
 * Read from the repository's own package.json, so it is true of the commit being built
 * rather than a number someone has to remember to update.
 */
const TOOL_VERSION = JSON.parse(
  readFileSync(path.join(ROOT, '..', 'package.json'), 'utf8'),
).version;

/**
 * When a page's Markdown last changed, from git, as an ISO timestamp.
 *
 * Google ignores <priority> and <changefreq> but does read <lastmod> — provided it is
 * accurate, which is why it comes from the commit history rather than from file mtimes
 * (a fresh checkout sets every mtime to the moment of cloning). Null when git is
 * unavailable or the history is too shallow to say, in which case the tag is omitted:
 * a missing date is honest, a made-up one teaches crawlers to distrust all of them.
 */
function lastModified(relativePath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cI', '--', relativePath], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

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
const NPM = 'https://www.npmjs.com/package/edf2csv';

/** The person behind the tool, for Article authorship and entity disambiguation. */
const AUTHOR = {
  '@type': 'Person',
  name: 'Sarthak Tayal',
  url: 'https://github.com/tayal-sarthak',
};

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
  const article = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: doc.title,
    description: doc.description,
    url: `${SITE_URL}/docs/${doc.slug}`,
    author: AUTHOR,
    image: `${SITE_URL}/og.png`,
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
  // Only when git can actually say. See lastModified for why absence beats invention.
  const modified = lastModified(`content/${doc.slug}.md`);
  if (modified) article.dateModified = modified;
  return article;
}

/**
 * Where the page sits: home, then the page. BreadcrumbList is one of the few schema
 * types still drawn as a rich result, and it costs two lines of true information.
 */
function breadcrumbs(doc) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'edf2csv', item: `${SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: doc.title, item: `${SITE_URL}/docs/${doc.slug}` },
    ],
  };
}

/**
 * The social-preview tags every page shares.
 *
 * One committed 1200x630 card rather than a generated-per-page image: the pages are
 * documentation, and eleven near-identical title cards would say less than one good
 * one. `summary_large_image` because a bare `summary` card with no image at all is
 * what a pasted link used to unfurl into.
 */
function socialImageTags() {
  return [
    `<meta property="og:image" content="${SITE_URL}/og.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="edf2csv: your recording, as numbers. npx edf2csv recording.edf" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${SITE_URL}/og.png" />`,
  ];
}

/**
 * The site footer, shared by the documentation pages and the 404.
 *
 * One string rather than two copies: the 404 had no footer at all, which is how it
 * ended up the one page with no way out to the repository, and a second literal is
 * how it would drift back out of step the next time the footer changes.
 */
const FOOTER = `<footer class="footer">
      <div class="shell footer__inner">
        <span>edf2csv is MIT licensed. It reads a file and writes files, nothing else.</span>
        <span class="footer__links"><a href="${REPO}" target="_blank" rel="noreferrer">GitHub</a><a href="${NPM}" target="_blank" rel="noreferrer">npm</a></span>
      </div>
    </footer>`;

/** Theme colour and icons, matched to what index.html declares statically. */
function chromeTags() {
  return [
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0e0d0b" />`,
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fcfbf9" />`,
    `<meta name="robots" content="max-image-preview:large" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
    `<link rel="manifest" href="/site.webmanifest" />`,
  ];
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

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(doc.title)} - edf2csv</title>
    <meta name="description" content="${escape(doc.description)}" />
    <link rel="canonical" href="${canonical}" />
    <!--
      The plain-Markdown mirror of this page, which the build has always written to
      /docs/<slug>.md and nothing ever pointed at. An agent or a reader who wants the
      prose without the HTML around it had to guess the URL existed.
    -->
    <link rel="alternate" type="text/markdown" href="${canonical}.md" title="${escape(doc.title)} as Markdown" />
    <meta name="color-scheme" content="dark light" />
    ${chromeTags().join('\n    ')}

    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escape(doc.title)} - edf2csv" />
    <meta property="og:description" content="${escape(doc.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:site_name" content="edf2csv" />
    ${socialImageTags().join('\n    ')}

    <link rel="preload" as="font" type="font/woff2" href="/fonts/SpaceGrotesk.woff2" crossorigin />
    <link rel="preload" as="font" type="font/woff2" href="/fonts/JetBrainsMono.woff2" crossorigin />
    <link rel="stylesheet" href="${assets.css}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <script>${THEME_SCRIPT}</script>
    <script type="application/ld+json">${JSON.stringify(structuredData(doc))}</script>
    <script type="application/ld+json">${JSON.stringify(breadcrumbs(doc))}</script>
    <script defer src="/_vercel/insights/script.js"></script>
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    <nav class="nav" data-scrolled="false">
      <div class="shell nav__inner">
        <a class="nav__brand" href="/">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 16h4l3-8 4 16 3-11 3 6h9" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          edf2csv
        </a>
        <div class="nav__links">
          <a href="/docs/getting-started">Docs</a>
          <a class="nav__hide-sm" href="/docs/cli-reference">CLI</a>
          <a class="nav__hide-sm" href="/docs/correctness">Correctness</a>
          <a href="${REPO}" target="_blank" rel="noreferrer">GitHub</a>
        </div>
      </div>
    </nav>

    <main class="shell docs" id="main">
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
        <p class="doc-source">
          Read this page as <a href="${canonical}.md">plain Markdown</a>, or the whole
          documentation as <a href="/llms-full.txt">one text file</a>.
        </p>
      </article>
    </main>

    ${FOOTER}
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
    <script defer src="/_vercel/insights/script.js"></script>
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    <nav class="nav"><div class="shell nav__inner">
      <a class="nav__brand" href="/">
        <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 16h4l3-8 4 16 3-11 3 6h9" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        edf2csv
      </a>
      <div class="nav__links">
          <a href="/docs/getting-started">Docs</a>
          <a class="nav__hide-sm" href="/docs/cli-reference">CLI</a>
          <a class="nav__hide-sm" href="/docs/correctness">Correctness</a>
          <a href="${REPO}" target="_blank" rel="noreferrer">GitHub</a>
      </div>
    </div></nav>
    <main class="shell not-found" id="main">
      <h1 class="section__title">That page is not here</h1>
      <p class="section__lede">The documentation is below, or start from the beginning.</p>
      <nav class="docs__nav docs__nav--static" aria-label="Documentation">
            ${links}
      </nav>
    </main>
    ${FOOTER}
  </body>
</html>
`;
}

/*
  The landing page is built by Vite from a static index.html, so its canonical link,
  structured data and prerendered markup are injected here, where the resolved site
  URL and the server-rendered HTML are known.

  The SoftwareApplication block describes what the tool is and where the source is.
  It deliberately carries no aggregateRating or downloadCount: inventing either would
  be fabricating social proof, and a wrong number is worse than no number.
*/
function enrichLandingPage(appHtml) {
  const file = path.join(DIST, 'index.html');
  let html = readFileSync(file, 'utf8');

  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': `${SITE_URL}/#software`,
        name: 'edf2csv',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux, Windows',
        description:
          'Command-line converter from EDF, EDF+ and BDF biosignal recordings to CSV. ' +
          'Runs locally, streams large files, and never resamples channels or alters units.',
        url: SITE_URL,
        image: `${SITE_URL}/og.png`,
        author: AUTHOR,
        codeRepository: REPO,
        installUrl: NPM,
        // The same project on the registry and on GitHub, so the three URLs resolve
        // to one entity instead of three lookalikes.
        sameAs: [REPO, NPM],
        softwareVersion: TOOL_VERSION,
        license: 'https://opensource.org/licenses/MIT',
        programmingLanguage: 'TypeScript',
        softwareRequirements: 'Node.js 20 or newer',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      },
      {
        '@type': 'WebSite',
        '@id': `${SITE_URL}/#website`,
        name: 'edf2csv',
        url: SITE_URL,
        about: { '@id': `${SITE_URL}/#software` },
      },
    ],
  };

  const head = [
    `<link rel="canonical" href="${SITE_URL}/" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="Convert EDF to CSV from the command line - edf2csv" />`,
    `<meta property="og:description" content="Convert EEG and biosignal files to CSV in one command. Works with EDF, EDF+ and BDF." />`,
    `<meta property="og:url" content="${SITE_URL}/" />`,
    `<meta property="og:site_name" content="edf2csv" />`,
    ...socialImageTags(),
    `<script type="application/ld+json">${JSON.stringify(graph)}</script>`,
  ].join('\n    ');

  html = html.replace('</head>', `  ${head}\n  </head>`);
  html = html.replace('<div id="root"></div>', `<div id="root">${appHtml}</div>`);
  writeFileSync(file, html);
}

/**
 * Server-render the landing page through Vite's SSR transform.
 *
 * The documentation pages have always been real HTML; this closes the one gap left.
 * Without it the homepage is an empty <div id="root"> to every crawler that does not
 * run JavaScript — which is most AI crawlers, on the site whose documentation was
 * deliberately prerendered for exactly those readers.
 */
async function renderLanding() {
  const vite = await createViteServer({
    root: ROOT,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  try {
    const { render } = await vite.ssrLoadModule('/src/entry-server.jsx');
    return render();
  } finally {
    await vite.close();
  }
}

/*
  <lastmod> only. Google states outright that it ignores <priority> and <changefreq>
  and reads <lastmod> when it proves accurate, so the two decorative tags are gone and
  the one that matters comes from commit history. A page whose date git cannot supply
  gets no tag rather than a guess.
*/
function sitemap(docs) {
  const urls = [
    /*
      The landing page's date comes from the landing page's own sources.

      It was the newest date across `content/*.md`, on the reasoning that the homepage is
      rebuilt whenever any page changes — but the homepage's text is not in `content/`. It
      is in Landing.jsx, and the 0.6.64 rewrite of the hero changed every visible sentence
      above the fold while touching no Markdown at all, so the sitemap would have gone on
      reporting a homepage last modified days earlier. A <lastmod> that is wrong in the
      "nothing changed" direction is the one kind that costs something: it tells a crawler
      not to bother re-reading a page that has been rewritten.
    */
    {
      loc: `${SITE_URL}/`,
      lastmod: [
        ...docs.map((doc) => lastModified(`content/${doc.slug}.md`)),
        lastModified('src/components/Landing.jsx'),
        lastModified('src/App.jsx'),
        lastModified('index.html'),
      ]
        .filter(Boolean)
        .sort()
        .at(-1),
    },
    ...docs.map((doc) => ({
      loc: `${SITE_URL}/docs/${doc.slug}`,
      lastmod: lastModified(`content/${doc.slug}.md`),
    })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map((url) => {
    const lastmod = url.lastmod ? `\n    <lastmod>${url.lastmod}</lastmod>` : '';
    return `  <url>\n    <loc>${url.loc}</loc>${lastmod}\n  </url>`;
  })
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

${docs.map((doc) => `- [${doc.title}](${SITE_URL}/docs/${doc.slug}.md): ${doc.description}`).join('\n')}

## Source

- [Repository](${REPO}): MIT licensed, zero runtime dependencies, requires Node 20 or newer.
- [Complete documentation as one file](${SITE_URL}/llms-full.txt): every page above, concatenated.
`;
}

/*
  The plain-Markdown mirror of every page, at /docs/<slug>.md.

  This is the part of the llms.txt proposal with real mechanical value. An agent or a
  person who fetches the .md URL gets the actual prose instead of HTML they have to
  strip. It is served by URL, never by sniffing the user agent, so everyone sees the
  same thing and there is no cloaking.
*/
function markdownMirror(doc) {
  return `# ${doc.title}

> ${doc.description}

Canonical HTML version: ${SITE_URL}/docs/${doc.slug}

${doc.body.trim()}
`;
}

/** The whole documentation set as one file, for pasting into a coding assistant. */
function llmsFullTxt(docs) {
  const header = `# edf2csv documentation

Complete documentation for edf2csv, a command-line converter from EDF, EDF+ and BDF
biosignal recordings to CSV. Source: ${REPO}

`;
  return (
    header +
    docs
      .map((doc) => `\n\n---\n\n# ${doc.title}\n\n> ${doc.description}\n\n${doc.body.trim()}\n`)
      .join('')
  );
}

/*
  A prerendered page that lost its content would look fine in a browser, because the
  landing bundle would still hydrate, while being an empty shell to every crawler.
  That is the exact failure this whole build step exists to prevent, so it is checked
  rather than assumed.
*/
function assertPagesHaveContent(docs, pages) {
  const MIN_WORDS = 150;
  const thin = [];
  for (const doc of docs) {
    const html = pages.get(doc.slug) ?? '';
    const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    if (words < MIN_WORDS) thin.push(`${doc.slug} (${words} words)`);
  }
  if (thin.length > 0) {
    throw new Error(
      `prerender: these pages rendered with almost no text, which would make them ` +
        `invisible to crawlers: ${thin.join(', ')}`,
    );
  }
}

const ROBOTS = `# edf2csv documentation. Indexing and citation are welcome.
User-agent: *
Allow: /

Sitemap: ${SITE_URL}/sitemap.xml
`;

async function main() {
  const assets = findAssets();
  const docs = readDocs().map((doc) => ({ ...doc, html: renderMarkdown(doc.body) }));

  const rendered = new Map();
  for (const doc of docs) {
    const dir = path.join(DIST, 'docs', doc.slug);
    mkdirSync(dir, { recursive: true });
    const html = page(doc, docs, assets);
    rendered.set(doc.slug, html);
    writeFileSync(path.join(dir, 'index.html'), html);
    // Plain Markdown alongside the HTML, at /docs/<slug>.md
    writeFileSync(path.join(DIST, 'docs', `${doc.slug}.md`), markdownMirror(doc));
  }

  assertPagesHaveContent(docs, rendered);

  // Held to the same standard as the documentation pages: if the server render ever
  // comes back as a stub, fail the build rather than ship a homepage only browsers see.
  const appHtml = await renderLanding();
  const landingWords = appHtml.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  if (landingWords < 150) {
    throw new Error(
      `prerender: the landing page server-rendered to ${landingWords} words, which would ` +
        `make the homepage invisible to crawlers that do not run JavaScript.`,
    );
  }

  enrichLandingPage(appHtml);
  writeFileSync(path.join(DIST, 'llms-full.txt'), llmsFullTxt(docs));
  writeFileSync(path.join(DIST, '404.html'), notFoundPage(docs, assets));
  writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap(docs));
  writeFileSync(path.join(DIST, 'robots.txt'), ROBOTS);
  writeFileSync(path.join(DIST, 'llms.txt'), llmsTxt(docs));

  console.log(
    `prerender: ${docs.length} pages + ${docs.length} markdown mirrors, ` +
      `landing (${landingWords} words), 404, sitemap, robots.txt, llms.txt, llms-full.txt`,
  );
  console.log(`prerender: site url ${SITE_URL}`);
}

await main();
