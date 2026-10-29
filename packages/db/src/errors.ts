// Errors in the shape the call sites already read (`{ message, details, hint, code }`, PostgREST's field names), so
// a handler that checks `error.code === '23505'` keeps working. Postgres errors keep their SQLSTATE; errors raised
// by the query engine itself use PostgREST's codes (PGRST116: not exactly one row, PGRST202: no such function).

export interface DbError {
  message: string;
  details: string | null;
  hint: string | null;
  code: string;
}

export class DbQueryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details: string | null = null,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'DbQueryError';
  }
}

export function toDbError(err: unknown): DbError {
  const e = err as { message?: string; detail?: string; details?: string; hint?: string; code?: string };
  return {
    message: e?.message ?? String(err),
    details: e?.detail ?? e?.details ?? null,
    hint: e?.hint ?? null,
    code: e?.code ?? '',
  };
}

/** The HTTP status PostgREST answered with for an error, for callers that read `status`. */
export function statusOf(error: DbError): number {
  switch (error.code) {
    case 'PGRST116':
      return 406;
    case 'PGRST202':
    case '42P01':
    case '42883':
      return 404;
    case '23505':
    case '23503':
      return 409;
    case '42501':
      return 403;
    default:
      return 400;
  }
}
