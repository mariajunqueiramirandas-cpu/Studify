// Card rows from model output (MEM-01, ai-pipeline §5.1). Shared by cards-generate-more and card-draft's
// storage path. Cloze cards keep their {{c1::…}} text as the front, so the app renders one field.
import type { Deps } from './deps.ts';

export interface ModelCard {
  type: 'basic' | 'cloze' | 'reverse';
  front: string;
  back: string;
  cloze_text: string | null;
  concept_key: string;
  source_pages: Array<{ doc: string; page_start: number; page_end: number }>;
  difficulty_estimate: number;
}

export function normalizeFront(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RowContext {
  deps: Deps;
  userId: string;
  subjectId: string;
  nodeId: string;
  conceptIds: Set<string>;
  labels: Record<string, string>;
  promptVersion: string;
}

export function sourceRefsToRows(cards: ModelCard[], ctx: RowContext): Record<string, unknown>[] {
  return cards.map((card) => ({
    id: ctx.deps.newId(),
    subject_id: ctx.subjectId,
    node_id: ctx.nodeId,
    concept_id: ctx.conceptIds.has(card.concept_key) ? card.concept_key : null,
    type: card.type === 'reverse' ? 'basic' : card.type,
    front: card.type === 'cloze' && card.cloze_text ? card.cloze_text : card.front,
    back: card.back,
    source_pages: card.source_pages
      .filter((r) => ctx.labels[r.doc])
      .map((r) => ({ document_id: ctx.labels[r.doc], page_start: r.page_start, page_end: r.page_end })),
    origin: 'generated',
    created_by: ctx.userId,
    prompt_version: ctx.promptVersion,
    status: 'active',
  }));
}
