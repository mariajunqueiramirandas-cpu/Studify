// SQL used by the pipeline stages. Every statement is parameterized. Writes that create several rows
// run inside one transaction (withTransaction) so a crash never leaves half a topic behind.
import type { Sql } from '../framework/db.ts';

export interface DocumentRecord {
  id: string;
  subjectId: string;
  uploadedBy: string | null;
  title: string;
  kind: string;
  storagePath: string;
  sizeBytes: number;
  pageCount: number | null;
  checksum: string;
  language: string | null;
  hasBookmarks: boolean | null;
  status: string;
  deleted: boolean;
  subjectName: string;
  contentLanguage: string | null;
  isLanguageSubject: boolean;
  ownerProfileId: string | null;
  ownerClassGroupId: string | null;
}

export async function loadDocument(sql: Sql, documentId: string): Promise<DocumentRecord | null> {
  const { rows } = await sql.query<{
    id: string;
    subject_id: string;
    uploaded_by: string | null;
    title: string;
    kind: string;
    storage_path: string;
    size_bytes: string;
    page_count: number | null;
    checksum_sha256: string;
    language: string | null;
    has_bookmarks: boolean | null;
    status: string;
    deleted_at: Date | null;
    subject_name: string;
    content_language: string | null;
    is_language_subject: boolean;
    owner_profile_id: string | null;
    owner_class_group_id: string | null;
    subject_deleted: Date | null;
  }>(
    `select d.id, d.subject_id, d.uploaded_by, d.title, d.kind, d.storage_path, d.size_bytes::text,
            d.page_count, d.checksum_sha256, d.language, d.has_bookmarks, d.status, d.deleted_at,
            s.name as subject_name, s.content_language, s.is_language_subject,
            s.owner_profile_id, s.owner_class_group_id, s.deleted_at as subject_deleted
       from public.documents d
       join public.subjects s on s.id = d.subject_id
      where d.id = $1`,
    [documentId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    subjectId: r.subject_id,
    uploadedBy: r.uploaded_by,
    title: r.title,
    kind: r.kind,
    storagePath: r.storage_path,
    sizeBytes: Number(r.size_bytes),
    pageCount: r.page_count,
    checksum: r.checksum_sha256,
    language: r.language,
    hasBookmarks: r.has_bookmarks,
    status: r.status,
    deleted: r.deleted_at !== null || r.subject_deleted !== null,
    subjectName: r.subject_name,
    contentLanguage: r.content_language,
    isLanguageSubject: r.is_language_subject,
    ownerProfileId: r.owner_profile_id,
    ownerClassGroupId: r.owner_class_group_id,
  };
}

export interface DocumentPatch {
  status?: 'uploaded' | 'processing' | 'ready' | 'failed' | 'waiting_budget';
  errorCode?: string | null;
  pageCount?: number;
  language?: string | null;
  detectedKind?: string | null;
  hasBookmarks?: boolean;
  storagePath?: string;
  sizeBytes?: number;
  checksum?: string;
  title?: string;
}

/** Updates the document row. Only the fields present in the patch change. */
export async function patchDocument(sql: Sql, documentId: string, patch: DocumentPatch): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [documentId];
  const add = (column: string, value: unknown) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.errorCode !== undefined) add('error_code', patch.errorCode);
  if (patch.pageCount !== undefined) add('page_count', patch.pageCount);
  if (patch.language !== undefined) add('language', patch.language);
  if (patch.detectedKind !== undefined) add('detected_kind', patch.detectedKind);
  if (patch.hasBookmarks !== undefined) add('has_bookmarks', patch.hasBookmarks);
  if (patch.storagePath !== undefined) add('storage_path', patch.storagePath);
  if (patch.sizeBytes !== undefined) add('size_bytes', patch.sizeBytes);
  if (patch.checksum !== undefined) add('checksum_sha256', patch.checksum);
  if (patch.title !== undefined) add('title', patch.title);
  if (sets.length === 1) return;
  await sql.query(`update public.documents set ${sets.join(', ')} where id = $1`, values);
}

export async function documentHasPages(sql: Sql, documentId: string): Promise<boolean> {
  const { rows } = await sql.query<{ n: string }>(
    `select count(*)::text as n from public.document_pages where document_id = $1`,
    [documentId],
  );
  return Number(rows[0]?.n ?? '0') > 0;
}

export interface PageRecord {
  pageNumber: number;
  text: string;
  textSource: 'pdf_text_layer' | 'ai_transcription' | 'none';
  charCount: number;
  hasImages: boolean;
  imagePath: string | null;
  thumbnailPath: string | null;
  textItemsPath: string | null;
  transcriptionConfidence: 'high' | 'medium' | 'low' | null;
}

/** Inserts or updates page rows in chunks. Existing rows keep their image paths unless given new ones. */
export async function upsertPages(sql: Sql, documentId: string, pages: readonly PageRecord[]): Promise<void> {
  const chunk = 200;
  for (let i = 0; i < pages.length; i += chunk) {
    const slice = pages.slice(i, i + chunk);
    const values: unknown[] = [documentId];
    const tuples: string[] = [];
    for (const p of slice) {
      const base = values.length;
      values.push(p.pageNumber, p.text, p.textSource, p.charCount, p.hasImages, p.imagePath, p.thumbnailPath, p.textItemsPath, p.transcriptionConfidence);
      tuples.push(
        `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::text)`,
      );
    }
    await sql.query(
      `insert into public.document_pages
         (document_id, page_number, text, text_source, char_count, has_images, image_path, thumbnail_path, text_items_path, transcription_confidence)
       values ${tuples.join(', ')}
       on conflict (document_id, page_number) do update set
         text = excluded.text,
         text_source = excluded.text_source,
         char_count = excluded.char_count,
         has_images = excluded.has_images,
         image_path = coalesce(excluded.image_path, public.document_pages.image_path),
         thumbnail_path = coalesce(excluded.thumbnail_path, public.document_pages.thumbnail_path),
         text_items_path = coalesce(excluded.text_items_path, public.document_pages.text_items_path),
         transcription_confidence = coalesce(excluded.transcription_confidence, public.document_pages.transcription_confidence),
         updated_at = now()`,
      values,
    );
  }
}

export async function setPageAssets(
  sql: Sql,
  documentId: string,
  assets: Array<{ pageNumber: number; imagePath?: string | null; thumbnailPath?: string | null; textItemsPath?: string | null }>,
): Promise<void> {
  for (const a of assets) {
    await sql.query(
      `update public.document_pages set
         image_path = coalesce($3, image_path),
         thumbnail_path = coalesce($4, thumbnail_path),
         text_items_path = coalesce($5, text_items_path),
         updated_at = now()
       where document_id = $1 and page_number = $2`,
      [documentId, a.pageNumber, a.imagePath ?? null, a.thumbnailPath ?? null, a.textItemsPath ?? null],
    );
  }
}

export async function scannedPages(sql: Sql, documentId: string): Promise<number[]> {
  const { rows } = await sql.query<{ page_number: number }>(
    `select page_number from public.document_pages
      where document_id = $1 and text_source = 'none' and char_count < 20 order by page_number`,
    [documentId],
  );
  return rows.map((r) => r.page_number);
}

export async function pagesWithFigures(sql: Sql, documentId: string): Promise<number[]> {
  const { rows } = await sql.query<{ page_number: number }>(
    `select page_number from public.document_pages where document_id = $1 and has_images order by page_number`,
    [documentId],
  );
  return rows.map((r) => r.page_number);
}

// ---------------------------------------------------------------------------
// Knowledge map
// ---------------------------------------------------------------------------

export interface NodeRow {
  id: string;
  parentId: string | null;
  kind: 'unit' | 'topic' | 'concept';
  title: string;
  summary: string;
  position: number;
  objectives: string[];
  keyTerms: string[];
  formulas: Array<{ latex: string; description: string }>;
  originDocumentId: string | null;
}

/** Non-archived nodes of a subject (units and topics; concepts when `withConcepts`). */
export async function listNodes(sql: Sql, subjectId: string, withConcepts = false): Promise<NodeRow[]> {
  const { rows } = await sql.query<{
    id: string;
    parent_id: string | null;
    kind: 'unit' | 'topic' | 'concept';
    title: string;
    summary: string | null;
    position: number;
    learning_objectives: string[];
    key_terms: string[];
    formulas: unknown;
    origin_document_id: string | null;
  }>(
    `select id, parent_id, kind, title, summary, position, learning_objectives, key_terms, formulas, origin_document_id
       from public.knowledge_nodes
      where subject_id = $1 and deleted_at is null
        and kind in ('unit','topic'${withConcepts ? ",'concept'" : ''})
      order by position, id`,
    [subjectId],
  );
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    kind: r.kind,
    title: r.title,
    summary: r.summary ?? '',
    position: r.position,
    objectives: r.learning_objectives ?? [],
    keyTerms: r.key_terms ?? [],
    formulas: Array.isArray(r.formulas) ? (r.formulas as Array<{ latex: string; description: string }>) : [],
    originDocumentId: r.origin_document_id,
  }));
}

/** Topics and units (and concept rows of a topic) that cite this document, with the pages it contributes. */
export async function nodeSourcesOfDocument(
  sql: Sql,
  documentId: string,
): Promise<Array<{ nodeId: string; kind: string; pageStart: number; pageEnd: number }>> {
  const { rows } = await sql.query<{ node_id: string; kind: string; page_start: number; page_end: number }>(
    `select ns.node_id, n.kind, ns.page_start, ns.page_end
       from public.node_sources ns
       join public.knowledge_nodes n on n.id = ns.node_id
      where ns.document_id = $1 and ns.deleted_at is null and n.deleted_at is null
      order by ns.page_start`,
    [documentId],
  );
  return rows.map((r) => ({ nodeId: r.node_id, kind: r.kind, pageStart: r.page_start, pageEnd: r.page_end }));
}

export async function documentHasNodes(sql: Sql, documentId: string): Promise<boolean> {
  const { rows } = await sql.query<{ n: string }>(
    `select count(*)::text as n from public.knowledge_nodes where origin_document_id = $1 and deleted_at is null`,
    [documentId],
  );
  return Number(rows[0]?.n ?? '0') > 0;
}

/** Concept rows created from this document for the given topics (S2 idempotency). */
export async function topicsWithConcepts(sql: Sql, topicIds: readonly string[]): Promise<Set<string>> {
  if (topicIds.length === 0) return new Set();
  const { rows } = await sql.query<{ parent_id: string }>(
    `select distinct parent_id from public.knowledge_nodes
      where parent_id = any($1::uuid[]) and kind = 'concept' and deleted_at is null`,
    [topicIds],
  );
  return new Set(rows.map((r) => r.parent_id));
}

export async function setContentStatus(sql: Sql, nodeIds: readonly string[], status: string): Promise<void> {
  if (nodeIds.length === 0) return;
  await sql.query(
    `update public.knowledge_nodes set content_status = $2, updated_at = now() where id = any($1::uuid[])`,
    [nodeIds, status],
  );
}

export async function subjectContentLanguage(sql: Sql, subjectId: string): Promise<string | null> {
  const { rows } = await sql.query<{ content_language: string | null }>(
    `select content_language from public.subjects where id = $1`,
    [subjectId],
  );
  return rows[0]?.content_language ?? null;
}

export interface SubjectRecord {
  id: string;
  name: string;
  contentLanguage: string | null;
  isLanguageSubject: boolean;
  ownerProfileId: string | null;
  ownerClassGroupId: string | null;
  createdBy: string;
}

export async function loadSubject(sql: Sql, subjectId: string): Promise<SubjectRecord | null> {
  const { rows } = await sql.query<{
    id: string;
    name: string;
    content_language: string | null;
    is_language_subject: boolean;
    owner_profile_id: string | null;
    owner_class_group_id: string | null;
    created_by: string;
  }>(
    `select id, name, content_language, is_language_subject, owner_profile_id, owner_class_group_id, created_by
       from public.subjects where id = $1 and deleted_at is null`,
    [subjectId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    contentLanguage: r.content_language,
    isLanguageSubject: r.is_language_subject,
    ownerProfileId: r.owner_profile_id,
    ownerClassGroupId: r.owner_class_group_id,
    createdBy: r.created_by,
  };
}
