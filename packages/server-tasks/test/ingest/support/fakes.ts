// In-memory stand-ins for Supabase Storage and for the job queue. The integration test runs the real
// OperationRegistry over the in-memory backend, so every retry, permanent failure and ai_jobs mirror is exercised.
import type { Db } from '@studify/db';
import type { ScheduleOptions as SendOptions } from '../../../src/framework/scheduler.ts';
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

/** Only the storage surface of the database client is provided; the pipeline never calls other APIs on it. */
export function fakeStorageDb(store: FakeObjectStore): Db {
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
  return client as unknown as Db;
}

/** Test clock for delayed calendar actions. Immediate operations run in the real registry. */
export class InMemoryQueue {
  readonly sent: Array<{ name: string; data: Record<string, unknown>; options?: SendOptions }> = [];
  readonly pending: Array<{ name: string; data: Record<string, unknown> }> = [];
  readonly failedJobs: Array<{ name: string; error: string }> = [];
  run!: (name: string, data: Record<string, unknown>) => Promise<unknown>;
  async send(name: string, data: Record<string, unknown>, options?: SendOptions): Promise<string> {
    this.sent.push({ name, data, options });
    this.pending.push({ name, data });
    return randomUUID();
  }
  async drain(maxSteps = 500): Promise<number> {
    let steps = 0;
    while (this.pending.length && steps++ < maxSteps) {
      const task = this.pending.shift()!;
      try { await this.run(task.name, task.data); }
      catch (error) { this.failedJobs.push({ name: task.name, error: String(error) }); }
    }
    return steps;
  }
  sentNamed(name: string) { return this.sent.filter((action) => action.name === name); }
}
