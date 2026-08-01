import { useCallback, useEffect, useState } from 'react';
import Nav from './components/Nav.jsx';
import Landing from './components/Landing.jsx';
import Docs from './components/Docs.jsx';

/*
  Hash routing, because the site is deployed as static files and a hash route needs
  no server rewrite rules to survive a refresh or a direct link.
*/

function currentRoute() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash === '' ? '/' : hash;
}

export default function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((next) => {
    window.location.hash = next;
    // A route change should start at the top; an in-page anchor should not.
    if (!next.includes('#')) window.scrollTo({ top: 0, behavior: 'auto' });
  }, []);

  const docsMatch = /^\/docs\/([\w-]+)/.exec(route);

  return (
    <>
      <Nav route={route} navigate={navigate} />
      {docsMatch ? (
        <Docs slug={docsMatch[1]} navigate={navigate} />
      ) : (
        <Landing navigate={navigate} />
      )}
      <footer className="footer">
        <div className="shell footer__inner">
          <span>
            edf2csv is MIT licensed. It reads a file and writes files, nothing else.
          </span>
          <span>
            <a href="https://github.com/tayal-sarthak/edf2csv" target="_blank" rel="noreferrer">
              GitHub
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}
