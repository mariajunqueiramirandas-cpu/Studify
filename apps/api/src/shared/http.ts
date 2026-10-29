// Shared request admission and SSE transport. Validation/authentication errors keep their HTTP status;
// once admitted, a stream opens before any handler work (including retrieval and the first model token).
import type { ZodError, ZodType } from 'zod';
import { ApiFailure, IdempotencyKeySchema, SYNC_SCHEMA_VERSION, apiError } from '@studify/shared';
import { authenticate, type AuthUser } from './auth.ts';
import { usagePctToday } from './budget.ts';
import type { Deps } from './deps.ts';
import { mapError } from './errors.ts';
import { beginIdempotent, hashBody, type IdempotencyHandle, type StoredResponse } from './idempotency.ts';
import { openSse, replaySse, SseOperation, type SseWriter } from './sse.ts';
import { admit, operationsFor, type LiveOperation } from './operations.ts';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, accept, last-event-id, idempotency-key, x-studify-version, x-studify-schema, x-device-id, x-client-info',
  'Access-Control-Expose-Headers': 'x-ai-usage-today, x-request-id, idempotent-replayed',
  'Access-Control-Max-Age': '600',
};
export interface FnContext<I> {
  req: Request;
  deps: Deps;
  user: AuthUser;
  input: I;
  requestId: string;
  now: Date;
  json(body: unknown, status?: number, headers?: Record<string, string>): Response;
  sse(producer: (writer: SseWriter) => Promise<void>): Promise<Response>;
  usagePct(): Promise<number>;
}
export interface FnSpec<I> {
  name: string;
  mutating: boolean;
  aiCall?: boolean;
  input?: ZodType<I>;
  /** Structured AI result: stream meta/heartbeats while computing, then done.result. Identical active calls join. */
  streamResult?: boolean | ((input: I) => boolean);
  /** Documents handlers whose model calls run inside an explicit SSE producer. */
  claudeInsideStream?: boolean;
  /**
   * Reads and in-memory actions (data reads, realtime joins): still answered over SSE (meta, then done.result),
   * but without an Idempotency-Key record or replay. A reconnect simply asks again, which is always safe.
   */
  readOnly?: boolean;
  run(ctx: FnContext<I>): Promise<Response>;
}
export function defineFunction<I>(spec: FnSpec<I>): (req: Request, deps: Deps) => Promise<Response> {
  return (req, deps) => runFunction(req, deps, spec);
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function validationFailure(error: ZodError): ApiFailure {
  const issues = error.issues.slice(0, 8).map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
  return new ApiFailure('invalid_request', { details: { issues } });
}

async function checkClientVersion(req: Request, deps: Deps): Promise<void> {
  const schema = req.headers.get('x-studify-schema');
  if (schema && /^\d+$/.test(schema) && Number(schema) > SYNC_SCHEMA_VERSION) {
    throw new ApiFailure('app_update_required');
  }
  const version = req.headers.get('x-studify-version');
  if (version && /^\d+$/.test(version) && deps.minClientVersion) {
    const min = await deps.minClientVersion();
    if (min !== null && Number(version) < min) throw new ApiFailure('app_update_required');
  }
}

function replayResponse(stored: StoredResponse, requestId: string, afterId = 0): Response {
  const headers = { 'x-request-id': requestId, 'Idempotent-Replayed': 'true' };
  if (stored.contentType.startsWith('text/event-stream')) return replaySse(stored.body, { ...CORS_HEADERS, ...headers }, afterId);
  return new Response(stored.body, {
    status: stored.status,
    headers: { ...CORS_HEADERS, ...headers, 'Content-Type': stored.contentType },
  });
}

/** A handler's JSON response as the stream's terminal event: `done` with the result, or `error`. */
async function finishStream(writer: SseWriter, response: Response, usagePct: number): Promise<void> {
  const text = await response.text();
  const result: unknown = text ? JSON.parse(text) : null;
  if (response.status >= 400) {
    writer.send('error', { ...((result as { error?: object })?.error ?? apiError('internal_error').error), status: response.status });
  } else {
    writer.send('done', { stop_reason: 'end_turn', usage_pct_today: usagePct, status: response.status, result });
  }
}

/** Statuses that a client should retry later rather than receive again: never replayed (api §2.4). */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 402 || status === 429;
}

export async function runFunction<I>(req: Request, deps: Deps, spec: FnSpec<I>): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const requestId = deps.newId();
  const now = deps.now();
  if (req.method !== 'POST') return jsonResponse(apiError('invalid_request', { message: 'Use POST nesta chamada.' }), 405, { 'x-request-id': requestId });
  let handle: IdempotencyHandle | undefined;
  let streamed = false;
  try {
    await checkClientVersion(req, deps);
    const user = await authenticate(req, deps.db);
    if (deps.rateLimit && !(await deps.rateLimit(user.userId, spec.name))) throw new ApiFailure('rate_limited');
    const raw = await req.text();
    let json: unknown = {};
    if (raw.trim()) { try { json = JSON.parse(raw); } catch { throw new ApiFailure('invalid_request'); } }
    const parsed = spec.input?.safeParse(json);
    if (parsed && !parsed.success) throw validationFailure(parsed.error);
    const input = (parsed?.data ?? json) as I;
    const wantsStream = req.headers.get('accept')?.split(',').some((type) => type.trim().split(';')[0] === 'text/event-stream') ?? false;
    const after = req.headers.get('last-event-id') ?? '0';
    if (!/^\d{1,10}$/.test(after)) throw new ApiFailure('invalid_request', { message: 'Last-Event-ID inválido.' });
    const afterId = Number(after);
    const scope = `${user.userId}:${spec.name}:`;
    const key = req.headers.get('idempotency-key') ?? '';
    const requestHash = await hashBody(raw);
    const state = operationsFor(deps);
    const headers = { ...CORS_HEADERS, 'x-request-id': requestId };
    const baseContext: FnContext<I> = {
      req, deps, user, input, requestId, now,
      json: (body, status = 200, extra = {}) => jsonResponse(body, status, { ...headers, ...extra }),
      usagePct: () => usagePctToday(deps.db, user.userId, deps.now()),
      sse: async (producer) => {
        streamed = true;
        return openSse({ heartbeatMs: deps.heartbeatMs, headers, signal: req.signal,
          onSettled: async ({ ok, transcript }) => {
            if (!handle) return;
            if (ok) await handle.complete({ status: 200, contentType: 'text/event-stream', body: transcript });
            else await handle.abort();
          },
        }, producer);
      },
    };

    const run = async (): Promise<Response> => {
      if (spec.readOnly && !spec.mutating && wantsStream) {
        streamed = true;
        return openSse({ heartbeatMs: deps.heartbeatMs, headers, signal: req.signal }, async (writer) => {
          writer.send('meta', { request_id: requestId });
          let explicitStream = false;
          const response = await spec.run({ ...baseContext,
            sse: async (producer) => {
              explicitStream = true;
              await producer(writer);
              return new Response(null);
            },
          });
          if (!explicitStream) await finishStream(writer, response, spec.aiCall ? await baseContext.usagePct() : 0);
        });
      }
      if (spec.mutating || wantsStream) {
        if (!IdempotencyKeySchema.safeParse(key).success) throw new ApiFailure('invalid_request', { message: 'Este pedido precisa de um Idempotency-Key (UUID v7).' });
        const active = state.active.get(scope + key);
        if (active) {
          if (active.hash !== requestHash) throw new ApiFailure('idempotency_mismatch');
          return active.operation.writer.subscribe(headers, afterId, req.signal);
        }
        const outcome = await beginIdempotent(deps.db, { userId: user.userId, fn: spec.name, key, requestHash, now });
        if (outcome.kind === 'replay') return replayResponse(outcome.stored, requestId, afterId);
        if (outcome.kind === 'mismatch') throw new ApiFailure('idempotency_mismatch');
        // A placeholder with no live producer means another process owns it or a previous deployment stopped.
        // Never start a second paid operation against that placeholder.
        if (outcome.kind === 'in_flight') throw new ApiFailure('already_exists', { message: 'Este pedido ainda está em andamento. Tente novamente em instantes.' });
        handle = outcome.handle;
      }
      if (!wantsStream) {
        const response = await spec.run(baseContext);
        if (streamed) return response;
        if (spec.aiCall) response.headers.set('x-ai-usage-today', String(await baseContext.usagePct()));
        response.headers.set('x-request-id', requestId);
        if (handle) await handle.complete({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: await response.clone().text() });
        return response;
      }

      const join = typeof spec.streamResult === 'function' ? spec.streamResult(input) : spec.streamResult === true;
      const sibling = join ? [...state.active.entries()].find(([id, live]) => id.startsWith(scope) && live.hash === requestHash && !live.operation.writer.terminal)?.[1] : undefined;
      if (sibling) {
        if (sibling.handles.length >= 64) { await handle?.abort(); handle = undefined; throw new ApiFailure('rate_limited'); }
        if (handle) sibling.handles.push(handle);
        state.active.set(scope + key, sibling);
        return sibling.operation.writer.subscribe(headers, afterId, req.signal);
      }
      if (new Set(state.active.values()).size >= 128) { await handle?.abort(); handle = undefined; throw new ApiFailure('rate_limited'); }
      const handles = handle ? [handle] : [];
      const cancellation = new AbortController();
      const deadline = setTimeout(() => cancellation.abort(new Error('operation deadline exceeded')), 30 * 60_000);
      deadline.unref();
      streamed = true;
      const operation = new SseOperation({
        heartbeatMs: deps.heartbeatMs,
        onSettled: async ({ transcript }) => {
          // Failures are also final answers for this key: a reconnect must not charge for a second generation.
          const stored = { status: 200, contentType: 'text/event-stream', body: transcript };
          let persisted = false;
          const remove = () => { for (const [id, entry] of state.active) if (entry.operation === operation) state.active.delete(id); };
          try {
            for (const owner of handles) {
              for (let attempt = 0; ; attempt++) {
                try { await owner.complete(stored); break; }
                catch (error) {
                  if (attempt >= 2) throw error;
                  await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
                }
              }
            }
            persisted = true;
          } finally {
            clearTimeout(deadline);
            if (persisted) remove();
            else setTimeout(remove, 5 * 60_000).unref(); // keep live replay available through a transient storage outage
          }
        },
      }, async (writer) => {
        writer.send('meta', { request_id: requestId });
        let explicitStream = false;
        const scopedDeps: Deps = { ...deps, signal: cancellation.signal,
          execute: (name, data, options = {}) => deps.execute(name, data, { ...options,
            signal: cancellation.signal,
            onProgress: (id, patch) => writer.send('status', { key: 'operation.progress', params: { id, ...patch } }),
          }),
        };
        const response = await spec.run({ ...baseContext, deps: scopedDeps,
          sse: async (producer) => {
            explicitStream = true;
            await producer(writer);
            return new Response(null);
          },
        });
        if (!explicitStream) await finishStream(writer, response, spec.aiCall ? await baseContext.usagePct() : 0);
      });
      const live: LiveOperation = { hash: requestHash, operation, handles };
      state.active.set(scope + key, live);
      return operation.writer.subscribe(headers, afterId, req.signal);
    };
    return wantsStream ? await admit(deps, scope, run) : await run();
  } catch (error) {
    const mapped = mapError(error);
    if (mapped.internal) console.error(`[${spec.name}] ${requestId}`, mapped.internal);
    if (handle && !streamed) {
      if (isRetryableStatus(mapped.status)) await handle.abort();
      else await handle.complete({ status: mapped.status, contentType: 'application/json', body: JSON.stringify(mapped.body) });
    }
    return jsonResponse(mapped.body, mapped.status, { 'x-request-id': requestId });
  }
}
