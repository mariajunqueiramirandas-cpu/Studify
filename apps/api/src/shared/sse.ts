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

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.close();
  }

  #write(frame: string): void {
    if (this.#closed) return;
    this.#transcript += frame;
    this.#controller.enqueue(this.#encoder.encode(frame));
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
  const stopHeartbeat = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const writer = new SseWriter(controller);
      if (options.heartbeatMs > 0) {
        timer = setInterval(() => writer.comment('ping'), options.heartbeatMs);
      }
      const settle = async (ok: boolean) => {
        stopHeartbeat();
        writer.close();
        await options.onSettled?.({ ok, transcript: writer.transcript });
      };
      producer(writer)
        .then(() => settle(true))
        .catch(async (err: unknown) => {
          const mapped = mapError(err);
          if (mapped.internal) console.error('sse producer failed', mapped.internal);
          writer.send('error', mapped.body.error);
          await settle(false);
        });
    },
    cancel() {
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
