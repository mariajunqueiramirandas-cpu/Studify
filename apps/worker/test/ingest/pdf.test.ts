import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { preflightPdf, hasPdfMagic, readBookmarkStarts } from '../../src/ingest/pdf-preflight.ts';
import { extractPages } from '../../src/ingest/pdf-text.ts';
import { buildSlice, loadSource } from '../../src/ingest/pdf-build.ts';
import { textPdf, encryptedPdfBytes, corruptPdfBytes } from './support/pdf.ts';

describe('S0 preflight (ING-02.1)', () => {
  it('accepts a 3-page text PDF and reports the page count', async () => {
    const bytes = await textPdf([['Capítulo 1', 'Células'], ['Organelas da célula'], ['Membrana plasmática']]);
    const result = await preflightPdf(bytes);
    expect(result).toMatchObject({ ok: true, pageCount: 3, hasBookmarks: false });
  });

  it('rejects bytes without the PDF header', async () => {
    expect(await preflightPdf(new TextEncoder().encode('<html>not a pdf</html>'))).toEqual({ ok: false, code: 'unsupported_type' });
    expect(hasPdfMagic(new TextEncoder().encode('%PDF-1.7 ok'))).toBe(true);
  });

  it('rejects an encrypted PDF as password_protected', async () => {
    expect(await preflightPdf(encryptedPdfBytes())).toEqual({ ok: false, code: 'password_protected' });
  });

  it('rejects a corrupt PDF', async () => {
    expect(await preflightPdf(corruptPdfBytes())).toEqual({ ok: false, code: 'corrupt' });
  });

  it('rejects files over the size limit before parsing', async () => {
    const bytes = await textPdf([['x']]);
    expect(await preflightPdf(bytes, { maxBytes: 100 })).toEqual({ ok: false, code: 'too_large' });
  });

  it('rejects documents over the page limit', async () => {
    const bytes = await textPdf([['a'], ['b'], ['c']]);
    expect(await preflightPdf(bytes, { maxPages: 2 })).toEqual({ ok: false, code: 'too_many_pages' });
  });
});

describe('text layer and scanned detection (ING-02.2, ING-02.3)', () => {
  it('extracts text and positioned spans per page, flagging blank pages as scanned', async () => {
    const bytes = await textPdf([['Mitocôndria produz ATP para a célula'], []]);
    const pages = await extractPages(bytes);
    expect(pages).toHaveLength(2);
    expect(pages[0]?.text).toContain('Mitocôndria produz ATP');
    expect(pages[0]?.scanned).toBe(false);
    expect(pages[0]?.spans.length).toBeGreaterThan(0);
    for (const span of pages[0]?.spans ?? []) {
      expect(span.x).toBeGreaterThanOrEqual(0);
      expect(span.y).toBeGreaterThanOrEqual(0);
      expect(span.x + span.w).toBeLessThanOrEqual(1.0001);
      expect(span.y + span.h).toBeLessThanOrEqual(1.0001);
    }
    expect(pages[1]?.scanned).toBe(true);
    expect(pages[1]?.spans).toEqual([]);
  });

  it('places the first line near the top of the page (origin top-left)', async () => {
    const bytes = await textPdf([['Topo da página']]);
    const [page] = await extractPages(bytes);
    const first = page?.spans[0];
    expect(first).toBeDefined();
    expect(first!.y).toBeLessThan(0.3);
  });
});

describe('slicing and bookmarks (ING-02.5)', () => {
  it('builds a slice with exactly the requested original pages, in order', async () => {
    const bytes = await textPdf([['p1'], ['p2'], ['p3'], ['p4']]);
    const source = await loadSource(bytes);
    const slice = await buildSlice(source, [2, 4]);
    const doc = await PDFDocument.load(slice);
    expect(doc.getPageCount()).toBe(2);
  });

  it('reads no bookmarks from a plain document', async () => {
    const source = await loadSource(await textPdf([['a']]));
    expect(readBookmarkStarts(source)).toEqual([]);
  });
});
