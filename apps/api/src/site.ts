// The link site (apps/site, a Vite + React build in apps/site/dist): index.html for the landing page and the
// shared-link routes /c, /i, /q and /b, the hashed bundle under /assets, the Android App Links file, and
// /download, a redirect to the newest release APK. Only these paths are served, so no request can reach
// outside the directory (no _redirects, no vercel.json).
import path from 'node:path';
import type { Hono } from 'hono';

export const HTML = 'text/html; charset=utf-8';
/** index.html names the hashed bundle, so it is revalidated on every load; the bundle never changes. */
const PAGE_CACHE = 'no-cache';
export const ASSET_CACHE = 'public, max-age=31536000, immutable';
export const FILE_CACHE = 'public, max-age=300';

/** Stable link to the APK of the newest GitHub Release (android-release.yml uploads it as studify.apk). */
export const DEFAULT_APK_URL = 'https://github.com/mariajunqueiramirandas-cpu/Studify/releases/latest/download/studify.apk';

/** Vite output under /assets: one flat directory of hashed files. */
export const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};
/** Plain file names only: no slash, and every dot-separated part is non-empty, so `..` cannot match. */
export const ASSET_NAME = /^[\w-]+(?:\.[\w-]+)+$/;

/** Serves one file of the site directory, or a plain 404 when it is missing from the deployment. */
export async function serveFile(full: string, contentType: string, cache: string, extra: Record<string, string> = {}): Promise<Response> {
  const body = Bun.file(full);
  if (!(await body.exists())) return new Response('Não encontrado', { status: 404 });
  return new Response(body, { headers: { 'Content-Type': contentType, 'Cache-Control': cache, ...extra } });
}

export function mountSite(app: Hono, siteDir: string, apkUrl: string = DEFAULT_APK_URL): void {
  const index = path.join(siteDir, 'index.html');

  app.get('/', () => serveFile(index, HTML, PAGE_CACHE));
  // Same page for every shared-link route (SOC-09.4, S-EXT-03); the React app reads the path. Link pages carry
  // codes, so they stay out of search results.
  for (const prefix of ['c', 'i', 'q', 'b']) {
    app.get(`/${prefix}/*`, () => serveFile(index, HTML, PAGE_CACHE, { 'X-Robots-Tag': 'noindex' }));
  }

  app.get('/assets/:name', (c) => {
    const name = c.req.param('name');
    const type = ASSET_TYPES[path.extname(name)];
    if (!ASSET_NAME.test(name) || !type) return c.text('Não encontrado', 404);
    return serveFile(path.join(siteDir, 'assets', name), type, ASSET_CACHE);
  });
  app.get('/favicon.svg', () => serveFile(path.join(siteDir, 'favicon.svg'), 'image/svg+xml', FILE_CACHE));
  app.get('/.well-known/assetlinks.json', () =>
    serveFile(path.join(siteDir, '.well-known/assetlinks.json'), 'application/json', FILE_CACHE),
  );

  // Not cached: the target moves to the new APK as soon as a release is published.
  app.get('/download', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.redirect(apkUrl, 302);
  });
}
