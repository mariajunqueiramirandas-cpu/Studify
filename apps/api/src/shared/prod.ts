// Production wiring for the base Deps. Built once at startup from the validated config (server.ts); handlers
// never build clients themselves. The pg-boss instance is started lazily on the first enqueue, so the API
// keeps serving while the worker is still creating the schema.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { AnthropicLike } from '@studify/ai';
import { uuidV7 } from '@studify/shared';
import type { ApiConfig } from '../config.ts';
import { log } from '../log.ts';
import { makeBudgetStore, makeUsageSink } from './budget.ts';
import type { Deps } from './deps.ts';
import { makePgBossEnqueue } from './enqueue.ts';
import { withPrivateSchema } from './private-schema.ts';

export interface ProdRuntime {
  deps: Deps;
  /** Warms up pg-boss. Failure is logged, not fatal: the next enqueue retries. */
  start(): Promise<void>;
  /** Stops pg-boss gracefully (in-flight sends finish). Safe when pg-boss never started. */
  stop(): Promise<void>;
}

/** Lowest client versionCode allowed (app_versions.blocks_older), cached for 60 s. */
function minClientVersionOf(db: SupabaseClient): () => Promise<number | null> {
  let cache: { value: number | null; at: number } | undefined;
  return async () => {
    if (cache && Date.now() - cache.at < 60_000) return cache.value;
    const { data } = await db
      .from('app_versions')
      .select('version_code')
      .eq('blocks_older', true)
      .order('version_code', { ascending: false })
      .limit(1)
      .maybeSingle();
    const value = data ? Number(data.version_code) : null;
    cache = { value, at: Date.now() };
    return value;
  };
}

export function buildProdRuntime(config: ApiConfig): ProdRuntime {
  // The private schema is not exposed through PostgREST: db.schema('private') runs over this pool.
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 4, idleTimeoutMillis: 30_000, application_name: 'studify-api' });
  pool.on('error', (err: Error) => log('warn', 'postgres pool error', { message: err.message }));
  const db = withPrivateSchema(
    createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
    pool,
  );
  const client = new Anthropic({
    apiKey: config.anthropicApiKey,
    baseURL: config.anthropicBaseUrl,
    maxRetries: 0,
  }) as unknown as AnthropicLike;

  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    schema: config.pgBossSchema,
    max: 2,
    // The worker owns the schema, supervision and scheduling. The API only sends.
    supervise: false,
    schedule: false,
    migrate: false,
  });
  boss.on('error', (err: Error) => log('error', 'pg-boss error', { message: err.message }));

  let starting: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    starting ??= boss.start().then(
      () => undefined,
      (err: unknown) => {
        starting = null;
        throw err;
      },
    );
    return starting;
  };

  const deps: Deps = {
    db,
    supabaseUrl: config.supabaseUrl,
    anonKey: config.anonKey,
    asUser: (jwt: string) =>
      createClient(config.supabaseUrl, config.anonKey, {
        global: { headers: { Authorization: `Bearer ${jwt}` } },
        auth: { persistSession: false, autoRefreshToken: false },
      }),
    verifyEmailCode: async (email: string, code: string) => {
      const once = createClient(config.supabaseUrl, config.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error } = await once.auth.verifyOtp({ email, token: code, type: 'email' });
      return !error;
    },
    ai: { client, budget: makeBudgetStore(db), usage: makeUsageSink(db), timeoutMs: 120_000, maxRetries: 2 },
    enqueue: makePgBossEnqueue(boss, ready),
    now: () => new Date(),
    newId: () => uuidV7(),
    heartbeatMs: 15_000,
    minClientVersion: minClientVersionOf(db),
    // Rate-limit stub (api §2.5: 10 AI requests per minute per user). Not enforced yet; the budget
    // gate still caps spend. Replace with a counter table when the limit is turned on.
    rateLimit: () => Promise.resolve(true),
  };

  return {
    deps,
    async start() {
      try {
        await ready();
        log('info', 'pg-boss started', { schema: config.pgBossSchema });
      } catch (err) {
        log('warn', 'pg-boss not ready yet; enqueue will retry', { message: errorMessage(err) });
      }
    },
    async stop() {
      if (starting) {
        await boss.stop({ graceful: true, timeout: 10_000 }).catch((err: unknown) => {
          log('warn', 'pg-boss stop failed', { message: errorMessage(err) });
        });
      }
      await pool.end().catch(() => undefined);
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
