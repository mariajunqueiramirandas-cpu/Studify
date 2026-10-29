import { describe, expect, it } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { normalizePhoto, PHOTO_LONG_EDGE_PX } from '../../src/ingest/photos.ts';
import { renderPages } from '../../src/ingest/pdf-render.ts';
import { textPdf } from './support/pdf.ts';
import { PermanentJobError } from '../../src/framework/errors.ts';

function samplePng(width: number, height: number): Uint8Array {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#336699';
  ctx.fillRect(0, 0, width, height);
  return new Uint8Array(canvas.toBuffer('image/png'));
}

describe('photos to PDF input (ING-01, CAM-01)', () => {
  it('downsizes to the long-edge limit and re-encodes as JPEG', async () => {
    const out = await normalizePhoto(samplePng(3200, 1600));
    expect(out.width).toBe(PHOTO_LONG_EDGE_PX);
    expect(out.height).toBe(PHOTO_LONG_EDGE_PX / 2);
    // JPEG start-of-image marker.
    expect(out.bytes[0]).toBe(0xff);
    expect(out.bytes[1]).toBe(0xd8);
  });

  it('keeps small photos at their size', async () => {
    const out = await normalizePhoto(samplePng(300, 200));
    expect([out.width, out.height]).toEqual([300, 200]);
  });

  it('rejects bytes that are not an image', async () => {
    await expect(normalizePhoto(new TextEncoder().encode('not an image'))).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe('page rendering (ING-02.4)', () => {
  it('renders each requested page as WebP with a JPEG thumbnail', async () => {
    const bytes = await textPdf([['Página um'], ['Página dois']], [595, 842]);
    const seen: Array<{ page: number; ext: string; type: string; thumbBytes: number }> = [];
    const count = await renderPages(bytes, [1, 2], async (r) => {
      seen.push({ page: r.pageNumber, ext: r.image.extension, type: r.image.contentType, thumbBytes: r.thumb.bytes.length });
    });
    expect(count).toBe(2);
    expect(seen.map((s) => s.page)).toEqual([1, 2]);
    expect(seen[0]?.ext).toBe('webp');
    expect(seen[0]?.type).toBe('image/webp');
    expect(seen[0]?.thumbBytes).toBeGreaterThan(100);
  });
});
