// Error mapping for every Edge Function (api.md §2.2, §11). Every failure becomes the ApiError
// envelope with a stable `code` and a PT-BR `message`. Internal details are logged, never returned.
import {
  ApiFailure,
  type ApiError,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  apiError,
  errorCodeFromHint,
  isErrorCode,
  type ApiErrorOptions,
  type ErrorCode,
} from '@studify/shared';
import { AiBadRequestError, AiRetryLaterError, AiUnavailableError, BudgetExceededError } from '@studify/ai';

/** 401: missing or invalid JWT. The api spec gives no code for it, so `forbidden` is used. */
export class AuthError extends Error {
  constructor(message = 'Entre na sua conta pra continuar.') {
    super(message);
    this.name = 'AuthError';
  }
}

/** Shape of a PostgREST / supabase-js error object. */
export interface PgErrorLike {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  details?: string | null;
}

export function isPgErrorLike(value: unknown): value is PgErrorLike {
  return typeof value === 'object' && value !== null && 'message' in value && typeof (value as PgErrorLike).message === 'string';
}

/**
 * Maps a Postgres / PostgREST error to an ApiFailure. RPCs raise either the code as the message
 * (current core_rpc.sql) or put it in the HINT (api §2.2); both are read.
 */
export function failureFromPg(err: PgErrorLike): ApiFailure {
  const fromMessage = isErrorCode(err.message) ? err.message : null;
  const code = fromMessage ?? errorCodeFromHint(err.message) ?? errorCodeFromHint(err.hint);
  if (code) return new ApiFailure(code);
  switch (err.code) {
    case '42501':
      return new ApiFailure('forbidden');
    case '23505':
      return new ApiFailure('already_exists');
    case '22023':
      return new ApiFailure('invalid_request');
    default:
      return new ApiFailure('internal_error');
  }
}

/** Errors that are safe to show: ApiFailure, and AI wrapper errors mapped to their envelope. */
export interface MappedError {
  status: number;
  body: ApiError;
  /** Set for internal failures, so the caller can log them with the request id. */
  internal?: unknown;
}

export function mapError(err: unknown): MappedError {
  if (err instanceof ApiFailure) {
    // ai_refused is HTTP 200 only inside an SSE `done`; on a JSON call it is a 422 (api §2.2).
    const status = ERROR_HTTP_STATUS[err.code] === 200 ? 422 : ERROR_HTTP_STATUS[err.code];
    return { status, body: err.toEnvelope() };
  }
  if (err instanceof AuthError) {
    return { status: 401, body: apiError('forbidden', { message: err.message }) };
  }
  if (err instanceof BudgetExceededError) {
    const options: ApiErrorOptions = { details: { scope: err.scope } };
    if (err.resetsAt) options.resets_at = err.resetsAt;
    return { status: 402, body: apiError('budget_exhausted', options) };
  }
  if (err instanceof AiUnavailableError) {
    return { status: 503, body: apiError('ai_unavailable'), internal: err };
  }
  if (err instanceof AiRetryLaterError) {
    return { status: 503, body: apiError('ai_unavailable'), internal: err };
  }
  if (err instanceof AiBadRequestError) {
    // A request-shape bug in our code, never the student's fault.
    return { status: 500, body: apiError('internal_error'), internal: err };
  }
  if (isPgErrorLike(err)) {
    const failure = failureFromPg(err);
    return { status: ERROR_HTTP_STATUS[failure.code], body: failure.toEnvelope(), internal: err };
  }
  return { status: 500, body: apiError('internal_error'), internal: err };
}

/** Lists the codes so tests and the app agree on the wire vocabulary. */
export const KNOWN_CODES: readonly ErrorCode[] = ERROR_CODES;
