// Shared fixture: two students (Alice owns the subject under test, Bob owns a private subject), a topic with
// one concept, a 40-page PDF in Storage and its page text. Ids are fixed so tests read clearly.
import { ALICE, BOB, makePdf, withUsers, type Harness } from './fakes.ts';

export const IDS = {
  subject: '5a000000-0000-4000-8000-000000000001',
  bobSubject: '5a000000-0000-4000-8000-000000000002',
  doc: 'd0c00000-0000-4000-8000-000000000001',
  bobDoc: 'd0c00000-0000-4000-8000-000000000002',
  topic: 'a0000000-0000-4000-8000-000000000001',
  concept: 'c0000000-0000-4000-8000-000000000001',
  bobTopic: 'a0000000-0000-4000-8000-000000000002',
  card: 'ca000000-0000-4000-8000-000000000001',
  bobCard: 'ca000000-0000-4000-8000-000000000002',
  question: 'b0000000-0000-4000-8000-000000000001',
  question2: 'b0000000-0000-4000-8000-000000000002',
  quiz: 'e0000000-0000-4000-8000-000000000001',
  attempt: 'f0000000-0000-4000-8000-000000000001',
  bobAttempt: 'f0000000-0000-4000-8000-000000000002',
  goal: '60000000-0000-4000-8000-000000000001',
  exam: 'e7000000-0000-4000-8000-000000000001',
  bobExam: 'e7000000-0000-4000-8000-000000000002',
  note: 'a7000000-0000-4000-8000-000000000001',
} as const;

/** Deterministic UUID v7-shaped id for client-generated rows (outbox ids, answers): same n, same id. */
export function v7(n: number): string {
  return `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

export async function seedWorld(h: Harness): Promise<void> {
  withUsers(h);
  const { db } = h;
  db.seed('subjects', [
    { id: IDS.subject, owner_profile_id: ALICE.id, owner_class_group_id: null, created_by: ALICE.id, name: 'Biologia', color: '#00AA00', icon: 'leaf', content_language: 'pt-BR', is_language_subject: false, enem_area: null, deleted_at: null },
    { id: IDS.bobSubject, owner_profile_id: BOB.id, owner_class_group_id: null, created_by: BOB.id, name: 'Bob privado', color: '#AA0000', icon: 'x', content_language: 'pt-BR', is_language_subject: false, enem_area: null, deleted_at: null },
  ]);
  db.seed('knowledge_nodes', [
    { id: IDS.topic, subject_id: IDS.subject, parent_id: null, kind: 'topic', title: 'Fotossíntese', summary: 'Como plantas produzem energia', learning_objectives: ['Explicar a fotossíntese'], key_terms: [], formulas: [], deleted_at: null, position: 0 },
  ]);
  db.seed('knowledge_nodes', [
    { id: IDS.concept, subject_id: IDS.subject, parent_id: IDS.topic, kind: 'concept', title: 'Clorofila', summary: 'Pigmento que capta luz', learning_objectives: [], key_terms: ['clorofila'], formulas: [], deleted_at: null, position: 0 },
    { id: IDS.bobTopic, subject_id: IDS.bobSubject, parent_id: null, kind: 'topic', title: 'Segredo', summary: null, learning_objectives: [], key_terms: [], formulas: [], deleted_at: null, position: 0 },
  ]);
  db.seed('documents', [
    { id: IDS.doc, subject_id: IDS.subject, title: 'Apostila de biologia', kind: 'textbook', storage_path: `documents/${IDS.subject}/${IDS.doc}.pdf`, size_bytes: 2048, checksum_sha256: 'a'.repeat(64), status: 'ready', page_count: 40, deleted_at: null, uploaded_by: ALICE.id },
    { id: IDS.bobDoc, subject_id: IDS.bobSubject, title: 'Privado', kind: 'textbook', storage_path: `documents/${IDS.bobSubject}/${IDS.bobDoc}.pdf`, size_bytes: 2048, checksum_sha256: 'b'.repeat(64), status: 'ready', page_count: 40, deleted_at: null, uploaded_by: BOB.id },
  ]);
  const pdf = await makePdf(40);
  db.objects.set(`documents/${IDS.subject}/${IDS.doc}.pdf`, pdf);
  db.objects.set(`documents/${IDS.bobSubject}/${IDS.bobDoc}.pdf`, pdf);
  // Pages 12–14 carry the photosynthesis text; the tutor's full-text search finds them.
  for (const page of [12, 13, 14]) {
    db.seed('document_pages', { document_id: IDS.doc, page_number: page, text: `Fotossíntese na página ${page}: a clorofila capta luz.`, tsv: 'fotossintese clorofila luz' });
  }
  db.seed('node_sources', [{ id: v7(900), node_id: IDS.topic, document_id: IDS.doc, page_start: 12, page_end: 14, origin: 'ai', deleted_at: null }]);
  db.seed('cards', [
    { id: IDS.card, subject_id: IDS.subject, node_id: IDS.topic, concept_id: IDS.concept, type: 'basic', front: 'O que é a clorofila?', back: 'Pigmento que capta luz.', source_pages: [{ document_id: IDS.doc, page_start: 13, page_end: 13 }], origin: 'generated', personal_for_user_id: null, status: 'active', deleted_at: null, version: 1, created_at: '2026-10-01T00:00:00Z' },
    { id: IDS.bobCard, subject_id: IDS.bobSubject, node_id: IDS.bobTopic, concept_id: null, type: 'basic', front: 'Segredo', back: 'Do Bob', source_pages: [], origin: 'user', personal_for_user_id: BOB.id, status: 'active', deleted_at: null, version: 1, created_at: '2026-10-01T00:00:00Z' },
  ]);
  db.seed('goals', { id: IDS.goal, user_id: ALICE.id, mode: 'exam_week', name: 'Semana de provas', start_date: '2026-10-01', end_date: '2026-12-01', status: 'active', deleted_at: null });
  db.seed('exams', [
    { id: IDS.exam, goal_id: IDS.goal, user_id: ALICE.id, subject_id: IDS.subject, title: 'Prova de bio', local_date: '2026-11-10', status: 'scheduled', scope_status: 'none', deleted_at: null },
    { id: IDS.bobExam, goal_id: IDS.goal, user_id: BOB.id, subject_id: IDS.bobSubject, title: 'Prova do Bob', local_date: '2026-11-10', status: 'scheduled', scope_status: 'none', deleted_at: null },
  ]);
}

/** A multiple-choice question in the shared payload shape (spec 05 §8.1). */
export function mcq(id: string, correct: 'A' | 'B', nodeId = IDS.topic, conceptId: string = IDS.concept): Record<string, unknown> {
  return {
    id,
    subject_id: IDS.subject,
    node_id: nodeId,
    concept_ids: [conceptId],
    type: 'mcq_single',
    stem: 'Qual organela faz a fotossíntese?',
    payload: {
      options: [
        { id: 'A', text: 'Cloroplasto', rationale: 'Correta: tem clorofila.' },
        { id: 'B', text: 'Mitocôndria', rationale: 'Produz energia por respiração.' },
        { id: 'C', text: 'Núcleo', rationale: 'Guarda o DNA.' },
        { id: 'D', text: 'Ribossomo', rationale: 'Monta proteínas.' },
      ],
      correct,
    },
    explanation: 'O cloroplasto contém clorofila.',
    difficulty: 2,
    source_pages: [{ document_id: IDS.doc, page_start: 13, page_end: 13 }],
    origin: 'generated',
    personal_for_user_id: null,
    status: 'active',
    review_status: 'approved',
    deleted_at: null,
    version: 1,
  };
}
