// Reads stored PDFs and slices for AI calls. Slices come from document_slices (ING-02): a slice is
// sent as its Files API id while that id is still valid, otherwise as base64 from the slices bucket.
import type { OperationContext } from '../framework/types.ts';
import type { PdfSlice } from '@studify/prompts';
import { JobDataError, fetchAll, unwrap } from './db.ts';

export interface DocumentRow {
  id: string;
  subject_id: string;
  title: string;
  kind: string;
  mime_type: string;
  storage_path: string;
  page_count: number | null;
  uploaded_by: string | null;
  teacher_name: string | null;
  exam_year: number | null;
  exam_term: number | null;
}

export interface SliceRow {
  document_id: string;
  page_start: number;
  page_end: number;
  storage_path: string;
  anthropic_file_id: string | null;
  anthropic_file_expires_at: string | null;
}

export async function downloadBase64(ctx: OperationContext, bucket: string, path: string): Promise<string> {
  const res = await ctx.db.storage.from(bucket).download(path);
  if (res.error || !res.data) throw new JobDataError(`storage download failed (${bucket}/${path}): ${res.error?.message ?? 'empty'}`, 'storage');
  return Buffer.from(await res.data.arrayBuffer()).toString('base64');
}

export function rangePages(start: number, end: number): number[] {
  const pages: number[] = [];
  for (let p = start; p <= end; p++) pages.push(p);
  return pages;
}

/**
 * Slices of one document that overlap `pages` (all slices when null), as PdfSlice values in page
 * order. Each slice's pages are the original page numbers it covers (ai-pipeline §4.3).
 */
export async function slicesFor(ctx: OperationContext, document: DocumentRow, pages: readonly number[] | null, title: string = document.title): Promise<PdfSlice[]> {
  const wanted = pages ? new Set(pages) : null;
  const rows = await fetchAll<SliceRow>(
    (from, to) =>
      ctx.db
        .from('document_slices')
        .select('document_id,page_start,page_end,storage_path,anthropic_file_id,anthropic_file_expires_at')
        .eq('document_id', document.id)
        .order('page_start', { ascending: true })
        .order('page_end', { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: SliceRow[] | null; error: { message: string } | null }>,
    'document_slices',
  );
  const now = ctx.now().getTime();
  const selected = rows.filter((r) => !wanted || rangePages(r.page_start, r.page_end).some((p) => wanted.has(p)));
  const out: PdfSlice[] = [];
  for (const row of selected) {
    const pagesOfSlice = rangePages(row.page_start, row.page_end);
    const fileValid = row.anthropic_file_id && row.anthropic_file_expires_at && Date.parse(row.anthropic_file_expires_at) > now;
    const source = fileValid
      ? { type: 'file' as const, file_id: row.anthropic_file_id as string }
      : { type: 'base64' as const, media_type: 'application/pdf' as const, data: await downloadBase64(ctx, 'slices', row.storage_path) };
    out.push({ documentId: document.id, title, pages: pagesOfSlice, source });
  }
  return out;
}

/** The whole stored PDF of a document as one slice (used when no slices exist yet). */
export async function wholeDocumentSlice(ctx: OperationContext, document: DocumentRow): Promise<PdfSlice> {
  if (document.mime_type !== 'application/pdf') throw new JobDataError(`document ${document.id} is not a PDF`, 'unsupported_type');
  const count = document.page_count ?? 1;
  const data = await downloadBase64(ctx, 'documents', document.storage_path);
  return {
    documentId: document.id,
    title: document.title,
    pages: rangePages(1, count),
    source: { type: 'base64', media_type: 'application/pdf', data },
  };
}

export async function loadDocument(ctx: OperationContext, documentId: string): Promise<DocumentRow> {
  const row = unwrap(
    await (ctx.db.from('documents').select('*').eq('id', documentId).is('deleted_at', null).maybeSingle() as unknown as PromiseLike<{ data: DocumentRow | null; error: { message: string } | null }>),
    'documents',
  );
  if (!row) throw new JobDataError(`document ${documentId} not found`, 'not_found');
  return row;
}

