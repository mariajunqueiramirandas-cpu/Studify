import { describe, expect, it } from 'vitest';
import { halveUntil, pagesToSpans, planOutlineSlices, splitSpan } from '../../src/ingest/slice-plan.ts';

describe('planOutlineSlices', () => {
  it('cuts fixed 150-page slices without bookmarks', () => {
    expect(planOutlineSlices(400)).toEqual([
      { start: 1, end: 150 },
      { start: 151, end: 300 },
      { start: 301, end: 400 },
    ]);
  });

  it('cuts at bookmark chapters and merges small chapters up to the limit', () => {
    // Chapters: 1–40, 41–90, 91–100, 101–400 (the last one is longer than 150 pages and gets split).
    const slices = planOutlineSlices(400, [41, 91, 101]);
    // 1–40, 41–90 and 91–100 fit together (100 pages), so they merge; 101–400 is split in two.
    expect(slices).toEqual([
      { start: 1, end: 100 },
      { start: 101, end: 250 },
      { start: 251, end: 400 },
    ]);
    expect(slices.every((s) => s.end - s.start + 1 <= 150)).toBe(true);
    expect(slices.at(-1)?.end).toBe(400);
    // Every page appears exactly once.
    const covered = slices.flatMap((s) => Array.from({ length: s.end - s.start + 1 }, (_, i) => s.start + i));
    expect(covered).toEqual(Array.from({ length: 400 }, (_, i) => i + 1));
  });

  it('ignores cut points outside the document', () => {
    expect(planOutlineSlices(10, [1, 50])).toEqual([{ start: 1, end: 10 }]);
  });
});

describe('page helpers', () => {
  it('turns pages into contiguous spans', () => {
    expect(pagesToSpans([7, 1, 2, 3, 9, 10])).toEqual([
      { start: 1, end: 3 },
      { start: 7, end: 7 },
      { start: 9, end: 10 },
    ]);
  });

  it('splits long topics into slices of at most 60 pages', () => {
    expect(splitSpan(1, 130, 60)).toEqual([
      { start: 1, end: 60 },
      { start: 61, end: 120 },
      { start: 121, end: 130 },
    ]);
  });

  it('halves a span until it fits', () => {
    const fits = (s: { start: number; end: number }) => s.end - s.start < 40;
    const parts = halveUntil({ start: 1, end: 150 }, fits);
    expect(parts.every(fits)).toBe(true);
    expect(parts[0]?.start).toBe(1);
    expect(parts.at(-1)?.end).toBe(150);
  });
});
