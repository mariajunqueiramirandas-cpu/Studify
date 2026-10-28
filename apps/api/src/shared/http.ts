// The request pipeline shared by every Edge Function (api.md §2): CORS, client version gate (426),
// authentication (401), body validation (400), Idempotency-Key replay (api §2.4), streaming (SSE, §2.6),
// the x-ai-usage-today header (PLT-04.2) and error mapping (§2.2). Handlers only implement `run`.
// Deferred calls (ADR 0009): a handler that calls Claude outside a stream runs as a job, and the request answers
// `202` with `x-operation-status: running` at once. The app repeats the request with the same Idempotency-Key until
// it gets the stored response, so no request waits on Claude and a dropped connection loses nothing.
import type { ZodError, ZodType } from 'zod';
import { ApiFailure, IdempotencyKeySchema, SYNC_SCHEMA_VERSION, apiError } from '@studify/shared';
import { authenticate, type AuthUser } from './auth.ts';
import { usagePctToday } from './budget.ts';
import type { DeferredJob, Deps } from './deps.ts';
import { mapError } from './errors.ts';
import { beginIdempotent, hashBody, idempotencyHandle, type IdempotencyHandle, type StoredResponse } from './idempotency.ts';
import { openSse, replaySse, type SseWriter } from './sse.ts';

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'authorization, apikey, content-type, idempotency-key, x-studify-version, x-studify-schema, x-studify-operations, x-device-id, x-client-info',
  'Access-Control-Expose-Headers': 'x-ai-usage-today, x-request-id, x-operation-status, retry-after, x-retry-after-ms',
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
  /**
   * ADR 0009: the handler calls Claude outside a stream, so it runs as a job and the request answers `202 running`.
   * A function decides per input when some of its inputs stream (capture-act). Deferred calls always use an
   * Idempotency-Key, mutating or not. Ignored when `deps.defer` is unset: the handler then runs inline.
   */
  deferred?: boolean | ((input: I) => boolean);
  /**
   * ADR 0009: the handler makes its plain Claude calls inside its SSE producer, after the stream opened, so the
   * heartbeat keeps the connection alive while it waits. Declares that to the no-sync-Claude check.
   */
  claudeInsideStream?: boolean;
  run(ctx: FnContext<I>): Promise<Response>;
}

/** Every defined function by name: the interactive queue looks deferred calls up here. */
const SPECS = new Map<string, FnSpec<any>>();

/** Header of a `202` that means "still running, ask again with the same key" (never a final answer). */
export const OPERATION_STATUS_HEADER = 'x-operation-status';
/**
 * Sent by app builds that repeat a call until it settles (ADR 0009). Older builds take the first answer as final, so
 * they keep the old contract: no deferral, no joining, and `409` for a repeat that is still running.
 */
export const CLIENT_OPERATIONS_HEADER = 'x-studify-operations';
const RETRY_AFTER_SECONDS = 1;
// Apps that read `x-retry-after-ms` ask again sooner; older builds keep to `Retry-After` (whole seconds).
const RETRY_AFTER_MS = 500;

function followsOperations(req: Request): boolean {
  return req.headers.get(CLIENT_OPERATIONS_HEADER) === '1';
}

/** Builds the `(req, deps) => Response` handler a function module exports. */
export function defineFunction<I>(spec: FnSpec<I>): (req: Request, deps: Deps) => Promise<Response> {
  SPECS.set(spec.name, spec);
  return (req, deps) => runFunction(req, deps, spec);
}

/** The names of the functions declared deferred (static or per input). */
export function deferredFunctionNames(): string[] {
  return [...SPECS.values()].filter((spec) => spec.deferred !== undefined && spec.deferred !== false).map((spec) => spec.name);
}

function isDeferred<I>(spec: FnSpec<I>, input: I): boolean {
  return typeof spec.deferred === 'function' ? spec.deferred(input) : spec.deferred === true;
}

/** `202 running`: the call with `key` has not finished. The app waits `Retry-After` and repeats it with that key. */
function runningResponse(key: string, requestId: string): Response {
  return jsonResponse({ status: 'running', operation_key: key }, 202, {
    'x-request-id': requestId,
    [OPERATION_STATUS_HEADER]: 'running',
    'Retry-After': String(RETRY_AFTER_SECONDS),
    'X-Retry-After-Ms': String(RETRY_AFTER_MS),
  });
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

    const follows = followsOperations(req);
    const deferred = follows && deps.defer !== undefined && isDeferred(spec, input);
    let key = '';
    if (spec.mutating || deferred) {
      key = req.headers.get('idempotency-key') ?? '';
      if (!IdempotencyKeySchema.safeParse(key).success) {
        throw new ApiFailure('invalid_request', { message: 'Este pedido precisa de um Idempotency-Key (UUID v7).' });
      }
      const outcome = await beginIdempotent(deps.db, {
        userId: user.userId,
        fn: spec.name,
        key,
        requestHash: await hashBody(raw),
        now,
        joinSameRequest: deferred,
      });
      if (outcome.kind === 'replay') return replayResponse(outcome.stored, requestId);
      if (outcome.kind === 'mismatch') throw new ApiFailure('idempotency_mismatch');
      // ADR 0009: a repeat of a call that is still running is a status check, never a conflict.
      if (outcome.kind === 'in_flight') {
        if (follows) return runningResponse(key, requestId);
        throw new ApiFailure('already_exists', { message: 'Esse pedido já está sendo feito. Espera um pouquinho.' });
      }
      if (outcome.kind === 'joined') return runningResponse(outcome.key, requestId);
      handle = outcome.handle;
    }

    if (deferred && handle && deps.defer) {
      try {
        await deps.defer({ fn: spec.name, user_id: user.userId, key, raw, request_id: requestId });
      } catch (err) {
        // Not queued: release the key so the app's retry starts the call again.
        await handle.abort();
        handle = undefined;
        throw err;
      }
      return runningResponse(key, requestId);
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

/**
 * Runs one deferred call on the interactive queue (ADR 0009) and stores its response under the call's
 * Idempotency-Key, where the app's next poll finds it. A server error is rethrown while the queue still has a
 * retry, so a transient failure is retried; the last attempt stores it, like any other failure, so the app stops
 * waiting and shows it. Each tap uses a new key, so a stored failure never blocks a new attempt.
 */
export async function runDeferred(job: DeferredJob, deps: Deps, opts: { finalAttempt: boolean }): Promise<StoredResponse> {
  const handle = idempotencyHandle(deps.db, job.user_id, job.fn, job.key);
  const spec = SPECS.get(job.fn);
  let stored: StoredResponse;
  try {
    if (!spec) throw new Error(`deferred call to unknown function ${job.fn}`);
    let json: unknown = {};
    if (job.raw.trim().length > 0) json = JSON.parse(job.raw);
    let input: unknown = json;
    if (spec.input) {
      const parsed = spec.input.safeParse(json);
      if (!parsed.success) throw validationFailure(parsed.error);
      input = parsed.data;
    }
    const ctx: FnContext<unknown> = {
      // Handlers of deferred calls never read the request (only the user id); this one carries the body for symmetry.
      req: new Request(`http://deferred.invalid/api/${job.fn}`, { method: 'POST', body: job.raw }),
      deps,
      user: { userId: job.user_id, email: null, jwt: '' },
      input,
      requestId: job.request_id,
      now: deps.now(),
      json: (body, status = 200, headers = {}) => jsonResponse(body, status, { 'x-request-id': job.request_id, ...headers }),
      usagePct: () => usagePctToday(deps.db, job.user_id, deps.now()),
      sse: () => {
        throw new Error(`${job.fn}: a streaming input must not be deferred`);
      },
    };
    const response = await spec.run(ctx);
    stored = { status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: await response.text() };
  } catch (err) {
    const mapped = mapError(err);
    if (mapped.internal) console.error(`[${job.fn}] ${job.request_id} (deferred)`, mapped.internal);
    if (mapped.status >= 500 && !opts.finalAttempt) throw err;
    stored = { status: mapped.status, contentType: 'application/json', body: JSON.stringify(mapped.body) };
  }
  await handle.complete(stored);
  return stored;
}
