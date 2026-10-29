// Domain failures carry a code and a PT-BR message key; direct operations are never retried as a unit.
import type { z } from 'zod';

export class PermanentJobError extends Error {
  readonly code: string;
  readonly messageKey: string;

  constructor(code: string, message?: string, messageKey?: string) {
    super(message ?? code);
    this.name = 'PermanentJobError';
    this.code = code;
    this.messageKey = messageKey ?? messageKeyFor(code);
  }
}

/** i18n keys for user-visible failures (api.md §11 and specs 01 §5). Never raw messages. */
export const ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  password_protected: 'ingest.error.password_protected',
  corrupt: 'ingest.error.corrupt',
  empty: 'ingest.error.empty',
  too_large: 'ingest.error.too_large',
  too_many_pages: 'ingest.error.too_many_pages',
  unsupported_type: 'ingest.error.corrupt',
  not_study_material: 'ingest.error.not_study_material',
  ai_failed: 'ingest.error.ai_failed',
  ai_refused: 'ingest.error.ai_refused',
  waiting_budget: 'ingest.error.waiting_budget',
  photo_unreadable: 'photos.error.unreadable',
  invalid_payload: 'errors.generic',
  storage_missing: 'ingest.error.corrupt',
};

export function messageKeyFor(code: string): string {
  return ERROR_MESSAGE_KEYS[code] ?? 'errors.generic';
}

/** Validates a job payload. Invalid payloads are a bug or a stale message: never retried. */
export function parsePayload<S extends z.ZodType>(schema: S, data: unknown, jobName: string): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join('.') || '(raiz)'}: ${i.message}`)
      .join('; ');
    throw new PermanentJobError('invalid_payload', `${jobName}: payload inválido (${issues})`);
  }
  return result.data;
}

/** Errors from the AI wrapper that carry a classified code (`budget_exhausted`, `ai_retry_later`…). */
export function errorCodeOf(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return null;
}
