import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const DIST = fileURLToPath(new URL('./dist', import.meta.url));

/*
  `npm run preview` serving the build the way the build is actually served.

  Vite's default `appType: 'spa'` puts a fallback in front of the preview server that
  answers every extensionless request with index.html. That is right for an app behind a
  client-side router and wrong for eleven prerendered files: the one command for looking
  at what was built showed the landing page at all eleven documentation URLs, and at
  every wrong URL as well — so the 404 page the prerenderer writes was unreachable, and
  the soft 404 this site's own comments say it refuses to serve was exactly what checking
  it locally produced.

  Vercel resolves /docs/faq to docs/faq/index.html and answers anything it cannot find
  with 404.html and a 404 status. This does the same, so a page checked here is the page
  that deploys.
*/
const serveTheWayVercelDoes = {
  name: 'serve-the-way-vercel-does',
  configurePreviewServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url ?? '/').split(/[?#]/)[0];
      if (path.extname(url)) return next();

      if (existsSync(path.join(DIST, url, 'index.html'))) {
        req.url = path.posix.join(url, 'index.html');
        return next();
      }

      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(readFileSync(path.join(DIST, '404.html')));
    });
  },
};

export default defineConfig({
  plugins: [react(), serveTheWayVercelDoes],
  // Not an SPA, so no SPA fallback: `npm run dev` has no prerendered documentation to
  // serve and should say so, rather than answering /docs/faq with the homepage.
  appType: 'mpa',
  // Absolute base: documentation is prerendered into /docs/<slug>/, and a relative
  // base would make those pages look for /docs/<slug>/assets/... instead.
  base: '/',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Documentation is inlined rather than fetched, which keeps navigation between
        // pages instant and the deploy a pile of static files. Splitting the libraries
        // out means a docs edit does not invalidate the vendor bundle in anyone's cache.
        manualChunks: {
          vendor: ['react', 'react-dom', 'motion'],
        },
      },
    },
    // The content chunk is large by design; the warning is not telling us anything new.
    chunkSizeWarningLimit: 700,
  },
});
