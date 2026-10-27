// Slice planning (spec 01 §8.1, ai-pipeline §4.1). Pure functions: page ranges in, page ranges out.
// Byte limits are enforced by the caller after the PDF is built (halving, see pdf-slices.ts).

export interface PageSpan {
  start: number;
  end: number;
}

export const OUTLINE_MAX_PAGES = 150;
export const TOPIC_MAX_PAGES = 60;

/** Consecutive pages to contiguous spans: [1,2,3,7] -> [{1,3},{7,7}]. Input need not be sorted. */
export function pagesToSpans(pages: readonly number[]): PageSpan[] {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const out: PageSpan[] = [];
  for (const page of sorted) {
    const last = out[out.length - 1];
    if (last && page === last.end + 1) last.end = page;
    else out.push({ start: page, end: page });
  }
  return out;
}

/** Splits [start, end] into consecutive spans of at most `max` pages. */
export function splitSpan(start: number, end: number, max: number): PageSpan[] {
  const out: PageSpan[] = [];
  for (let s = start; s <= end; s += max) out.push({ start: s, end: Math.min(end, s + max - 1) });
  return out;
}

/**
 * Outline slices for a document of `pageCount` pages. `cutStarts` are bookmark start pages (1-based).
 * With cut points, chapters are merged while the slice stays within `maxPages`; a chapter longer than
 * `maxPages` is split. Without cut points the document is cut into fixed slices.
 */
export function planOutlineSlices(pageCount: number, cutStarts: readonly number[] = [], maxPages = OUTLINE_MAX_PAGES): PageSpan[] {
  if (pageCount < 1) return [];
  const cuts = [...new Set(cutStarts.filter((p) => p > 1 && p <= pageCount))].sort((a, b) => a - b);
  if (cuts.length === 0) return splitSpan(1, pageCount, maxPages);

  const starts = [1, ...cuts];
  const chapters: PageSpan[] = starts.map((start, i) => ({
    start,
    end: i + 1 < starts.length ? (starts[i + 1] as number) - 1 : pageCount,
  }));

  const out: PageSpan[] = [];
  let current: PageSpan | null = null;
  for (const chapter of chapters) {
    if (chapter.end - chapter.start + 1 > maxPages) {
      if (current) out.push(current);
      current = null;
      out.push(...splitSpan(chapter.start, chapter.end, maxPages));
      continue;
    }
    if (current && chapter.end - current.start + 1 <= maxPages) {
      current.end = chapter.end;
    } else {
      if (current) out.push(current);
      current = { ...chapter };
    }
  }
  if (current) out.push(current);
  return out;
}

/** Halves a span until `fits` accepts it. Used when a built slice exceeds the byte limit. */
export function halveUntil(span: PageSpan, fits: (s: PageSpan) => boolean): PageSpan[] {
  if (fits(span) || span.end <= span.start) return [span];
  const mid = Math.floor((span.start + span.end) / 2);
  return [...halveUntil({ start: span.start, end: mid }, fits), ...halveUntil({ start: mid + 1, end: span.end }, fits)];
}
