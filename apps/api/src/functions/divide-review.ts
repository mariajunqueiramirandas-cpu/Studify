// divide-review (SOC-06.3; class A). Private AI review of a draft contribution against the topic's pages: errors
// with page links and missing key concepts. Stored on the contribution (author-only) so the draft screen shows
// it again; the author may revise and ask again before submitting.
import { getTask, type ContributionReviewOutput } from '@studify/prompts';
import { ApiFailure, ContributionReviewReqSchema, type ContributionFeedback } from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { loadTopic, topicSlices } from '../shared/topic.ts';
import { loadOwnContribution } from '../shared-p5/divide.ts';

export const MIN_CONTRIBUTION_CHARS = 80;

export const handler = defineFunction<z.infer<typeof ContributionReviewReqSchema>>({
  name: 'divide-review',
  // Calls Claude outside a stream: runs as a job, the request answers 202 running (ADR 0009).
  deferred: true,
  mutating: true,
  aiCall: true,
  input: ContributionReviewReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const { contribution, plan } = await loadOwnContribution(deps, userId, input.contribution_id);
    if (contribution.status !== 'draft' || plan.status !== 'open') throw new ApiFailure('already_completed', { message: 'Esse resumo já foi enviado.' });
    if (contribution.body_md.trim().length < MIN_CONTRIBUTION_CHARS) throw new ApiFailure('invalid_request', { message: 'Escreve um pouco mais antes de pedir a revisão.' });

    const bundle = await loadTopic(deps.db, userId, contribution.node_id);
    const { slices } = await topicSlices(deps, bundle);
    const built = getTask('divide.review').build({
      topic: { title: bundle.title, summary: bundle.summary ?? '', key_concepts: bundle.concepts.map((c) => c.title) },
      contribution: contribution.body_md,
      slices,
      contentLanguage: bundle.contentLanguage,
    });
    const out = unwrapResult(
      await callTask(claudeDepsFor(deps), { built, taskId: 'divide.review', ctx: budgetCtxFor(bundle.subject, userId, 'SOC-06', 'user', { nodeId: contribution.node_id }) }),
    ) as ContributionReviewOutput;
    const labels = built.documents?.labels ?? {};
    const feedback: ContributionFeedback = {
      errors: out.errors.map((e) => ({ quote: e.quote, correction: e.correction, page: e.source?.page_start ?? null, document_id: e.source ? (labels[e.source.doc] ?? null) : null })),
      missing_concepts: out.missing_concepts,
      ok_to_merge: out.ok_to_merge,
      summary: out.summary,
    };
    const saved = await deps.db.from('contributions').update({ ai_feedback: feedback }).eq('id', contribution.id);
    if (saved.error) throw saved.error;
    return ctx.json({ feedback });
  },
});

export default handler;
