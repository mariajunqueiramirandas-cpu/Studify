// API function callers (api.md §2; apps/api serves /api/<name>): JSON calls with Idempotency-Key and error-envelope mapping,
// and SSE streaming via XMLHttpRequest (React Native's fetch does not expose a readable stream).
// ADR 0009: no request waits on the server's AI work. Every call repeats with the same Idempotency-Key until the
// answer is final (`202 running` means ask again), each attempt has a deadline, and a dropped stream resumes.
import { uuidv7 } from 'uuidv7';
import { SYNC_SCHEMA_VERSION } from '../db/sync/constants';
import { getDeviceId } from '../lib/device';
import { getApiUrl, getEnv } from './env';
import { ApiError, apiErrorFromResponse, offlineError } from './errors';
import {
  NETWORK_ATTEMPTS,
  OPERATION_DEADLINE_MS,
  STREAM_STALL_MS,
  abortableSleep,
  backoffMs,
  isRunning,
  operationKeyOf,
  retryAfterMs,
  timeoutError,
  untilSettled,
  type Reply,
} from './operation';
import { createSseParser } from './sse';
import { supabase } from './supabase';
import Constants from 'expo-constants';

export { ApiError } from './errors';

export interface CallOptions {
  /** Reused on retries so the server returns the stored response. Generated when omitted. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/** Events of a streaming endpoint (api.md §2.6). */
export type SseEvent =
  | { event: 'meta'; data: { request_id: string; message_id?: string; thread_id?: string } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'citation'; data: Record<string, unknown> & { index: number } }
  | { event: 'tool'; data: { name: string; payload: unknown } }
  | { event: 'status'; data: { key: string; params?: object } }
  | { event: 'done'; data: { stop_reason: 'end_turn' | 'max_tokens' | 'refusal'; usage_pct_today: number; result?: unknown } }
  | { event: 'error'; data: { code: string; message: string } };

export interface StreamHandle {
  cancel(): void;
  /** Resolves when the stream ends with `done`; rejects with ApiError otherwise. */
  done: Promise<void>;
}

const appVersionCode = (): string => {
  const android = Constants.expoConfig?.android as { versionCode?: number } | undefined;
  return String(android?.versionCode ?? 1);
};

async function authHeaders(idempotencyKey: string | null): Promise<Record<string, string>> {
  const env = getEnv();
  const { data } = await supabase.auth.getSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.session?.access_token ?? env.anonKey}`,
    'x-studify-version': appVersionCode(),
    'x-studify-schema': String(SYNC_SCHEMA_VERSION),
    'x-device-id': getDeviceId(),
    // ADR 0009: this build repeats a call until it settles, so the server may answer `202 running` and defer AI work.
    'x-studify-operations': '1',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

/**
 * POST an API function and return its JSON body. Errors become ApiError with the stable `code`.
 * A 401 refreshes the session once and retries with the same Idempotency-Key. While the server answers
 * `202 running` the call is repeated with the same key, so the result of slow AI work arrives without a long-held
 * connection; a network failure or a silent attempt is retried the same way (operation.ts).
 */
export async function callFunction<TReq, TRes>(name: string, body: TReq, opts: CallOptions = {}): Promise<TRes> {
  const url = `${getApiUrl()}/${name}`;
  const payload = JSON.stringify(body ?? {});
  const send = async (key: string, signal: AbortSignal): Promise<Reply> => {
    const post = async (): Promise<Response> => fetch(url, { method: 'POST', headers: await authHeaders(key), body: payload, signal });
    let response = await post();
    if (response.status === 401) {
      await supabase.auth.refreshSession();
      response = await post();
    }
    return { status: response.status, header: (h) => response.headers.get(h), text: await response.text() };
  };

  const reply = await untilSettled({ send }, opts.idempotencyKey ?? uuidv7(), opts.signal);
  if (reply.status < 200 || reply.status >= 300) throw apiErrorFromResponse(reply.status, reply.text);
  return (reply.text ? JSON.parse(reply.text) : null) as TRes;
}

const cancelledError = (): ApiError => new ApiError('cancelled', 0, 'Cancelado.');

/** What one stream attempt ended with: the `done` event, or "still running, ask again". */
type StreamAttempt = { kind: 'done' } | { kind: 'running'; key: string; retryAfterMs: number };

/**
 * Streams an SSE endpoint. `onEvent` receives each event in order, once. A stream that drops or goes silent
 * (STREAM_STALL_MS without a byte, heartbeats included) reconnects with the same Idempotency-Key: the server answers
 * `202 running` until the turn is finished, then replays the stored stream, whose events already delivered are
 * skipped. An `error` event rejects `done` with that ApiError.
 */
export function streamFunction<TReq>(
  name: string,
  body: TReq,
  onEvent: (event: SseEvent) => void,
  opts: CallOptions = {},
): StreamHandle {
  let key = opts.idempotencyKey ?? uuidv7();
  const url = `${getApiUrl()}/${name}`;
  const controller = new AbortController();
  let activeXhr: XMLHttpRequest | null = null;
  /** Events handed to `onEvent` so far, across attempts: a replay starts over and skips these. */
  let delivered = 0;

  const runOnce = async (): Promise<StreamAttempt> => {
    const headers = await authHeaders(key);
    return new Promise<StreamAttempt>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhr = xhr;
      let seen = 0;
      let index = 0;
      let finished = false;
      let streamError: ApiError | null = null;
      let stalled = false;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const armStall = () => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stalled = true;
          xhr.abort();
        }, STREAM_STALL_MS);
      };
      const settle = () => {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
      };
      const parser = createSseParser((message) => {
        if (finished) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }
        index += 1;
        if (index > delivered) {
          delivered = index;
          onEvent({ event: message.event, data: parsed } as SseEvent);
        }
        if (message.event === 'done') finished = true;
        if (message.event === 'error') {
          const data = parsed as { code?: unknown; message?: unknown };
          streamError = new ApiError(
            typeof data.code === 'string' ? data.code : 'unknown',
            0,
            typeof data.message === 'string' ? data.message : 'Algo deu errado. Tente de novo em instantes.',
          );
        }
      });
      const flushNew = () => {
        const text: string = xhr.responseText ?? '';
        if (text.length > seen) {
          parser.feed(text.slice(seen));
          seen = text.length;
        }
      };
      const header = (h: string) => xhr.getResponseHeader(h);

      xhr.open('POST', url, true);
      for (const [h, v] of Object.entries(headers)) xhr.setRequestHeader(h, v);
      xhr.onreadystatechange = armStall;
      xhr.onprogress = () => {
        armStall();
        if (xhr.status === 200) flushNew();
      };
      xhr.onerror = () => {
        settle();
        reject(offlineError());
      };
      xhr.onabort = () => {
        settle();
        reject(stalled ? timeoutError() : cancelledError());
      };
      xhr.onload = () => {
        settle();
        if (isRunning(xhr.status, header)) {
          resolve({ kind: 'running', key: operationKeyOf(xhr.responseText ?? '', key), retryAfterMs: retryAfterMs(header) });
          return;
        }
        if (xhr.status >= 400) {
          reject(apiErrorFromResponse(xhr.status, xhr.responseText ?? ''));
          return;
        }
        flushNew();
        parser.flush();
        if (finished) resolve({ kind: 'done' });
        else if (streamError) reject(streamError);
        else reject(offlineError()); // ended without `done`: treated as a dropped connection
      };
      armStall();
      xhr.send(JSON.stringify(body ?? {}));
    });
  };

  const done = (async () => {
    const started = Date.now();
    const pause = (ms: number) =>
      abortableSleep(ms, controller.signal).catch(() => {
        throw cancelledError();
      });
    let drops = 0;
    for (;;) {
      if (controller.signal.aborted) throw cancelledError();
      let outcome: StreamAttempt;
      try {
        outcome = await runOnce();
      } catch (error) {
        if (controller.signal.aborted) throw cancelledError();
        // A drop (`offline`) or a stall (`timeout`) reconnects with the same key; anything else is the answer.
        const dropped = error instanceof ApiError && (error.code === 'offline' || error.code === 'timeout');
        if (!dropped) throw error;
        drops += 1;
        if (drops >= NETWORK_ATTEMPTS || Date.now() - started >= OPERATION_DEADLINE_MS) throw error;
        await pause(backoffMs(drops));
        continue;
      }
      if (outcome.kind === 'done') return;
      drops = 0;
      key = outcome.key;
      if (Date.now() - started >= OPERATION_DEADLINE_MS) throw timeoutError();
      await pause(outcome.retryAfterMs);
    }
  })();

  const cancel = () => {
    controller.abort();
    activeXhr?.abort();
  };
  opts.signal?.addEventListener('abort', cancel);

  return { cancel, done };
}
