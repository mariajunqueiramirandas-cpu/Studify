import { describe, expect, it } from 'vitest';
import { multiplyTransform, normalizeTextItem } from '../../src/ingest/pdf-spans.ts';

// A 600 x 800 page: PDF user space has its origin at the bottom-left, so the viewport flips y.
const VIEWPORT = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };

describe('normalizeTextItem', () => {
  it('maps a PDF text item to a top-left normalized box', () => {
    // Baseline at PDF y = 700 (device y = 100), font size 20, width 200.
    const span = normalizeTextItem({ str: 'Mitocôndria', transform: [20, 0, 0, 20, 50, 700], width: 200 }, VIEWPORT);
    expect(span).toEqual({ text: 'Mitocôndria', x: 0.0833, y: 0.1, w: 0.3333, h: 0.025 });
  });

  it('keeps every coordinate inside 0–1', () => {
    const span = normalizeTextItem({ str: 'Fora', transform: [30, 0, 0, 30, 590, 10], width: 500 }, VIEWPORT);
    expect(span).not.toBeNull();
    for (const v of [span!.x, span!.y, span!.w, span!.h]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('skips empty or whitespace-only items', () => {
    expect(normalizeTextItem({ str: '   ', transform: [10, 0, 0, 10, 0, 0], width: 5 }, VIEWPORT)).toBeNull();
    expect(normalizeTextItem({ str: '', transform: [10, 0, 0, 10, 0, 0], width: 5 }, VIEWPORT)).toBeNull();
  });

  it('multiplies affine matrices in PDF.js order', () => {
    expect(multiplyTransform([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 10, 20]);
  });
});
