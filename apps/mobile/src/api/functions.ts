// Edge Function callers (api.md §2): JSON calls with Idempotency-Key and error-envelope mapping,
// and SSE streaming via XMLHttpRequest (React Native's fetch does not expose a readable stream).
import { uuidv7 } from 'uuidv7';
import { SYNC_SCHEMA_VERSION } from '../db/sync/constants';
import { getDeviceId } from '../lib/device';
import { getEnv } from './env';
import { ApiError, apiErrorFromResponse, offlineError } from './errors';
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
    apikey: env.anonKey,
    'x-studify-version': appVersionCode(),
    'x-studify-schema': String(SYNC_SCHEMA_VERSION),
    'x-device-id': getDeviceId(),
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

/**
 * POST an Edge Function and return its JSON body. Errors become ApiError with the stable `code`.
 * A 401 refreshes the session once and retries with the same Idempotency-Key.
 */
export async function callFunction<TReq, TRes>(name: string, body: TReq, opts: CallOptions = {}): Promise<TRes> {
  const key = opts.idempotencyKey ?? uuidv7();
  const url = `${getEnv().url}/functions/v1/${name}`;
  const send = async (): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: await authHeaders(key),
      body: JSON.stringify(body ?? {}),
      signal: opts.signal,
    });

  let response: Response;
  try {
    response = await send();
    if (response.status === 401) {
      await supabase.auth.refreshSession();
      response = await send();
    }
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw cause;
    throw offlineError();
  }

  const text = await response.text();
  if (!response.ok) throw apiErrorFromResponse(response.status, text);
  return (text ? JSON.parse(text) : null) as TRes;
}

/**
 * Streams an SSE endpoint. `onEvent` receives each event in order. A dropped connection before
 * `done` is retried once with the same Idempotency-Key (the server returns the stored message).
 */
export function streamFunction<TReq>(
  name: string,
  body: TReq,
  onEvent: (event: SseEvent) => void,
  opts: CallOptions = {},
): StreamHandle {
  const key = opts.idempotencyKey ?? uuidv7();
  const url = `${getEnv().url}/functions/v1/${name}`;
  let cancelled = false;
  let activeXhr: XMLHttpRequest | null = null;

  const runOnce = async (): Promise<void> => {
    const headers = await authHeaders(key);
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhr = xhr;
      let seen = 0;
      let finished = false;
      const parser = createSseParser((message) => {
        if (finished) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(message.data);
        } catch {
          return;
        }
        onEvent({ event: message.event, data: parsed } as SseEvent);
        if (message.event === 'done') finished = true;
      });
      const flushNew = () => {
        const text: string = xhr.responseText ?? '';
        if (text.length > seen) {
          parser.feed(text.slice(seen));
          seen = text.length;
        }
      };

      xhr.open('POST', url, true);
      for (const [h, v] of Object.entries(headers)) xhr.setRequestHeader(h, v);
      xhr.onprogress = flushNew;
      xhr.onerror = () => reject(offlineError());
      xhr.onabort = () => reject(new ApiError('cancelled', 0, 'Cancelado.'));
      xhr.onload = () => {
        flushNew();
        parser.flush();
        if (xhr.status >= 400) {
          reject(apiErrorFromResponse(xhr.status, xhr.responseText ?? ''));
        } else if (finished) {
          resolve();
        } else {
          reject(offlineError()); // ended without `done`: treated as a dropped connection
        }
      };
      xhr.send(JSON.stringify(body ?? {}));
    });
  };

  const done = (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await runOnce();
        return;
      } catch (error) {
        if (cancelled || attempt === 1) throw error;
        if (error instanceof ApiError && error.code !== 'offline') throw error;
      }
    }
  })();

  opts.signal?.addEventListener('abort', () => {
    cancelled = true;
    activeXhr?.abort();
  });

  return {
    cancel() {
      cancelled = true;
      activeXhr?.abort();
    },
    done,
  };
}
