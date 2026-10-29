// Transport deadlines and cancellable reconnect backoff. SSE replaces operation polling (ADR 0010).
import { ApiError } from './errors';
export const REQUEST_DEADLINE_MS = 30_000;
export const OPERATION_DEADLINE_MS = 30 * 60_000;
export const STREAM_STALL_MS = 45_000;
export const NETWORK_ATTEMPTS = 3;
export function timeoutError(): ApiError {
  return new ApiError('timeout', 0, 'Está demorando mais que o normal. Tenta de novo em instantes.');
}
export function backoffMs(failures: number): number { return Math.min(8_000, 1_000 * 2 ** Math.max(0, failures - 1)); }
export function abortError(): Error { const error = new Error('Aborted'); error.name = 'AbortError'; return error; }
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
