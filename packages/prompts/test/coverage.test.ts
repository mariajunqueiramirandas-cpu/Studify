import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as S from '../src/schemas/index.ts';
import { PAYLOAD_ALIASES, SCHEMA_CASES } from './schema-cases.ts';

describe('schema coverage guard', () => {
  it('every exported Zod schema has a valid/invalid case (directly or via alias)', () => {
    const covered = new Set(SCHEMA_CASES.map((c) => c.name));
    const exported = Object.entries(S).filter(([, value]) => value instanceof z.ZodType).map(([key]) => key);
    const missing = exported.filter((key) => !covered.has(key) && !PAYLOAD_ALIASES[key] && !covered.has(key));
    expect(missing).toEqual([]);
    for (const alias of Object.values(PAYLOAD_ALIASES)) {
      expect(covered.has(alias), alias).toBe(true);
    }
  });
});
