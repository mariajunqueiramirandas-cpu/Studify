// quiz-shared-open — SOC-09.1–2, D-32. Sign-in required. Opens a shared quiz by token and gives the opener a
// practice quiz and an in-progress attempt over the snapshot's questions. Outsiders get the questions and
// `outsider: true`; the subject name and material links are for Turma members only.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';
import { activeMember } from '../shared-p2/turma.ts';
import { SHARE_TOKEN_RE, type ShareSnapshot } from '../shared-p2/share.ts';

export const QuizSharedOpenInput = z.object({ token: z.string().regex(SHARE_TOKEN_RE, 'token inválido') });
export type QuizSharedOpenInput = z.infer<typeof QuizSharedOpenInput>;

export const handler = defineP2<QuizSharedOpenInput>({
  name: 'quiz-shared-open',
  mutating: false,
  input: QuizSharedOpenInput,
  run: async (ctx) => {
    const { p2, input: i, now } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;

    const share = await db.from('quiz_shares').select('token, quiz_id, snapshot, expires_at, revoked_at, uses').eq(
      'token',
      i.token,
    ).maybeSingle();
    if (share.error) throw share.error;
    if (!share.data || share.data.revoked_at || new Date(share.data.expires_at as string).getTime() <= now.getTime()) {
      throw new ApiFailure('not_found', { message: 'Esse desafio não está mais disponível.' });
    }
    const snapshot = share.data.snapshot as ShareSnapshot;
    const quiz = await db.from('quizzes').select('id, owner_id, subject_id, class_group_id, title, question_ids').eq(
      'id',
      share.data.quiz_id as string,
    ).maybeSingle();
    if (quiz.error) throw quiz.error;
    if (!quiz.data) throw new ApiFailure('not_found');
    const sourceQuestionIds = quiz.data.question_ids as string[];

    const classGroupId = (quiz.data.class_group_id as string | null) ?? null;
    const member = classGroupId ? await activeMember(db, classGroupId, me) : null;
    const outsider = member === null;

    // The opener's practice quiz over the same questions, reused on repeat opens of the same link.
    const mine = await db.from('quizzes').select('id, scope').eq('owner_id', me).eq('kind', 'practice');
    if (mine.error) throw mine.error;
    let openerQuiz = (mine.data ?? []).find((q) =>
      (q.scope as { share_token?: string } | null)?.share_token === i.token
    );
    if (!openerQuiz) {
      const id = p2.newId();
      const created = await db.from('quizzes').insert({
        id,
        owner_id: me,
        kind: 'practice',
        mode: 'practice',
        title: snapshot.title,
        question_ids: sourceQuestionIds,
        scope: { share_token: i.token, source_quiz_id: quiz.data.id },
        config: { shared: true },
      });
      if (created.error) throw created.error;
      openerQuiz = { id, scope: {} };
    }

    const openAttempt = await db.from('quiz_attempts').select('id').eq('quiz_id', openerQuiz.id).eq('user_id', me).eq(
      'status',
      'in_progress',
    ).maybeSingle();
    if (openAttempt.error) throw openAttempt.error;
    let attemptId = openAttempt.data?.id as string | undefined;
    if (!attemptId) {
      attemptId = p2.newId();
      const attempt = await db.from('quiz_attempts').insert({
        id: attemptId,
        user_id: me,
        quiz_id: openerQuiz.id,
        status: 'in_progress',
        started_at: now.toISOString(),
        device_id: ctx.req.headers.get('x-device-id') ?? 'server',
      });
      if (attempt.error) throw attempt.error;
    }

    const bump = await db.from('quiz_shares').update({ uses: Number(share.data.uses ?? 0) + 1 }).eq('token', i.token);
    if (bump.error) throw bump.error;

    // The creator's result as k correct out of n (SOC-09.3 "consegue bater?"). Null when they never submitted.
    let creatorScore: { k: number; n: number } | null = null;
    const creatorAttempt = await db
      .from('quiz_attempts')
      .select('id')
      .eq('quiz_id', quiz.data.id as string)
      .eq('user_id', quiz.data.owner_id as string)
      .eq('status', 'submitted')
      .order('finished_at', { ascending: false })
      .limit(1);
    if (creatorAttempt.error) throw creatorAttempt.error;
    const creatorAttemptId = creatorAttempt.data?.[0]?.id as string | undefined;
    if (creatorAttemptId) {
      const answers = await db.from('attempt_answers').select('correct').eq('attempt_id', creatorAttemptId);
      if (answers.error) throw answers.error;
      creatorScore = { k: (answers.data ?? []).filter((a) => a.correct === true).length, n: sourceQuestionIds.length };
    }

    let subjectName: string | null = null;
    if (!outsider && quiz.data.subject_id) {
      const subject = await db.from('subjects').select('name').eq('id', quiz.data.subject_id as string).maybeSingle();
      subjectName = (subject.data?.name as string | undefined) ?? null;
    }
    return ctx.json({
      quiz_id: openerQuiz.id,
      attempt_id: attemptId,
      title: snapshot.title,
      subject_name: subjectName,
      question_count: snapshot.questions.length,
      creator_score: creatorScore,
      outsider,
      snapshot: { questions: snapshot.questions },
    });
  },
});
