import { useEffect, useLayoutEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { neighbours, pageBySlug, pages } from '../lib/content.js';
import { addHeadingAnchors, highlightWithin } from '../lib/highlight.js';

export default function Docs({ slug, navigate }) {
  const page = pageBySlug(slug) ?? pages[0];
  const bodyRef = useRef(null);
  const reduced = useReducedMotion();
  const { previous, next } = neighbours(page.slug);

  // Highlight and anchor before paint so the reader never sees unstyled code.
  useLayoutEffect(() => {
    highlightWithin(bodyRef.current);
    addHeadingAnchors(bodyRef.current);
  }, [page.slug]);

  // Intercept in-page links so the site keeps its own routing.
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;

    const onClick = (event) => {
      const anchor = event.target.closest('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      if (href.startsWith('#/')) {
        event.preventDefault();
        navigate(href.slice(1));
      } else if (href.startsWith('http')) {
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
      }
    };

    container.addEventListener('click', onClick);
    return () => container.removeEventListener('click', onClick);
  }, [navigate, page.slug]);

  return (
    <main className="shell docs">
      <nav className="docs__nav" aria-label="Documentation">
        {pages.map((entry) => (
          <a
            key={entry.slug}
            className="docs__link"
            href={`#/docs/${entry.slug}`}
            aria-current={entry.slug === page.slug ? 'true' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate(`/docs/${entry.slug}`);
            }}
          >
            {entry.title}
          </a>
        ))}
      </nav>

      <motion.article
        key={page.slug}
        className="prose"
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <h1>{page.title}</h1>
        {page.description ? <p className="prose__lede">{page.description}</p> : null}

        <div ref={bodyRef} dangerouslySetInnerHTML={{ __html: page.html }} />

        <div className="doc-footer">
          {previous ? (
            <a
              href={`#/docs/${previous.slug}`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/docs/${previous.slug}`);
              }}
            >
              &larr; {previous.title}
            </a>
          ) : (
            <span />
          )}
          {next ? (
            <a
              href={`#/docs/${next.slug}`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/docs/${next.slug}`);
              }}
            >
              {next.title} &rarr;
            </a>
          ) : (
            <span />
          )}
        </div>
      </motion.article>
    </main>
  );
}
