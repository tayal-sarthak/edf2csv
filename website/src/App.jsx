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
      <Nav />
      <Landing />
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
