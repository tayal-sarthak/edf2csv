# edf2csv website

The documentation site for edf2csv, and the documentation itself.

## Layout

```text
website/
├── content/          the documentation, as Markdown
├── public/
│   ├── fonts/        Space Grotesk and JetBrains Mono, self-hosted and subset
│   ├── og.png        the 1200x630 social-preview card
│   ├── favicon.svg   and apple-touch-icon.png
│   └── site.webmanifest
├── scripts/          docs-index.mjs and prerender.mjs, which build the static pages
├── src/              the landing page, its components and the shared stylesheet
└── dist/             build output, gitignored
```

The Markdown in `content/` is the documentation. It's written to be readable on its
own, in an editor or on a repository page, without the site around it. Each file
carries frontmatter with a title, a one-line description and a sort order:

```markdown
---
title: Getting started
description: Convert a recording to CSV with one command
order: 1
---
```

Adding a page is a matter of dropping a new `.md` file in `content/` with that
frontmatter. It appears in the sidebar and on the landing page automatically, in
`order` sequence. Nothing else needs editing.

## Running it

```bash
npm install
npm run dev
```

```bash
npm run build
```

The build writes static files to `dist/`, and they must be served from a domain
root. The base path is absolute (`base: '/'` in `vite.config.js`) because the
documentation is prerendered into `/docs/<slug>/`, and a relative base would send
those pages looking for `/docs/<slug>/assets/...` instead. Served from a subpath —
a GitHub Pages project site at `/edf2csv/`, say — every asset reference 404s and
the page renders blank. Deploying there means rebuilding with a matching `base`.

## Notes on the build

Documentation is inlined into the bundle at build time rather than fetched at
runtime. That makes moving between pages instant and the deploy a plain pile of
static files with no API behind it, at the cost of a larger initial download. The
libraries are split into their own chunk so editing a page doesn't invalidate them
in anyone's cache.

## What the build refuses to ship

`scripts/prerender.mjs` stops the build rather than emitting a page that is quietly wrong.
Each of these exists because the failure it catches is invisible in a browser:

- A documentation page that rendered with almost no text, or a landing page missing its
  heading, its one-sentence lede, the install command or a link into the documentation.
  A page that lost its content still looks fine to anyone whose browser runs the bundle.
- An internal link pointing at a file the build did not write. The links in the template —
  the header, the footer, the skip target, the 404's list — are the ones no test reads back.
- An id used twice on one page, or an `href="#..."` matching no element. Neither throws
  and neither 404s; the browser simply scrolls to the wrong paragraph.
- A `url(#...)` matching no element. SVG reaches a gradient, mask, clip path, filter or
  marker that way rather than through an href, so the check above does not see them, and
  this is the quietest failure of the set: nothing throws, nothing 404s, and the property
  simply resolves to none. The hero's edge fade is one — mistype it and the traces stop
  looking like they continue past the border, which you have to already know to notice.

The `/docs/<slug>.md` mirrors and `llms-full.txt` are served with `X-Robots-Tag: noindex`
(see the repository root's `vercel.json`). They are the same prose as the HTML pages they
sit beside, at a second address, and a plain-text file has no way to declare a canonical
link — so left indexable they would compete with the pages they mirror. `llms-full.txt` is
the strongest case of all: it is every page at once, over 400 kB of it. The header keeps them
fetchable by anyone who asks, which is the reason they exist, while leaving one indexable
copy of each page. `llms.txt` stays indexable — it is a 3 kB index of the site rather than
a copy of it.

Every page is real HTML before JavaScript arrives. The documentation is prerendered
by `scripts/prerender.mjs`, and the landing page is server-rendered through Vite's
SSR transform (`src/entry-server.jsx`) and hydrated in the browser. Google runs
JavaScript; most of the AI crawlers that answer "how do I convert EDF to CSV" do
not, and before this they saw an empty homepage. The prerenderer also emits the
sitemap (with `lastmod` read from git, the one field Google actually uses), the
social-preview tags pointing at `public/og.png`, and the structured data — a
SoftwareApplication entity on the landing page, TechArticle plus BreadcrumbList on
each documentation page. None of it carries ratings, download counts or any other
number the project cannot back.

Every terminal block and CSV sample on the landing page is real output, captured from
the tool running against a synthetic recording. There are no mocked screenshots.

## Design

Amber on warm near-black, borrowed from an oscilloscope rather than from the usual
cool-blue developer-tool palette, since the subject is biosignals. One accent colour,
one corner radius scale, one theme at a time. Light and dark both ship, following the
system preference unless the reader overrides it from the header.

Motion is used where it explains something: the hero trace animates because the tool
turns a continuous signal into rows of numbers, and the sampling-rate comparison
animates because watching 765 values appear out of nowhere makes the point faster
than a sentence does. The rest of the page does not fade in on scroll — it used to,
and a page where every heading rises into place is indistinguishable from every
other page where every heading rises into place. Content is simply there; motion is
reserved for the two visuals that argue something and for interaction feedback. The
hero's entrance is CSS rather than JavaScript so the prerendered title is visible
the instant the HTML paints. Everything collapses to static under
`prefers-reduced-motion: reduce`.
