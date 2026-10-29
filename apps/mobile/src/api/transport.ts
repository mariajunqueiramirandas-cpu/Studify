// Streaming transport, independent of Expo so packet boundaries, reconnects and deadlines can be tested in Node.
import { ApiError, apiErrorFromResponse, offlineError } from './errors';
import { createSseParser } from './sse';
import { abortableSleep, backoffMs, timeoutError, NETWORK_ATTEMPTS, REQUEST_DEADLINE_MS, STREAM_STALL_MS, OPERATION_DEADLINE_MS } from './operation';

export interface StreamMessage { event: string; data: unknown }
export interface StreamingRequest {
  send(lastEventId: string | undefined, signal: AbortSignal): Promise<Response>;
  onEvent(message: StreamMessage): void;
  signal?: AbortSignal;
  /** Injected for transport tests. */
  stallMs?: number;
  deadlineMs?: number;
  sleep?: typeof abortableSleep;
}

const cancelled = () => new ApiError('cancelled', 0, 'Cancelado.');

export async function receiveStream(options: StreamingRequest): Promise<void> {
  let lastId: string | undefined;
  let delivered = 0;
  let drops = 0;
  const deadline = Date.now() + (options.deadlineMs ?? OPERATION_DEADLINE_MS);
  for (;;) {
    if (options.signal?.aborted) throw cancelled();
    const controller = new AbortController();
    const forward = () => controller.abort();
    options.signal?.addEventListener('abort', forward, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(0, Math.min(ms, deadline - Date.now())));
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let terminal = false;
    let consumerError = false;
    const previousId = lastId;
    const deliver = (message: StreamMessage) => {
      try { options.onEvent(message); }
      catch (error) { consumerError = true; throw error; }
    };
    try {
      arm(REQUEST_DEADLINE_MS);
      const response = await options.send(lastId, controller.signal);
      if (!response.ok) throw apiErrorFromResponse(response.status, await response.text());
      if (!response.headers.get('content-type')?.startsWith('text/event-stream')) {
        // During a server-first rollout, old JSON/cache-hit responses remain readable.
        const text = await response.text();
        deliver({ event: 'done', data: { stop_reason: 'end_turn', result: text ? JSON.parse(text) : null, status: response.status } });
        return;
      }
      if (!response.body) throw offlineError();
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let index = 0;
      const parser = createSseParser((message) => {
        if (terminal) return;
        index++;
        if (message.id !== undefined) {
          if (!/^\d+$/.test(message.id)) throw new ApiError('invalid_response', 0, 'Resposta inválida do servidor.');
          if (lastId !== undefined && Number(message.id) <= Number(lastId)) return;
        } else if (index <= delivered) return;
        let data: unknown;
        try { data = JSON.parse(message.data); }
        catch { throw new ApiError('invalid_response', 0, 'Resposta inválida do servidor.'); }
        if (message.event === 'error') {
          terminal = true;
          const failure = data as { status?: number };
          deliver({ event: 'error', data });
          throw apiErrorFromResponse(failure.status ?? 0, JSON.stringify({ error: data }));
        }
        deliver({ event: message.event, data });
        if (message.id !== undefined) lastId = message.id;
        delivered = Math.max(delivered, index);
        if (message.event === 'done') terminal = true;
      });
      while (!terminal) {
        arm(options.stallMs ?? STREAM_STALL_MS);
        const chunk = await reader.read();
        if (chunk.done) {
          parser.feed(decoder.decode());
          parser.flush();
          if (!terminal) throw offlineError();
          break;
        }
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
      return;
    } catch (error) {
      if (options.signal?.aborted) throw cancelled();
      // An explicit terminal error is final, including errors whose codes resemble network failures.
      if (terminal || consumerError) throw error;
      const failure = timedOut ? timeoutError() : error instanceof ApiError ? error : offlineError();
      if (failure.code !== 'offline' && failure.code !== 'timeout') throw failure;
      if (lastId !== previousId) drops = 0;
      drops++;
      if (drops >= NETWORK_ATTEMPTS || Date.now() >= deadline) throw failure;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener('abort', forward);
      controller.abort();
      if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    }
    try { await (options.sleep ?? abortableSleep)(backoffMs(drops), options.signal); }
    catch (error) { if (options.signal?.aborted) throw cancelled(); throw error; }
  }
}
