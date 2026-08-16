import docs from '../generated/docs-index.json';

/*
  Only the documentation index reaches the browser bundle.

  The pages themselves are prerendered to static HTML at build time so crawlers, and
  the AI systems that read them, get the full text of every page at its own URL. The
  landing page needs titles and descriptions for its card grid, which is all this is.
*/

export const pages = docs;
