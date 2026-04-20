import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  // Force the development build of React so testing-library's act() works.
  // Vitest defaults NODE_ENV to 'test', which makes React resolve the
  // production bundle that strips act-support.
  define: {
    'process.env.NODE_ENV': JSON.stringify('development'),
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
  test: {
    environment: 'jsdom',
    globals: false,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
  },
});
