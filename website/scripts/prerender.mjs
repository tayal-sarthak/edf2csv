/*
  Turns every documentation page into real static HTML at build time.

  A client-rendered app behind hash routes has exactly one URL as far as a crawler is
  concerned, so 37,000 words of documentation would be invisible to search engines and
  to the AI crawlers that answer questions like "how do I convert EDF to CSV". Each
  page here gets its own address, its own title and description, its own canonical
  link, and its full text present in the initial HTML with no JavaScript required.

  It also emits sitemap.xml, robots.txt, and llms.txt.
*/

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
/*
  Every release is described here, and the site linked it from nowhere. The documentation
  answers what the tool does now; a reader who wants to know when a flag arrived, or whether
  the version they installed has a fix, had the README's link or nothing — and the README is
  not on this site.
*/
const CHANGELOG = `${REPO}/blob/main/docs/CHANGELOG.md`;

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

/**
 * The theme control, for the pages React never runs on.
 *
 * Every prerendered page has honoured a saved theme since the script above was added, and
 * none of them could change it: the toggle lives in the React nav, which only the landing
 * page mounts. A reader arriving on the CLI reference from a search result — which is how
 * most people arrive at documentation — had to find their way to the homepage to switch,
 * and back again.
 *
 * Twelve lines of inline script rather than shipping React to eleven static pages. It
 * cycles the same three states in the same order and writes the same storage key, so the
 * two controls are the same control.
 */
/*
  All three glyphs ship, and CSS shows the one matching the current theme — see
  `.nav__toggle [data-glyph]` in the stylesheet. The script sets the attribute on <html>
  and the icon follows from it, so the icon needs no JavaScript of its own and cannot
  fall out of step with the theme the way a hand-updated one does: this button showed
  the same glyph in all three states for as long as it existed, which is one release.
*/
const THEME_TOGGLE = `<button type="button" class="nav__toggle" id="theme" aria-label="Switch to the light theme" title="Switch to the light theme">
            <svg data-glyph="auto" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" opacity="0.55"/></svg>
            <svg data-glyph="light" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" stroke-linecap="round"/></svg>
            <svg data-glyph="dark" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" stroke-linejoin="round"/></svg>
          </button>`;

const THEME_TOGGLE_SCRIPT = `(function(){
var b=document.getElementById('theme');if(!b)return;
var order={auto:'light',light:'dark',dark:'auto'};
var label={auto:'Match the system theme',light:'Switch to the light theme',dark:'Switch to the dark theme'};
function get(){try{return localStorage.getItem('edf2csv-theme')||'auto'}catch(e){return 'auto'}}
function sync(){var n=order[get()]||'light';b.setAttribute('aria-label',label[n]);b.title=label[n];}
b.addEventListener('click',function(){
var n=order[get()]||'light';
try{localStorage.setItem('edf2csv-theme',n)}catch(e){}
if(n==='auto')document.documentElement.removeAttribute('data-theme');
else document.documentElement.setAttribute('data-theme',n);
sync();});
sync();})();`;

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
  const alt = 'edf2csv: your recording, as numbers. npx edf2csv recording.edf';
  return [
    `<meta property="og:image" content="${SITE_URL}/og.png" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${alt}" />`,
    `<meta property="og:locale" content="en_US" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:image" content="${SITE_URL}/og.png" />`,
    /*
      X reads its own alt tag and does not fall back to the Open Graph one, so the card
      that carries the whole preview was the one image on this site with no description.
      Written once above and used by both, because two literals of the same sentence is
      how one of them ends up describing an image that has changed.
    */
    `<meta name="twitter:image:alt" content="${alt}" />`,
  ];
}

/**
 * The site header, shared by the documentation pages and the 404.
 *
 * It was written out twice, and the two copies had already drifted once: until 0.6.67 the
 * 404's version carried one link where the documentation pages carried four, and 0.6.92
 * had to add the theme toggle to both by hand. Same reasoning as FOOTER below — a second
 * literal is not a copy, it is a copy that will be older than the first one soon enough.
 *
 * `aria-label` because a documentation page has three <nav> landmarks — this, the page
 * list and the on-page contents — and the other two name themselves. A screen reader's
 * landmark list read "Documentation", "On this page", and one simply called "navigation".
 */
/**
 * A header link, marked when it is the page you are on.
 *
 * `aria-current="page"`, not `"true"`. Both are valid; `"page"` is the token defined for
 * "this is the current page in a set of pages", and a screen reader says "current page"
 * for it where `"true"` gets the generic "current item". The list of files on the landing
 * page keeps `"true"`, correctly: those are not pages.
 */
function headerLink(href, text, slug, className = '') {
  const current = href === `/docs/${slug}`;
  const classes = className ? ` class="${className}"` : '';
  return `<a${classes} href="${href}"${current ? ' aria-current="page"' : ''}>${text}</a>`;
}

/*
  Three of the header's links go to documentation pages, and the stylesheet has marked the
  current one since the header existed — `.nav__links a[aria-current]` — against markup that
  never set the attribute. So the rule matched nothing, and a reader on the CLI reference got
  a header identical to the one on every other page.
*/
const nav = (slug = '') => `<nav class="nav" data-scrolled="false" aria-label="Site">
      <div class="shell nav__inner">
        <a class="nav__brand" href="/">
          <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true"><path d="M3 16h4l3-8 4 16 3-11 3 6h9" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          edf2csv
        </a>
        <div class="nav__links">
          ${headerLink('/docs/getting-started', 'Docs', slug)}
          ${headerLink('/docs/cli-reference', 'CLI', slug, 'nav__hide-sm')}
          ${headerLink('/docs/correctness', 'Correctness', slug, 'nav__hide-sm')}
          <a href="${REPO}" target="_blank" rel="noreferrer">GitHub</a>
          ${THEME_TOGGLE}
        </div>
      </div>
    </nav>`;

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
        <span class="footer__links"><a href="${REPO}" target="_blank" rel="noreferrer">GitHub</a><a href="${NPM}" target="_blank" rel="noreferrer">npm</a><a href="${CHANGELOG}" target="_blank" rel="noreferrer">Changelog</a></span>
      </div>
    </footer>`;

/**
 * Vercel Web Analytics. Cookieless and aggregate; it records page views, not people, and
 * is inert until Analytics is enabled for the project in the dashboard.
 *
 * Written once and added to every page here, including the landing page. It used to sit in
 * index.html, where Vite tried to resolve it as a build input and said so on every single
 * build: "can't be bundled without type='module' attribute". It cannot be bundled at all —
 * Vercel serves it at request time and no build writes it — and a warning printed by every
 * green build is a warning nobody reads. It was also the last thing on this site written
 * out in three places by hand.
 */
const ANALYTICS = `<script defer src="/_vercel/insights/script.js"></script>`;

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
  /*
    Both levels, not just h2.

    The contents list showed h2s only, which suits a page whose h3s are subdivisions of
    an argument. It does not suit the reference pages, where the h3 *is* the entry: the
    warnings page is 13,000 words holding 42 of them, one per diagnostic code, and the
    reader who arrives having just seen INPUT_CHANGED in their terminal was offered a
    list of eleven section titles, none of which is the thing they came to look up.
  */
  const headings = extractHeadings(doc.body).filter((heading) => heading.level <= 3);

  const sidebar = docs
    .map(
      (entry) =>
        `<a class="docs__link" href="/docs/${entry.slug}"${
          entry.slug === doc.slug ? ' aria-current="page"' : ''
        }>${escape(entry.title)}</a>`,
    )
    .join('\n          ');

  const toc = headings.length
    ? `<nav class="docs__toc" aria-label="On this page">
            <span class="docs__toc-title">On this page</span>
            ${headings
              .map(
                (heading) =>
                  `<a href="#${heading.id}" data-level="${heading.level}">${escape(heading.text)}</a>`,
              )
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
    ${ANALYTICS}
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    ${nav(doc.slug)}

    <main class="shell docs" id="main">
      <nav class="docs__nav" aria-label="Documentation">
          ${sidebar}
      </nav>

      <article class="prose">
        <!--
          Where this page sits in the sequence. The sidebar lists eleven titles and the
          footer offers the next one, but nothing said the documentation is an ordered
          set or how much of it is left — the same information the breadcrumb structured
          data has been giving crawlers since 0.6.62, given to the reader.
        -->
        <p class="prose__where">Documentation<span aria-hidden="true"> / </span>${index + 1} of ${docs.length}</p>
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
    <script>${THEME_TOGGLE_SCRIPT}</script>
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
    <!--
      noindex here rather than the shared max-image-preview value: this page has no
      content of its own to preview, and it is the one page that must never be indexed.
    -->
    <meta name="robots" content="noindex" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0e0d0b" />
    <meta name="theme-color" media="(prefers-color-scheme: light)" content="#fcfbf9" />
    <link rel="preload" as="font" type="font/woff2" href="/fonts/SpaceGrotesk.woff2" crossorigin />
    <link rel="preload" as="font" type="font/woff2" href="/fonts/JetBrainsMono.woff2" crossorigin />
    <link rel="stylesheet" href="${assets.css}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="manifest" href="/site.webmanifest" />
    <script>${THEME_SCRIPT}</script>
    ${ANALYTICS}
  </head>
  <body>
    <a class="skip" href="#main">Skip to content</a>
    ${nav()}
    <main class="shell not-found" id="main">
      <h1 class="section__title">That page is not here</h1>
      <p class="section__lede">The documentation is below, or start from the beginning.</p>
      <nav class="docs__nav docs__nav--static" aria-label="Documentation">
            ${links}
      </nav>
    </main>
    ${FOOTER}
    <script>${THEME_TOGGLE_SCRIPT}</script>
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
    ANALYTICS,
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
        /*
          The whole of `src`, not three files named by hand.

          Naming them is what went wrong the first time and it went wrong again: the list was
          Landing.jsx, App.jsx and index.html, and the homepage is also styles.css, Waveform,
          PhosphorScope, RateComparison and Nav. 0.6.140 changed the stylesheet and nothing
          else, so the date reported for the homepage that day was the newest documentation
          page's — older than the change, which is the direction that tells a crawler not to
          bother. A directory cannot fall behind the files added to it.
        */
        lastModified('src'),
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
  return `# edf2csv ${TOOL_VERSION}

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
- [Changelog](${CHANGELOG}): every release, what it changed and why.
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
  /*
    The version, for the same reason llms-full.txt carries one since 0.6.83.

    A mirror is fetched precisely so it can be kept: pasted into a conversation, cached
    by an agent, saved beside a script. The HTML page it mirrors states the version in
    its structured data and links a changelog; the Markdown copy stated neither, so a
    reader holding one had no way to tell which release's flags they were reading.
  */
  return `# ${doc.title}

> ${doc.description}

edf2csv ${TOOL_VERSION}. Canonical HTML version: ${SITE_URL}/docs/${doc.slug}

${doc.body.trim()}
`;
}

/** The whole documentation set as one file, for pasting into a coding assistant. */
function llmsFullTxt(docs) {
  /*
    The version this file documents, stated in the file.

    It is 6,400 lines of flag names, exit codes and JSON field names pasted into
    conversations and context windows, where it can outlive the release it describes by
    a long way. Without a version on it, a reader — human or otherwise — has no way to
    tell whether the `--layout` flag it documents existed in the copy they installed.
    The same number the site's structured data reports, from package.json at build.
  */
  const header = `# edf2csv documentation

Complete documentation for edf2csv ${TOOL_VERSION}, a command-line converter from EDF, EDF+
and BDF biosignal recordings to CSV. Source: ${REPO}

This file is generated from the documentation at ${SITE_URL}/docs, which is canonical. If
the two disagree, the site is newer.

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

/**
 * No page repeats an id, and every same-page anchor points at one that exists.
 *
 * 0.6.87 fixed two headings sharing `no_samples`, which had been shipping for as long as
 * both had existed: duplicate ids do not throw, do not 404 and do not look wrong — the
 * browser scrolls to whichever came first, so the reader lands on a real paragraph that
 * is not the one they asked for. That is precisely the failure a person proof-reading a
 * page will not notice, and precisely the one a build can settle in a few lines.
 */
function assertAnchorsResolve(pages) {
  const problems = [];
  for (const [name, html] of pages) {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    for (const id of new Set(ids)) {
      const count = ids.filter((other) => other === id).length;
      if (count > 1) problems.push(`${name}: id "${id}" appears ${count} times`);
    }
    const present = new Set(ids);
    for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) {
      if (!present.has(target)) problems.push(`${name}: #${target} matches no element`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`prerender: broken anchors:\n  ${problems.join('\n  ')}`);
  }
}

/**
 * Every internal link in the emitted HTML resolves to something the build wrote.
 *
 * The prerenderer hand-writes links that no test reads: the header, the footer, the
 * skip target, the 404's list, and the Markdown-mirror line added in 0.6.68. A typo in
 * any of them is a 404 that nothing catches — the pages still build, still pass their
 * word count, and still look right in the one browser anybody checks. Cheap to verify
 * from the file listing the build has just produced, so it is verified.
 */
function assertLinksResolve(pages, emitted) {
  const broken = [];
  for (const [name, html] of pages) {
    for (const [, href] of html.matchAll(/(?:href|src)="(\/[^"#?]*)(?:[#?][^"]*)?"/g)) {
      // Vercel injects the analytics script at request time; no build writes it.
      if (href.startsWith('/_vercel/')) continue;
      const relative = href.replace(/^\//, '').replace(/\/$/, '');
      // A directory URL is served by the index.html inside it, and "/" by the root one.
      const candidates = relative
        ? [relative, `${relative}/index.html`]
        : ['index.html'];
      if (!candidates.some((candidate) => emitted.has(candidate))) {
        broken.push(`${name} -> ${href}`);
      }
    }
  }
  if (broken.length > 0) {
    throw new Error(`prerender: these links point at files the build did not write:\n  ${broken.join('\n  ')}`);
  }
}

/** Everything under dist/, relative and slash-separated, for the link check. */
function emittedFiles(dir, base = DIST) {
  const out = new Set();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const nested of emittedFiles(full, base)) out.add(nested);
    else out.add(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
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

  /*
    The parts of the homepage a crawler is actually read for.

    A word count catches a render that collapsed to nothing, and nothing else. It would
    pass a homepage that lost its h1, or whose lede reverted to placeholder text, or which
    rendered five sections as four — all of which are the failure this step exists to
    prevent, just short of total. These are the elements the SEO work put there on purpose,
    so they are the ones worth asserting rather than hoping about.
  */
  const required = [
    ['an <h1>', /<h1[^>]*>/],
    ['the one-sentence lede', /Convert EEG and biosignal files to CSV in one command\./],
    ['the install command', /npx edf2csv recording\.edf/],
    ['a link into the documentation', /href="\/docs\/getting-started"/],
  ];
  const missing = required.filter(([, pattern]) => !pattern.test(appHtml)).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `prerender: the server-rendered homepage is missing ${missing.join(', ')}. ` +
        `A crawler that does not run JavaScript sees only what this render produced.`,
    );
  }

  enrichLandingPage(appHtml);
  writeFileSync(path.join(DIST, 'llms-full.txt'), llmsFullTxt(docs));
  writeFileSync(path.join(DIST, '404.html'), notFoundPage(docs, assets));
  writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap(docs));
  writeFileSync(path.join(DIST, 'robots.txt'), ROBOTS);
  writeFileSync(path.join(DIST, 'llms.txt'), llmsTxt(docs));

  // Last, so it sees every file the build produced, including the ones just written.
  const emitted = emittedFiles(DIST);
  const finished = [
    ['index.html', readFileSync(path.join(DIST, 'index.html'), 'utf8')],
    ['404.html', readFileSync(path.join(DIST, '404.html'), 'utf8')],
    ...docs.map((doc) => [`docs/${doc.slug}`, rendered.get(doc.slug) ?? '']),
  ];
  assertLinksResolve(finished, emitted);
  assertAnchorsResolve(finished);

  console.log(
    `prerender: ${docs.length} pages + ${docs.length} markdown mirrors, ` +
      `landing (${landingWords} words), 404, sitemap, robots.txt, llms.txt, llms-full.txt`,
  );
  console.log(`prerender: site url ${SITE_URL}`);
}

await main();
