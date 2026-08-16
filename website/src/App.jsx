import Nav from './components/Nav.jsx';
import Landing from './components/Landing.jsx';

/*
  The app is the landing page and nothing else.

  Documentation pages are prerendered to static HTML at build time, so they are real
  URLs a crawler can read without running JavaScript. Links to them are ordinary
  links, which also means they work with the bundle still downloading.
*/

export default function App() {
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Nav />
      <Landing />
      <footer className="footer">
        <div className="shell footer__inner">
          <span>
            edf2csv is MIT licensed. It reads a file and writes files, nothing else.
          </span>
          <span className="footer__links">
            <a href="https://github.com/tayal-sarthak/edf2csv" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="https://www.npmjs.com/package/edf2csv" target="_blank" rel="noreferrer">
              npm
            </a>
            <a
              href="https://github.com/tayal-sarthak/edf2csv/blob/main/docs/CHANGELOG.md"
              target="_blank"
              rel="noreferrer"
            >
              Changelog
            </a>
          </span>
        </div>
      </footer>
    </>
  );
}
