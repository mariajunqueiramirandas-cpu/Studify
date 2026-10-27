// duel-next — SOC-02.4, SOC-08.8 (anti-cheat). Serves the next question of the caller's duel attempt.
// The question is recorded in private.question_served with deadline = served + 30 s, and a repeated call
// returns the same served question without resetting its timer. Answer keys never leave the server.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';
import { finalizeIfComplete, loadDuelContext, questionDeadline, recordDuelAnswer } from '../shared-p2/duel.ts';
import { loadQuestion, publicQuestion } from '../shared-p2/questions.ts';

export const DuelNextInput = z.object({ attempt_id: z.uuid() });
export type DuelNextInput = z.infer<typeof DuelNextInput>;

interface ServedRow {
  question_id: string;
  served_at: string;
  deadline_at: string;
}

export const handler = defineP2<DuelNextInput>({
  name: 'duel-next',
  mutating: true,
  input: DuelNextInput,
  run: async (ctx) => {
    const { p2, input: i, now } = ctx;
    const db = p2.db;
    const { attempt, quiz, duel } = await loadDuelContext(db, i.attempt_id, ctx.user.userId, now);
    const total = quiz.question_ids.length;

    const served = await db
      .schema('private')
      .from('question_served')
      .select('question_id, served_at, deadline_at')
      .eq('quiz_attempt_id', attempt.id)
      .order('served_at', { ascending: true });
    if (served.error) throw served.error;
    const servedRows = (served.data ?? []) as ServedRow[];

    const answered = await db.from('attempt_answers').select('question_id').eq('attempt_id', attempt.id);
    if (answered.error) throw answered.error;
    const answeredIds = new Set((answered.data ?? []).map((r) => r.question_id as string));

    const last = servedRows[servedRows.length - 1];
    let timedOut = false;
    if (last && !answeredIds.has(last.question_id)) {
      if (now.getTime() <= new Date(last.deadline_at).getTime()) {
        const q = await loadQuestion(db, last.question_id);
        if (!q) throw new ApiFailure('internal_error');
        return ctx.json({
          index: servedRows.length - 1,
          total,
          question: publicQuestion(q),
          deadline_at: last.deadline_at,
        });
      }
      // Past the deadline without an answer: record the timeout (scores 0) before serving the next one.
      const q = await loadQuestion(db, last.question_id);
      if (!q) throw new ApiFailure('internal_error');
      await recordDuelAnswer({
        deps: p2,
        attempt,
        question: q,
        servedAt: new Date(last.served_at),
        response: null,
        answerId: p2.newId(),
        timeout: true,
        now,
      });
      timedOut = true;
    }

    if (servedRows.length >= total) {
      if (timedOut) await finalizeIfComplete(p2, duel, quiz, now);
      return ctx.json({ finished: true });
    }

    const questionId = quiz.question_ids[servedRows.length];
    const q = questionId ? await loadQuestion(db, questionId) : null;
    if (!q) throw new ApiFailure('internal_error');
    const deadline = questionDeadline(now);
    const inserted = await db
      .schema('private')
      .from('question_served')
      .upsert(
        {
          quiz_attempt_id: attempt.id,
          question_id: q.id,
          served_at: now.toISOString(),
          deadline_at: deadline.toISOString(),
        },
        { onConflict: 'quiz_attempt_id,question_id', ignoreDuplicates: true },
      );
    if (inserted.error) throw inserted.error;
    return ctx.json({
      index: servedRows.length,
      total,
      question: publicQuestion(q),
      deadline_at: deadline.toISOString(),
    });
  },
});
