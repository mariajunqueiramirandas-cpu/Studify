import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CitationSchema,
  SourcePageSchema,
  countPages,
  formatPageChip,
  formatPageRange,
  formatPageRanges,
  mergePageNumbers,
  normalizePageRanges,
  sliceRangeToOriginalRanges,
  toOriginalPage,
  toSourcePages,
} from '../../src/core/citations.ts';

const DOC = '0190f3b2-7c4d-7a1b-8c2d-3e4f5a6b7c8d';

describe('slice → original page mapping (ai-pipeline §4.3)', () => {
  // A slice built from original pages 12–14 and 40–41 (non-contiguous, as in tutor packs).
  const pages = [12, 13, 14, 40, 41];

  it('maps 1-based slice indices to original pages', () => {
    expect(toOriginalPage(pages, 1)).toBe(12);
    expect(toOriginalPage(pages, 4)).toBe(40);
  });

  it('returns null for indices outside the slice (the item is then invalid)', () => {
    expect(toOriginalPage(pages, 0)).toBeNull();
    expect(toOriginalPage(pages, 6)).toBeNull();
    expect(toOriginalPage(pages, 1.5)).toBeNull();
  });

  it('maps an index range and merges contiguous original pages', () => {
    expect(sliceRangeToOriginalRanges(pages, 1, 5)).toEqual([
      { page_start: 12, page_end: 14 },
      { page_start: 40, page_end: 41 },
    ]);
    expect(sliceRangeToOriginalRanges(pages, 3, 4)).toEqual([
      { page_start: 14, page_end: 14 },
      { page_start: 40, page_end: 40 },
    ]);
  });

  it('refuses a range that reaches outside the slice', () => {
    expect(sliceRangeToOriginalRanges(pages, 4, 6)).toBeNull();
    expect(sliceRangeToOriginalRanges(pages, 3, 2)).toBeNull();
  });
});

describe('merging and normalizing page ranges', () => {
  it('sorts, merges overlapping and adjacent ranges', () => {
    expect(
      normalizePageRanges([
        { page_start: 3, page_end: 5 },
        { page_start: 6, page_end: 8 },
        { page_start: 1, page_end: 1 },
        { page_start: 10, page_end: 12 },
        { page_start: 11, page_end: 11 },
      ]),
    ).toEqual([
      { page_start: 1, page_end: 1 },
      { page_start: 3, page_end: 8 },
      { page_start: 10, page_end: 12 },
    ]);
  });

  it('mergePageNumbers de-duplicates and groups consecutive pages', () => {
    expect(mergePageNumbers([5, 3, 4, 4, 9])).toEqual([
      { page_start: 3, page_end: 5 },
      { page_start: 9, page_end: 9 },
    ]);
    expect(mergePageNumbers([])).toEqual([]);
  });

  it('rejects invalid ranges and page numbers', () => {
    expect(() => normalizePageRanges([{ page_start: 5, page_end: 4 }])).toThrow(RangeError);
    expect(() => normalizePageRanges([{ page_start: 0, page_end: 2 }])).toThrow(RangeError);
    expect(() => mergePageNumbers([0])).toThrow(RangeError);
  });

  it('is idempotent and preserves the set of covered pages (property)', () => {
    const rangeArb = fc
      .tuple(fc.integer({ min: 1, max: 60 }), fc.integer({ min: 0, max: 8 }))
      .map(([start, len]) => ({ page_start: start, page_end: start + len }));

    fc.assert(
      fc.property(fc.array(rangeArb, { maxLength: 12 }), (ranges) => {
        const once = normalizePageRanges(ranges);
        expect(normalizePageRanges(once)).toEqual(once);

        const covered = new Set<number>();
        for (const r of ranges) for (let p = r.page_start; p <= r.page_end; p += 1) covered.add(p);
        const coveredAfter = new Set<number>();
        for (const r of once) for (let p = r.page_start; p <= r.page_end; p += 1) coveredAfter.add(p);
        expect([...coveredAfter].sort((a, b) => a - b)).toEqual([...covered].sort((a, b) => a - b));
        expect(countPages(ranges)).toBeGreaterThanOrEqual(covered.size);
      }),
    );
  });
});

describe('formatting (copy-pt-br §2 "Page references")', () => {
  it('single page and range', () => {
    expect(formatPageRange({ page_start: 14, page_end: 14 })).toBe('p. 14');
    expect(formatPageRange({ page_start: 14, page_end: 16 })).toBe('p. 14–16');
  });

  it('list of ranges shares one prefix', () => {
    expect(formatPageRanges([{ page_start: 9, page_end: 9 }, { page_start: 3, page_end: 5 }])).toBe('p. 3–5, 9');
    expect(formatPageRanges([])).toBe('');
  });

  it('chip uses the 📄 prefix', () => {
    expect(formatPageChip({ page_start: 14, page_end: 14 })).toBe('📄 p. 14');
  });
});

describe('citation schemas', () => {
  it('SourcePage requires page_end >= page_start', () => {
    expect(SourcePageSchema.safeParse({ document_id: DOC, page_start: 14, page_end: 16 }).success).toBe(true);
    expect(SourcePageSchema.safeParse({ document_id: DOC, page_start: 16, page_end: 14 }).success).toBe(false);
    expect(SourcePageSchema.safeParse({ document_id: 'nope', page_start: 1, page_end: 1 }).success).toBe(false);
  });

  it('Citation checks both offsets and pages', () => {
    const ok = { start: 0, end: 12, document_id: DOC, page_start: 2, page_end: 2, cited_text: 'Mitose' };
    expect(CitationSchema.safeParse(ok).success).toBe(true);
    expect(CitationSchema.safeParse({ ...ok, end: -1 }).success).toBe(false);
    expect(CitationSchema.safeParse({ ...ok, start: 20, end: 10 }).success).toBe(false);
  });

  it('toSourcePages attaches the document id to normalized ranges', () => {
    expect(
      toSourcePages(DOC, [
        { page_start: 2, page_end: 3 },
        { page_start: 4, page_end: 4 },
      ]),
    ).toEqual([{ document_id: DOC, page_start: 2, page_end: 4 }]);
  });
});
