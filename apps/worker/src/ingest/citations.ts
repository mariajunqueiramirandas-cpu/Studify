// Turns citation-mode output into the stored body + citations array (spec 02 §7, ai-pipeline §5.2).
// Markers `[[cite:N]]` are inserted right after the cited block, where N indexes the stored citations
// array. The app renders each marker as a 📄 chip. Citations with invalid pages are dropped (TRU-01.2).

export interface CitationInput {
  textStart: number | null;
  textEnd: number | null;
  documentId: string | null;
  pageStart: number | null;
  pageEnd: number | null;
  citedText: string;
  valid: boolean;
}

export interface StoredCitation {
  start: number;
  end: number;
  document_id: string;
  page_start: number;
  page_end: number;
  cited_text: string;
}

export interface CitedBody {
  body: string;
  citations: StoredCitation[];
  /** Citations dropped because their pages or offsets were invalid. */
  dropped: number;
}

export const CITE_MARKER = (index: number): string => `[[cite:${index}]]`;

export function renderCitedBody(text: string, citations: readonly CitationInput[]): CitedBody {
  type Entry = { pos: number; citation: Omit<StoredCitation, 'start' | 'end'> & { origStart: number } };
  const entries: Entry[] = [];
  const seen = new Map<string, number>();
  let dropped = 0;

  for (const c of citations) {
    const ok =
      c.valid &&
      c.documentId !== null &&
      c.pageStart !== null &&
      c.pageEnd !== null &&
      c.pageEnd >= c.pageStart &&
      c.textStart !== null &&
      c.textEnd !== null &&
      c.textStart >= 0 &&
      c.textEnd >= c.textStart &&
      c.textEnd <= text.length;
    if (!ok) {
      dropped++;
      continue;
    }
    const key = `${c.documentId}|${c.pageStart}|${c.pageEnd}|${c.citedText}|${c.textStart}|${c.textEnd}`;
    if (seen.has(key)) continue;
    seen.set(key, entries.length);
    entries.push({
      pos: c.textEnd as number,
      citation: {
        document_id: c.documentId as string,
        page_start: c.pageStart as number,
        page_end: c.pageEnd as number,
        cited_text: c.citedText,
        origStart: c.textStart as number,
      },
    });
  }

  // Each citation's marker sits at its end offset. Markers at the same offset keep citation order.
  const ordered = entries
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.pos - b.pos || a.index - b.index);

  const shiftBefore = (offset: number, strict: boolean): number => {
    let shift = 0;
    for (const item of ordered) {
      if (strict ? item.pos < offset : item.pos <= offset) shift += CITE_MARKER(item.index).length;
    }
    return shift;
  };

  let body = '';
  let cursor = 0;
  for (const item of ordered) {
    body += text.slice(cursor, item.pos);
    body += CITE_MARKER(item.index);
    cursor = item.pos;
  }
  body += text.slice(cursor);

  const stored: StoredCitation[] = entries.map((entry) => {
    const start = entry.citation.origStart + shiftBefore(entry.citation.origStart, true);
    const end = entry.pos + shiftBefore(entry.pos, true);
    return {
      start,
      end,
      document_id: entry.citation.document_id,
      page_start: entry.citation.page_start,
      page_end: entry.citation.page_end,
      cited_text: entry.citation.cited_text,
    };
  });
  return { body, citations: stored, dropped };
}

/** Counts `[[cite:N]]` markers in a body that point at a citation index. Used by tests and quality checks. */
export function markerIndexes(body: string): number[] {
  return [...body.matchAll(/\[\[cite:(\d+)\]\]/g)].map((m) => Number(m[1]));
}
