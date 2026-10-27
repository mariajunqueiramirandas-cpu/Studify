// Contract shared by every job module (api.md §7). The framework (boss setup, clients, budget
// store, usage sink) lives in this folder; job modules live in src/jobs/ and only export
// `jobs: JobDefinition[]`, which src/index.ts registers with pg-boss.
import type { SupabaseClient } from '@supabase/supabase-js';
import type pg from 'pg';
import type { ClaudeDeps } from '@studify/ai';
import type { TtsProvider } from '@studify/speech';
import type { Logger } from 'pino';

export interface JobContext {
  /** Service-role client (bypasses RLS) — authorize from job data, never trust it blindly. */
  supabase: SupabaseClient;
  /** Direct Postgres pool for transactions and private.* functions. */
  db: pg.Pool;
  /** Claude dependencies (client, BudgetStore over private.ai_budget_*, UsageSink → ai_usage). */
  ai: ClaudeDeps;
  log: Logger;
  /** Enqueue a follow-up job (pg-boss send). */
  enqueue: (name: string, data: Record<string, unknown>, opts?: { singletonKey?: string; startAfter?: Date | number }) => Promise<string | null>;
  /** Update the user-visible ai_jobs row mirrored for this pg-boss job (progress, stage, status). */
  progress: (patch: { stage?: string; status?: string; progress?: number; items_total?: number; items_done?: number; error_code?: string; error_message_key?: string }) => Promise<void>;
  /** Injected clock for deterministic tests. */
  now: () => Date;
  /** Push notifications via the Expo Push API (respects quiet hours + 3/day cap). */
  push: (userId: string, message: { channel: 'reviews' | 'plan' | 'class' | 'processing'; title: string; body: string; data?: Record<string, unknown>; requested?: boolean }) => Promise<void>;
  /** Cloud TTS for podcast audio (INT-01.4). Null: episodes are played with on-device TTS (INT-01.11). */
  tts?: TtsProvider | null;
}

export interface JobDefinition<T = Record<string, unknown>> {
  /** pg-boss queue name from api.md §7, e.g. 'ingest.document'. */
  name: string;
  handler: (ctx: JobContext, data: T, meta: { jobId: string; aiJobId: string | null; attempt: number }) => Promise<void>;
  /** Cron schedule (UTC) for recurring jobs, e.g. nightly plan recompute. */
  schedule?: string;
  retryLimit?: number;
  retryBackoff?: boolean;
  expireInSeconds?: number;
  /** Max concurrent handlers of this queue in one worker process. */
  concurrency?: number;
}
