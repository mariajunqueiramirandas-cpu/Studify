// A resumable SSE operation. Production work starts once; reconnects subscribe to the same live writer.
// Completed transcripts are persisted by the HTTP pipeline under the request's Idempotency-Key.
import { mapError } from './errors.ts';

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const ERROR_RESERVE_BYTES = 64 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const encoder = new TextEncoder();
type Subscriber = { controller: ReadableStreamDefaultController<Uint8Array>; detach(): void };

export class SseWriter {
  #frames: Array<{ id: number; text: string }> = [];
  #subscribers = new Set<Subscriber>();
  #bytes = 0;
  #closed = false;
  #terminal = false;
  #nextId = 1;

  get closed(): boolean { return this.#closed; }
  get terminal(): boolean { return this.#terminal; }
  get transcript(): string { return this.#frames.map((frame) => frame.text).join(''); }

  send(event: string, data: unknown): void {
    if (this.#closed || this.#terminal) return;
    if (!/^[a-z][a-z0-9_-]*$/i.test(event)) throw new Error('invalid SSE event name');
    const id = this.#nextId;
    const text = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const bytes = encoder.encode(text);
    // Keep room for a final error even if a producer exceeds its output allowance.
    const limit = event === 'error' ? MAX_TRANSCRIPT_BYTES : MAX_TRANSCRIPT_BYTES - ERROR_RESERVE_BYTES;
    if (this.#bytes + bytes.byteLength > limit) throw new Error('SSE output limit exceeded');
    this.#nextId++;
    this.#bytes += bytes.byteLength;
    this.#frames.push({ id, text });
    this.#terminal = event === 'done' || event === 'error';
    this.#broadcast(bytes);
  }

  /** Heartbeats are deliberately absent from the replay log and never advance event IDs. */
  comment(text: string): void {
    if (!this.#closed) this.#broadcast(encoder.encode(`: ${text.replace(/[\r\n]/g, '')}\n\n`));
  }

  #broadcast(bytes: Uint8Array): void {
    for (const subscriber of this.#subscribers) {
      try {
        if ((subscriber.controller.desiredSize ?? 0) < bytes.byteLength) {
          subscriber.controller.error(new Error('SSE consumer too slow; reconnect to resume'));
          subscriber.detach();
        } else subscriber.controller.enqueue(bytes);
      } catch { subscriber.detach(); }
    }
  }

  subscribe(headers: Record<string, string> = {}, afterId = 0, signal?: AbortSignal): Response {
    let subscriber: Subscriber;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const onAbort = () => { subscriber.detach(); try { controller.close(); } catch {} };
        subscriber = {
          controller,
          detach: () => {
            this.#subscribers.delete(subscriber);
            signal?.removeEventListener('abort', onAbort);
          },
        };
        // One replay chunk is bounded by the transcript cap. Future live data has a separate small buffer.
        const replay = this.#frames.filter((frame) => frame.id > afterId).map((frame) => frame.text).join('');
        controller.enqueue(encoder.encode(`: connected\n\n${replay}`));
        if (this.#closed || signal?.aborted) controller.close();
        else {
          this.#subscribers.add(subscriber);
          signal?.addEventListener('abort', onAbort, { once: true });
        }
      },
      cancel: () => subscriber?.detach(),
    }, { highWaterMark: MAX_PENDING_BYTES, size: (chunk) => chunk?.byteLength ?? 0 });
    return new Response(stream, { status: 200, headers: { ...SSE_HEADERS, ...headers } });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      try { subscriber.controller.close(); } catch {}
      subscriber.detach();
    }
  }
}

export interface SseSettled { ok: boolean; transcript: string }
export interface OpenSseOptions {
  heartbeatMs: number;
  headers?: Record<string, string>;
  onSettled?: (settled: SseSettled) => Promise<void>;
  signal?: AbortSignal;
}

/** Owns the producer, independently of any particular network connection. */
export class SseOperation {
  readonly writer = new SseWriter();
  readonly done: Promise<void>;
  constructor(options: OpenSseOptions, producer: (writer: SseWriter) => Promise<void>) {
    const timer = options.heartbeatMs > 0 ? setInterval(() => this.writer.comment('ping'), options.heartbeatMs) : undefined;
    timer?.unref?.();
    this.done = Promise.resolve().then(async () => {
      let ok = false;
      try {
        await producer(this.writer);
        if (!this.writer.terminal) throw new Error('SSE producer ended without a terminal event');
        ok = true;
      } catch (error) {
        const mapped = mapError(error);
        if (mapped.internal) console.error('sse producer failed', mapped.internal);
        this.writer.send('error', { ...mapped.body.error, status: mapped.status });
      }
      try {
        // Persist BEFORE closing. A reconnect after EOF must find a replay, never a stale in-flight lock.
        await options.onSettled?.({ ok, transcript: this.writer.transcript });
      } finally {
        if (timer !== undefined) clearInterval(timer);
        this.writer.close();
      }
    });
    // The caller can still await done; disconnected clients must never cause an unhandled rejection.
    void this.done.catch((error: unknown) => console.error('sse settlement failed', error));
  }
}

export function openSse(options: OpenSseOptions, producer: (writer: SseWriter) => Promise<void>): Response {
  const operation = new SseOperation(options, producer);
  return operation.writer.subscribe(options.headers, 0, options.signal);
}

export function replaySse(transcript: string, headers: Record<string, string> = {}, afterId = 0): Response {
  const body = afterId > 0
    ? transcript.split('\n\n').filter((frame) => Number(/^id: (\d+)/m.exec(frame)?.[1] ?? 0) > afterId).join('\n\n') + '\n\n'
    : transcript;
  return new Response(body, { status: 200, headers: { ...SSE_HEADERS, ...headers } });
}
