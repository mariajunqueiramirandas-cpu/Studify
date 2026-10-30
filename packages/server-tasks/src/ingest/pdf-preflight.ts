// S0 preflight (spec 01 §8.2, ING-02.1, no AI): magic bytes, size, encryption, parse validity, page count,
// bookmarks. Returns a code for every rejection so the document row can show the matching PT-BR message.
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { openPdf } from './pdfjs.ts';
import { isApostila } from './apostila.ts';

export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_PAGES = 1000;

export type PreflightCode = 'unsupported_type' | 'too_large' | 'password_protected' | 'corrupt' | 'empty' | 'too_many_pages';

export type PreflightResult =
  | { ok: true; pageCount: number; hasBookmarks: boolean; cutStarts: number[]; apostila: boolean }
  | { ok: false; code: PreflightCode };

export interface PreflightLimits {
  maxBytes?: number;
  maxPages?: number;
}

/** `%PDF-` within the first kilobyte (the PDF spec allows leading junk before the header). */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(1024, bytes.length)));
  return head.includes('%PDF-');
}

export async function preflightPdf(bytes: Uint8Array, limits: PreflightLimits = {}): Promise<PreflightResult> {
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const maxPages = limits.maxPages ?? MAX_PAGES;
  if (!hasPdfMagic(bytes)) return { ok: false, code: 'unsupported_type' };
  if (bytes.byteLength > maxBytes) return { ok: false, code: 'too_large' };

  let lib: PDFDocument;
  try {
    lib = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (/encrypted/i.test(message)) return { ok: false, code: 'password_protected' };
    return { ok: false, code: 'corrupt' };
  }

  // pdf-lib accepts some broken files without error, so pdf.js is the authority for parse validity.
  let pageCount: number;
  try {
    const doc = await openPdf(bytes);
    pageCount = doc.numPages;
    await doc.destroy();
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'PasswordException') return { ok: false, code: 'password_protected' };
    return { ok: false, code: 'corrupt' };
  }
  if (pageCount === 0) return { ok: false, code: 'empty' };
  if (pageCount > maxPages) return { ok: false, code: 'too_many_pages' };

  const cutStarts = readBookmarkStarts(lib);
  return { ok: true, pageCount, hasBookmarks: cutStarts.length > 0, cutStarts, apostila: isApostila(lib) };
}

/**
 * Start pages of the top-level bookmarks (ai-pipeline §4.1: slices cut at chapter boundaries).
 * Named destinations are ignored; any structural surprise yields an empty list (fixed slicing).
 */
export function readBookmarkStarts(doc: PDFDocument): number[] {
  try {
    const outlines = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    if (!outlines) return [];
    const pageRefs = doc.getPages().map((p) => p.ref.toString());
    const starts: number[] = [];
    let item = outlines.lookupMaybe(PDFName.of('First'), PDFDict);
    let guard = 0;
    while (item && guard++ < 5000) {
      const page = destinationPage(item, pageRefs);
      if (page !== null) starts.push(page + 1);
      item = item.lookupMaybe(PDFName.of('Next'), PDFDict);
    }
    return [...new Set(starts)].sort((a, b) => a - b);
  } catch {
    return [];
  }
}

function destinationPage(item: PDFDict, pageRefs: string[]): number | null {
  let dest: unknown = item.get(PDFName.of('Dest'));
  if (!dest) {
    const action = item.lookupMaybe(PDFName.of('A'), PDFDict);
    dest = action?.get(PDFName.of('D'));
  }
  if (!(dest instanceof PDFArray)) return null;
  const first = dest.get(0);
  if (!(first instanceof PDFRef)) return null;
  const index = pageRefs.indexOf(first.toString());
  return index >= 0 ? index : null;
}
