// Error classes and classification (ai-pipeline §10.1, §2.4).
// Classification uses numeric `status` and error names, not `instanceof`, so this file stays
// runtime-neutral and does not load the SDK at runtime.

import type { BudgetScope } from "./types.ts";

export class AiError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** PLT-04 gate refused the reservation. No request was made. */
export class BudgetExceededError extends AiError {
  readonly scope: BudgetScope;
  readonly resetsAt: string | undefined;
  constructor(scope: BudgetScope, resetsAt?: string) {
    super("budget_exhausted", `AI budget exhausted (${scope})`);
    this.scope = scope;
    this.resetsAt = resetsAt;
  }
}

/** 400/404/413/422 or a request-shape invariant failure. A bug: never retried blindly. */
export class AiBadRequestError extends AiError {
  readonly status: number | undefined;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super("ai_bad_request", message, options);
    this.status = options?.status;
  }
}

/** 401/403: key or project configuration problem. Alert the owner. */
export class AiUnavailableError extends AiError {
  readonly status: number | undefined;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super("ai_unavailable", message, options);
    this.status = options?.status;
  }
}

/** 408/409/429/5xx/529, connection errors and timeouts. Queue and retry later. */
export class AiRetryLaterError extends AiError {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(
    message: string,
    options?: { cause?: unknown; status?: number; retryAfterMs?: number },
  ) {
    super("ai_retry_later", message, options);
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

interface ApiErrorLike {
  name?: unknown;
  message?: unknown;
  status?: unknown;
  headers?: unknown;
}

function asApiErrorLike(err: unknown): ApiErrorLike | null {
  return typeof err === "object" && err !== null ? (err as ApiErrorLike) : null;
}

function retryAfterMs(headers: unknown): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get !== "function") return undefined;
  const raw = (get as (k: string) => string | null).call(headers, "retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * Maps an SDK error to an AiError subtype. Returns the original value for errors that are
 * not API failures (for example an AbortError), so callers can rethrow them unchanged.
 */
export function classifyError(err: unknown): unknown {
  if (err instanceof AiError) return err;
  const e = asApiErrorLike(err);
  if (!e) return err;
  const name = typeof e.name === "string" ? e.name : "";
  const message = typeof e.message === "string" ? e.message : "Claude API error";
  const status = typeof e.status === "number" ? e.status : undefined;

  if (name === "APIUserAbortError" || name === "AbortError") return err;

  if (name.startsWith("APIConnection")) {
    return new AiRetryLaterError(message, { cause: err });
  }
  if (status === undefined) return err;
  if (status === 401 || status === 403) {
    return new AiUnavailableError(message, { cause: err, status });
  }
  if (status === 408 || status === 409 || status === 429 || status >= 500) {
    return new AiRetryLaterError(message, {
      cause: err,
      status,
      retryAfterMs: retryAfterMs(e.headers),
    });
  }
  if (status >= 400) {
    return new AiBadRequestError(message, { cause: err, status });
  }
  return err;
}
