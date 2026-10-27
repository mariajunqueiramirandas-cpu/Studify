// Assembles the worker: configuration, Postgres pool, Supabase service client, pg-boss, Claude deps,
// the push service, and the job registry. Used by src/index.ts and by the integration tests (which pass
// fakes for Supabase and the queue).
import { PgBoss } from 'pg-boss';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ClaudeDeps } from '@studify/ai';
import type { WorkerConfig } from './env.ts';
import { createBudgetStore } from './budget.ts';
import { createPool, type Sql } from './db.ts';
import { createLogger, type Logger } from './logger.ts';
import { createAnthropicClient, createClaudeDeps } from './anthropic.ts';
import { createUsageSink } from './usage.ts';
import { createExpoClient, createPushService, type PushService } from './push.ts';
import { createPgBossBackend, type QueueBackend } from './queue.ts';
import { JobRegistry, type RuntimeDeps } from './registry.ts';
import { builtinJobs } from './builtin.ts';
import type pg from 'pg';

export interface Runtime {
  log: Logger;
  pool: pg.Pool;
  registry: JobRegistry;
  push: PushService;
  shutdown(): Promise<void>;
}

export interface RuntimeOverrides {
  backend?: QueueBackend;
  supabase?: SupabaseClient;
  claude?: ClaudeDeps;
  pool?: pg.Pool;
  now?: () => Date;
  log?: Logger;
  /** Expo client override (tests). Defaults to the real client when EXPO_ACCESS_TOKEN is set. */
  expo?: Parameters<typeof createPushService>[0]['expo'];
}

/** Starts pg-boss unless a backend is injected. Callers register job modules afterwards. */
export async function createRuntime(config: WorkerConfig, overrides: RuntimeOverrides = {}): Promise<Runtime> {
  const log = overrides.log ?? createLogger(config.logLevel);
  const now = overrides.now ?? (() => new Date());
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = overrides.pool ?? createPool(config.databaseUrl, config.pgPoolMax);
  const sql: Sql = pool;

  let boss: PgBoss | null = null;
  let backend = overrides.backend;
  if (!backend) {
    boss = new PgBoss({ connectionString: config.databaseUrl, schema: config.pgBossSchema, max: 4 });
    boss.on('error', (err: unknown) => log.error({ err: err instanceof Error ? err.name : 'unknown' }, 'pg-boss error'));
    await boss.start();
    backend = createPgBossBackend(boss);
  }

  const supabase = overrides.supabase ?? createSupabase(config);
  const claude =
    overrides.claude ??
    createClaudeDeps({
      client: createAnthropicClient({
        apiKey: config.anthropicApiKey ?? 'missing-key',
        baseURL: config.anthropicBaseUrl,
        timeoutMs: config.aiTimeoutMs,
      }),
      budget: createBudgetStore(sql),
      usage: createUsageSink(sql, log.child({ component: 'usage' })),
      timeoutMs: config.aiTimeoutMs,
      clock: () => now().getTime(),
    });

  const expo = overrides.expo !== undefined ? overrides.expo : await createExpoClient(config.expoAccessToken);
  let enqueueRef: ((name: string, data: Record<string, unknown>, opts?: { startAfter?: Date | number; singletonKey?: string }) => Promise<string | null>) | null = null;
  const push = createPushService({
    sql,
    expo,
    now,
    log: log.child({ component: 'push' }),
    enqueue: (name, data, opts) => {
      if (!enqueueRef) throw new Error('registry not ready');
      return enqueueRef(name, data, opts);
    },
  });

  const registry = new JobRegistry({
    backend,
    pool,
    supabase,
    claude,
    push,
    log,
    now,
  } satisfies RuntimeDeps);
  enqueueRef = (name, data, opts) => registry.enqueue(name, data, opts);
  await registry.register(builtinJobs(() => push));

  return {
    log,
    pool,
    registry,
    push,
    async shutdown() {
      log.info('shutting down');
      if (boss) await boss.stop({ graceful: true, timeout: 30_000 });
      await pool.end();
    },
  };
}

function createSupabase(config: WorkerConfig): SupabaseClient {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
