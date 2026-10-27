// card-draft (MEM-01.7, LRN-01.9). Drafts one card from a selection in a note or a PDF. The app inserts
// the card after the student edits it; this function only drafts (api §4.3).
import { z } from 'zod';
import { ApiFailure, CardDraftReqSchema, } from '@studify/shared';
import type { CardDraftRes } from '../shared/responses.ts';
import { getTask } from '@studify/prompts';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';

export const handler = defineFunction<z.infer<typeof CardDraftReqSchema>>({
  name: 'card-draft',
  mutating: true,
  aiCall: true,
  input: CardDraftReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const subject = await requireSubject(deps.db, userId, input.subject_id, 'read');

    let conceptCandidates: Array<{ key: string; title: string }> = [];
    if (input.node_id) {
      const node = await deps.db.from('knowledge_nodes').select('id, subject_id').eq('id', input.node_id).is('deleted_at', null).maybeSingle();
      if (node.error) throw node.error;
      if (!node.data || node.data.subject_id !== subject.id) throw new ApiFailure('not_found');
      const concepts = await deps.db.from('knowledge_nodes').select('id, title').eq('parent_id', input.node_id).eq('kind', 'concept').is('deleted_at', null);
      if (concepts.error) throw concepts.error;
      conceptCandidates = (concepts.data as Array<{ id: string; title: string }>).map((c) => ({ key: c.id, title: c.title }));
    }
    if (input.document_id) {
      const doc = await deps.db.from('documents').select('id, subject_id').eq('id', input.document_id).is('deleted_at', null).maybeSingle();
      if (doc.error) throw doc.error;
      if (!doc.data || doc.data.subject_id !== subject.id) throw new ApiFailure('not_found');
    }

    const task = getTask('cards.fromSelection');
    const built = task.build({
      selectionText: input.selection,
      regionImage: null,
      page: input.page ?? null,
      conceptCandidates,
      contentLanguage: subject.content_language ?? 'pt-BR',
      languageSubject: subject.is_language_subject,
    });
    const result = await callTask(claudeDepsFor(deps), {
      built,
      taskId: 'cards.fromSelection',
      ctx: budgetCtxFor(subject, userId, 'MEM-01.7', 'user', { nodeId: input.node_id ?? null, documentId: input.document_id ?? null }),
    });
    const data = unwrapResult(result) as { type: 'basic' | 'cloze' | 'reverse'; front: string; back: string; cloze_text: string | null };
    const sourcePages =
      input.document_id && input.page ? [{ document_id: input.document_id, page_start: input.page, page_end: input.page }] : [];
    const body: CardDraftRes = {
      front: data.type === 'cloze' && data.cloze_text ? data.cloze_text : data.front,
      back: data.back,
      type: data.type === 'cloze' ? 'cloze' : 'basic',
      source_pages: sourcePages,
    };
    return ctx.json(body);
  },
});

export default handler;
