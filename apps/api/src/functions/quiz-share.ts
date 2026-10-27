// quiz-share — SOC-09.1, SOC-09.4, SOC-09.6. The owner of a finished quiz creates a 22-character share token.
// The stored snapshot has questions without answer keys, explanations or page references. Expires in 30 days.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';
import { loadQuiz } from '../shared-p2/duel.ts';
import { loadQuestions, snapshotQuestion } from '../shared-p2/questions.ts';
import { MS_PER_DAY, randomToken, shareUrl, startOfLocalDayIso } from '../shared-p2/util.ts';
import {
  assertSnapshotSafe,
  SHARE_DAILY_LIMIT,
  SHARE_TOKEN_BYTES,
  SHARE_TTL_DAYS,
  type ShareSnapshot,
} from '../shared-p2/share.ts';

export const QuizShareInput = z.object({ quiz_id: z.uuid() });
export type QuizShareInput = z.infer<typeof QuizShareInput>;

export const handler = defineP2<QuizShareInput>({
  name: 'quiz-share',
  mutating: true,
  input: QuizShareInput,
  run: async (ctx) => {
    const { p2, input: i, now } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;

    const quiz = await loadQuiz(db, i.quiz_id);
    if (!quiz) throw new ApiFailure('not_found');
    const owner = await db.from('quizzes').select('owner_id, title, subject_id').eq('id', i.quiz_id).maybeSingle();
    if (owner.error) throw owner.error;
    if (!owner.data || owner.data.owner_id !== me) throw new ApiFailure('not_found');

    const finished = await db.from('quiz_attempts').select('id').eq('quiz_id', i.quiz_id).eq('user_id', me).eq(
      'status',
      'submitted',
    ).limit(1);
    if (finished.error) throw finished.error;
    if ((finished.data ?? []).length === 0) {
      throw new ApiFailure('invalid_request', { message: 'Termine o desafio antes de compartilhar.' });
    }

    const today = await db.from('quiz_shares').select('token').eq('created_by', me).gte(
      'created_at',
      startOfLocalDayIso(now),
    );
    if (today.error) throw today.error;
    if ((today.data ?? []).length >= SHARE_DAILY_LIMIT) {
      throw new ApiFailure('rate_limited', { message: 'Você já compartilhou 50 desafios hoje. Amanhã tem mais!' });
    }

    const questions = await loadQuestions(db, quiz.question_ids);
    const ordered = quiz.question_ids.map((id) => questions.get(id)).filter((q): q is NonNullable<typeof q> =>
      q !== undefined
    );
    let subjectName: string | null = null;
    if (owner.data.subject_id) {
      const subject = await db.from('subjects').select('name').eq('id', owner.data.subject_id as string).maybeSingle();
      subjectName = (subject.data?.name as string | undefined) ?? null;
    }
    const snapshot: ShareSnapshot = {
      version: 1,
      title: (owner.data.title as string | null) ?? null,
      subject_name: subjectName,
      questions: ordered.map((q) => snapshotQuestion(q)),
    };
    assertSnapshotSafe(snapshot);

    const token = randomToken(p2.randomBytes, SHARE_TOKEN_BYTES);
    const expiresAt = new Date(now.getTime() + SHARE_TTL_DAYS * MS_PER_DAY);
    const inserted = await db.from('quiz_shares').insert({
      token,
      quiz_id: i.quiz_id,
      created_by: me,
      snapshot,
      expires_at: expiresAt.toISOString(),
      uses: 0,
    });
    if (inserted.error) throw inserted.error;
    return ctx.json({ token, url: shareUrl(p2.baseUrl, token), expires_at: expiresAt.toISOString() });
  },
});
