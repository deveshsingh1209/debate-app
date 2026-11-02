import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Stamped once per build; makes every deploy's asset URLs unique. */
const BUILD_ID = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

const repo = fileURLToPath(new URL('..', import.meta.url));

/**
 * What the dev server must never hand out, whatever URL asks: the debate
 * database and every upload. `/@fs/` requests never reach the backend, so none
 * of its guards (Host, Origin, password, CSRF) apply to them; this list is the
 * only wall. DATA_DIR may sit anywhere, so it is named explicitly, beside both
 * places the default lands (the server's cwd is server/ under `npm run dev`).
 */
const dataDirs = [process.env.DATA_DIR, path.join(repo, 'data'), path.join(repo, 'server', 'data')]
  .filter((d): d is string => !!d)
  .map((d) => `${path.resolve(d).replace(/\\/g, '/')}/**`);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // The app is same-origin with its own proxy, so nothing needs CORS. Vite's
    // default grants it to every localhost origin, which let a page on any
    // other local port read /api/me (and so the CSRF token) through the proxy.
    cors: false,
    proxy: {
      '/api': {
        // Overridable so a scratch server (a copy of the data, a different
        // port) can be driven from a second dev instance without touching the
        // one the founder has open.
        target: process.env.API_TARGET ?? 'http://localhost:8794',
        changeOrigin: false,
        // SSE needs buffering off; http-proxy streams by default.
      },
    },
    fs: {
      strict: true,
      // web/ itself, the shared contract it imports, and the hoisted packages (fonts).
      allow: ['.', '../shared', '../node_modules'],
      deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '*.db', '*.db-*', '*.sqlite*', '**/.scratch/**', ...dataDirs],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        /**
         * Every deploy gets a unique asset directory.
         *
         * Content hashes alone are not enough behind a CDN: if an edge ever
         * caches a bad response for a hash (a 404 falling through to
         * index.html, say), that URL stays poisoned for the whole TTL and the
         * app boots blank. A per-build directory guarantees fresh URLs.
         */
        entryFileNames: `assets/${BUILD_ID}/[name]-[hash].js`,
        chunkFileNames: `assets/${BUILD_ID}/[name]-[hash].js`,
        assetFileNames: `assets/${BUILD_ID}/[name]-[hash].[ext]`,
      },
    },
  },
});
