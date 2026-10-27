// The error envelope of Edge Functions and RPCs (api.md §2.2) as a typed exception.

export type ApiErrorCode =
  | 'invalid_request'
  | 'forbidden'
  | 'not_member'
  | 'blocked'
  | 'not_found'
  | 'already_exists'
  | 'duplicate_document'
  | 'attempt_open_elsewhere'
  | 'duel_not_open'
  | 'idempotency_mismatch'
  | 'pdf_password_protected'
  | 'pdf_corrupt'
  | 'file_too_large'
  | 'too_many_pages'
  | 'photo_unreadable'
  | 'under_age'
  | 'invite_invalid'
  | 'invite_expired'
  | 'invite_used_up'
  | 'class_full'
  | 'banned'
  | 'display_name_rejected'
  | 'regenerate_limit'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'class_budget_exhausted'
  | 'ai_unavailable'
  | 'ai_refused'
  | 'app_update_required'
  | 'unauthorized'
  | 'offline'
  | 'unknown';

export class ApiError extends Error {
  /** Stable machine code for app logic. */
  readonly code: string;
  /** HTTP status (0 when there was no response). */
  readonly status: number;
  readonly retryAfterS?: number;
  readonly resetsAt?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    status: number,
    message: string,
    extra: { retryAfterS?: number; resetsAt?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryAfterS = extra.retryAfterS;
    this.resetsAt = extra.resetsAt;
    this.details = extra.details;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

const DEFAULT_MESSAGE = 'Algo deu errado. Tente de novo em instantes.';

/** Builds an ApiError from an HTTP status and a raw body (JSON envelope or anything else). */
export function apiErrorFromResponse(status: number, rawBody: string): ApiError {
  if (status === 426) {
    return new ApiError('app_update_required', 426, 'Tem uma versão nova da Studify. Atualiza pra continuar.');
  }
  if (status === 401) {
    return new ApiError('unauthorized', 401, 'Sua sessão expirou. Entre de novo.');
  }
  let parsed: unknown = null;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsed = null;
  }
  const envelope = (parsed as { error?: Record<string, unknown> } | null)?.error;
  if (envelope && typeof envelope === 'object' && typeof envelope['code'] === 'string') {
    return new ApiError(
      envelope['code'],
      status,
      typeof envelope['message'] === 'string' ? envelope['message'] : DEFAULT_MESSAGE,
      {
        retryAfterS: typeof envelope['retry_after_s'] === 'number' ? envelope['retry_after_s'] : undefined,
        resetsAt: typeof envelope['resets_at'] === 'string' ? envelope['resets_at'] : undefined,
        details: (envelope['details'] as Record<string, unknown> | undefined) ?? undefined,
      },
    );
  }
  return new ApiError(status >= 500 ? 'ai_unavailable' : 'unknown', status, DEFAULT_MESSAGE);
}

export function offlineError(): ApiError {
  return new ApiError('offline', 0, 'Você está sem internet. Isso precisa de conexão.');
}
