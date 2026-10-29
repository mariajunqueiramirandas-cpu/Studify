// Data endpoints of apps/mobile/src/features/prova (define.ts explains the contract): teacher profiles, the Prova
// Provável quiz, "O que caiu?" (PRA-09.11) and the exam schedule import (ING-07).
import { z } from 'zod';
import { dataRoute, done, maybe, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();

export const routes: DataRoute[] = [
  dataRoute({
    name: 'prova-teacher-profiles',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: ({ db, input }) => rows(db.from('teacher_profiles').select('*').eq('subject_id', input.subject_id).order('n_tests', { ascending: false })),
  }),

  dataRoute({
    name: 'prova-predicted-quiz',
    write: false,
    input: z.object({ exam_id: Id }),
    example: (seed) => ({ exam_id: seed.examId }),
    run: ({ db, user, input }) =>
      maybe(
        db
          .from('quizzes')
          .select('id,question_ids,created_at')
          .eq('owner_id', user.userId)
          .eq('exam_id', input.exam_id)
          .eq('kind', 'predicted_test')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
  }),

  dataRoute({
    name: 'prova-exam-outcome-save',
    write: true,
    input: z.object({ exam_id: Id, node_ids: z.array(Id).min(1).max(500) }),
    example: (seed) => ({ exam_id: seed.examId, node_ids: [seed.nodeId] }),
    run: async ({ db, user, input }) => {
      // Students may update only deleted_at (column grants): new topics are inserted, ones already there are kept,
      // and a topic removed before (deleted_at set) is brought back.
      await done(
        db.from('exam_outcome_topics').upsert(
          input.node_ids.map((node_id) => ({ exam_id: input.exam_id, user_id: user.userId, node_id })),
          { onConflict: 'exam_id,user_id,node_id', ignoreDuplicates: true },
        ),
      );
      await done(
        db.from('exam_outcome_topics').update({ deleted_at: null }).eq('exam_id', input.exam_id).eq('user_id', user.userId).in('node_id', input.node_ids).not('deleted_at', 'is', null),
      );
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'prova-schedule-import',
    write: false,
    input: z.object({ schedule_import_id: Id }),
    example: (seed) => ({ schedule_import_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('schedule_imports').select('*').eq('id', input.schedule_import_id).maybeSingle()),
  }),

  dataRoute({
    name: 'prova-schedule-import-apply',
    write: true,
    input: z.object({ schedule_import_id: Id, goal_id: Id.optional() }),
    example: (seed) => ({ schedule_import_id: seed.missingId, goal_id: seed.goalId }),
    run: ({ db, input }) =>
      done(db.rpc('apply_schedule_import', { p_schedule_import_id: input.schedule_import_id, p_goal_id: input.goal_id ?? null }), 'apply_schedule_import'),
  }),
];
