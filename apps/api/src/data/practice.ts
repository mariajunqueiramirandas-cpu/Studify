// Data endpoints of apps/mobile/src/features/practice (define.ts explains the contract): the quiz being run, an
// attempt's result, the Caderno de Erros, calibration and the boss's first-win check.
import { z } from 'zod';
import { dataRoute, done, maybe, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();
const MistakeCause = z.enum(['didnt_know', 'confused', 'careless', 'misread']);

export const routes: DataRoute[] = [
  dataRoute({
    // The quiz, its questions and, for official ENEM questions, the items behind them (ENM-02.7).
    name: 'practice-quiz-bundle',
    write: false,
    input: z.object({ quiz_id: Id }),
    example: (seed) => ({ quiz_id: seed.missingId }),
    run: async ({ db, input }) => {
      const quiz = await maybe<{ kind: string; question_ids: string[] }>(db.from('quizzes').select('*').eq('id', input.quiz_id).maybeSingle());
      if (!quiz) return null;
      const questions = await rows<{ origin?: string }>(db.from('questions').select('*').in('id', quiz.question_ids));
      const official = quiz.kind === 'enem_simulado' || questions.some((q) => q.origin === 'enem_official');
      const enem = official
        ? await rows(db.from('enem_items').select('id,question_id,edition_year,day,positions,annulled,crop_paths,alt_text').in('question_id', quiz.question_ids))
        : [];
      return { quiz, questions, enem };
    },
  }),

  dataRoute({
    name: 'practice-attempt',
    write: false,
    input: z.object({ attempt_id: Id }),
    example: (seed) => ({ attempt_id: seed.missingId }),
    run: async ({ db, input }) => {
      const attempt = await maybe(db.from('quiz_attempts').select('*').eq('id', input.attempt_id).maybeSingle());
      const answers = await rows<{ question_id: string }>(db.from('attempt_answers').select('*').eq('attempt_id', input.attempt_id));
      const questions = answers.length ? await rows(db.from('questions').select('*').in('id', answers.map((a) => a.question_id))) : [];
      return { attempt, answers, questions };
    },
  }),

  dataRoute({
    name: 'practice-mistakes',
    write: false,
    input: z.object({ filter: z.enum(['open', 'resolved', 'all']) }),
    example: () => ({ filter: 'all' as const }),
    run: async ({ db, user, input }) => {
      let q = db.from('mistakes').select('*').eq('user_id', user.userId).is('deleted_at', null).order('created_at', { ascending: false });
      if (input.filter === 'open') q = q.is('resolved_at', null);
      if (input.filter === 'resolved') q = q.not('resolved_at', 'is', null);
      const mistakes = await rows<{ question_id: string }>(q);
      const questions = mistakes.length ? await rows(db.from('questions').select('*').in('id', [...new Set(mistakes.map((m) => m.question_id))])) : [];
      return { mistakes, questions };
    },
  }),

  dataRoute({
    // PRA-04 cause / "O que eu aprendi": LWW fields on the student's own row.
    name: 'practice-mistake-update',
    write: true,
    input: z.object({ mistake_id: Id, cause: MistakeCause.nullable().optional(), user_note: z.string().max(2000).nullable().optional() }),
    example: (seed) => ({ mistake_id: seed.missingId, cause: 'careless' as const }),
    run: async ({ db, input }) => {
      const patch: Record<string, unknown> = {};
      if (input.cause !== undefined) patch.cause = input.cause;
      if (input.user_note !== undefined) patch.user_note = input.user_note;
      if (input.cause) patch.cause_source = 'user';
      if (Object.keys(patch).length > 0) await done(db.from('mistakes').update(patch).eq('id', input.mistake_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'practice-calibration',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => rows(db.from('calibration_stats').select('node_id,confidence,n,n_correct').eq('user_id', user.userId)),
  }),

  dataRoute({
    // MOT-02.4: whether the student already defeated this unit's boss (the first win is worth more XP).
    name: 'practice-boss-defeated',
    write: false,
    input: z.object({ unit_node_id: Id }),
    example: (seed) => ({ unit_node_id: seed.nodeId }),
    run: async ({ db, user, input }) => {
      const before = await rows(db.from('boss_attempts').select('id').eq('user_id', user.userId).eq('unit_node_id', input.unit_node_id).eq('passed', true).limit(1));
      return { defeated: before.length > 0 };
    },
  }),
];
