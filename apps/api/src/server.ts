// API entry point: `bun apps/api/src/server.ts` (Dokploy runs the same command in the image).
// Validates the environment, builds the runtime deps once, starts Bun.serve with the Hono app and stops
// gracefully on SIGTERM/SIGINT: the HTTP server drains in-flight requests, then pg-boss stops.
import { ConfigError, loadConfig } from './config.ts';
import { createApp, VERSION } from './app.ts';
import { log } from './log.ts';
import { buildP2Runtime } from './shared-p2/prod.ts';
import { existsSync } from 'node:fs';

/** Dokploy gives a stopping container 60 s (stop_grace_period in docker-compose.yml). Stay under it. */
const SHUTDOWN_DEADLINE_MS = 50_000;

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
