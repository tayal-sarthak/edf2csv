import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

const STORAGE_KEY = 'edf2csv-theme';

function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M3 16h4l3-8 4 16 3-11 3 6h9"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Nav() {
  const reduced = useReducedMotion();
  const [scrolled, setScrolled] = useState(false);
  // Guarded because this also runs during prerendering, where there is no storage.
  const [theme, setTheme] = useState(
    () => (typeof localStorage === 'undefined' ? 'auto' : localStorage.getItem(STORAGE_KEY)) ?? 'auto',
  );

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    // IntersectionObserver on a sentinel rather than a scroll listener, which would
    // fire on every frame.
    const sentinel = document.createElement('div');
    sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px;';
    document.body.prepend(sentinel);
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      sentinel.remove();
    };
  }, []);

  const next = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
  const cycle = () => setTheme(next);

  /*
    The label names what pressing it does, not what is currently true.

    It read "Switch theme, currently auto", which tells a screen-reader user the state
    they are already in and leaves the outcome to be discovered by pressing. A button's
    accessible name is its action; the state it happens to be in is what the icon shows.
  */
  const label = next === 'auto' ? 'Match the system theme' : `Switch to the ${next} theme`;

  return (
    // Named to match the prerendered header: a page with more than one <nav> should not
    // leave one of them listed as simply "navigation".
    <nav className="nav" data-scrolled={scrolled} aria-label="Site">
      <div className="shell nav__inner">
        <a className="nav__brand" href="/">
          <Mark />
          edf2csv
        </a>

        <div className="nav__links">
          <a href="/docs/getting-started">Docs</a>
          <a className="nav__hide-sm" href="/docs/cli-reference">CLI</a>
          <a className="nav__hide-sm" href="/docs/correctness">Correctness</a>
          <a href="https://github.com/tayal-sarthak/edf2csv" target="_blank" rel="noreferrer">
            GitHub
          </a>

          <motion.button
            type="button"
            className="nav__toggle"
            onClick={cycle}
            whileTap={reduced ? undefined : { scale: 0.92 }}
            title={label}
            aria-label={label}
          >
            {theme === 'light' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" strokeLinecap="round" />
              </svg>
            ) : theme === 'dark' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 3v18" />
                <path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" opacity="0.55" />
              </svg>
            )}
          </motion.button>
        </div>
      </div>
    </nav>
  );
}
