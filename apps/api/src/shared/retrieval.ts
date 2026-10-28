// Tutor retrieval and history (TUT-01, ai-pipeline §6.1 B, §6.6). Pages come from Postgres full-text search
// over document_pages.tsv (portuguese, accent-insensitive query) or from the knowledge map when the thread
// is scoped to a topic. Only pages the thread has not sent yet are added (context pack). Earlier user turns
// are replayed with their documents rebuilt from the same stored slices, so the replayed prefix is identical.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PdfSlice } from '@studify/prompts';
import { downloadBytes, sliceObjectPath } from './storage.ts';
import { toBase64, prepareSlices, type PreparedSlice } from './slices.ts';
import type { Deps } from './deps.ts';

export const TUTOR_NEW_PAGES_PER_TURN = 30;
export const TUTOR_CONTEXT_PAGES_CAP = 120;
export const TUTOR_MESSAGES_PER_DAY = 60;
export const TUTOR_THREAD_MESSAGE_CAP = 200;

/** Lowercase, accents removed, punctuation dropped: matches document_pages.tsv (f_unaccent + portuguese). */
export function searchTerms(message: string): string {
  return message
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 8)
    .join(' ');
}

export interface PageHit {
  document_id: string;
  page_number: number;
  text: string | null;
}

export async function ftsPages(db: SupabaseClient, documentIds: string[], query: string, limit = 40): Promise<PageHit[]> {
  if (documentIds.length === 0 || query.length === 0) return [];
  const { data, error } = await db
    .from('document_pages')
    .select('document_id, page_number, text')
    .in('document_id', documentIds)
    .textSearch('tsv', query, { type: 'websearch', config: 'portuguese' })
    .limit(limit);
  if (error) throw error;
  return (data as PageHit[]) ?? [];
}

/** Picks the pages to add this turn: not already in the context pack, capped per turn, grouped per document. */
export function selectNewPages(hits: PageHit[], sent: Set<string>, cap = TUTOR_NEW_PAGES_PER_TURN): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let total = 0;
  for (const hit of hits) {
    if (total >= cap) break;
    const key = `${hit.document_id}|${hit.page_number}`;
    if (sent.has(key)) continue;
    const list = out.get(hit.document_id) ?? [];
    if (list.includes(hit.page_number)) continue;
    list.push(hit.page_number);
    out.set(hit.document_id, list);
    total += 1;
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

/** Stored form of one tutor slice, kept in tutor_messages.retrieval so a replay can rebuild it. */
export interface StoredSlice {
  row_id: string;
  document_id: string;
  title: string;
  pages: number[];
  storage_path: string;
}

/** Prepares the new slices for a turn and returns them with their stored form. */
export async function prepareTurnSlices(deps: Deps, docs: Map<string, { title: string; storagePath: string }>, pagesByDoc: Map<string, number[]>): Promise<{ prepared: PreparedSlice[]; stored: StoredSlice[] }> {
  const prepared: PreparedSlice[] = [];
  for (const [documentId, pages] of [...pagesByDoc.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const doc = docs.get(documentId);
    if (!doc) continue;
    prepared.push(
      ...(await prepareSlices(deps.db, { documentId, title: doc.title, storagePath: doc.storagePath, pages, purpose: 'tutor', newId: deps.newId })),
    );
  }
  const stored = prepared.map((p) => ({ row_id: p.rowId, document_id: p.documentId, title: p.title, pages: p.pages, storage_path: p.storagePath }));
  return { prepared, stored };
}

/** Document block source for a stored slice, re-read from Storage (same bytes as the original turn). */
export async function slicesFromStored(deps: Deps, stored: StoredSlice[], cache: Map<string, string>): Promise<PdfSlice[]> {
  const out: PdfSlice[] = [];
  for (const s of stored) {
    let data = cache.get(s.row_id);
    if (!data) {
      data = toBase64(await downloadBytes(deps.db, sliceObjectPath(s.storage_path)));
      cache.set(s.row_id, data);
    }
    out.push({ documentId: s.document_id, title: s.title, pages: s.pages, source: { type: 'base64', media_type: 'application/pdf', data } });
  }
  return out;
}
