// battle-answer — SOC-03.5, SOC-03.7, SOC-03.9, SOC-03.10. Records one answer. Acceptance is decided only by
// server time: the question must be open, the index current, and the receipt within closes_at + 1 s.
// Correctness and the distribution are never returned here; they go out on the channel at reveal.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';
import { isAnswerAccepted, loadBattle } from '../shared-p2/battle.ts';
import { gradeQuestion, loadQuestion, parseResponse } from '../shared-p2/questions.ts';
import { loadQuiz } from '../shared-p2/duel.ts';

export const BattleAnswerInput = z.object({
  battle_id: z.uuid(),
  question_index: z.number().int().min(0).max(14),
  response: z.unknown(),
  answer_id: z.uuid(),
});
export type BattleAnswerInput = z.infer<typeof BattleAnswerInput>;

export const handler = defineP2<BattleAnswerInput>({
  name: 'battle-answer',
  mutating: true,
  input: BattleAnswerInput,
  run: async (ctx) => {
    const { p2, input: i, now } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;
    const battle = await loadBattle(db, i.battle_id);
    if (!battle) throw new ApiFailure('not_found');

    const player = await db.from('battle_players').select('quiz_attempt_id').eq('battle_id', battle.id).eq(
      'user_id',
      me,
    ).maybeSingle();
    if (player.error) throw player.error;
    if (!player.data) throw new ApiFailure('forbidden', { message: 'Entra na batalha pelo PIN antes de responder.' });
    const attemptId = player.data.quiz_attempt_id as string;

    const quiz = await loadQuiz(db, battle.quiz_id);
    const questionId = quiz?.question_ids[i.question_index];
    if (!quiz || !questionId) throw new ApiFailure('invalid_request');
    const question = await loadQuestion(db, questionId);
    if (!question) throw new ApiFailure('internal_error');

    const opensAtMs = battle.question_opens_at ? new Date(battle.question_opens_at).getTime() : null;
    const closesAtMs = battle.question_closes_at ? new Date(battle.question_closes_at).getTime() : null;
    const accepted = isAnswerAccepted({
      status: battle.status,
      currentIndex: battle.current_index,
      questionIndex: i.question_index,
      opensAtMs,
      closesAtMs,
      receivedMs: now.getTime(),
    });
    if (!accepted || opensAtMs === null || closesAtMs === null) return ctx.json({ accepted: false });

    // Served at the server open time; the deadline is the battle close (battle clock, not the client's).
    const opensAt = new Date(opensAtMs);
    const served = await db
      .schema('private')
      .from('question_served')
      .upsert(
        {
          quiz_attempt_id: attemptId,
          question_id: question.id,
          served_at: opensAt.toISOString(),
          deadline_at: new Date(closesAtMs).toISOString(),
        },
        { onConflict: 'quiz_attempt_id,question_id', ignoreDuplicates: true },
      );
    if (served.error) throw served.error;

    const parsed = parseResponse(question, i.response);
    const outcome = gradeQuestion(question, parsed);
    const inserted = await db.from('attempt_answers').insert({
      id: i.answer_id,
      attempt_id: attemptId,
      user_id: me,
      question_id: question.id,
      question_version: question.version,
      response: i.response,
      correct: outcome.correct,
      score: outcome.score,
      grading_status: 'graded',
      time_spent_ms: Math.max(0, now.getTime() - opensAtMs),
      answered_at: now.toISOString(),
    });
    if (inserted.error) {
      if (inserted.error.code === '23505') return ctx.json({ accepted: false });
      throw inserted.error;
    }
    return ctx.json({ accepted: true });
  },
});
