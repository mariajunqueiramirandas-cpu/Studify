import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Built into dist/ with every URL under /painel/, which the API serves (apps/api/src/dashboard.ts). The API puts
// the Supabase settings into index.html at serve time; `pnpm dev` does the same from SUPABASE_URL and
// SUPABASE_ANON_KEY (or the VITE_ names) and proxies /api to a local API on port 3000.
function devConfig(): Plugin {
  return {
    name: 'studify-dev-config',
    apply: 'serve',
    transformIndexHtml(html) {
      const env = process.env;
      const settings = JSON.stringify({
        supabaseUrl: env.VITE_SUPABASE_URL ?? env.SUPABASE_URL ?? '',
        supabaseAnonKey: env.VITE_SUPABASE_ANON_KEY ?? env.SUPABASE_ANON_KEY ?? '',
      }).replace(/"/g, '&quot;');
      return html.replaceAll('%STUDIFY_CONFIG%', settings);
    },
  };
}

export default defineConfig({
  base: '/painel/',
  plugins: [react(), devConfig()],
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
