// Per-page text layer, positioned spans and scanned detection (ING-02.2, ING-02.3, spec 01 §8.3).
// Runs pdf.js sequentially and releases each page before the next one to bound memory.
import { normalizeTextItem, type TextSpanOut, type RawTextItem } from './pdf-spans.ts';
import { openPdf, pdfjs } from './pdfjs.ts';
import { nonWhitespaceCount } from './text.ts';

export const SCANNED_MIN_CHARS = 20;

export interface PageExtraction {
  pageNumber: number;
  /** Viewport size at scale 1 (points). */
  width: number;
  height: number;
  text: string;
  charCount: number;
  scanned: boolean;
  spans: TextSpanOut[];
  hasImages: boolean;
}

const IMAGE_OPS = new Set<number>([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject]);

export async function extractPages(bytes: Uint8Array, onPage?: (page: PageExtraction) => Promise<void> | void): Promise<PageExtraction[]> {
  const doc = await openPdf(bytes);
  const out: PageExtraction[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        const spans: TextSpanOut[] = [];
        let text = '';
        for (const raw of content.items) {
          if (typeof raw !== 'object' || raw === null || !('str' in raw)) continue;
          const item = raw as RawTextItem & { hasEOL?: boolean };
          if (item.str) {
            const span = normalizeTextItem(item, viewport);
            if (span) spans.push(span);
          }
          text += item.str;
          text += item.hasEOL ? '\n' : ' ';
        }
        text = text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
        const charCount = nonWhitespaceCount(text);
        const ops = await page.getOperatorList();
        const hasImages = ops.fnArray.some((fn) => IMAGE_OPS.has(fn));
        const extraction: PageExtraction = {
          pageNumber: n,
          width: viewport.width,
          height: viewport.height,
          text,
          charCount,
          scanned: charCount < SCANNED_MIN_CHARS,
          spans,
          hasImages,
        };
        out.push(extraction);
        if (onPage) await onPage(extraction);
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }
  return out;
}
