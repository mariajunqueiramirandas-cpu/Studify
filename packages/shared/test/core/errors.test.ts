import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  ApiFailure,
  DOCUMENT_ERROR_MESSAGES_PT_BR,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  ERROR_MESSAGES_PT_BR,
  apiError,
  apiErrorFromPostgres,
  errorCodeFromHint,
  isErrorCode,
} from '../../src/core/errors.ts';
import { DOCUMENT_ERROR_CODE } from '../../src/core/enums.ts';

describe('error codes', () => {
  it('every code has an HTTP status and a PT-BR message', () => {
    expect(Object.keys(ERROR_HTTP_STATUS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(typeof ERROR_HTTP_STATUS[code]).toBe('number');
      expect(ERROR_MESSAGES_PT_BR[code].length, code).toBeGreaterThan(5);
    }
  });

  it('uses the copy-guide wording where the guide has a string', () => {
    expect(ERROR_MESSAGES_PT_BR.rate_limited).toBe('Calma! Tenta de novo em instantes.');
    expect(ERROR_MESSAGES_PT_BR.app_update_required).toBe('Tem uma versão nova do Studify. Atualize pra continuar.');
    expect(ERROR_MESSAGES_PT_BR.not_found).toBe('Não encontrei isso. Pode ter sido apagado.');
  });

  it('keeps messages free of emojis and English error words', () => {
    for (const code of ERROR_CODES) {
      expect(ERROR_MESSAGES_PT_BR[code], code).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(ERROR_MESSAGES_PT_BR[code], code).not.toMatch(/\bError\b|\bexception\b/i);
    }
  });

  it('maps HTTP statuses from api.md §2.2 and §11', () => {
    expect(ERROR_HTTP_STATUS.budget_exhausted).toBe(402);
    expect(ERROR_HTTP_STATUS.rate_limited).toBe(429);
    expect(ERROR_HTTP_STATUS.app_update_required).toBe(426);
    expect(ERROR_HTTP_STATUS.ai_unavailable).toBe(503);
    expect(ERROR_HTTP_STATUS.duplicate_document).toBe(409);
    expect(ERROR_HTTP_STATUS.pdf_password_protected).toBe(422);
  });

  it('isErrorCode narrows strings', () => {
    expect(isErrorCode('banned')).toBe(true);
    expect(isErrorCode('nope')).toBe(false);
  });

  it('every stored document error code has a message', () => {
    for (const code of DOCUMENT_ERROR_CODE) {
      expect(DOCUMENT_ERROR_MESSAGES_PT_BR[code], code).toBeTruthy();
    }
  });
});

describe('envelope', () => {
  it('apiError builds a schema-valid envelope with the default message', () => {
    const env = apiError('budget_exhausted', { resets_at: '2026-10-28T03:00:00Z', retry_after_s: 3600 });
    expect(ApiErrorSchema.parse(env).error.code).toBe('budget_exhausted');
    expect(env.error.message).toContain('Seu limite de IA de hoje acabou');
    expect(env.error.resets_at).toBe('2026-10-28T03:00:00Z');
  });

  it('rejects a bad resets_at and an unknown code', () => {
    expect(() => ApiErrorSchema.parse({ error: { code: 'budget_exhausted', message: 'x', resets_at: 'tomorrow' } })).toThrow();
    expect(() => ApiErrorSchema.parse({ error: { code: 'teapot', message: 'x' } })).toThrow();
  });

  it('ApiFailure carries status and the envelope', () => {
    const failure = new ApiFailure('not_member');
    expect(failure.status).toBe(403);
    expect(failure.toEnvelope().error.message).toBe('Você precisa estar na turma pra ver isso.');
  });
});

describe('RPC error mapping (api.md §2.2)', () => {
  it('reads the code from the HINT of a P0001 exception', () => {
    expect(errorCodeFromHint('duel_not_open')).toBe('duel_not_open');
    expect(errorCodeFromHint('code=invite_expired; retry later')).toBe('invite_expired');
    expect(errorCodeFromHint('something else')).toBeNull();
    expect(errorCodeFromHint(null)).toBeNull();
  });

  it('maps P0001 with a known hint to that code, anything else to internal_error', () => {
    expect(apiErrorFromPostgres({ code: 'P0001', hint: 'class_full' }).error.code).toBe('class_full');
    expect(apiErrorFromPostgres({ code: 'P0001', hint: 'unknown' }).error.code).toBe('internal_error');
    expect(apiErrorFromPostgres({ code: '23505', hint: 'banned' }).error.code).toBe('internal_error');
  });
});
