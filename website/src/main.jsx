import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

/*
  The production build prerenders the landing page into #root (see entry-server.jsx),
  so the app hydrates the markup that is already there. The dev server has no
  prerender step and starts from an empty root, so it still mounts from scratch.
*/

const root = document.getElementById('root');
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);

if (root.hasChildNodes()) hydrateRoot(root, app);
else createRoot(root).render(app);
