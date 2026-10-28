// divide-submit (SOC-06.4; class A). Moderates the contribution (spec 10 §8.9) and approves it for the merge.
// When every claimed topic has its approved summary, the merge into the Resumo da turma starts on its own.
import { ApiFailure, ContributionSubmitReqSchema } from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { requireAllowedText } from '../shared-p4/moderation.ts';
import { allClaimsApproved, loadOwnContribution, startMerge } from '../shared-p5/divide.ts';
import { MIN_CONTRIBUTION_CHARS } from './divide-review.ts';

export const handler = defineFunction<z.infer<typeof ContributionSubmitReqSchema>>({
  name: 'divide-submit',
  // Calls Claude outside a stream: runs as a job, the request answers 202 running (ADR 0009).
  deferred: true,
  mutating: true,
  aiCall: true,
  input: ContributionSubmitReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const { contribution, plan } = await loadOwnContribution(deps, userId, input.contribution_id);
    if (plan.status !== 'open') throw new ApiFailure('already_completed', { message: 'Essa divisão já foi fechada.' });
    if (contribution.status === 'approved') return ctx.json({ status: 'approved', merge_started: false });
    if (contribution.status !== 'draft') throw new ApiFailure('already_completed');
    if (contribution.body_md.trim().length < MIN_CONTRIBUTION_CHARS) throw new ApiFailure('invalid_request', { message: 'Escreve um pouco mais antes de enviar.' });

    await requireAllowedText(deps, userId, contribution.body_md.slice(0, 4000), 'SOC-06', 'Esse resumo não pode ir pra turma assim. Tira ofensas ou dados pessoais e tenta de novo.');
    const updated = await deps.db.from('contributions').update({ status: 'approved', submitted_at: ctx.now.toISOString() }).eq('id', contribution.id).eq('status', 'draft');
    if (updated.error) throw updated.error;

    let mergeStarted = false;
    if (await allClaimsApproved(deps, plan)) mergeStarted = (await startMerge(deps, plan)) !== null;
    return ctx.json({ status: 'approved', merge_started: mergeStarted });
  },
});

export default handler;
