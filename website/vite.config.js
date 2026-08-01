import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
