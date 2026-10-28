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
import type { DeferredJob, Deps } from './deps.ts';
import { makePgBossEnqueue } from './enqueue.ts';
import { withPrivateSchema } from './private-schema.ts';

/**
 * ADR 0009: handlers that call Claude outside a stream run as jobs on this queue, served by the API process itself
 * (it has the handlers and their dependencies). pg-boss makes the work durable: a job whose process dies is
 * retried after `expireInSeconds`. One retry covers a transient failure; the app stops polling after 4 minutes.
 */
export const INTERACTIVE_QUEUE = 'api.interactive';
const INTERACTIVE_QUEUE_OPTIONS = { retryLimit: 1, retryDelay: 2, retryBackoff: false, expireInSeconds: 240, policy: 'standard', notify: true } as const;
/** Deferred calls one API process runs at once. They wait on Claude, not on the CPU. */
const INTERACTIVE_CONCURRENCY = 16;

export type DeferredRunner = (job: DeferredJob, attempt: { finalAttempt: boolean }) => Promise<void>;

export interface ProdRuntime {
  deps: Deps;
  /** Warms up pg-boss. Failure is logged, not fatal: the next enqueue retries. */
  start(): Promise<void>;
  /** Starts working the interactive queue (ADR 0009). Rejects when pg-boss is not reachable yet; the caller retries. */
  serveInteractive(run: DeferredRunner): Promise<void>;
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
    max: 4,
    // The worker owns the schema, supervision and scheduling. The API sends, and works only its interactive queue.
    supervise: false,
    schedule: false,
    migrate: false,
    // Wakes the interactive workers as soon as a call is deferred. Falls back to polling when LISTEN is unavailable.
    useListenNotify: true,
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

  let queueReady: Promise<void> | null = null;
  const interactiveQueue = (): Promise<void> => {
    queueReady ??= (async () => {
      await ready();
      if ((await boss.getQueue(INTERACTIVE_QUEUE)) === null) {
        await boss.createQueue(INTERACTIVE_QUEUE, INTERACTIVE_QUEUE_OPTIONS).catch(async (err: unknown) => {
          // Another API process created it first.
          if ((await boss.getQueue(INTERACTIVE_QUEUE)) === null) throw err;
        });
      }
    })().catch((err: unknown) => {
      queueReady = null;
      throw err;
    });
    return queueReady;
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
    // One SDK retry: worst case 2 × 120 s stays under Bun's 255 s idle timeout for streams (ADR 0009).
    ai: { client, budget: makeBudgetStore(db), usage: makeUsageSink(db), timeoutMs: 120_000, maxRetries: 1 },
    enqueue: makePgBossEnqueue(boss, ready),
    defer: async (job: DeferredJob) => {
      await interactiveQueue();
      await boss.send(INTERACTIVE_QUEUE, { ...job });
    },
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
    async serveInteractive(run: DeferredRunner) {
      await interactiveQueue();
      await boss.work(
        INTERACTIVE_QUEUE,
        { localConcurrency: INTERACTIVE_CONCURRENCY, pollingIntervalSeconds: 0.5, includeMetadata: true },
        async (jobs) => {
          for (const job of jobs) {
            await run(job.data as DeferredJob, { finalAttempt: job.retryCount >= job.retryLimit });
          }
        },
      );
    },
    async stop() {
      if (starting) {
        // Deferred calls in progress get time to finish; one cut off is retried by the queue after it expires.
        await boss.stop({ graceful: true, timeout: 30_000 }).catch((err: unknown) => {
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
