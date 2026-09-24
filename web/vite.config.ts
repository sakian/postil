import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// For UI development against a running server: POSTIL_URL=http://127.0.0.1:<port> npm run dev:web
const target = process.env.POSTIL_URL ?? 'http://127.0.0.1:7717';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true, target: 'es2022' },
  // ES-module workers can code-split, so each syntax grammar is its own chunk, fetched on first use.
  worker: { format: 'es' },
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
      '/events': {
        target,
        ws: true,
        changeOrigin: true,
        // The server only accepts its own origin on the event feed.
        configure: (proxy) => proxy.on('proxyReqWs', (req) => req.setHeader('origin', target)),
      },
    },
  },
});
