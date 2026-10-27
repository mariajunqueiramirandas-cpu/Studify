import { describe, expect, it } from 'vitest';
import { SCHEMA_CASES } from './schema-cases.ts';

describe('Zod output schemas: each has a valid and an invalid example', () => {
  it('covers every schema family used by the task catalog', () => {
    expect(SCHEMA_CASES.length).toBeGreaterThanOrEqual(45);
  });

  for (const testCase of SCHEMA_CASES) {
    it(`${testCase.name}: accepts the valid example`, () => {
      const result = testCase.schema.safeParse(testCase.valid);
      expect(result.success, JSON.stringify(result.error?.issues ?? [], null, 2)).toBe(true);
    });
    it(`${testCase.name}: rejects the invalid example`, () => {
      expect(testCase.schema.safeParse(testCase.invalid).success).toBe(false);
    });
  }
});
