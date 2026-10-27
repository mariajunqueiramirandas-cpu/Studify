// The request pipeline shared by every Edge Function (api.md §2): CORS, client version gate (426),
// authentication (401), body validation (400), Idempotency-Key replay (api §2.4), streaming (SSE, §2.6),
// the x-ai-usage-today header (PLT-04.2) and error mapping (§2.2). Handlers only implement `run`.
import type { ZodError, ZodType } from 'zod';
import { ApiFailure, IdempotencyKeySchema, SYNC_SCHEMA_VERSION, apiError } from '@studify/shared';
import { authenticate, type AuthUser } from './auth.ts';
import { usagePctToday } from './budget.ts';
import type { Deps } from './deps.ts';
import { mapError } from './errors.ts';
import { beginIdempotent, hashBody, type IdempotencyHandle, type StoredResponse } from './idempotency.ts';
import { openSse, replaySse, type SseWriter } from './sse.ts';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, idempotency-key, x-studify-version, x-studify-schema, x-device-id, x-client-info',
  'Access-Control-Expose-Headers': 'x-ai-usage-today, x-request-id',
  'Access-Control-Max-Age': '600',
};

export interface FnContext<I> {
  req: Request;
  deps: Deps;
  user: AuthUser;
  input: I;
  requestId: string;
  now: Date;
  /** JSON response with CORS and x-request-id. */
  json(body: unknown, status?: number, headers?: Record<string, string>): Response;
  /**
   * Opens an SSE response. `producer` sends the events and must end with `done`. Must be awaited.
   * Once streaming has started, errors arrive as an `error` event, not as an HTTP status.
   */
  sse(producer: (writer: SseWriter) => Promise<void>): Promise<Response>;
  /** Share of today's AI budget used by the caller (0–100). */
  usagePct(): Promise<number>;
}

export interface FnSpec<I> {
  /** Function name, used as the idempotency scope and in logs. */
  name: string;
  /** POST with Idempotency-Key: the response is stored and replayed for 24 h (api §2.4). */
  mutating: boolean;
  /** Adds the x-ai-usage-today header (AI endpoints, api §2.5). */
  aiCall?: boolean;
  /** JSON body schema. Omit for functions with no body. */
  input?: ZodType<I>;
  run(ctx: FnContext<I>): Promise<Response>;
}

/** Builds the `(req, deps) => Response` handler a function module exports. */
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

function replayResponse(stored: StoredResponse, requestId: string): Response {
  const headers = { 'x-request-id': requestId, 'Idempotent-Replayed': 'true' };
  if (stored.contentType.startsWith('text/event-stream')) return replaySse(stored.body, headers);
  return new Response(stored.body, {
    status: stored.status,
    headers: { ...CORS_HEADERS, ...headers, 'Content-Type': stored.contentType },
  });
}

/** Statuses that a client should retry later rather than receive again: never replayed (api §2.4). */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 402 || status === 429;
}

export async function runFunction<I>(req: Request, deps: Deps, spec: FnSpec<I>): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  const requestId = deps.newId();
  const now = deps.now();
  if (req.method !== 'POST') {
    const body = apiError('invalid_request', { message: 'Use POST nesta chamada.' });
    return jsonResponse(body, 405, { 'x-request-id': requestId });
  }

  let handle: IdempotencyHandle | undefined;
  let streamed = false;
  try {
    await checkClientVersion(req, deps);
    const user = await authenticate(req, deps.db);
    if (deps.rateLimit && !(await deps.rateLimit(user.userId, spec.name))) throw new ApiFailure('rate_limited');

    const raw = await req.text();
    let json: unknown = {};
    if (raw.trim().length > 0) {
      try {
        json = JSON.parse(raw);
      } catch {
        throw new ApiFailure('invalid_request');
      }
    }
    let input: I;
    if (spec.input) {
      const parsed = spec.input.safeParse(json);
      if (!parsed.success) throw validationFailure(parsed.error);
      input = parsed.data;
    } else {
      input = json as I;
    }

    if (spec.mutating) {
      const key = req.headers.get('idempotency-key') ?? '';
      if (!IdempotencyKeySchema.safeParse(key).success) {
        throw new ApiFailure('invalid_request', { message: 'Este pedido precisa de um Idempotency-Key (UUID v7).' });
      }
      const outcome = await beginIdempotent(deps.db, {
        userId: user.userId,
        fn: spec.name,
        key,
        requestHash: await hashBody(raw),
        now,
      });
      if (outcome.kind === 'replay') return replayResponse(outcome.stored, requestId);
      if (outcome.kind === 'mismatch') throw new ApiFailure('idempotency_mismatch');
      if (outcome.kind === 'in_flight') {
        throw new ApiFailure('already_exists', { message: 'Esse pedido já está sendo feito. Espera um pouquinho.' });
      }
      handle = outcome.handle;
    }

    const ctx: FnContext<I> = {
      req,
      deps,
      user,
      input,
      requestId,
      now,
      json: (body, status = 200, headers = {}) => jsonResponse(body, status, { 'x-request-id': requestId, ...headers }),
      usagePct: () => usagePctToday(deps.db, user.userId, deps.now()),
      sse: async (producer) => {
        streamed = true;
        const headers: Record<string, string> = { 'x-request-id': requestId };
        if (spec.aiCall) headers['x-ai-usage-today'] = String(await usagePctToday(deps.db, user.userId, deps.now()));
        return openSse(
          {
            heartbeatMs: deps.heartbeatMs,
            headers,
            onSettled: async ({ ok, transcript }) => {
              if (!handle) return;
              if (ok) await handle.complete({ status: 200, contentType: 'text/event-stream', body: transcript });
              else await handle.abort();
            },
          },
          producer,
        );
      },
    };

    const response = await spec.run(ctx);
    if (streamed) return response;
    if (spec.aiCall) response.headers.set('x-ai-usage-today', String(await usagePctToday(deps.db, user.userId, deps.now())));
    response.headers.set('x-request-id', requestId);
    if (handle) {
      const body = await response.clone().text();
      await handle.complete({ status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body });
    }
    return response;
  } catch (err) {
    const mapped = mapError(err);
    if (mapped.internal) console.error(`[${spec.name}] ${requestId}`, mapped.internal);
    const envelope = JSON.stringify(mapped.body);
    if (handle && !streamed) {
      if (isRetryableStatus(mapped.status)) await handle.abort();
      else await handle.complete({ status: mapped.status, contentType: 'application/json', body: envelope });
    }
    return jsonResponse(mapped.body, mapped.status, { 'x-request-id': requestId });
  }
}
