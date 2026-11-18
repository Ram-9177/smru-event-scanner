import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Component tests run in jsdom with fetch mocked per test. CSS (Tailwind, the fonts) is not needed and not processed.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
    css: false,
  },
});
