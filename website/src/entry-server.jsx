import { renderToString } from 'react-dom/server';
import App from './App.jsx';

/*
  Server entry for the prerenderer.

  The documentation pages have been static HTML from the start; the landing page was
  an empty <div id="root"> until JavaScript arrived. Google runs JavaScript, but most
  of the AI crawlers that answer "how do I convert EDF to CSV" do not, and they saw a
  blank homepage. The prerenderer loads this module through Vite's SSR transform and
  injects the markup into dist/index.html, where main.jsx hydrates it.
*/

export function render() {
  return renderToString(<App />);
}
