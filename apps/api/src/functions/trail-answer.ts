// trail-answer (TRL-01.5–01.7, 01.13; api §4.11). Records the student's answer to the step on screen (or that a
// lesson was read), returns the feedback that teaches (right option, why each option is right or wrong, a tip),
// writes mastery evidence, saves a miss to the Caderno de Erros, scores a finished chapter-test round and moves the
// path on when the chapter is closed (test passed and Lucas taught). Answering a step twice returns the first
// answer's feedback; it is never graded again.
import { ApiFailure, TrailAnswerReqSchema, evidenceWeight, type TrailAnswerReq, type TrailAnswerRes } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { advanceIfPassed, buildState, checkpointScore, isQuestionPurpose, loadOutline, loadSteps, loadTrail, saveMistake, toView, type QuestionContent } from '../shared/trail.ts';

export const handler = defineFunction<TrailAnswerReq>({
  name: 'trail-answer',
  mutating: true,
  input: TrailAnswerReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const [loaded, steps] = await Promise.all([loadTrail(db, userId, input.trail_id), loadSteps(db, input.trail_id)]);
    let trail = loaded;
    // The outline is read while the access check runs; it is only used once the check has passed.
    const [, outline] = await Promise.all([requireSubject(db, userId, trail.subject_id, 'read'), loadOutline(db, userId, trail.subject_id)]);
    const row = steps.find((s) => s.id === input.step_id);
    if (!row) throw new ApiFailure('not_found');
    if (row.served_seq == null || row.status === 'discarded') throw new ApiFailure('invalid_request', { message: 'Esse passo não está na tela.' });
    const question = isQuestionPurpose(row.purpose);
    if (question && input.response === null && row.status !== 'done') throw new ApiFailure('invalid_request', { message: 'Escolha uma alternativa.' });

    let mistakeId: string | null = null;
    if (row.status === 'ready') {
      const answeredAt = ctx.now.toISOString();
      const correct = question ? input.response === (row.content as QuestionContent).correct : null;
      const patch = { status: 'done' as const, response: question ? input.response : null, correct, answered_at: answeredAt };
      const upd = await db.from('trail_steps').update(patch).eq('id', row.id).eq('status', 'ready');
      if (upd.error) throw upd.error;
      Object.assign(row, patch);

      if (question) {
        // Mastery evidence (learning-engine §5.2): a multiple-choice answer, source multiplier 1.0.
        const score = correct ? 1 : 0;
        const weight = evidenceWeight({ id: row.id, conceptId: row.concept_id, answeredAt: ctx.now, questionType: 'mcq_single', source: 'trail', score });
        // The evidence, the recompute job and the Caderno entry do not depend on each other: write them together.
        const evidence = db.from('mastery_evidence').upsert(
          [{ user_id: userId, node_id: row.concept_id, subject_id: trail.subject_id, source: 'trail', outcome: score, weight, ref_type: 'trail_step', ref_id: row.id, occurred_at: answeredAt }],
          { onConflict: 'ref_type,ref_id,node_id', ignoreDuplicates: true },
        );
        const recompute = deps.enqueue('mastery.recompute', { user_id: userId, node_ids: [row.concept_id] }, { singletonKey: `mastery.recompute:${userId}`, startAfterSeconds: 60 });
        // Best effort: the answer is already recorded, so a Caderno failure must not fail (and retry) the step.
        const caderno = correct
          ? Promise.resolve(null)
          : saveMistake(deps, trail, row, input.time_spent_ms ?? 0, ctx.now).catch((err) => {
              console.warn('[trail-answer] caderno', err instanceof Error ? err.message : err);
              return null;
            });
        const [ev, , saved] = await Promise.all([evidence, recompute, caderno]);
        if (ev.error) throw ev.error;
        mistakeId = saved;
      }
    }

    let feedback: TrailAnswerRes['feedback'] = null;
    if (question) {
      const q = row.content as QuestionContent;
      feedback = {
        correct: row.correct === true,
        correct_option: q.correct,
        explanation: q.explanation,
        tip: q.tip,
        rationales: q.options.map((o) => ({ id: o.id, text: o.text, rationale: o.rationale })),
      };
    }

    let checkpointResult: TrailAnswerRes['checkpoint_result'] = null;
    if (row.purpose === 'checkpoint') {
      const score = checkpointScore(steps.filter((s) => s.topic_id === row.topic_id).map(toView), row.round);
      if (score) checkpointResult = { round: row.round, ...score };
    }

    const advanced = await advanceIfPassed(deps, trail, steps, outline, ctx.now);
    trail = advanced.trail;

    const body: TrailAnswerRes = {
      feedback,
      checkpoint_result: checkpointResult,
      mistake_id: mistakeId,
      state: await buildState(deps, trail, steps, outline, { chapterDone: advanced.chapterDone }),
    };
    return ctx.json(body);
  },
});

export default handler;
