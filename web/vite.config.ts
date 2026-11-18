import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development Vite serves the web app on :5173 and passes API calls to the Node server on :3000.
const api = process.env.API_URL || 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': api, '/img': api, '/admin/onedrive': api, '/auth': api },
  },
  build: { outDir: 'dist', sourcemap: false },
});
