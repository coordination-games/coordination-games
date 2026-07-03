import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiTarget = process.env.CONSOLE_API_TARGET ?? 'http://127.0.0.1:4310';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      '/api': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
