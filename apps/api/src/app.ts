// The HTTP surface: /api/health, the function routes under /api/<name> and the static link site.
// Built from the runtime deps by server.ts; tests drive it with app.request() and the same fakes.
import { Hono } from 'hono';
import { apiError } from '@studify/shared';
import pkg from '../package.json' with { type: 'json' };
import { jsonResponse } from './shared/http.ts';
import { log } from './log.ts';
import { mountSite } from './site.ts';
import { ROUTES } from './routes.ts';
import type { P2Deps } from './shared-p2/deps.ts';

export const VERSION: string = pkg.version;

export function createApp(deps: P2Deps, siteDir: string, apkUrl?: string): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    // Logged when the response headers are ready: for SSE, that is the start of the stream.
    log('info', 'request', {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));

  // All methods reach the function, which answers its own 405 for non-POST (the contract the apps rely on).
  app.all('/api/:name', (c) => {
    const handler = ROUTES.get(c.req.param('name'));
    if (!handler) {
      return jsonResponse(apiError('not_found', { message: 'Essa função não existe.' }), 404);
    }
    return handler(c.req.raw, deps);
  });

  mountSite(app, siteDir, apkUrl);

  app.notFound((c) => {
    if (new URL(c.req.url).pathname.startsWith('/api/')) {
      return jsonResponse(apiError('not_found', { message: 'Essa função não existe.' }), 404);
    }
    return c.text('Não encontrado', 404);
  });

  app.onError((err, c) => {
    log('error', 'unhandled error', { path: new URL(c.req.url).pathname, message: err instanceof Error ? err.message : String(err) });
    return jsonResponse(apiError('internal_error'), 500);
  });

  return app;
}
