// Error envelope and stable error codes (api.md §2.2 and §11). `code` is stable for app logic;
// `message` is always PT-BR and safe to show. Wording comes from docs/design/copy-pt-br.md where that
// guide has a string for the case, and from api.md §11 otherwise.
import { z } from 'zod';
import type { DocumentErrorCode } from './enums.ts';

export const ERROR_CODES = [
  'invalid_request',
  'forbidden',
  'not_member',
  'blocked',
  'not_found',
  'already_exists',
  'duplicate_document',
  'attempt_open_elsewhere',
  'duel_not_open',
  'idempotency_mismatch',
  'pdf_password_protected',
  'pdf_corrupt',
  'file_too_large',
  'too_many_pages',
  'photo_unreadable',
  'under_age',
  'invite_invalid',
  'invite_expired',
  'invite_used_up',
  'class_full',
  'banned',
  'display_name_rejected',
  'already_completed',
  'regenerate_limit',
  'rate_limited',
  'budget_exhausted',
  'class_budget_exhausted',
  'ai_unavailable',
  'ai_refused',
  'app_update_required',
  'offline',
  // Not in api.md §11: the catch-all for unexpected server failures. Assumption, flagged in the report.
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const ErrorCodeSchema = z.enum(ERROR_CODES);

/** HTTP status per code (api.md §2.2 and §11). `ai_refused` travels inside a 200 `done` event. */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  invalid_request: 400,
  forbidden: 403,
  not_member: 403,
  blocked: 403,
  banned: 403,
  not_found: 404,
  already_exists: 409,
  duplicate_document: 409,
  attempt_open_elsewhere: 409,
  duel_not_open: 409,
  idempotency_mismatch: 409,
  pdf_password_protected: 422,
  pdf_corrupt: 422,
  file_too_large: 422,
  too_many_pages: 422,
  photo_unreadable: 422,
  under_age: 422,
  invite_invalid: 422,
  invite_expired: 422,
  invite_used_up: 422,
  class_full: 422,
  display_name_rejected: 422,
  already_completed: 409,
  regenerate_limit: 429,
  rate_limited: 429,
  budget_exhausted: 402,
  class_budget_exhausted: 402,
  ai_unavailable: 503,
  ai_refused: 200,
  app_update_required: 426,
  offline: 0, // client-only: never sent by the server
  internal_error: 500,
};

/** PT-BR default message per code. Source of truth for final wording is the copy guide. */
export const ERROR_MESSAGES_PT_BR: Readonly<Record<ErrorCode, string>> = {
  invalid_request: 'Algo deu errado com esse pedido. Tenta de novo.',
  forbidden: 'Você não tem permissão pra fazer isso.',
  not_member: 'Você precisa estar na turma pra ver isso.',
  blocked: 'Não dá pra fazer isso com essa pessoa.',
  not_found: 'Não encontrei isso. Pode ter sido apagado.', // copy-pt-br error.not_found
  already_exists: 'Isso já existe.',
  duplicate_document: 'Você já enviou esse material nessa matéria.', // copy-pt-br ingest.duplicate
  attempt_open_elsewhere: 'Esse simulado está aberto em outro aparelho.',
  duel_not_open: 'Esse duelo já terminou.',
  idempotency_mismatch: 'Algo deu errado com esse pedido. Tenta de novo.', // internal; the app retries with a new key
  pdf_password_protected: 'Esse PDF tem senha. Tira a senha e envia de novo.', // copy-pt-br ingest.password
  pdf_corrupt: 'Não consegui abrir esse arquivo. Ele pode estar corrompido — tenta baixar de novo.', // copy-pt-br ingest.corrupt
  file_too_large: 'Esse arquivo é grande demais (máx. 100 MB). Tenta dividir em partes.', // copy-pt-br ingest.too_large
  too_many_pages: 'Esse PDF tem mais de 1.000 páginas. Envia só os capítulos que você precisa.', // copy-pt-br ingest.too_many_pages
  photo_unreadable: 'Não deu pra ler a foto. Tenta de novo com mais luz e sem tremer.',
  under_age: 'A Studify é para estudantes a partir de 12 anos.',
  invite_invalid: 'Código inválido ou expirado. Peça um novo pra quem organiza a turma.', // copy-pt-br onb.invite.invalid
  invite_expired: 'Código inválido ou expirado. Peça um novo pra quem organiza a turma.', // copy-pt-br onb.invite.invalid
  invite_used_up: 'Esse convite não vale mais. Peça um novo para quem te convidou.',
  class_full: 'Essa turma já está cheia.',
  banned: 'Você não pode entrar nessa turma.',
  display_name_rejected: 'Esse nome não pode ser usado. Que tal outro?',
  already_completed: 'Seu cadastro já foi concluído.', // assumption: not in api.md §11
  regenerate_limit: 'Você já refez esse resumo 3 vezes hoje. Tenta amanhã!', // copy-pt-br regenerate.limit
  rate_limited: 'Calma! Tenta de novo em instantes.', // copy-pt-br error.rate_limited
  budget_exhausted:
    'Seu limite de IA de hoje acabou. O que não precisa de IA continua funcionando — e eu continuo o resto amanhã.', // copy-pt-br budget.user_daily
  class_budget_exhausted: 'A turma usou toda a IA do mês. O resto volta dia 1º.',
  ai_unavailable: 'A IA está ocupada agora. Tenta de novo em alguns minutos.',
  ai_refused: 'Não consegui responder isso. Tenta perguntar de outro jeito.',
  app_update_required: 'Tem uma versão nova do Studify. Atualize pra continuar.', // copy-pt-br update.required
  offline: 'Isso precisa de internet.', // copy-pt-br offline.ai_disabled
  internal_error: 'Algo deu errado. Tenta de novo?', // copy-pt-br error.generic
};

/** PT-BR message for each stored `documents.error_code` (data-model §4.2). */
export const DOCUMENT_ERROR_MESSAGES_PT_BR: Readonly<Record<DocumentErrorCode, string>> = {
  password_protected: ERROR_MESSAGES_PT_BR.pdf_password_protected,
  corrupt: ERROR_MESSAGES_PT_BR.pdf_corrupt,
  empty: 'Esse arquivo não tem nenhuma página com conteúdo. Envia outro material.', // assumption
  too_large: ERROR_MESSAGES_PT_BR.file_too_large,
  too_many_pages: ERROR_MESSAGES_PT_BR.too_many_pages,
  not_study_material: 'Hmm, isso não parece material de estudo. Quer usar mesmo assim?', // copy-pt-br ingest.not_study
  ai_failed: 'Algo deu errado ao ler o material.', // copy-pt-br ingest.failed
  ai_refused: 'Não consegui processar esse material. Tenta com outro arquivo.', // assumption
  unsupported_type: 'Esse tipo de arquivo não é suportado. Envia um PDF ou fotos.', // assumption
};

/** The error envelope every Edge Function and RPC failure maps to (api.md §2.2). */
export const ApiErrorBodySchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  retry_after_s: z.number().nonnegative().optional(),
  resets_at: z.iso.datetime().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export const ApiErrorSchema = z.object({ error: ApiErrorBodySchema });
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;

export interface ApiErrorOptions {
  message?: string;
  retry_after_s?: number;
  resets_at?: string;
  details?: Record<string, unknown>;
}

/** Builds the envelope for a code, with the default PT-BR message unless overridden. */
export function apiError(code: ErrorCode, options: ApiErrorOptions = {}): ApiError {
  const body: ApiErrorBody = {
    code,
    message: options.message ?? ERROR_MESSAGES_PT_BR[code],
  };
  if (options.retry_after_s !== undefined) body.retry_after_s = options.retry_after_s;
  if (options.resets_at !== undefined) body.resets_at = options.resets_at;
  if (options.details !== undefined) body.details = options.details;
  return { error: body };
}

/** Throwable carrier for Edge Functions. `toEnvelope()` gives the response body. */
export class ApiFailure extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly options: ApiErrorOptions;

  constructor(code: ErrorCode, options: ApiErrorOptions = {}) {
    super(options.message ?? ERROR_MESSAGES_PT_BR[code]);
    this.name = 'ApiFailure';
    this.code = code;
    this.status = ERROR_HTTP_STATUS[code];
    this.options = options;
  }

  toEnvelope(): ApiError {
    return apiError(this.code, this.options);
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * RPC functions raise Postgres exceptions (errcode P0001) whose HINT carries the code (api.md §2.2).
 * Returns the first known code found in the hint, or null. The exact hint format is not fixed by
 * the docs, so this matches any whole-word occurrence.
 */
export function errorCodeFromHint(hint: string | null | undefined): ErrorCode | null {
  if (!hint) return null;
  for (const token of hint.split(/[^a-z_]+/)) {
    if (isErrorCode(token)) return token;
  }
  return null;
}

/** Maps a Postgres error (as returned by supabase-js) to the API envelope. Unknown errors become internal_error. */
export function apiErrorFromPostgres(err: { code?: string | null; hint?: string | null }): ApiError {
  if (err.code === 'P0001') {
    const code = errorCodeFromHint(err.hint);
    if (code) return apiError(code);
  }
  return apiError('internal_error');
}
