// questions-generate-more (PRA-01.4, ENM-03.5). Up to 10 questions for one topic; ENEM style defaults to 5
// (ENEM content arrives in Phase 4, the flag is accepted now). Stored rows come from the shared payload schema.
import { z } from 'zod';
import { QuestionsGenerateMoreReqSchema, } from '@studify/shared';
import type { QuestionsGenerateMoreRes } from '../_shared/responses.ts';
import { defineFunction } from '../_shared/http.ts';
import { loadSubject, canReadSubject } from '../_shared/access.ts';
import { ApiFailure } from '@studify/shared';
import { generateQuestionsForNode } from '../_shared/questions.ts';

export const handler = defineFunction<z.infer<typeof QuestionsGenerateMoreReqSchema>>({
  name: 'questions-generate-more',
  mutating: true,
  aiCall: true,
  input: QuestionsGenerateMoreReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const node = await deps.db.from('knowledge_nodes').select('id, subject_id').eq('id', input.node_id).is('deleted_at', null).maybeSingle();
    if (node.error) throw node.error;
    if (!node.data) throw new ApiFailure('not_found');
    const subject = await loadSubject(deps.db, node.data.subject_id as string);
    if (!subject || !(await canReadSubject(deps.db, userId, subject))) throw new ApiFailure('not_found');

    const count = input.count ?? (input.enem_style ? 5 : 10);
    const ids = await generateQuestionsForNode(deps, input.node_id, { count, enemStyle: input.enem_style ?? false, subject, userId });
    const body: QuestionsGenerateMoreRes = { question_ids: ids };
    return ctx.json(body);
  },
});

export default handler;

// Entry point: serves the function when this file is the main module. Tests import `handler` only.
if (import.meta.main) {
  const { prodDeps } = await import('../_shared/prod.ts');
  Deno.serve((req) => handler(req, prodDeps()));
}
