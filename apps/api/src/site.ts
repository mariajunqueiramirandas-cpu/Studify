// The static link site (apps/site/public): the landing page, the link page for /c, /i, /q and /b, the
// Android App Links file and the assets they reference. Only these files are served, so no path can reach
// outside the directory (no _redirects, no vercel.json).
import path from 'node:path';
import type { Hono } from 'hono';

const HTML = 'text/html; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const CACHE = 'public, max-age=300';

interface SiteFile {
  file: string;
  contentType: string;
}

const FILES: Record<string, SiteFile> = {
  index: { file: 'index.html', contentType: HTML },
  link: { file: 'link.html', contentType: HTML },
  styles: { file: 'styles.css', contentType: CSS },
  app: { file: 'app.js', contentType: JS },
  config: { file: 'config.js', contentType: JS },
  assetlinks: { file: '.well-known/assetlinks.json', contentType: 'application/json' },
};

/** Serves one file of the site directory, or a plain 404 when it is missing from the deployment. */
function serve(siteDir: string, key: keyof typeof FILES): () => Promise<Response> {
  const spec = FILES[key] as SiteFile;
  const full = path.join(siteDir, spec.file);
  return async () => {
    const body = Bun.file(full);
    if (!(await body.exists())) return new Response('Não encontrado', { status: 404 });
    return new Response(body, { headers: { 'Content-Type': spec.contentType, 'Cache-Control': CACHE } });
  };
}

export function mountSite(app: Hono, siteDir: string): void {
  app.get('/', serve(siteDir, 'index'));
  app.get('/styles.css', serve(siteDir, 'styles'));
  app.get('/app.js', serve(siteDir, 'app'));
  app.get('/config.js', serve(siteDir, 'config'));
  app.get('/.well-known/assetlinks.json', serve(siteDir, 'assetlinks'));
  // Same landing page for every shared-link route (SOC-09.4, S-EXT-03): the app opens the code.
  for (const prefix of ['c', 'i', 'q', 'b']) app.get(`/${prefix}/*`, serve(siteDir, 'link'));
}
