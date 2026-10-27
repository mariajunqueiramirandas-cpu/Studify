// Items a student can flag (TRU-02) and how each one is read to check the flag. Shared by flag-create
// (online) and the `flag` kind of sync-push (offline queue), so both apply the same rules.
import type { ItemType } from '@studify/shared';

/** Items that are a row with subject_id (Phase 1–2). Other item types are not flaggable yet. */
export const FLAG_TABLES: Partial<Record<ItemType, { table: string; select: string; versioned: boolean }>> = {
  knowledge_node: { table: 'knowledge_nodes', select: 'id, subject_id, version', versioned: true },
  note: { table: 'notes', select: 'id, subject_id, version', versioned: true },
  glossary_term: { table: 'glossary_terms', select: 'id, subject_id, version', versioned: true },
  card: { table: 'cards', select: 'id, subject_id, version, personal_for_user_id', versioned: true },
  question: { table: 'questions', select: 'id, subject_id, version, personal_for_user_id', versioned: true },
  explanation: { table: 'explanations', select: 'id, subject_id, personal_for_user_id', versioned: false },
  feed_item: { table: 'feed_items', select: 'id, subject_id', versioned: false },
  document: { table: 'documents', select: 'id, subject_id', versioned: false },
};
