// trail-grade (TRL-01.5; api §4.11). The verdict of a question: records the student's answer and returns whether it
// is right and which option is. Only the step is written here, so the verdict comes back at once; the explanation,
// mastery, the Caderno and the next step come from trail-settle. Answering a step twice returns the first verdict.
import { ApiFailure, TrailAnswerReqSchema, type TrailAnswerReq, type TrailGradeRes } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { isQuestionPurpose, loadSteps, loadTrail, type QuestionContent } from '../shared/trail.ts';

export const handler = defineFunction<TrailAnswerReq>({
  name: 'trail-grade',
  mutating: true,
  input: TrailAnswerReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const [trail, steps] = await Promise.all([loadTrail(db, userId, input.trail_id), loadSteps(db, input.trail_id)]);
    await requireSubject(db, userId, trail.subject_id, 'read');
    const row = steps.find((s) => s.id === input.step_id);
    if (!row) throw new ApiFailure('not_found');
    if (row.served_seq == null || row.status === 'discarded') throw new ApiFailure('invalid_request', { message: 'Esse passo não está na tela.' });
    if (!isQuestionPurpose(row.purpose)) throw new ApiFailure('invalid_request', { message: 'Esse passo não é uma pergunta.' });
    if (input.response === null && row.status !== 'done') throw new ApiFailure('invalid_request', { message: 'Escolha uma alternativa.' });

    if (row.status === 'ready') {
      const patch = {
        status: 'done' as const,
        response: input.response,
        correct: input.response === (row.content as QuestionContent).correct,
        answered_at: ctx.now.toISOString(),
      };
      const upd = await db.from('trail_steps').update(patch).eq('id', row.id).eq('status', 'ready');
      if (upd.error) throw upd.error;
      Object.assign(row, patch);
    }

    const body: TrailGradeRes = { correct: row.correct === true, correct_option: (row.content as QuestionContent).correct };
    return ctx.json(body);
  },
});

export default handler;
