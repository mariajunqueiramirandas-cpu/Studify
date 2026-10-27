import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_STATUS,
  DocumentStatusSchema,
  ENUMS,
  FEATURE_IDS,
  ITEM_HIDE_TYPE,
  ITEM_TYPE,
  QUIZ_KIND,
  isOneOf,
} from '../../src/core/enums.ts';

describe('ENUMS registry', () => {
  it('keys are exactly table.column (or bare private table .column)', () => {
    for (const key of Object.keys(ENUMS)) {
      expect(key, key).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it('every list is non-empty, unique and snake_case (or an uppercase area code)', () => {
    for (const [key, values] of Object.entries(ENUMS)) {
      expect(values.length, key).toBeGreaterThan(0);
      expect(new Set(values).size, `${key} duplicates`).toBe(values.length);
      for (const v of values) {
        expect(v, `${key}:${v}`).toMatch(/^([a-z][a-z0-9_]*|[A-Z]{2})$/);
      }
    }
  });

  it('maps the documented value lists (spot checks against data-model.md)', () => {
    expect(ENUMS['documents.status']).toEqual(['uploaded', 'processing', 'ready', 'failed', 'waiting_budget']);
    expect(ENUMS['quizzes.kind']).toHaveLength(9);
    expect(ENUMS['mistakes.cause']).toEqual(['didnt_know', 'confused', 'careless', 'misread']);
    expect(ENUMS['subjects.enem_area']).toEqual(['LC', 'CH', 'CN', 'MT']);
    expect(ENUMS['notes.depth']).toContain('class_summary');
    expect(ENUMS['exams.kind']).toEqual(['regular', 'recuperacao', 'final']);
  });

  it('item_hides never takes card (R7) while content_flags and item_revisions do (R19)', () => {
    expect(ITEM_TYPE).toContain('card');
    expect(ITEM_HIDE_TYPE).not.toContain('card');
    expect(ENUMS['item_hides.item_type']).toEqual(ITEM_HIDE_TYPE);
    expect(ENUMS['content_flags.item_type']).toEqual(ITEM_TYPE);
  });

  it('Zod enums accept listed values and reject others', () => {
    expect(DocumentStatusSchema.parse('ready')).toBe('ready');
    expect(() => DocumentStatusSchema.parse('done')).toThrow();
    expect(isOneOf(QUIZ_KIND, 'boss')).toBe(true);
    expect(isOneOf(QUIZ_KIND, 'quiz')).toBe(false);
    expect(DOCUMENT_STATUS).toContain('waiting_budget');
  });
});

describe('FEATURE_IDS', () => {
  it('has 89 unique PRD IDs', () => {
    expect(FEATURE_IDS).toHaveLength(89);
    expect(new Set(FEATURE_IDS).size).toBe(89);
  });

  it('matches the PRD §5 feature catalog exactly', () => {
    const prdPath = fileURLToPath(new URL('../../../../docs/product/PRD.md', import.meta.url));
    const prd = readFileSync(prdPath, 'utf8');
    const catalog = prd.slice(prd.indexOf('## 5. Feature catalog'), prd.indexOf('## 6.'));
    const ids = [...catalog.matchAll(/^\| ([A-Z]{3}-\d{2}) \|/gm)].map((m) => m[1]);
    expect(ids).toEqual([...FEATURE_IDS]);
  });
});
