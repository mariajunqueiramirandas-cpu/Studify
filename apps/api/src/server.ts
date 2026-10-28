// API entry point: `bun apps/api/src/server.ts` (Dokploy runs the same command in the image).
// Validates the environment, builds the runtime deps once, starts Bun.serve with the Hono app, works the
// interactive queue of deferred calls (ADR 0009) and stops gracefully on SIGTERM/SIGINT: the HTTP server drains
// in-flight requests, then pg-boss stops (deferred calls in progress get time to finish).
import { ConfigError, loadConfig } from './config.ts';
import { createApp, VERSION } from './app.ts';
import { log } from './log.ts';
import { runDeferred } from './shared/http.ts';
import type { DeferredRunner, ProdRuntime } from './shared/prod.ts';
import { buildP2Runtime } from './shared-p2/prod.ts';
import type { P2Deps } from './shared-p2/deps.ts';
import { existsSync } from 'node:fs';

/** Dokploy gives a stopping container 60 s (stop_grace_period in docker-compose.yml). Stay under it. */
const SHUTDOWN_DEADLINE_MS = 50_000;
/** How long to wait before trying again to serve the interactive queue when pg-boss is not reachable. */
const INTERACTIVE_RETRY_MS = 30_000;

/**
 * Works the interactive queue (ADR 0009): each deferred call runs its handler here and stores the response under
 * its Idempotency-Key. Retries until pg-boss is reachable, so the API serves requests even while it is not.
 */
function serveDeferredCalls(runtime: ProdRuntime, deps: P2Deps, isStopping: () => boolean): void {
  const run: DeferredRunner = async (job, attempt) => {
    const started = performance.now();
    try {
      const stored = await runDeferred(job, deps, attempt);
      log('info', 'deferred call', { fn: job.fn, requestId: job.request_id, status: stored.status, ms: Math.round(performance.now() - started) });
    } catch (err) {
      log('warn', 'deferred call failed; retrying', { fn: job.fn, requestId: job.request_id, ms: Math.round(performance.now() - started), message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  };
  const attempt = (): void => {
    if (isStopping()) return;
    runtime.serveInteractive(run).then(
      () => log('info', 'serving deferred calls'),
      (err: unknown) => {
        log('warn', 'interactive queue not ready; retrying', { message: err instanceof Error ? err.message : String(err) });
        setTimeout(attempt, INTERACTIVE_RETRY_MS).unref();
      },
    );
  };
  attempt();
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  if (!existsSync(config.siteDir)) log('warn', 'static site directory not found', { siteDir: config.siteDir });

  const runtime = buildP2Runtime(config);
  await runtime.start();
  const app = createApp(runtime.deps, config.siteDir, config.apkUrl);

  // idleTimeout 255 s (the Bun maximum): AI calls can run past the default 10 s without writing bytes,
  // and SSE streams send a heartbeat every 15 s (shared/sse.ts).
  const server = Bun.serve({ port: config.port, fetch: app.fetch, idleTimeout: 255 });
  log('info', 'api listening', { version: VERSION, port: server.port, siteDir: config.siteDir });

  let stopping = false;
  serveDeferredCalls(runtime, runtime.deps, () => stopping);
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log('info', 'stop requested', { signal });
    const deadline = setTimeout(() => {
      log('error', 'shutdown deadline reached, exiting');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    await server.stop();
    await runtime.stop();
    log('info', 'stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  log('error', 'fatal', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
