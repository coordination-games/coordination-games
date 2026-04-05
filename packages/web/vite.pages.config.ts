import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds only the /games microsite for GitHub Pages
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: 'pages-entry.html',
    },
  },
});
