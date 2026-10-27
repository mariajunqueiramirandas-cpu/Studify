// Per-run environment shared by the pipeline stages: the JobContext (db, Claude deps, logger, progress),
// object storage, and a per-run cache of loaded source PDFs and built slices.
import type { BudgetContext } from '@studify/ai';
import { PDFDocument } from 'pdf-lib';
import type { JobContext } from '../framework/types.ts';
import type { Sql } from '../framework/db.ts';
import { BUCKET, keys, type ObjectStore } from './store.ts';
import { buildSlice, loadSource } from './pdf-build.ts';
import { loadDocument, type DocumentRecord } from './repo.ts';
import type { PageSpan } from './slice-plan.ts';

export interface PipelineEnv {
  ctx: JobContext;
  store: ObjectStore;
  sources: SourceCache;
  /** Document records loaded during this run (a topic can cite several documents). */
  documents: Map<string, Promise<DocumentRecord | null>>;
}

export function createEnv(ctx: JobContext, store: ObjectStore): PipelineEnv {
  return { ctx, store, sources: new SourceCache(store, ctx.db), documents: new Map() };
}

export function getDocument(env: PipelineEnv, documentId: string): Promise<DocumentRecord | null> {
  let hit = env.documents.get(documentId);
  if (!hit) {
    hit = loadDocument(env.ctx.db, documentId);
    env.documents.set(documentId, hit);
  }
  return hit;
}

export function sqlOf(env: PipelineEnv): Sql {
  return env.ctx.db;
}

export interface CachedSlice {
  id: string;
  documentId: string;
  pages: number[];
  storagePath: string;
  bytes: Uint8Array;
}

/**
 * Loads each document's PDF once per run and builds each slice once. Slice rows are written to
 * document_slices (purpose, page range) and the bytes to the `slices` bucket.
 */
export class SourceCache {
  private readonly pdfs = new Map<string, Promise<PDFDocument>>();
  private readonly slices = new Map<string, Promise<CachedSlice>>();

  constructor(private readonly store: ObjectStore, private readonly sql: Sql) {}

  pdf(doc: Pick<DocumentRecord, 'id' | 'storagePath'>): Promise<PDFDocument> {
    let hit = this.pdfs.get(doc.id);
    if (!hit) {
      hit = this.store.download(BUCKET.documents, doc.storagePath).then((bytes) => loadSource(bytes));
      this.pdfs.set(doc.id, hit);
    }
    return hit;
  }

  /** Slice of consecutive original pages. `purpose` is one of outline | topic | transcription. */
  slice(doc: Pick<DocumentRecord, 'id' | 'storagePath'>, span: PageSpan, purpose: 'outline' | 'topic' | 'transcription'): Promise<CachedSlice> {
    const cacheKey = `${doc.id}:${span.start}-${span.end}`;
    let hit = this.slices.get(cacheKey);
    if (!hit) {
      hit = this.buildAndStore(doc, span, purpose);
      this.slices.set(cacheKey, hit);
    }
    return hit;
  }

  private async buildAndStore(doc: Pick<DocumentRecord, 'id' | 'storagePath'>, span: PageSpan, purpose: string): Promise<CachedSlice> {
    const pages = range(span);
    const source = await this.pdf(doc);
    const bytes = await buildSlice(source, pages);
    const storagePath = keys.slice(doc.id, span.start, span.end);
    const { rows } = await this.sql.query<{ id: string }>(
      `insert into public.document_slices
         (document_id, purpose, page_start, page_end, storage_path, size_bytes, est_tokens)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (document_id, purpose, page_start, page_end)
       do update set storage_path = excluded.storage_path, size_bytes = excluded.size_bytes, updated_at = now()
       returning id`,
      [doc.id, purpose, span.start, span.end, storagePath, bytes.byteLength, estimateTokens(pages.length)],
    );
    await this.store.upload(BUCKET.slices, storagePath, bytes, 'application/pdf');
    const id = rows[0]?.id;
    if (!id) throw new Error('document_slices upsert returned no id');
    return { id, documentId: doc.id, pages, storagePath, bytes };
  }
}

/** Placeholder until countTokens is wired in (ai-pipeline §4.1). Keeps budget estimates in range. */
export function estimateTokens(pageCount: number): number {
  return pageCount * 1500;
}

function range(span: PageSpan): number[] {
  const out: number[] = [];
  for (let p = span.start; p <= span.end; p++) out.push(p);
  return out;
}

/** Budget scope of a call (ai-pipeline §9.1): the Turma for shared subjects, the requester otherwise. */
export function budgetFor(
  scope: { subjectId: string; ownerClassGroupId: string | null; uploadedBy: string | null; documentId?: string | null },
  opts: { jobId: string | null; feature: string; nodeId?: string | null; userId?: string | null },
): BudgetContext {
  return {
    userId: opts.userId ?? scope.uploadedBy,
    classGroupId: scope.ownerClassGroupId,
    subjectId: scope.subjectId,
    documentId: scope.documentId ?? null,
    nodeId: opts.nodeId ?? null,
    jobId: opts.jobId,
    feature: opts.feature,
    budgetClass: 'content',
  };
}
