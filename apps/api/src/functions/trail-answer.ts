// trail-answer (TRL-01.5–01.7, 01.13; api §4.11). Records the student's answer to the step on screen (or that a
// lesson was read), returns the feedback that teaches (right option, why each option is right or wrong, a tip),
// writes mastery evidence, saves a miss to the Caderno de Erros, scores a finished chapter-test round and moves the
// path on when the chapter is closed (test passed and Lucas taught). Answering a step twice returns the first
// answer's feedback; it is never graded again. The app now grades a question with trail-grade and settles it with
// trail-settle; this call remains for lessons and for app builds that predate the split.
import { ApiFailure, TrailAnswerReqSchema, type TrailAnswerReq, type TrailAnswerRes } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { advanceIfPassed, buildState, checkpointScore, feedbackOf, isQuestionPurpose, loadOutline, loadSteps, loadTrail, recordQuestionAnswer, toView, type QuestionContent } from '../shared/trail.ts';

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
      if (question) mistakeId = await recordQuestionAnswer(deps, trail, row, input.time_spent_ms ?? 0, ctx.now, true);
    }

    let checkpointResult: TrailAnswerRes['checkpoint_result'] = null;
    if (row.purpose === 'checkpoint') {
      const score = checkpointScore(steps.filter((s) => s.topic_id === row.topic_id).map(toView), row.round);
      if (score) checkpointResult = { round: row.round, ...score };
    }

    const advanced = await advanceIfPassed(deps, trail, steps, outline, ctx.now);
    trail = advanced.trail;

    const body: TrailAnswerRes = {
      feedback: question ? feedbackOf(row) : null,
      checkpoint_result: checkpointResult,
      mistake_id: mistakeId,
      state: await buildState(deps, trail, steps, outline, { chapterDone: advanced.chapterDone }),
    };
    return ctx.json(body);
  },
});

export default handler;
