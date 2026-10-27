// teaching-finish (INT-02.6–02.8; api §4.8). Ends the lesson: Lucas's teach-back (asked now when the student
// ended early), the score per spec 12 §8.6 ("too short" before turn 4), the band, the gaps and the errors the
// student taught with their corrections and pages. Key concepts explained become mastery evidence (source
// teaching, learning-engine §5.2) and the lesson earns XP (10 + ⌊score/10⌋).
import {
  ApiFailure,
  TeachingFinishReqSchema,
  evidenceWeight,
  lucasBand,
  lucasEvidence,
  lucasGaps,
  lucasRubric,
  lucasScore,
  type TeachingFinishRes,
} from '@studify/shared';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { loadOwnSession, type TeachingRow } from '../shared-p3/teaching.ts';
import { runLucasTurn } from '../shared-p3/lucas.ts';

function resultOf(session: TeachingRow): TeachingFinishRes {
  const scored = lucasScore(session.evaluation_state, session.turn_count);
  const tooShort = scored === 'too_short';
  const rubric = lucasRubric(session.evaluation_state);
  return {
    score: tooShort ? null : scored,
    too_short: tooShort,
    band: tooShort ? null : lucasBand(scored),
    rubric: { misconceptions: rubric.misconceptions, coverage: rubric.coverage, accuracy: rubric.accuracy, clarity: rubric.clarity },
    gaps: lucasGaps(session.plan.scoring, session.evaluation_state).map((g) => ({ kind: g.kind, id: g.id, text: g.text, correct: g.correct, source_pages: g.source_pages })),
    errors_taught: session.evaluation_state.errors_taught.map((e) => ({ claim: e.claim, correction: e.correction, severity: e.severity, source_pages: e.source_pages })),
    teach_back: session.teach_back ?? '',
  };
}

export const handler = defineFunction<z.infer<typeof TeachingFinishReqSchema>>({
  name: 'teaching-finish',
  mutating: true,
  aiCall: true,
  input: TeachingFinishReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const session = await loadOwnSession(db, userId, input.session_id);
    if (!session) throw new ApiFailure('not_found');
    if (session.status === 'finished') return ctx.json(resultOf(session));

    // INT-02.6: the teach-back, when the student ends before the last turn.
    if (!session.teach_back && session.turn_count >= 1) {
      await runLucasTurn(deps, session, '(O estudante terminou a aula agora. Faça o teach-back.)', ctx.now, true);
    }
    const body = resultOf(session);
    const saved = await db
      .from('teaching_sessions')
      .update({
        status: 'finished',
        finished_at: ctx.now.toISOString(),
        score: body.score,
        rubric: body.rubric,
        gaps: body.gaps,
        errors_taught: body.errors_taught,
        teach_back: session.teach_back,
      })
      .eq('id', session.id);
    if (saved.error) throw saved.error;

    // Mastery evidence (INT-02.8): one item per knowledge node; several key concepts of one node average.
    const byNode = new Map<string, number[]>();
    for (const ev of lucasEvidence(session.plan.scoring, session.evaluation_state)) {
      const node = ev.node_id ?? session.node_id;
      byNode.set(node, [...(byNode.get(node) ?? []), ev.score]);
    }
    const evidence = [...byNode.entries()].map(([nodeId, scores]) => {
      const outcome = scores.reduce((s, v) => s + v, 0) / scores.length;
      const weight = evidenceWeight({ id: session.id, conceptId: nodeId, answeredAt: ctx.now, questionType: 'mcq_single', source: 'lucas', score: outcome });
      return { user_id: userId, node_id: nodeId, subject_id: session.subject_id, source: 'teaching', outcome, weight, ref_type: 'teaching_session', ref_id: session.id, occurred_at: ctx.now.toISOString() };
    });
    if (evidence.length > 0) {
      const ins = await db.from('mastery_evidence').upsert(evidence, { onConflict: 'ref_type,ref_id,node_id', ignoreDuplicates: true });
      if (ins.error) throw ins.error;
      await deps.enqueue('mastery.recompute', { user_id: userId, node_ids: [...byNode.keys()] }, { singletonKey: `mastery.recompute:${userId}`, startAfterSeconds: 60 });
    }
    if (body.score !== null) {
      await deps.enqueue(
        'xp.award',
        { user_id: userId, events: [{ event: { kind: 'lucas_finished', score: body.score }, ref_type: 'teaching_session', ref_id: session.id, source_feature: 'INT-02', occurred_at: ctx.now.toISOString() }] },
        { singletonKey: `xp:teaching_session:${session.id}` },
      );
    }
    return ctx.json(body);
  },
});

export default handler;
