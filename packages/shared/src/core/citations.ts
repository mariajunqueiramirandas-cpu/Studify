// Page references and citations (TRU-01). Every stored or displayed page number is an ORIGINAL
// document page. The model only sees slice-relative indices, so the mapping below is applied before
// anything is stored (ai-pipeline §4.3, architecture §5 "Citations").
import { z } from 'zod';

export interface PageRange {
  page_start: number;
  page_end: number;
}

/** One entry of `SourcePages` (data-model §1.2). Original page numbers only. */
export interface SourcePage extends PageRange {
  document_id: string;
}

/** One entry of `Citations` (data-model §1.2). `start`/`end` index the prose body by character. */
export interface Citation extends PageRange {
  start: number;
  end: number;
  document_id: string;
  cited_text: string;
}

export const PageNumberSchema = z.int().min(1);

const pageRangeShape = {
  page_start: z.int().min(1),
  page_end: z.int().min(1),
};

export const PageRangeSchema = z
  .object(pageRangeShape)
  .refine((r) => r.page_end >= r.page_start, { message: 'page_end must be >= page_start' });

export const SourcePageSchema = z
  .object({ document_id: z.uuid(), ...pageRangeShape })
  .refine((r) => r.page_end >= r.page_start, { message: 'page_end must be >= page_start' });

/** `SourcePages`: the jsonb used by cards, questions, glossary_terms, feed_items, ... */
export const SourcePagesSchema = z.array(SourcePageSchema);

/** Citation fields without the ordering checks, so SSE events can extend it (api §2.6). */
export const CitationBaseSchema = z.object({
  start: z.int().min(0),
  end: z.int().min(0),
  document_id: z.uuid(),
  ...pageRangeShape,
  cited_text: z.string(),
});

export const CitationSchema = CitationBaseSchema
  .refine((c) => c.end >= c.start, { message: 'end must be >= start' })
  .refine((c) => c.page_end >= c.page_start, { message: 'page_end must be >= page_start' });

/** `Citations`: the jsonb used by notes, explanations, tutor_messages, camera_captures, podcast_interactions. */
export const CitationsSchema = z.array(CitationSchema);

/**
 * Maps a 1-based slice index to the original page (ai-pipeline §4.3 `toOriginalPage`).
 * `pages` is the slice's ordered list of original page numbers. Returns null when the index is
 * outside what was sent; the caller then invalidates the item.
 */
export function toOriginalPage(pages: readonly number[], sliceIndex1Based: number): number | null {
  if (!Number.isInteger(sliceIndex1Based) || sliceIndex1Based < 1) return null;
  return pages[sliceIndex1Based - 1] ?? null;
}

/**
 * Maps a slice-relative inclusive index range [sliceStart, sliceEnd] (1-based) to original page
 * ranges. Returns null when any index falls outside the slice, so a partly invalid citation is never
 * stored. Contiguous original pages are merged (TRU-01.2).
 */
export function sliceRangeToOriginalRanges(
  pages: readonly number[],
  sliceStart: number,
  sliceEnd: number,
): PageRange[] | null {
  if (sliceEnd < sliceStart) return null;
  const mapped: number[] = [];
  for (let i = sliceStart; i <= sliceEnd; i += 1) {
    const page = toOriginalPage(pages, i);
    if (page === null) return null;
    mapped.push(page);
  }
  return mergePageNumbers(mapped);
}

/** Sorts and de-duplicates page numbers, then merges consecutive ones into ranges. */
export function mergePageNumbers(pages: readonly number[]): PageRange[] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: PageRange[] = [];
  for (const page of sorted) {
    if (!Number.isInteger(page) || page < 1) throw new RangeError(`page number must be an integer >= 1: ${page}`);
    const last = out[out.length - 1];
    if (last && page === last.page_end + 1) {
      last.page_end = page;
    } else {
      out.push({ page_start: page, page_end: page });
    }
  }
  return out;
}

/**
 * Sorts ranges and merges any that overlap or touch (p. 3–5 and p. 6 become p. 3–6).
 * Throws on invalid ranges. Output is canonical and idempotent.
 */
export function normalizePageRanges(ranges: readonly PageRange[]): PageRange[] {
  const sorted = ranges
    .map((r) => {
      if (!Number.isInteger(r.page_start) || !Number.isInteger(r.page_end)) {
        throw new RangeError('page range bounds must be integers');
      }
      if (r.page_start < 1 || r.page_end < r.page_start) {
        throw new RangeError(`invalid page range ${r.page_start}–${r.page_end}`);
      }
      return { page_start: r.page_start, page_end: r.page_end };
    })
    .sort((a, b) => a.page_start - b.page_start || a.page_end - b.page_end);

  const out: PageRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.page_start <= last.page_end + 1) {
      last.page_end = Math.max(last.page_end, r.page_end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Builds `SourcePages` for one document from ranges (normalized). */
export function toSourcePages(documentId: string, ranges: readonly PageRange[]): SourcePage[] {
  return normalizePageRanges(ranges).map((r) => ({ document_id: documentId, ...r }));
}

/** Number of distinct original pages covered by the ranges. */
export function countPages(ranges: readonly PageRange[]): number {
  return normalizePageRanges(ranges).reduce((n, r) => n + (r.page_end - r.page_start + 1), 0);
}

const EN_DASH = '–';

/**
 * "p. 14" for a single page, "p. 14–16" for a range (copy-pt-br §2 "Page references").
 * The copy guide is the wording source; the spec's "pág." form is not used.
 */
export function formatPageRange(range: PageRange): string {
  if (range.page_end <= range.page_start) return `p. ${range.page_start}`;
  return `p. ${range.page_start}${EN_DASH}${range.page_end}`;
}

/** Comma-separated list of normalized ranges with one "p." prefix: "p. 3–5, 9". */
export function formatPageRanges(ranges: readonly PageRange[]): string {
  const parts = normalizePageRanges(ranges).map((r) =>
    r.page_end <= r.page_start ? `${r.page_start}` : `${r.page_start}${EN_DASH}${r.page_end}`,
  );
  return parts.length === 0 ? '' : `p. ${parts.join(', ')}`;
}

/** The 📄 chip shown next to generated items: "📄 p. 14" (copy-pt-br global.page_chip). */
export function formatPageChip(range: PageRange): string {
  return `📄 ${formatPageRange(range)}`;
}
