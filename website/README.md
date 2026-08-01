# edf2csv website

The documentation site for edf2csv, and the documentation itself.

## Layout

```text
website/
├── content/          the documentation, as Markdown
├── public/fonts/     Space Grotesk and JetBrains Mono, self-hosted
├── src/              the site
└── dist/             build output, gitignored
```

The Markdown in `content/` is the documentation. It is written to be readable on its
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

The build writes static files to `dist/`, with a relative base path, so it can be
served from a domain root or from a subpath such as GitHub Pages without changes.

## Notes on the build

Documentation is inlined into the bundle at build time rather than fetched at
runtime. That makes moving between pages instant and the deploy a plain pile of
static files with no API behind it, at the cost of a larger initial download. The
libraries are split into their own chunk so editing a page does not invalidate them
in anyone's cache.

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
than a sentence does. Everything collapses to static under
`prefers-reduced-motion: reduce`.
