import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:3101';
const wsTarget = apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind beyond loopback so the dev server is reachable over a tailnet.
    host: true,
    proxy: {
      '/api': apiTarget,
      '/ws': { target: wsTarget, ws: true },
    },
  },
  preview: {
    // Same as above, for `vite preview` (the demo-day serving path).
    host: true,
  },
});
