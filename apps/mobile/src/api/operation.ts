// Client side of ADR 0009 (no request waits on Claude). Every API call carries an Idempotency-Key, so repeating it is
// always safe: the server either replays the stored answer or says it is still running (`202` with
// `x-operation-status: running`). This module repeats a call with the same key until it has a final answer, with a
// deadline on each attempt and on the whole operation. Pure (transport injected), so it is unit-tested in Node.
import { ApiError, offlineError } from './errors';

/** One HTTP attempt. Every API answer is short now; a longer silence means the connection is gone. */
export const REQUEST_DEADLINE_MS = 30_000;
/** How long the app follows one operation before telling the student it is taking too long. */
export const OPERATION_DEADLINE_MS = 4 * 60_000;
/** A stream with no bytes for this long (three missed 15 s heartbeats) has dropped. */
export const STREAM_STALL_MS = 45_000;
/** Attempts that fail without any answer (network down, deadline) before giving up. */
export const NETWORK_ATTEMPTS = 3;

export const RUNNING_HEADER = 'x-operation-status';
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 5_000;

export interface Reply {
  status: number;
  header(name: string): string | null;
  text: string;
}

export interface OperationDeps {
  /** Sends the call once with this Idempotency-Key. Rejects on a network failure; `signal` aborts it. */
  send(key: string, signal: AbortSignal): Promise<Reply>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export function timeoutError(): ApiError {
  return new ApiError('timeout', 0, 'Está demorando mais que o normal. Tenta de novo em instantes.');
}

/** True for the `202` that means "still running, ask again with the same key". */
export function isRunning(status: number, header: (name: string) => string | null): boolean {
  return status === 202 && header(RUNNING_HEADER) === 'running';
}

/** How long to wait before asking again, from `Retry-After` (seconds), bounded. */
export function retryAfterMs(header: (name: string) => string | null): number {
  const seconds = Number(header('retry-after'));
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1000));
}

/**
 * The key to keep asking with. A repeat of an identical call that is already running joins it: the server answers
 * with that call's key (`operation_key`), so the app follows the one call instead of starting a second.
 */
export function operationKeyOf(text: string, fallback: string): string {
  try {
    const key = (JSON.parse(text) as { operation_key?: unknown }).operation_key;
    return typeof key === 'string' && key.length > 0 ? key : fallback;
  } catch {
    return fallback;
  }
}

/** Backoff after a failure without an answer: 1 s, 2 s, 4 s… */
export function backoffMs(failures: number): number {
  return Math.min(8_000, 1_000 * 2 ** Math.max(0, failures - 1));
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

class DeadlineError extends Error {}

/** Runs one attempt with its own deadline, still cancellable by the caller's signal. */
async function attempt<T>(run: (signal: AbortSignal) => Promise<T>, deadlineMs: number, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadlineMs);
  const forward = () => controller.abort();
  outer?.addEventListener('abort', forward, { once: true });
  try {
    return await run(controller.signal);
  } catch (err) {
    if (timedOut) throw new DeadlineError('deadline');
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
}

/**
 * Sends the call and repeats it with the same key until the answer is final: while the server says it is running,
 * after `Retry-After`; after a network failure or a silent attempt, with backoff, up to NETWORK_ATTEMPTS in a row.
 * Throws `timeout` past OPERATION_DEADLINE_MS, `offline` when the network never answered, and the caller's
 * AbortError when it cancels. A final error status is returned as is (the caller maps it).
 */
export async function untilSettled(deps: OperationDeps, key: string, signal?: AbortSignal): Promise<Reply> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  const started = now();
  let current = key;
  let failures = 0;
  for (;;) {
    if (signal?.aborted) throw abortError();
    let reply: Reply;
    try {
      reply = await attempt((s) => deps.send(current, s), REQUEST_DEADLINE_MS, signal);
    } catch (err) {
      if (signal?.aborted) throw abortError();
      failures += 1;
      if (failures >= NETWORK_ATTEMPTS || now() - started >= OPERATION_DEADLINE_MS) {
        throw err instanceof DeadlineError ? timeoutError() : offlineError();
      }
      await sleep(backoffMs(failures), signal);
      continue;
    }
    if (!isRunning(reply.status, reply.header)) return reply;
    failures = 0;
    current = operationKeyOf(reply.text, current);
    if (now() - started >= OPERATION_DEADLINE_MS) throw timeoutError();
    await sleep(retryAfterMs(reply.header), signal);
  }
}
