// PDF slices as document blocks, and mapping slice-relative page numbers back to original pages.
// Source: ai-pipeline §4.1 (document blocks), §4.2 (source types), §4.3 (page numbers, TRU-01),
// §5.2 (citations: all-or-none per request).

import type {
  BetaRequestDocumentBlock,
  BetaTextCitation,
  CacheTtl,
  DocumentSlice,
  MappedCitation,
  SourceMap,
  SourcePageRef,
} from "./types.ts";

export interface PageRange {
  page_start: number;
  page_end: number;
}

/** Sorted, de-duplicated, contiguous ranges: [12,13,14,40] -> [{12,14},{40,40}]. */
export function pagesToRanges(pages: readonly number[]): PageRange[] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: PageRange[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p === last.page_end + 1) {
      last.page_end = p;
    } else {
      out.push({ page_start: p, page_end: p });
    }
  }
  return out;
}

/** "12–14, 40" in PT-BR typography. */
export function formatPageList(pages: readonly number[]): string {
  return pagesToRanges(pages)
    .map((r) => (r.page_start === r.page_end ? `${r.page_start}` : `${r.page_start}–${r.page_end}`))
    .join(", ");
}

/** Label from ai-pipeline §4.1: "Documento {title} — páginas originais {list}". */
export function documentLabel(slice: DocumentSlice): string {
  return `Documento ${slice.title} — páginas originais ${formatPageList(slice.pages)}`;
}

/** Slice page index (1-based, as the model sees it) to the original page number, or null. */
export function toOriginalPage(slice: DocumentSlice, indexOneBased: number): number | null {
  if (!Number.isInteger(indexOneBased) || indexOneBased < 1) return null;
  return slice.pages[indexOneBased - 1] ?? null;
}

export type SourcePagesResult =
  | { ok: true; ranges: SourcePageRef[] }
  | { ok: false; invalid: number[] };

/**
 * Maps structured-output `source_pages` (slice-relative) to original page ranges (TRU-01.2).
 * Any index outside the slice invalidates the item: the caller retries once, then drops it.
 */
export function mapSourcePages(slice: DocumentSlice, sourcePages: readonly number[]): SourcePagesResult {
  const invalid: number[] = [];
  const original: number[] = [];
  for (const idx of sourcePages) {
    const page = toOriginalPage(slice, idx);
    if (page === null) invalid.push(idx);
    else original.push(page);
  }
  if (invalid.length > 0 || original.length === 0) {
    return { ok: false, invalid: invalid.length > 0 ? invalid : [...sourcePages] };
  }
  return {
    ok: true,
    ranges: pagesToRanges(original).map((r) => ({
      documentId: slice.documentId,
      pageStart: r.page_start,
      pageEnd: r.page_end,
    })),
  };
}

export interface DocumentBlockOptions {
  /** `base64` for synchronous calls; `file` (Files API id) for worker jobs. One per request type (§4.2). */
  source: "base64" | "file";
  /** Enables citations on every document block of the request (all-or-none, §5.2). */
  citations: boolean;
  /** Adds a cache breakpoint on the last document block (§6.1). */
  cacheTtl?: CacheTtl;
}

export interface DocumentBlocks {
  blocks: BetaRequestDocumentBlock[];
  /** Same order as `blocks`. Pass it to TaskCall.sources. */
  sourceMap: SourceMap;
}

/**
 * Builds document blocks for slices. Slices are ordered by (documentId, first page) so the
 * cached prefix is byte-identical across calls that share the same slices (§6.2).
 */
export function documentBlocks(slices: readonly DocumentSlice[], opts: DocumentBlockOptions): DocumentBlocks {
  const ordered = [...slices].sort(
    (a, b) => a.documentId.localeCompare(b.documentId) || (a.pages[0] ?? 0) - (b.pages[0] ?? 0),
  );
  const blocks: BetaRequestDocumentBlock[] = ordered.map((slice) => {
    const source =
      opts.source === "file"
        ? requireField(slice.anthropicFileId, `slice ${slice.id} has no Files API id`, () => ({
            type: "file" as const,
            file_id: slice.anthropicFileId as string,
          }))
        : requireField(slice.base64, `slice ${slice.id} has no base64 bytes`, () => ({
            type: "base64" as const,
            media_type: "application/pdf" as const,
            data: slice.base64 as string,
          }));
    const block: BetaRequestDocumentBlock = {
      type: "document",
      source,
      title: documentLabel(slice),
    };
    if (opts.citations) block.citations = { enabled: true };
    return block;
  });
  const last = blocks[blocks.length - 1];
  if (last && opts.cacheTtl) last.cache_control = { type: "ephemeral", ttl: opts.cacheTtl };
  return { blocks, sourceMap: ordered };
}

function requireField<T>(value: unknown, message: string, build: () => T): T {
  if (value === undefined || value === null || value === "") throw new Error(message);
  return build();
}

/**
 * Maps one API citation to original page numbers. `document_index` selects the slice in the
 * request's SourceMap. Only page locations are mapped; other kinds are returned with valid = false.
 */
export function mapCitation(citation: BetaTextCitation, sources: SourceMap | undefined): MappedCitation {
  const documentIndex = (citation as { document_index?: number }).document_index ?? -1;
  const slice = sources?.[documentIndex];
  const base: MappedCitation = {
    type: citation.type,
    citedText: (citation as { cited_text?: string }).cited_text ?? "",
    documentIndex,
    documentId: slice?.documentId ?? null,
    pageStart: null,
    pageEnd: null,
    textStart: null,
    textEnd: null,
    valid: false,
  };
  if (citation.type !== "page_location" || !slice) return base;
  const pageStart = toOriginalPage(slice, citation.start_page_number);
  const pageEnd = toOriginalPage(slice, citation.end_page_number);
  if (pageStart === null || pageEnd === null || pageStart > pageEnd) return base;
  return { ...base, pageStart, pageEnd, valid: true };
}

/** Image block (Câmera Mágica, past-test photos). Base64 only in this helper. */
export function imageBlock(
  base64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif",
  cacheTtl?: CacheTtl,
): { type: "image"; source: { type: "base64"; media_type: typeof mediaType; data: string }; cache_control?: { type: "ephemeral"; ttl: CacheTtl } } {
  const block: ReturnType<typeof imageBlock> = {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: base64 },
  };
  if (cacheTtl) block.cache_control = { type: "ephemeral", ttl: cacheTtl };
  return block;
}
