// Item crops for the ENEM bank (ENM-02.2): renders a booklet page and cuts the item's regions, stacked into one
// image per region. Also builds the one-page PDF slice sent with the transcription (exact characters).
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { openPdf, type PdfPageLike } from '../ingest/pdfjs.ts';
import type { CropRegion } from './import-parse.ts';

/** Rendered width of a page before cropping (A4 at ~2.4×: legible small print). */
const PAGE_WIDTH_PX = 1400;

export interface CropImage {
  bytes: Uint8Array;
  contentType: 'image/webp' | 'image/jpeg';
  extension: 'webp' | 'jpg';
}

async function encode(canvas: Canvas): Promise<CropImage> {
  try {
    return { bytes: new Uint8Array(await canvas.encode('webp', 85)), contentType: 'image/webp', extension: 'webp' };
  } catch {
    return { bytes: new Uint8Array(await canvas.encode('jpeg', 88)), contentType: 'image/jpeg', extension: 'jpg' };
  }
}

/** One image per region, in order. Pages are rendered once per call. */
export async function renderCrops(pdf: Uint8Array, regions: readonly CropRegion[]): Promise<CropImage[]> {
  const doc = await openPdf(pdf);
  const rendered = new Map<number, Canvas>();
  const out: CropImage[] = [];
  try {
    for (const r of regions) {
      let pageCanvas: Canvas | undefined = rendered.get(r.page);
      if (!pageCanvas) {
        const page: PdfPageLike = await doc.getPage(r.page);
        try {
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: PAGE_WIDTH_PX / base.width });
          const fresh = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvasContext: fresh.getContext('2d'), viewport, canvas: fresh } as unknown as Parameters<PdfPageLike['render']>[0]).promise;
          rendered.set(r.page, fresh);
          pageCanvas = fresh;
        } finally {
          page.cleanup();
        }
      }
      const W = pageCanvas.width;
      const H = pageCanvas.height;
      const sx = Math.floor(r.x0 * W);
      const sy = Math.floor(r.y0 * H);
      const sw = Math.max(1, Math.ceil((r.x1 - r.x0) * W));
      const sh = Math.max(1, Math.ceil((r.y1 - r.y0) * H));
      const crop = createCanvas(sw, sh);
      const g = crop.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, sw, sh);
      g.drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
      out.push(await encode(crop));
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** A one-page PDF (base64) for the transcription prompt's document block. */
export async function pageSliceBase64(pdf: Uint8Array, page: number): Promise<string> {
  const src = await PDFDocument.load(pdf, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const [copied] = await out.copyPages(src, [page - 1]);
  out.addPage(copied!);
  return Buffer.from(await out.save()).toString('base64');
}
