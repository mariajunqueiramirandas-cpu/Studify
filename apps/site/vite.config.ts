import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Built into dist/, which the API serves (apps/api/src/site.ts). In `pnpm dev`, /download and /api go to a
// local API on port 3000.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', assetsDir: 'assets' },
  server: {
    proxy: { '/download': 'http://localhost:3000', '/api': 'http://localhost:3000' },
  },
});
