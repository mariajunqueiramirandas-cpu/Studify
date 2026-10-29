// Direct server operations. There is no pending queue, pickup delay, background consumer or automatic job retry.
// Existing domain handlers retain their payload/progress contract while running in the caller's SSE operation.
import type { ClaudeDeps } from '@studify/ai';
import type { SupabaseClient } from '@supabase/supabase-js';
import type pg from 'pg';
import { ApiFailure } from '@studify/shared';
import { randomUUID } from 'node:crypto';
import type { OperationContext, OperationDefinition } from './types.ts';
import { PermanentJobError } from './errors.ts';
import { STANDARD_WAVE_CONCURRENCY } from './concurrency-defaults.ts';
import { applyProgress, finishProgress, withProgressListener, ensureAiJob, isUuid, type ProgressPatch } from './progress.ts';
import type { PushService } from './push.ts';
import type { Logger } from './logger.ts';
import type { TtsProvider } from '@studify/speech';
import type { Schedule, ScheduleOptions } from './scheduler.ts';

export interface RuntimeDeps {
  pool: pg.Pool;
  supabase: SupabaseClient;
  claude: ClaudeDeps;
  push: PushService;
  log: Logger;
  now: () => Date;
  schedule: Schedule;
  cron?: (name: string, expression: string) => void;
  tts?: TtsProvider | null;
  waveConcurrency?: number;
  /** Batch-domain tests only; production always uses direct standard calls. */
  useBatch?: boolean;
}
export interface Invocation {
  onProgress?: (id: string, patch: ProgressPatch) => void;
  signal?: AbortSignal;
}
export class OperationRegistry {
  private definitions = new Map<string, OperationDefinition<any>>();
  private active = new Map<string, Promise<string | null>>();
  private counts = new Map<string, number>();
  private running = new Set<Promise<unknown>>();
  private stopped = false;
  constructor(private deps: RuntimeDeps) {}
  async register(definitions: ReadonlyArray<OperationDefinition<any>>): Promise<void> {
    for (const def of definitions) {
      if (this.definitions.has(def.name)) throw new Error(`duplicate operation name: ${def.name}`);
      this.definitions.set(def.name, def);
      if (def.schedule) this.deps.cron?.(def.name, def.schedule);
    }
  }
  execute(name: string, data: Record<string, unknown>, options: ScheduleOptions = {}, invocation: Invocation = {}): Promise<string | null> {
    if (this.stopped) return Promise.reject(new Error('server operations are stopping'));
    if (!this.definitions.has(name)) return Promise.reject(new Error(`unknown operation: ${name}`));
    if (options.startAfter !== undefined) return this.deps.schedule(name, data, options);
    const singleton = options.singletonKey ? `${name}:${options.singletonKey}` : undefined;
    const existing = singleton ? this.active.get(singleton) : undefined;
    if (existing) return existing;
    const count = this.counts.get(name) ?? 0;
    if (count >= (this.definitions.get(name)!.concurrency ?? 16)) {
      return Promise.reject(new ApiFailure('rate_limited', { message: 'O servidor está ocupado com outras gerações. Tente novamente em instantes.' }));
    }
    this.counts.set(name, count + 1);
    const promise = withProgressListener(invocation.onProgress, () => this.run(name, data, invocation));
    if (singleton) this.active.set(singleton, promise);
    this.running.add(promise);
    void promise.finally(() => {
      this.running.delete(promise);
      this.counts.set(name, (this.counts.get(name) ?? 1) - 1);
      if (singleton) this.active.delete(singleton);
    }).catch(() => undefined);
    return promise;
  }
  private async run(name: string, data: Record<string, unknown>, invocation: Invocation): Promise<string> {
    invocation.signal?.throwIfAborted();
    const def = this.definitions.get(name)!;
    const id = randomUUID();
    // A row handed in (data.ai_job_id) belongs to the caller, which finishes it; a row created here is this operation's.
    const ownsRow = def.tracksProgress !== false && !isUuid(data.ai_job_id) && (isUuid(data.subject_id) || isUuid(data.document_id));
    const aiJobId = def.tracksProgress === false ? null : isUuid(data.ai_job_id) ? data.ai_job_id :
      ownsRow ? await ensureAiJob(this.deps.pool, {
        operationId: id, type: name, userId: isUuid(data.user_id) ? data.user_id : null,
        subjectId: isUuid(data.subject_id) ? data.subject_id : null, documentId: isUuid(data.document_id) ? data.document_id : null,
      }) : null;
    const progress = async (patch: ProgressPatch) => {
      if (aiJobId) {
        await applyProgress(this.deps.pool, aiJobId, patch);
      }
    };
    const ctx: OperationContext = {
      supabase: this.deps.supabase, db: this.deps.pool,
      ai: { ...this.deps.claude, signal: invocation.signal },
      log: this.deps.log.child({ operation: name, operationId: id }),
      now: this.deps.now,
      execute: (child, payload, options) => this.execute(child, payload, options, invocation),
      progress, push: async (user, message) => { await this.deps.push.push(user, message); },
      tts: this.deps.tts ?? null, useBatch: this.deps.useBatch ?? false,
      waveConcurrency: this.deps.waveConcurrency ?? STANDARD_WAVE_CONCURRENCY,
    };
    await progress({ status: 'running', attempts: 1 });
    try {
      await def.handler(ctx, data, { jobId: id, aiJobId, attempt: 1 });
      invocation.signal?.throwIfAborted();
      // Most operations never write their own success: left running, the row kept the app polling and counted toward
      // the student's three jobs in flight for good.
      if (ownsRow && aiJobId) await finishProgress(this.deps.pool, aiJobId);
      return id;
    } catch (error) {
      const code = error instanceof PermanentJobError ? error.code : 'ai_failed';
      await progress({ status: 'failed', error_code: code });
      throw error;
    }
  }
  async stop(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running]);
    this.stopped = true;
  }
}
