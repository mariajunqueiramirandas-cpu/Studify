/// <reference types="jest" />
import { apiErrorFromResponse, ApiError } from '../errors';

describe('error envelope (api.md §2.2)', () => {
  it('maps the JSON envelope to a typed ApiError', () => {
    const err = apiErrorFromResponse(
      402,
      JSON.stringify({ error: { code: 'budget_exhausted', message: 'Você atingiu o limite de IA de hoje. Volta amanhã!', resets_at: '2026-10-28T03:00:00Z' } }),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('budget_exhausted');
    expect(err.status).toBe(402);
    expect(err.resetsAt).toBe('2026-10-28T03:00:00Z');
  });

  it('maps 426 to app_update_required regardless of body', () => {
    expect(apiErrorFromResponse(426, '').code).toBe('app_update_required');
  });

  it('maps unknown bodies to a generic PT-BR message', () => {
    const err = apiErrorFromResponse(500, '<html>');
    expect(err.code).toBe('ai_unavailable');
    expect(err.message).toMatch(/Tente de novo/);
  });
});
