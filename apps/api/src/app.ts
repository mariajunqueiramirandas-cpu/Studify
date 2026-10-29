// The HTTP surface: /api/health, the function routes under /api/<name>, the web dashboard at /painel and the
// static link site.
// Built from the runtime deps by server.ts; tests drive it with app.request() and the same fakes.
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { apiError } from '@studify/shared';
import pkg from '../package.json' with { type: 'json' };
import { jsonResponse } from './shared/http.ts';
import { log } from './log.ts';
import { mountSite } from './site.ts';
import { mountDashboard, type DashboardConfig } from './dashboard.ts';
import { ROUTES } from './routes.ts';
import { mountStorage } from './storage/routes.ts';
import type { P2Deps } from './shared-p2/deps.ts';

export const VERSION: string = pkg.version;

export function createApp(deps: P2Deps, siteDir: string, apkUrl?: string, dashboard?: DashboardConfig): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    const started = performance.now();
    const path = new URL(c.req.url).pathname;
    // Request identity without secrets: a short hash of the Idempotency-Key ties a resend to its original call,
    // and the user agent tells the app's HTTP stack from a proxy (ADR 0009 §Context 4). Only function calls carry them.
    const key = c.req.header('idempotency-key');
    const who: Record<string, unknown> =
      !path.startsWith('/api/') || path === '/api/health'
        ? {}
        : { ...(key ? { key: createHash('sha256').update(key).digest('hex').slice(0, 12) } : {}), ua: (c.req.header('user-agent') ?? '').slice(0, 80) };
    let answered = false;
    c.req.raw.signal?.addEventListener('abort', () => {
      if (answered) return;
      log('info', 'client disconnected', { method: c.req.method, path, ...who, ms: Math.round(performance.now() - started) });
    });
    await next();
    answered = true;
    // Logged when the response headers are ready: for SSE, that is the start of the stream.
    log('info', 'request', {
      method: c.req.method,
      path,
      status: c.res.status,
      ...who,
      ms: Math.round(performance.now() - started),
    });
  });

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));
  mountStorage(app, deps);

  // All methods reach the function, which answers its own 405 for non-POST (the contract the apps rely on).
  app.all('/api/:name', (c) => {
    const handler = ROUTES.get(c.req.param('name'));
    if (!handler) {
      return jsonResponse(apiError('not_found', { message: 'Essa função não existe.' }), 404);
    }
    return handler(c.req.raw, deps);
  });

  if (dashboard) mountDashboard(app, dashboard);
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
