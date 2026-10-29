// Structured results and token deltas share one resumable SSE transport (ADR 0010).
import { uuidv7 } from 'uuidv7';
import { CLIENT_COMPAT_HEADER, CLIENT_COMPAT_LEVEL } from '@studify/shared';
import { SYNC_SCHEMA_VERSION } from '../db/sync/constants';
import { getDeviceId } from '../lib/device';
import { getApiUrl, getEnv } from './env';
import { fetch } from 'expo/fetch';
import { receiveStream } from './transport';
import { supabase } from './supabase';
import Constants from 'expo-constants';

export { ApiError } from './errors';

export interface CallOptions {
  /** Reused on retries so the server returns the stored response. Generated when omitted. */
  idempotencyKey?: string;
  signal?: AbortSignal;
  onProgress?: (status: { key: string; params?: object }) => void;
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

export async function authHeaders(idempotencyKey: string | null): Promise<Record<string, string>> {
  const env = getEnv();
  const { data } = await supabase.auth.getSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.session?.access_token ?? env.anonKey}`,
    'x-studify-version': appVersionCode(),
    'x-studify-schema': String(SYNC_SCHEMA_VERSION),
    [CLIENT_COMPAT_HEADER]: String(CLIENT_COMPAT_LEVEL),
    'x-device-id': getDeviceId(),
    Accept: 'text/event-stream',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

/** Posts once and reads the final structured result from SSE, with transparent live reconnection. */
export async function callFunction<TReq, TRes>(name: string, body: TReq, opts: CallOptions = {}): Promise<TRes> {
  let result: unknown;
  const handle = streamFunction(name, body, (event) => {
    if (event.event === 'done') result = event.data.result;
  }, opts);
  await handle.done;
  return result as TRes;
}

/** Shared by structured-result calls and conversational token streams. No operation polling or XHR buffering. */
export function streamFunction<TReq>(
  name: string,
  body: TReq,
  onEvent: (event: SseEvent) => void,
  opts: CallOptions = {},
): StreamHandle {
  const key = opts.idempotencyKey ?? uuidv7();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (opts.signal?.aborted) cancel();
  else opts.signal?.addEventListener('abort', cancel, { once: true });
  const payload = JSON.stringify(body ?? {});
  const done = receiveStream({
    signal: controller.signal,
    onEvent: (message) => {
      if (message.event === 'status') opts.onProgress?.(message.data as { key: string; params?: object });
      onEvent(message as SseEvent);
    },
    send: async (lastEventId, signal) => {
      const post = async () => {
        const headers = await authHeaders(key);
        if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
        return fetch(`${getApiUrl()}/${name}`, { method: 'POST', headers, body: payload, signal });
      };
      let response = await post();
      if (response.status === 401) {
        await response.body?.cancel();
        await supabase.auth.refreshSession();
        response = await post();
      }
      return response;
    },
  }).finally(() => opts.signal?.removeEventListener('abort', cancel));
  // Screens that follow the events (onError) need not also catch `done`: it never surfaces as an unhandled rejection.
  done.catch(() => undefined);
  return { cancel, done };
}
