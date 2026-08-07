/*
  How a heading becomes a fragment id.

  Its own module, importing nothing, because two things need it and only one of them can
  afford `marked`. The site's markdown renderer stamps these ids onto headings; the
  package's test suite checks that every `/docs/...#fragment` link in the content names one.

  That test used to carry its own copy of the rule and the two disagreed on hyphens — `##
  --layout` is `#--layout` here and was `#layout` there — so 0.5.1 had it import `slugify`
  from markdown.js. Which pulls in `marked`, a website dependency: the package itself has
  none, `npm test` runs with none installed, and every publish from 0.5.1 to 0.5.12 failed
  on `Cannot find package 'marked'` while the releases themselves looked fine. Splitting the
  function out is what lets both callers share it without sharing a dependency graph.
*/

export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}
