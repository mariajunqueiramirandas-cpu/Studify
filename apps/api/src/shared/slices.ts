// PDF slices for synchronous calls (ai-pipeline §4.1, §4.2): the pages a task needs, as a PDF that
// keeps only those original pages, in order. Slices are stored once per (document, purpose, range) in
// document_slices and reused, so the same pages share one cache prefix (§4.1). Synchronous calls send
// them as base64 (§4.2).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PdfSlice } from '@studify/prompts';
import { pagesToRanges } from '@studify/ai';
import { documentObjectPath, downloadBytes, sliceBytes, uploadBytes } from './storage.ts';

export type SlicePurpose = 'outline' | 'topic' | 'transcription' | 'tutor';

/** A prepared slice. `rowId` is document_slices.id, so tutor history can reload the same bytes. */
export interface PreparedSlice {
  rowId: string;
  documentId: string;
  title: string;
  pages: number[];
  base64: string;
  storagePath: string;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function toPdfSlice(slice: PreparedSlice): PdfSlice {
  return {
    documentId: slice.documentId,
    title: slice.title,
    pages: slice.pages,
    source: { type: 'base64', media_type: 'application/pdf', data: slice.base64 },
  };
}

/** Pages `start..end` as an array, in order. */
export function rangePages(start: number, end: number): number[] {
  const out: number[] = [];
  for (let p = start; p <= end; p += 1) out.push(p);
  return out;
}

export interface PrepareArgs {
  documentId: string;
  title: string;
  /** documents.storage_path (the original PDF). */
  storagePath: string;
  /** Original page numbers, any order; they are merged into contiguous ranges. */
  pages: readonly number[];
  purpose: SlicePurpose;
  newId: () => string;
  estTokensPerPage?: number;
}

/**
 * Returns one prepared slice per contiguous range, in ascending page order. Missing slices are built
 * from the original PDF with pdf-lib, uploaded to the `slices` bucket and recorded in document_slices.
 */
export async function prepareSlices(db: SupabaseClient, args: PrepareArgs): Promise<PreparedSlice[]> {
  const ranges = pagesToRanges(args.pages.map(Number));
  let source: Uint8Array | null = null;
  const out: PreparedSlice[] = [];
  for (const range of ranges) {
    const pages = rangePages(range.page_start, range.page_end);
    const { data: existing, error } = await db
      .from('document_slices')
      .select('id, storage_path')
      .eq('document_id', args.documentId)
      .eq('purpose', args.purpose)
      .eq('page_start', range.page_start)
      .eq('page_end', range.page_end)
      .maybeSingle();
    if (error) throw error;

    let rowId: string;
    let storagePath: string;
    let bytes: Uint8Array;
    if (existing) {
      rowId = existing.id as string;
      storagePath = existing.storage_path as string;
      bytes = await downloadBytes(db, storagePath);
    } else {
      source ??= await downloadBytes(db, documentObjectPath(args.storagePath));
      bytes = await sliceBytes(source, pages);
      rowId = args.newId();
      storagePath = `slices/${args.documentId}/${args.purpose}-${range.page_start}-${range.page_end}-${rowId.slice(0, 8)}.pdf`;
      await uploadBytes(db, storagePath, bytes);
      const inserted = await db.from('document_slices').insert({
        id: rowId,
        document_id: args.documentId,
        purpose: args.purpose,
        page_start: range.page_start,
        page_end: range.page_end,
        storage_path: storagePath,
        size_bytes: bytes.length,
        est_tokens: pages.length * (args.estTokensPerPage ?? 2000),
      });
      if (inserted.error && inserted.error.code !== '23505') throw inserted.error;
    }
    out.push({ rowId, documentId: args.documentId, title: args.title, pages, base64: toBase64(bytes), storagePath });
  }
  return out;
}
