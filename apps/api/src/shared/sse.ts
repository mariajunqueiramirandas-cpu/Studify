// Server-sent events for streaming endpoints (api.md §2.6). Frames are `event: <name>` + `data: <json>`.
// Every frame is also kept in a transcript, so a completed stream can be stored under its Idempotency-Key
// and replayed (api §2.6: a retry returns the completed message instead of generating again).
import { mapError } from './errors.ts';

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

export class SseWriter {
  #controller: ReadableStreamDefaultController<Uint8Array>;
  #encoder = new TextEncoder();
  #transcript = '';
  #closed = false;
  /** The client went away. Frames still go to the transcript so the finished stream can be replayed (ADR 0009). */
  #detached = false;

  constructor(controller: ReadableStreamDefaultController<Uint8Array>) {
    this.#controller = controller;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get transcript(): string {
    return this.#transcript;
  }

  send(event: string, data: unknown): void {
    this.#write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Comment line: keeps mobile networks from dropping an idle stream while the model thinks (ai-pipeline §10.2). */
  comment(text: string): void {
    this.#write(`: ${text}\n\n`);
  }

  /** Stops writing to the socket; the producer keeps running and the transcript keeps growing. */
  detach(): void {
    this.#detached = true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#detached) return;
    try {
      this.#controller.close();
    } catch {
      // Cancelled underneath us: nothing left to close.
    }
  }

  #write(frame: string): void {
    if (this.#closed) return;
    this.#transcript += frame;
    if (this.#detached) return;
    try {
      this.#controller.enqueue(this.#encoder.encode(frame));
    } catch {
      // The client disconnected between frames. Keep the transcript; a reconnect with the same key replays it.
      this.#detached = true;
    }
  }
}

export interface SseSettled {
  ok: boolean;
  transcript: string;
}

export interface OpenSseOptions {
  /** 0 disables the heartbeat (tests). Production uses 15 s. */
  heartbeatMs: number;
  headers?: Record<string, string>;
  /** Called once the producer finished (ok) or failed (error event sent). */
  onSettled?: (settled: SseSettled) => Promise<void>;
  /** Called when the client disconnects before the producer finishes. */
  onCancel?: () => void;
}

/**
 * Starts a text/event-stream response. `producer` sends the events, including `done`. A thrown error
 * becomes a final `error` event with the ApiError body (api §2.6), so the stream always ends cleanly.
 */
export function openSse(options: OpenSseOptions, producer: (writer: SseWriter) => Promise<void>): Response {
  let timer: ReturnType<typeof setInterval> | undefined;
  let writer: SseWriter | undefined;
  const stopHeartbeat = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      writer = new SseWriter(controller);
      const out = writer;
      if (options.heartbeatMs > 0) {
        timer = setInterval(() => out.comment('ping'), options.heartbeatMs);
      }
      const settle = async (ok: boolean) => {
        stopHeartbeat();
        out.close();
        await options.onSettled?.({ ok, transcript: out.transcript });
      };
      producer(out)
        .then(() => settle(true))
        .catch(async (err: unknown) => {
          const mapped = mapError(err);
          if (mapped.internal) console.error('sse producer failed', mapped.internal);
          out.send('error', mapped.body.error);
          await settle(false);
        })
        .catch((err: unknown) => console.error('sse settle failed', err));
    },
    cancel() {
      // The client disconnected. The producer finishes into the transcript, which is stored under the
      // Idempotency-Key, so the app's reconnect gets the whole answer instead of a second generation.
      writer?.detach();
      stopHeartbeat();
      options.onCancel?.();
    },
  });
  return new Response(stream, { status: 200, headers: { ...SSE_HEADERS, ...(options.headers ?? {}) } });
}

/** A completed SSE body replayed from idempotency storage: no generation, same frames. */
export function replaySse(transcript: string, headers: Record<string, string> = {}): Response {
  return new Response(transcript, { status: 200, headers: { ...SSE_HEADERS, ...headers } });
}
