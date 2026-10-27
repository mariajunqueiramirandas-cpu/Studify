/// <reference types="jest" />
import { REDACTED, scrubBreadcrumb, scrubSentryEvent, scrubString, scrubValue } from '../pii';

describe('PII scrubbing', () => {
  it('redacts emails inside free text', () => {
    expect(scrubString('erro para ana.silva@gmail.com ao salvar')).toBe(`erro para ${REDACTED} ao salvar`);
  });

  it('redacts user-content keys at any depth', () => {
    const out = scrubValue({ card: { front: 'pergunta secreta', id: 'c1' }, list: [{ user_note: 'minha nota' }], note: 'x' }) as Record<string, unknown>;
    expect(out).toEqual({ card: { front: REDACTED, id: 'c1' }, list: [{ user_note: REDACTED }], note: REDACTED });
  });

  it('removes the user, request and user-content extras from events', () => {
    const event = scrubSentryEvent({
      user: { email: 'a@b.co', id: 'u' },
      request: { data: 'body' },
      message: 'falhou para x@y.com',
      extra: { title: 'Resumo da célula', status: 500 },
      exception: { values: [{ type: 'Error', value: 'mail: x@y.com' }] },
      breadcrumbs: [{ category: 'navigation', message: 'a', data: { path: '/subjects/1' } }],
    }) as Record<string, unknown>;
    expect(event).not.toHaveProperty('user');
    expect(event).not.toHaveProperty('request');
    expect(event['message']).toBe(`falhou para ${REDACTED}`);
    expect(event['extra']).toEqual({ title: REDACTED, status: 500 });
    expect((event['exception'] as { values: { value: string }[] }).values[0]!.value).toBe(`mail: ${REDACTED}`);
    expect(scrubBreadcrumb({ category: 'x', data: { a: 1 } })).toEqual({ category: 'x' });
  });
});
