// The web dashboard (apps/dashboard, a Vite + React build in apps/dashboard/dist) at /painel: index.html for every
// /painel route (the React app routes in the browser), the hashed bundle under /painel/assets and the favicon.
// The page receives the public Supabase settings it needs for the e-mail code sign-in at serve time, in a meta
// tag, so one image works for every deployment. The page holds a session token, so it is served with a strict
// Content-Security-Policy (scripts and styles from this origin only, network to this origin and Supabase Auth)
// and is never framed, indexed or sent a referrer.
import path from 'node:path';
import type { Hono } from 'hono';
import { ASSET_CACHE, ASSET_NAME, ASSET_TYPES, FILE_CACHE, HTML, serveFile } from './site.ts';

export interface DashboardConfig {
  /** The built dashboard (DASHBOARD_DIR). */
  dir: string;
  supabaseUrl: string;
  /** The publishable (anon) key: public by design, the same one the app ships. */
  anonKey: string;
}

/** Where index.html asks for the runtime settings (apps/dashboard/index.html). */
export const CONFIG_PLACEHOLDER = '%STUDIFY_CONFIG%';

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function dashboardHeaders(supabaseUrl: string): Record<string, string> {
  const supabase = new URL(supabaseUrl).origin;
  return {
    'Content-Type': HTML,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "font-src 'self'",
      "img-src 'self' data:",
      `connect-src 'self' ${supabase}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'X-Robots-Tag': 'noindex, nofollow',
  };
}

export function mountDashboard(app: Hono, config: DashboardConfig): void {
  const settings = escapeAttribute(JSON.stringify({ supabaseUrl: config.supabaseUrl, supabaseAnonKey: config.anonKey }));
  const headers = dashboardHeaders(config.supabaseUrl);
  // Read once: the build does not change while the process runs. A missing build is retried on the next request.
  let page: string | null = null;

  const index = async (): Promise<Response> => {
    if (page === null) {
      const file = Bun.file(path.join(config.dir, 'index.html'));
      if (!(await file.exists())) return new Response('Não encontrado', { status: 404 });
      page = (await file.text()).replaceAll(CONFIG_PLACEHOLDER, settings);
    }
    return new Response(page, { headers });
  };

  app.get('/painel/assets/:name', (c) => {
    const name = c.req.param('name');
    const type = ASSET_TYPES[path.extname(name)];
    if (!ASSET_NAME.test(name) || !type) return c.text('Não encontrado', 404);
    return serveFile(path.join(config.dir, 'assets', name), type, ASSET_CACHE, { 'X-Content-Type-Options': 'nosniff' });
  });
  app.get('/painel/favicon.svg', () => serveFile(path.join(config.dir, 'favicon.svg'), 'image/svg+xml', FILE_CACHE));
  app.get('/painel', index);
  app.get('/painel/*', index);
}
