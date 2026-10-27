import { describe, expect, it } from "vitest";
import {
  documentBlocks,
  documentLabel,
  formatPageList,
  mapCitation,
  mapSourcePages,
  pagesToRanges,
  toOriginalPage,
} from "../src/pdf.ts";
import type { DocumentSlice } from "../src/types.ts";
import { SLICE } from "./helpers.ts";

describe("page numbers (TRU-01, ai-pipeline §4.3)", () => {
  it("merges contiguous original pages into ranges", () => {
    expect(pagesToRanges([12, 13, 14, 40, 41])).toEqual([
      { page_start: 12, page_end: 14 },
      { page_start: 40, page_end: 41 },
    ]);
    expect(pagesToRanges([5, 3, 3, 4])).toEqual([{ page_start: 3, page_end: 5 }]);
  });

  it("formats page lists in PT-BR typography", () => {
    expect(formatPageList([12, 13, 14, 40, 41, 80])).toBe("12–14, 40–41, 80");
  });

  it("labels document blocks with the original pages", () => {
    expect(documentLabel(SLICE)).toBe("Documento Biologia — Célula — páginas originais 12–14, 40–41");
  });

  it("maps slice indices (1-based) to original pages, and rejects out-of-range indices", () => {
    expect(toOriginalPage(SLICE, 1)).toBe(12);
    expect(toOriginalPage(SLICE, 4)).toBe(40);
    expect(toOriginalPage(SLICE, 6)).toBeNull();
    expect(toOriginalPage(SLICE, 0)).toBeNull();
  });

  it("maps source_pages to ranges, and reports invalid indices so the item can be retried", () => {
    const ok = mapSourcePages(SLICE, [2, 3, 5]);
    expect(ok).toEqual({
      ok: true,
      ranges: [
        { documentId: "doc-1", pageStart: 13, pageEnd: 14 },
        { documentId: "doc-1", pageStart: 41, pageEnd: 41 },
      ],
    });
    expect(mapSourcePages(SLICE, [2, 9])).toEqual({ ok: false, invalid: [9] });
  });

  it("maps a page_location citation back to original pages through document_index", () => {
    const mapped = mapCitation(
      { type: "page_location", cited_text: "trecho", document_index: 0, document_title: null, start_page_number: 2, end_page_number: 4, file_id: null },
      [SLICE],
    );
    expect(mapped).toMatchObject({ valid: true, pageStart: 13, pageEnd: 40, documentId: "doc-1", citedText: "trecho" });
  });

  it("marks citations that cannot be mapped as invalid", () => {
    const outOfRange = mapCitation(
      { type: "page_location", cited_text: "x", document_index: 0, document_title: null, start_page_number: 1, end_page_number: 9, file_id: null },
      [SLICE],
    );
    expect(outOfRange.valid).toBe(false);
    const noSource = mapCitation(
      { type: "page_location", cited_text: "x", document_index: 3, document_title: null, start_page_number: 1, end_page_number: 1, file_id: null },
      [SLICE],
    );
    expect(noSource.valid).toBe(false);
    expect(noSource.documentId).toBeNull();
  });
});

describe("document blocks (ai-pipeline §4.1, §4.2, §6.2)", () => {
  const other: DocumentSlice = { id: "slice-0", documentId: "doc-0", title: "Aula 1", pages: [1, 2], base64: "QQ==" };

  it("orders blocks by (documentId, first page) and records the matching source map", () => {
    const { blocks, sourceMap } = documentBlocks([SLICE, other], { source: "base64", citations: false });
    expect(sourceMap.map((s) => s.id)).toEqual(["slice-0", "slice-1"]);
    expect(blocks[0]?.title).toBe("Documento Aula 1 — páginas originais 1–2");
  });

  it("enables citations on every block when asked, and puts the cache breakpoint on the last one", () => {
    const { blocks } = documentBlocks([other, SLICE], { source: "base64", citations: true, cacheTtl: "1h" });
    expect(blocks.every((b) => b.citations?.enabled === true)).toBe(true);
    expect(blocks[0]?.cache_control).toBeUndefined();
    expect(blocks[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("uses the Files API id for worker jobs and base64 for synchronous calls", () => {
    const withFile = { ...SLICE, anthropicFileId: "file_123", base64: undefined };
    const { blocks } = documentBlocks([withFile], { source: "file", citations: false });
    expect(blocks[0]?.source).toEqual({ type: "file", file_id: "file_123" });
    expect(() => documentBlocks([withFile], { source: "base64", citations: false })).toThrow(/no base64/);
  });
});
