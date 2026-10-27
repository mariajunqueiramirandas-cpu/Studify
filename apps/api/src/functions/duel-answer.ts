// duel-answer — SOC-02.6, SOC-02.8. Scores one answer on the server clock. Receipt after deadline_at + 1.5 s
// scores 0 (timeout). When both players have finished, the duel closes with the winner and result pushes.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';
import {
  finalizeIfComplete,
  isTimeoutAt,
  loadDuelContext,
  questionDeadline,
  recordDuelAnswer,
} from '../shared-p2/duel.ts';
import { correctResponseOf, loadQuestion } from '../shared-p2/questions.ts';

export const DuelAnswerInput = z.object({
  attempt_id: z.uuid(),
  question_id: z.uuid(),
  response: z.unknown(),
  answer_id: z.uuid(),
});
export type DuelAnswerInput = z.infer<typeof DuelAnswerInput>;

export const handler = defineP2<DuelAnswerInput>({
  name: 'duel-answer',
  mutating: true,
  input: DuelAnswerInput,
  run: async (ctx) => {
    const { p2, input: i, now } = ctx;
    const db = p2.db;
    const { attempt, quiz, duel } = await loadDuelContext(db, i.attempt_id, ctx.user.userId, now);

    const served = await db
      .schema('private')
      .from('question_served')
      .select('question_id, served_at, deadline_at')
      .eq('quiz_attempt_id', attempt.id)
      .eq('question_id', i.question_id)
      .maybeSingle();
    if (served.error) throw served.error;
    if (!served.data) {
      throw new ApiFailure('invalid_request', { message: 'Essa pergunta ainda não foi servida pra você.' });
    }

    const question = await loadQuestion(db, i.question_id);
    if (!question || !quiz.question_ids.includes(i.question_id)) throw new ApiFailure('not_found');

    const prior = await db.from('attempt_answers').select('correct, points_awarded').eq('attempt_id', attempt.id).eq(
      'question_id',
      i.question_id,
    ).maybeSingle();
    if (prior.error) throw prior.error;
    const reveal = {
      correct_response: correctResponseOf(question),
      explanation: question.explanation ?? '',
      source_pages: question.source_pages,
    };
    if (prior.data) {
      return ctx.json({
        correct: prior.data.correct === true,
        points: Number(prior.data.points_awarded ?? 0),
        ...reveal,
      });
    }

    const servedAt = new Date(served.data.served_at as string);
    const deadline = served.data.deadline_at ? new Date(served.data.deadline_at as string) : questionDeadline(servedAt);
    const timeout = isTimeoutAt(now.getTime(), deadline.getTime());
    const result = await recordDuelAnswer({
      deps: p2,
      attempt,
      question,
      servedAt,
      response: i.response,
      answerId: i.answer_id,
      timeout,
      now,
    });
    if (result.kind === 'existing') {
      throw new ApiFailure('already_exists', { message: 'Essa resposta já foi registrada.' });
    }

    await finalizeIfComplete(p2, duel, quiz, now);
    return ctx.json({ correct: result.correct, points: result.points, ...reveal });
  },
});
