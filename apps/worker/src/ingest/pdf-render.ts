// Page images for the viewer and thumbnails (ING-02.4, ING-08). Citation view: long edge ≈ 1600 px as WebP
// (JPEG when WebP encoding is unavailable; the stored path records which one was written). Thumbnails:
// about 50 dpi JPEG. Rendering runs in its own job so S1 is not blocked by it.
import { createCanvas } from '@napi-rs/canvas';
import { openPdf, type PdfPageLike } from './pdfjs.ts';

export const IMAGE_LONG_EDGE_PX = 1600;
export const THUMB_DPI = 50;

export interface RenderedPage {
  pageNumber: number;
  image: { bytes: Uint8Array; contentType: 'image/webp' | 'image/jpeg'; extension: 'webp' | 'jpg' };
  thumb: { bytes: Uint8Array };
}

/** Renders the given pages one at a time. `sink` receives each result before the next render starts. */
export async function renderPages(
  bytes: Uint8Array,
  pages: readonly number[],
  sink: (rendered: RenderedPage) => Promise<void>,
): Promise<number> {
  const doc = await openPdf(bytes);
  let done = 0;
  try {
    for (const pageNumber of pages) {
      if (pageNumber < 1 || pageNumber > doc.numPages) continue;
      const page = await doc.getPage(pageNumber);
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = IMAGE_LONG_EDGE_PX / Math.max(base.width, base.height);
        const image = await renderToEncoded(page, scale, 0.82);
        const thumb = await renderToEncoded(page, THUMB_DPI / 72, 0.7, 'jpeg');
        await sink({ pageNumber, image, thumb: { bytes: thumb.bytes } });
        done++;
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }
  return done;
}

type PdfPage = PdfPageLike;

async function renderToEncoded(
  page: PdfPage,
  scale: number,
  quality: number,
  preferred: 'webp' | 'jpeg' = 'webp',
): Promise<{ bytes: Uint8Array; contentType: 'image/webp' | 'image/jpeg'; extension: 'webp' | 'jpg' }> {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport, canvas } as unknown as Parameters<PdfPage['render']>[0]).promise;
  if (preferred === 'webp') {
    try {
      const encoded = await canvas.encode('webp', Math.round(quality * 100));
      return { bytes: new Uint8Array(encoded), contentType: 'image/webp', extension: 'webp' };
    } catch {
      // Fall through to JPEG: the caller stores the .jpg path it actually receives.
    }
  }
  const jpeg = await canvas.encode('jpeg', Math.round(quality * 100));
  return { bytes: new Uint8Array(jpeg), contentType: 'image/jpeg', extension: 'jpg' };
}
