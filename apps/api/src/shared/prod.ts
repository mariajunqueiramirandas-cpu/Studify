// One API process owns HTTP streams and direct domain operations. No queue client or consumer.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import type { AnthropicLike } from '@studify/ai';
import { uuidV7 } from '@studify/shared';
import type { ApiConfig } from '../config.ts';
import { log } from '../log.ts';
import { makeBudgetStore, makeUsageSink } from './budget.ts';
import type { Deps } from './deps.ts';
import { createRuntime, discoverOperations, loadConfig as loadTaskConfig } from '@studify/server-tasks';
import { withPrivateSchema } from './private-schema.ts';

export interface ProdRuntime {
  deps: Deps;
  /** Initializes domain operations and calendar triggers. */
  start(): Promise<void>;
  /** Drains operations and closes database connections. */
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
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.databasePoolMax, idleTimeoutMillis: 30_000, application_name: 'studify-api' });
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

  let ownership: pg.PoolClient | undefined;
  let tasks: Awaited<ReturnType<typeof createRuntime>> | undefined;

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
    execute: async (name, data, options = {}) => {
      if (!tasks) throw new Error('server operations have not started');
      try { return await tasks.registry.execute(name, data, {
        singletonKey: options.singletonKey,
        ...(options.startAfterSeconds !== undefined ? { startAfter: options.startAfterSeconds } : {}),
      }, { onProgress: options.onProgress ? (id, patch) => options.onProgress!(id, { ...patch }) : undefined, signal: options.signal });
      } catch (error) {
        // Direct execution has no later worker attempt to repair these placeholders. Make a fresh tap retryable.
        if (typeof data.ai_job_id === 'string') await db.from('ai_jobs').update({ status: 'failed', error_code: 'ai_failed', finished_at: new Date().toISOString() }).eq('id', data.ai_job_id).in('status', ['queued', 'running']);
        if (name.startsWith('ingest.') && typeof data.document_id === 'string') await db.from('documents').update({ status: 'failed', error_code: 'ai_failed' }).eq('id', data.document_id).in('status', ['uploaded', 'processing']);
        if (typeof data.note_id === 'string') await db.from('notes').update({ status: 'failed' }).eq('id', data.note_id).in('status', ['pending', 'generating']);
        if (typeof data.episode_id === 'string') await db.from('podcast_episodes').update({ status: 'failed', error_code: 'ai_failed' }).eq('id', data.episode_id).in('status', ['queued', 'scripting', 'synthesizing']);
        throw error;
      }
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
      // Live fan-out is process-local. Hold ownership for the lifetime of this API, so an overlapping
      // deployment cannot mistake another process's active calls for interrupted ones.
      ownership = await pool.connect();
      ownership.once('error', (error: Error) => {
        log('error', 'API ownership connection lost; exiting', { message: error.message });
        process.exit(1); // another process may now own this database; stop all writes immediately
      });
      const lease = await ownership.query<{ acquired: boolean }>("select pg_try_advisory_lock(hashtextextended('studify-api-runtime', 0)) as acquired");
      if (!lease.rows[0]?.acquired) throw new Error('Another Studify API instance is active; deploy with one replica and stop-first ordering.');
      await ownership.query('select operation_id from public.ai_jobs limit 0');
      await ownership.query('select id from private.scheduled_actions limit 0');
      // A material the restart cut off resumes where it stopped (each stage reads what is already written, ADR 0011)
      // instead of failing: its progress row stays running and a calendar trigger starts it again in a few seconds.
      await ownership.query(`insert into private.scheduled_actions (id, name, data, due_at, singleton_key)
        select gen_random_uuid(), 'ingest.document',
               jsonb_build_object('document_id', d.id, 'mode', 'resume', 'user_id', j.user_id, 'ai_job_id', j.id),
               now() + interval '5 seconds', 'ingest.document:resume:' || d.id
          from public.ai_jobs j join public.documents d on d.id = j.document_id
         where j.status in ('queued', 'running') and j.type in ('ingest.document', 'ingest.merge')
           and d.status = 'processing' and d.deleted_at is null
           and not exists (select 1 from private.scheduled_actions a where a.data->>'ai_job_id' = j.id::text)
        on conflict (singleton_key) do nothing`);
      const interrupted = JSON.stringify({ error: { code: 'ai_unavailable', message: 'O servidor reiniciou antes de concluir. Tente novamente.' } });
      await ownership.query(`update private.idempotency_keys set status_code = 503,
        response = jsonb_build_object('status', 503, 'contentType', 'application/json', 'body', $1::text)
        where status_code = 102`, [interrupted]);
      await ownership.query(`update public.ai_jobs set status = 'failed', error_code = 'interrupted', finished_at = now()
        where status in ('queued', 'running') and not exists
        (select 1 from private.scheduled_actions where data->>'ai_job_id' = ai_jobs.id::text)`);
      await ownership.query(`update public.documents set status = 'failed', error_code = 'ai_failed'
        where status = 'processing' and exists
        (select 1 from public.ai_jobs where document_id = documents.id and error_code = 'interrupted')`);
      await ownership.query("update public.notes set status = 'failed' where status in ('pending', 'generating')");
      await ownership.query("update public.podcast_episodes set status = 'failed', error_code = 'interrupted' where status in ('queued', 'scripting', 'synthesizing')");
      const taskConfig = loadTaskConfig({ ...process.env, DATABASE_URL: config.databaseUrl,
        SUPABASE_URL: config.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: config.serviceRoleKey,
        ANTHROPIC_API_KEY: config.anthropicApiKey, ANTHROPIC_BASE_URL: config.anthropicBaseUrl,
      });
      tasks = await createRuntime(taskConfig, { pool, supabase: db });
      await tasks.registry.register(await discoverOperations());
      await tasks.start();
    },
    async stop() {
      await tasks?.shutdown();
      if (ownership) { await ownership.query("select pg_advisory_unlock(hashtextextended('studify-api-runtime', 0))"); ownership.release(); }
      await pool.end();
    },
  };
}
