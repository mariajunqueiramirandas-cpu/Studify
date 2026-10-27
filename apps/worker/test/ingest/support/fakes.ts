// In-memory stand-ins for Supabase Storage and for the job queue. The integration test runs the real
// JobRegistry over the in-memory backend, so every retry, permanent failure and ai_jobs mirror is exercised.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { QueueBackend, QueueJob, QueueOptions, SendOptions } from '../../../src/framework/queue.ts';
import { randomUUID } from 'node:crypto';

export class FakeObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();

  private key(bucket: string, path: string): string {
    return `${bucket}/${path}`;
  }

  put(bucket: string, path: string, bytes: Uint8Array, contentType = 'application/octet-stream'): void {
    this.objects.set(this.key(bucket, path), { bytes, contentType });
  }

  async download(bucket: string, path: string): Promise<Uint8Array> {
    const hit = this.objects.get(this.key(bucket, path));
    if (!hit) throw new Error(`storage ${bucket}: object not found ${path}`);
    return hit.bytes;
  }

  async upload(bucket: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.put(bucket, path, bytes, contentType);
  }

  async remove(bucket: string, paths: string[]): Promise<void> {
    for (const p of paths) this.objects.delete(this.key(bucket, p));
  }

  keysIn(bucket: string): string[] {
    const prefix = `${bucket}/`;
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
  }
}

/** Only the storage surface of supabase-js is provided; the pipeline never calls other APIs on it. */
export function fakeSupabase(store: FakeObjectStore): SupabaseClient {
  const client = {
    storage: {
      from(bucket: string) {
        return {
          async download(path: string) {
            try {
              const bytes = await store.download(bucket, path);
              return { data: new Blob([new Uint8Array(bytes)]), error: null };
            } catch (err) {
              return { data: null, error: { message: err instanceof Error ? err.message : 'missing' } };
            }
          },
          async upload(path: string, body: Uint8Array, options?: { contentType?: string }) {
            await store.upload(bucket, path, new Uint8Array(body), options?.contentType ?? 'application/octet-stream');
            return { data: { path }, error: null };
          },
          async remove(paths: string[]) {
            await store.remove(bucket, paths);
            return { data: [], error: null };
          },
        };
      },
    },
  };
  return client as unknown as SupabaseClient;
}

interface Pending {
  id: string;
  name: string;
  data: Record<string, unknown>;
  retryCount: number;
  startAfter: number;
  singletonKey: string | null;
}

/**
 * Queue backend for tests. `send` honours singletonKey while a job with the same key is pending;
 * `startAfter` is recorded but jobs run as soon as `drain` reaches them (time is not simulated).
 */
export class InMemoryQueue implements QueueBackend {
  readonly queues = new Map<string, QueueOptions>();
  readonly handlers = new Map<string, (jobs: QueueJob[]) => Promise<void>>();
  readonly pending: Pending[] = [];
  readonly sent: Array<{ name: string; data: Record<string, unknown>; options?: SendOptions }> = [];
  readonly failedJobs: Array<{ name: string; error: string }> = [];

  async getQueue(name: string) {
    return this.queues.get(name) ?? null;
  }

  async createQueue(name: string, options: QueueOptions) {
    this.queues.set(name, options);
  }

  async send(name: string, data: Record<string, unknown>, options?: SendOptions): Promise<string | null> {
    this.sent.push({ name, data, options });
    if (options?.singletonKey && this.pending.some((p) => p.singletonKey === options.singletonKey)) return null;
    const id = randomUUID();
    this.pending.push({
      id,
      name,
      data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
      retryCount: 0,
      startAfter: 0,
      singletonKey: options?.singletonKey ?? null,
    });
    return id;
  }

  async work(name: string, _options: { localConcurrency: number }, handler: (jobs: QueueJob[]) => Promise<void>): Promise<void> {
    this.handlers.set(name, handler);
  }

  async schedule(): Promise<void> {
    /* cron jobs are triggered explicitly in tests */
  }

  async stop(): Promise<void> {
    /* nothing to stop */
  }

  /**
   * Runs jobs until the queue is empty or `maxSteps` is reached. A throwing handler is retried up to the
   * queue's retryLimit (pg-boss semantics without the delay), then recorded in failedJobs.
   */
  async drain(maxSteps = 500): Promise<number> {
    let steps = 0;
    while (this.pending.length > 0 && steps < maxSteps) {
      steps++;
      const job = this.pending.shift() as Pending;
      const handler = this.handlers.get(job.name);
      if (!handler) throw new Error(`no worker registered for ${job.name}`);
      try {
        await handler([{ id: job.id, name: job.name, data: job.data, retryCount: job.retryCount }]);
      } catch (err) {
        const limit = this.queues.get(job.name)?.retryLimit ?? 3;
        if (job.retryCount < limit) {
          this.pending.push({ ...job, retryCount: job.retryCount + 1 });
        } else {
          this.failedJobs.push({ name: job.name, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    return steps;
  }

  /** Enqueued jobs of one name (for assertions about what the pipeline scheduled). */
  sentNamed(name: string) {
    return this.sent.filter((s) => s.name === name);
  }
}
