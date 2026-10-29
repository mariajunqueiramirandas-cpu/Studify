// Slices and photo PDFs built with pdf-lib (ING-02.5, spec 01 §8.1). Each slice contains exactly the listed
// original pages, in order, so page index i of the slice is slice.pages[i-1] (ai-pipeline §4.3).
import { PDFDocument } from 'pdf-lib';

/** Loads a source document for repeated slicing. Encrypted files never reach this point (S0). */
export async function loadSource(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/** Builds a PDF with the given 1-based original pages, in the given order. */
export async function buildSlice(source: PDFDocument, pages: readonly number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const indexes = pages.map((p) => p - 1);
  const copied = await out.copyPages(source, indexes);
  for (const page of copied) out.addPage(page);
  return out.save({ useObjectStreams: true });
}

/** Builds a photo PDF: one page per image, page size equal to the image in points. */
export async function buildPhotoPdf(
  images: ReadonlyArray<{ bytes: Uint8Array; width: number; height: number }>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const image of images) {
    const embedded = await doc.embedJpg(image.bytes);
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(embedded, { x: 0, y: 0, width: image.width, height: image.height });
  }
  return doc.save({ useObjectStreams: true });
}
