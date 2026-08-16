/*
  A deliberately small syntax highlighter.

  The palette has one accent, so code gets four token types rather than a rainbow:
  comments recede, strings and flags take the accent, numbers sit between the two.
  Anything richer would fight the rest of the page for attention.

  It takes source text and returns escaped HTML, so the caller hands it the unescaped
  original and there is no double-escaping to get wrong.
*/

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

/*
  `highlightWithin` and `addHeadingAnchors` used to live here, for a browser pass over
  markdown rendered at runtime. Nothing has called either since the documentation became
  prerendered: `renderMarkdown` highlights and stamps ids at build time and marks the blocks
  `data-highlighted`, so there is no second pass to make. Vite tree-shakes unused exports, so
  they cost no bytes and were invisible for it.

  They are gone because `addHeadingAnchors` was still doing `node.id || slugify(text)` — the
  plain rule, one id per heading text, which is what 0.6.87 replaced with `makeSlugger` after
  two `NO_SAMPLES` headings both answered to `#no_samples`. Wiring it back up would have
  reintroduced that bug, and a helper that looks ready to use is a worse place to keep a known
  wrong rule than no helper at all.
*/
