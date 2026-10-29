// Domain operation definitions shared by ingestion, generation, planning, grading and notifications.
import type { SupabaseClient } from '@supabase/supabase-js';
import type pg from 'pg';
import type { ClaudeDeps } from '@studify/ai';
import type { TtsProvider } from '@studify/speech';
import type { Logger } from 'pino';

export interface OperationContext {
  /** Service-role client (bypasses RLS) — authorize from job data, never trust it blindly. */
  supabase: SupabaseClient;
  /** Direct Postgres pool for transactions and private.* functions. */
  db: pg.Pool;
  /** Claude dependencies (client, BudgetStore over private.ai_budget_*, UsageSink → ai_usage). */
  ai: ClaudeDeps;
  log: Logger;
  /**
   * Invoke a child operation now and await it, or register a calendar trigger with `startAfter` (seconds or a date).
   * `startAfter: 0` starts it in the background within about a second, without holding the caller (ADR 0011).
   */
  execute: (name: string, data: Record<string, unknown>, opts?: { singletonKey?: string; startAfter?: Date | number }) => Promise<string | null>;
  /** Update the user-visible ai_jobs row mirrored for this the API runtime job (progress, stage, status). */
  progress: (patch: { stage?: string; status?: string; progress?: number; items_total?: number; items_done?: number; error_code?: string; error_message_key?: string }) => Promise<void>;
  /** Injected clock for deterministic tests. */
  now: () => Date;
  /** Push notifications via the Expo Push API (respects quiet hours + 3/day cap). */
  push: (userId: string, message: import('./push.ts').PushMessage) => Promise<void>;
  /** Cloud TTS for podcast audio (INT-01.4). Null: episodes are played with on-device TTS (INT-01.11). */
  tts?: TtsProvider | null;
  /** Content waves go to the Message Batches API (AI_USE_BATCH); otherwise they run as standard calls. */
  useBatch?: boolean;
  /** Standard calls a content wave runs at once (AI_WAVE_CONCURRENCY). */
  waveConcurrency?: number;
  /** The lane every ingestion and Trilha model call of this server waits in (one per runtime, see aiLane). */
  aiLane?: import('../ingest/concurrency.ts').AiLane;
}

export interface OperationDefinition<T = Record<string, unknown>> {
  /** Operation name from api.md §7, e.g. 'ingest.document'. */
  name: string;
  handler: (ctx: OperationContext, data: T, meta: { jobId: string; aiJobId: string | null; attempt: number }) => Promise<void>;
  /** Cron schedule (UTC) for recurring jobs, e.g. nightly plan recompute. */
  schedule?: string;
  /** Concurrent active invocations; overflow fails immediately instead of entering a queue. */
  concurrency?: number;
  /**
   * False: the runner keeps this job out of ai_jobs (no row of its own, no status written to the ai_job_id in its
   * data). For jobs that only read a job's progress (notify.live) and for side jobs that must not show up as a
   * material's progress (ingest.material_check).
   */
  tracksProgress?: boolean;
}
