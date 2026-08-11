/*
  A deliberately small syntax highlighter.

  The palette has one accent, so code gets four token types rather than a rainbow:
  comments recede, strings and flags take the accent, numbers sit between the two.
  Anything richer would fight the rest of the page for attention.

  It runs over already-rendered DOM, reading textContent (which is unescaped) and
  writing back escaped HTML, so there is no double-escaping to get wrong.
*/

import { slugify } from './slug.js';

const RULES = {
  bash: /(?<comment>#[^\n]*)|(?<string>'[^'\n]*'|"[^"\n]*")|(?<flag>(?:^|(?<=\s))--?[a-zA-Z][\w-]*)|(?<number>\b\d+(?:\.\d+)?\b)/g,
  javascript:
    /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<string>'[^'\n]*'|"[^"\n]*"|`[^`]*`)|(?<keyword>\b(?:const|let|var|function|return|import|export|from|await|async|new|for|of|in|if|else|class|try|catch|throw)\b)|(?<number>\b\d+(?:\.\d+)?\b)/g,
  python:
    /(?<comment>#[^\n]*)|(?<string>'''[\s\S]*?'''|"""[\s\S]*?"""|'[^'\n]*'|"[^"\n]*")|(?<keyword>\b(?:import|from|def|return|for|in|if|elif|else|with|as|not|and|or|None|True|False|print|lambda|class)\b)|(?<number>\b\d+(?:\.\d+)?\b)/g,
  json: /(?<string>"[^"\n]*")|(?<keyword>\b(?:true|false|null)\b)|(?<number>-?\b\d+(?:\.\d+)?(?:e[-+]?\d+)?\b)/gi,
};

const ALIASES = {
  sh: 'bash',
  shell: 'bash',
  console: 'bash',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  typescript: 'javascript',
  mjs: 'javascript',
  py: 'python',
};

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Tokenise `source` for `language`, returning escaped HTML. */
export function highlight(source, language) {
  const rule = RULES[ALIASES[language] ?? language];
  if (!rule) return escapeHtml(source);

  rule.lastIndex = 0;
  let out = '';
  let cursor = 0;
  let match;

  while ((match = rule.exec(source)) !== null) {
    // A zero-length match would spin forever.
    if (match.index === rule.lastIndex) {
      rule.lastIndex++;
      continue;
    }
    const groups = match.groups ?? {};
    const kind = Object.keys(groups).find((key) => groups[key] !== undefined);
    if (!kind) continue;

    out += escapeHtml(source.slice(cursor, match.index));
    out += `<span class="tok-${kind}">${escapeHtml(match[0])}</span>`;
    cursor = match.index + match[0].length;
  }

  out += escapeHtml(source.slice(cursor));
  return out;
}

/** Highlight every fenced code block inside a rendered markdown container. */
export function highlightWithin(container) {
  if (!container) return;
  for (const block of container.querySelectorAll('pre > code')) {
    if (block.dataset.highlighted === 'true') continue;
    const className = block.getAttribute('class') ?? '';
    const language = /language-([\w-]+)/.exec(className)?.[1] ?? 'text';
    const source = block.textContent ?? '';
    block.innerHTML = highlight(source, language);
    block.dataset.highlighted = 'true';
  }
}

/** Give headings stable ids so the page can be deep-linked. */
export function addHeadingAnchors(container) {
  if (!container) return [];
  const headings = [];
  for (const node of container.querySelectorAll('h2, h3')) {
    const text = node.textContent ?? '';
    // slugify, not a copy of it: the module exists because a second copy of this rule already
    // disagreed with the first about hyphens, and the ids it makes have to be the ones the
    // prerendered pages and every /docs/...#fragment link were built with.
    const id = node.id || slugify(text);
    node.id = id;
    headings.push({ id, text, level: Number(node.tagName.slice(1)) });
  }
  return headings;
}
