// Loads what a topic-level generation needs (ai-pipeline §3, data-model §5.2–5.3): the topic node, its
// concepts, the subject's language, and the pages of each source document, prepared as PDF slices.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PdfSlice, TopicInput } from '@studify/prompts';
import { ApiFailure } from '@studify/shared';
import { requireNode, type SubjectRow } from './access.ts';
import type { Deps } from './deps.ts';
import { prepareSlices, toPdfSlice, type PreparedSlice } from './slices.ts';

export interface ConceptRow {
  id: string;
  title: string;
  summary: string | null;
  key_terms: string[];
  formulas: Array<{ latex: string; description: string }>;
}

export interface TopicBundle {
  nodeId: string;
  subject: SubjectRow;
  title: string;
  summary: string | null;
  objectives: string[];
  keyTerms: string[];
  formulas: Array<{ latex: string; description: string }>;
  concepts: ConceptRow[];
  sources: Array<{ documentId: string; title: string; storagePath: string; pages: number[] }>;
  contentLanguage: string;
  languageSubject: boolean;
}

export async function loadTopic(db: SupabaseClient, userId: string, nodeId: string): Promise<TopicBundle> {
  const { node, subject } = await requireNode(db, userId, nodeId);
  if (node.kind !== 'topic') throw new ApiFailure('invalid_request', { message: 'Isso não é um tópico.' });

  const concepts = await db
    .from('knowledge_nodes')
    .select('id, title, summary, key_terms, formulas')
    .eq('parent_id', nodeId)
    .eq('kind', 'concept')
    .is('deleted_at', null)
    .order('position');
  if (concepts.error) throw concepts.error;

  // Two plain reads (no embedded join): the source rows, then their documents.
  const sources = await db.from('node_sources').select('document_id, page_start, page_end').eq('node_id', nodeId).is('deleted_at', null);
  if (sources.error) throw sources.error;
  const sourceRows = sources.data as Array<{ document_id: string; page_start: number; page_end: number }>;
  const docIds = [...new Set(sourceRows.map((r) => r.document_id))];
  const docs = docIds.length
    ? await db.from('documents').select('id, title, storage_path, deleted_at').in('id', docIds)
    : { data: [], error: null };
  if (docs.error) throw docs.error;
  const docById = new Map((docs.data as Array<{ id: string; title: string; storage_path: string; deleted_at: string | null }>).map((d) => [d.id, d]));

  const byDoc = new Map<string, { documentId: string; title: string; storagePath: string; pages: Set<number> }>();
  for (const row of sourceRows) {
    const doc = docById.get(row.document_id);
    if (!doc || doc.deleted_at) continue;
    const entry = byDoc.get(row.document_id) ?? { documentId: row.document_id, title: doc.title, storagePath: doc.storage_path, pages: new Set<number>() };
    for (let p = Number(row.page_start); p <= Number(row.page_end); p += 1) entry.pages.add(p);
    byDoc.set(row.document_id, entry);
  }

  return {
    nodeId,
    subject,
    title: node.title as string,
    summary: (node.summary as string | null) ?? null,
    objectives: (node.learning_objectives as string[] | null) ?? [],
    keyTerms: (node.key_terms as string[] | null) ?? [],
    formulas: (node.formulas as Array<{ latex: string; description: string }> | null) ?? [],
    concepts: (concepts.data as ConceptRow[]) ?? [],
    sources: [...byDoc.values()].map((s) => ({
      documentId: s.documentId,
      title: s.title,
      storagePath: s.storagePath,
      pages: [...s.pages].sort((a, b) => a - b),
    })),
    contentLanguage: subject.content_language ?? 'pt-BR',
    languageSubject: subject.is_language_subject,
  };
}

/** The TopicInput of the prompts package. Concept keys are the concept node ids (≤ 40 chars, NodeKey). */
export function topicInput(bundle: TopicBundle): TopicInput & { objectives: string[] } {
  return {
    title: bundle.title,
    objectives: bundle.objectives,
    concepts: bundle.concepts.map((c) => ({
      key: c.id,
      title: c.title,
      keyTerms: c.key_terms ?? [],
      formulas: c.formulas ?? [],
    })),
  };
}

/** Slices for every source document of the topic (purpose `topic`), in document order. */
export async function topicSlices(deps: Deps, bundle: TopicBundle): Promise<{ slices: PdfSlice[]; prepared: PreparedSlice[] }> {
  if (bundle.sources.length === 0) throw new ApiFailure('not_found', { message: 'Esse tópico não tem páginas de material.' });
  const prepared: PreparedSlice[] = [];
  for (const source of bundle.sources) {
    const parts = await prepareSlices(deps, {
      documentId: source.documentId,
      title: source.title,
      storagePath: source.storagePath,
      pages: source.pages,
      purpose: 'topic',
      newId: deps.newId,
    });
    prepared.push(...parts);
  }
  return { slices: prepared.map(toPdfSlice), prepared };
}
