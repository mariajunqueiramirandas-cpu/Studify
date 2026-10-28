// trail-settle (TRL-01.5–01.7, 01.13; api §4.11). What a graded question leaves behind: mastery evidence, the Caderno
// entry for a miss, the chapter-test round, and the path moved on when the chapter closes. Returns the explanation
// of the question and the next state. The app calls it right after trail-grade; calling it again is harmless: a
// miss is saved to the Caderno once.
import { ApiFailure, TrailSettleReqSchema, type TrailAnswerRes, type TrailSettleReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { advanceIfPassed, buildState, checkpointScore, feedbackOf, isQuestionPurpose, loadOutline, loadSteps, loadTrail, recordQuestionAnswer, toView } from '../shared/trail.ts';

export const handler = defineFunction<TrailSettleReq>({
  name: 'trail-settle',
  mutating: true,
  input: TrailSettleReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const [loaded, steps] = await Promise.all([loadTrail(db, userId, input.trail_id), loadSteps(db, input.trail_id)]);
    let trail = loaded;
    const [, outline] = await Promise.all([requireSubject(db, userId, trail.subject_id, 'read'), loadOutline(db, userId, trail.subject_id)]);
    const row = steps.find((s) => s.id === input.step_id);
    if (!row) throw new ApiFailure('not_found');
    if (!isQuestionPurpose(row.purpose) || row.status !== 'done') throw new ApiFailure('invalid_request', { message: 'Responda a pergunta antes.' });

    const mistakeId = await recordQuestionAnswer(deps, trail, row, input.time_spent_ms ?? 0, ctx.now, row.question_id == null);

    let checkpointResult: TrailAnswerRes['checkpoint_result'] = null;
    if (row.purpose === 'checkpoint') {
      const score = checkpointScore(steps.filter((s) => s.topic_id === row.topic_id).map(toView), row.round);
      if (score) checkpointResult = { round: row.round, ...score };
    }

    const advanced = await advanceIfPassed(deps, trail, steps, outline, ctx.now);
    trail = advanced.trail;

    const body: TrailAnswerRes = {
      feedback: feedbackOf(row),
      checkpoint_result: checkpointResult,
      mistake_id: mistakeId,
      state: await buildState(deps, trail, steps, outline, { chapterDone: advanced.chapterDone }),
    };
    return ctx.json(body);
  },
});

export default handler;
