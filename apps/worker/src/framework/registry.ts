// Job registration and execution. Every job module exports `jobs: JobDefinition[]` (framework/types.ts).
// This file turns a definition into a pg-boss (or in-memory) worker: queue creation with retry policy,
// the ai_jobs mirror, the JobContext each handler receives, and error classification.
import type { ClaudeDeps } from '@studify/ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { JobContext, JobDefinition } from './types.ts';
import { PermanentJobError } from './errors.ts';
import { applyProgress, ensureAiJob, isUuid, type ProgressPatch } from './progress.ts';
import type { PushService, PushMessage } from './push.ts';
import type { QueueBackend, QueueJob, QueueOptions, SendOptions } from './queue.ts';
import type { Logger } from './logger.ts';

export interface RuntimeDeps {
  backend: QueueBackend;
  pool: pg.Pool;
  supabase: SupabaseClient;
  claude: ClaudeDeps;
  push: PushService;
  log: Logger;
  now: () => Date;
}

const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_EXPIRE_SECONDS = 3600;

export class JobRegistry {
  private readonly queues = new Set<string>();
  private readonly definitions = new Map<string, JobDefinition<any>>();

  constructor(private readonly deps: RuntimeDeps) {}

  /** Registers definitions and starts the workers. Duplicate names are a startup error. */
  async register(definitions: ReadonlyArray<JobDefinition<any>>): Promise<void> {
    for (const def of definitions) {
      if (this.definitions.has(def.name)) throw new Error(`duplicate job name: ${def.name}`);
      this.definitions.set(def.name, def);
    }
    for (const def of definitions) {
      await this.ensureQueue(def.name, optionsFor(def));
      if (def.schedule) await this.deps.backend.schedule(def.name, def.schedule);
      await this.deps.backend.work(def.name, { localConcurrency: def.concurrency ?? 1 }, async (jobs) => {
        for (const job of jobs) await this.runOne(def, job);
      });
    }
  }

  /** Enqueues a job. Creates the queue with default options when no module registered it. */
  async enqueue(name: string, data: Record<string, unknown>, opts?: SendOptions): Promise<string | null> {
    const def = this.definitions.get(name);
    await this.ensureQueue(name, def ? optionsFor(def) : defaultOptions());
    return this.deps.backend.send(name, data, opts);
  }

  private async ensureQueue(name: string, options: QueueOptions): Promise<void> {
    if (this.queues.has(name)) return;
    if ((await this.deps.backend.getQueue(name)) === null) {
      await this.deps.backend.createQueue(name, options);
    }
    this.queues.add(name);
  }

  /** Runs one attempt of a job. Permanent errors complete the job; others are rethrown for a retry. */
  async runOne(def: JobDefinition<any>, job: QueueJob): Promise<void> {
    const data = (job.data ?? {}) as Record<string, unknown>;
    const attempt = job.retryCount + 1;
    const limit = def.retryLimit ?? DEFAULT_RETRY_LIMIT;
    const log = this.deps.log.child({ job: def.name, jobId: job.id, attempt });
    const aiJobId = await this.resolveAiJobId(def, job, data);
    const ctx = this.buildContext(log, aiJobId);
    if (aiJobId) await applyProgress(this.deps.pool, aiJobId, { status: 'running', attempts: attempt });
    const started = Date.now();
    try {
      await def.handler(ctx, data, { jobId: job.id, aiJobId, attempt });
      log.info({ durationMs: Date.now() - started }, 'job finished');
    } catch (err) {
      if (err instanceof PermanentJobError) {
        log.warn({ code: err.code }, 'job failed permanently');
        if (aiJobId) await applyProgress(this.deps.pool, aiJobId, { status: 'failed', error_code: err.code, error_message_key: err.messageKey, attempts: attempt });
        return;
      }
      const final = job.retryCount >= limit;
      log.error({ err: describe(err), final }, final ? 'job failed; no retries left' : 'job attempt failed; retrying');
      if (final && aiJobId) {
        await applyProgress(this.deps.pool, aiJobId, { status: 'failed', error_code: 'ai_failed', attempts: attempt });
      }
      throw err;
    }
  }

  private async resolveAiJobId(def: JobDefinition<any>, job: QueueJob, data: Record<string, unknown>): Promise<string | null> {
    if (isUuid(data.ai_job_id)) return data.ai_job_id;
    const subjectId = isUuid(data.subject_id) ? data.subject_id : null;
    const documentId = isUuid(data.document_id) ? data.document_id : null;
    if (!subjectId && !documentId) return null;
    const userId = isUuid(data.user_id) ? data.user_id : null;
    return ensureAiJob(this.deps.pool, { pgbossJobId: job.id, type: def.name, userId, subjectId, documentId });
  }

  private buildContext(log: Logger, aiJobId: string | null): JobContext {
    const deps = this.deps;
    return {
      supabase: deps.supabase,
      db: deps.pool,
      ai: deps.claude,
      log,
      enqueue: (name, data, opts) => this.enqueue(name, data, opts),
      progress: async (patch: ProgressPatch) => {
        if (aiJobId) await applyProgress(deps.pool, aiJobId, patch as ProgressPatch);
      },
      now: () => deps.now(),
      push: async (userId: string, message: PushMessage) => {
        await deps.push.push(userId, message);
      },
    };
  }
}

export function optionsFor(def: JobDefinition<any>): QueueOptions {
  return {
    retryLimit: def.retryLimit ?? DEFAULT_RETRY_LIMIT,
    retryDelay: 10,
    retryBackoff: def.retryBackoff ?? true,
    expireInSeconds: def.expireInSeconds ?? DEFAULT_EXPIRE_SECONDS,
  };
}

function defaultOptions(): QueueOptions {
  return { retryLimit: DEFAULT_RETRY_LIMIT, retryDelay: 10, retryBackoff: true, expireInSeconds: DEFAULT_EXPIRE_SECONDS };
}

function describe(err: unknown): { name: string; code?: string; message: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, ...(typeof code === 'string' ? { code } : {}), message: err.message.slice(0, 300) };
  }
  return { name: 'unknown', message: String(err).slice(0, 300) };
}

export function newJobId(): string {
  return randomUUID();
}
