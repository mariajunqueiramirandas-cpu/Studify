// PDF fixtures built at test time with pdf-lib (no binary files in the repo).
import { PDFDocument, StandardFonts } from 'pdf-lib';

/** One PDF page per entry; each entry is the lines of text on that page. Empty array = blank page. */
export async function textPdf(pages: string[][], size: [number, number] = [600, 800]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const page = doc.addPage(size);
    lines.forEach((line, i) => {
      page.drawText(line, { x: 50, y: size[1] - 90 - i * 24, size: 16, font });
    });
  }
  return doc.save();
}

/** A structurally valid PDF with a catalog-level /Encrypt entry, which pdf-lib reports as encrypted. */
export function encryptedPdfBytes(): Uint8Array {
  const text = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj
3 0 obj << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >> endobj
trailer << /Root 1 0 R /Encrypt 3 0 R /Size 4 >>
%%EOF`;
  return new TextEncoder().encode(text);
}

/** Starts with the PDF header but is not a document. */
export function corruptPdfBytes(): Uint8Array {
  return new TextEncoder().encode('%PDF-1.4\nthis is not a pdf structure at all\n%%EOF');
}

export function sha256Hex(bytes: Uint8Array): Promise<string> {
  return import('node:crypto').then(({ createHash }) => createHash('sha256').update(bytes).digest('hex'));
}
