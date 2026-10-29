// Domain clients, direct operation registry, and future calendar triggers, owned by the API process.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ClaudeDeps } from '@studify/ai';
import { ttsFromEnv, type TtsProvider } from '@studify/speech';
import type { TaskConfig } from './env.ts';
import { createBudgetStore } from './budget.ts';
import { createPool, type Sql } from './db.ts';
import { createLogger, type Logger } from './logger.ts';
import { createAnthropicClient, createClaudeDeps } from './anthropic.ts';
import { createUsageSink } from './usage.ts';
import { createExpoClient, createPushService, type PushService } from './push.ts';
import { Scheduler, type Schedule } from './scheduler.ts';
import { OperationRegistry, type RuntimeDeps } from './registry.ts';
import { builtinJobs } from './builtin.ts';
import { isTerminalStatus, setProgressListener } from './progress.ts';
import type pg from 'pg';

export interface Runtime {
  log: Logger;
  pool: pg.Pool;
  registry: OperationRegistry;
  push: PushService;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RuntimeOverrides {
  schedule?: Schedule;
  supabase?: SupabaseClient;
  claude?: ClaudeDeps;
  pool?: pg.Pool;
  now?: () => Date;
  log?: Logger;
  /** Expo client override (tests). Defaults to the real client when EXPO_ACCESS_TOKEN is set. */
  expo?: Parameters<typeof createPushService>[0]['expo'];
  /** TTS override (tests). Defaults to TTS_PROVIDER / GOOGLE_TTS_API_KEY (packages/speech). */
  tts?: TtsProvider | null;
}

/** Builds the domain library. Register all definitions before starting calendar triggers. */
export async function createRuntime(config: TaskConfig, overrides: RuntimeOverrides = {}): Promise<Runtime> {
  const log = overrides.log ?? createLogger(config.logLevel);
  const now = overrides.now ?? (() => new Date());
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
  const pool = overrides.pool ?? createPool(config.databaseUrl, config.pgPoolMax);
  const sql: Sql = pool;

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
    execute: (name, data, opts) => {
      if (!enqueueRef) throw new Error('registry not ready');
      return enqueueRef(name, data, opts);
    },
  });

  const scheduler: Scheduler = new Scheduler(sql, log, (name, data, singletonKey) => registry.execute(name, data, singletonKey ? { singletonKey } : {}));
  const registry: OperationRegistry = new OperationRegistry({
    schedule: overrides.schedule ?? scheduler.schedule,
    cron: (name, expression) => scheduler.cron(name, expression),
    pool,
    supabase,
    claude,
    push,
    log,
    now,
    tts: overrides.tts !== undefined ? overrides.tts : ttsFromEnv(process.env),
    waveConcurrency: config.waveConcurrency,
  } satisfies RuntimeDeps);
  enqueueRef = (name, data, opts) => registry.execute(name, data, opts);
  // Live progress (api.md §9.1): each stage change and each terminal state of a job, and at most one
  // update per minute within a stage, become a notify.live job.
  setProgressListener((aiJobId, patch) => {
    const slot = isTerminalStatus(patch.status) ? 'end' : String(Math.floor(now().getTime() / 60_000));
    void registry
      .execute('notify.live', { ai_job_id: aiJobId }, { singletonKey: `live:${aiJobId}:${patch.stage ?? ''}:${patch.status ?? ''}:${slot}` })
      .catch(() => undefined);
  });
  await registry.register(builtinJobs(() => push));

  return {
    log,
    pool,
    registry,
    push,
    async start() { if (!overrides.schedule) await scheduler.start(); },
    async shutdown() {
      log.info('shutting down');
      setProgressListener(null);
      await scheduler.stop();
      await registry.stop();
      if (!overrides.pool) await pool.end();
    },
  };
}

function createSupabase(config: TaskConfig): SupabaseClient {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
