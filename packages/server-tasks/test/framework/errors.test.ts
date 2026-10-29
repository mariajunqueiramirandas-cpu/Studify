import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PermanentJobError, messageKeyFor, parsePayload, errorCodeOf } from '../../src/framework/errors.ts';

describe('parsePayload', () => {
  const schema = z.object({ document_id: z.uuid(), pages: z.array(z.number().int()).default([]) });

  it('returns the parsed value for a valid payload', () => {
    const id = '0190f3a2-7b1c-7d3e-8f00-000000000001';
    expect(parsePayload(schema, { document_id: id }, 'x').pages).toEqual([]);
  });

  it('throws a permanent error naming the failing path', () => {
    try {
      parsePayload(schema, { document_id: 'nope' }, 'ingest.document');
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PermanentJobError);
      expect((err as PermanentJobError).code).toBe('invalid_payload');
      expect((err as Error).message).toContain('ingest.document');
      expect((err as Error).message).toContain('document_id');
    }
  });
});

describe('messageKeyFor', () => {
  it('maps document error codes to i18n keys and falls back to a generic key', () => {
    expect(messageKeyFor('password_protected')).toBe('ingest.error.password_protected');
    expect(messageKeyFor('something_else')).toBe('errors.generic');
  });
});

describe('errorCodeOf', () => {
  it('reads a string code from classified errors', () => {
    expect(errorCodeOf(Object.assign(new Error('x'), { code: 'budget_exhausted' }))).toBe('budget_exhausted');
    expect(errorCodeOf(new Error('plain'))).toBeNull();
  });
});
