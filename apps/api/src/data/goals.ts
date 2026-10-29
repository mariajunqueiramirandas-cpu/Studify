// Data endpoints of apps/mobile/src/features/goals (define.ts explains the contract): goals, exams and their scope,
// the plan, study time, readiness, grading (GOL-06), Modo Desespero (GOL-12) and the véspera sheet (GOL-07).
import { z } from 'zod';
import { dataRoute, done, maybe, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();
const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Time = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const Timestamp = z.string().datetime({ offset: true });
/** A JSON object stored in a jsonb column, bounded in size. */
const JsonObject = z.record(z.string(), z.unknown()).refine((v) => JSON.stringify(v).length <= 20_000, 'too large');
const ExamKind = z.enum(['regular', 'recuperacao', 'final']);
const Group = z.enum(['focus', 'basic', 'out']);

/** The fields the app sets on an exam (ExamInput in apps/mobile/src/features/goals/api.ts). */
const ExamFields = {
  subject_id: Id.nullable(),
  title: z.string().min(1).max(200),
  local_date: LocalDate,
  starts_at: Timestamp.nullable(),
  kind: ExamKind,
  weight: z.number().min(0).max(1000).nullable(),
  teacher_name: z.string().max(200).nullable().optional(),
  parent_exam_id: Id.nullable().optional(),
};

/** Keys present in `input` among `keys` (absent keys stay out of the patch, as supabase-js left undefined out). */
function pick<T extends object>(input: T, keys: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (input[k] !== undefined) out[k as string] = input[k];
  return out;
}

export const routes: DataRoute[] = [
  // ---------- goals ----------
  dataRoute({
    name: 'goals-list',
    write: false,
    input: z.object({ status: z.enum(['active', 'all']) }),
    example: () => ({ status: 'active' as const }),
    run: ({ db, user, input }) => {
      let q = db.from('goals').select('*').eq('user_id', user.userId).is('deleted_at', null).order('start_date', { ascending: false });
      if (input.status === 'active') q = q.eq('status', 'active');
      return rows(q);
    },
  }),

  dataRoute({
    name: 'goals-get',
    write: false,
    input: z.object({ goal_id: Id }),
    example: (seed) => ({ goal_id: seed.goalId }),
    run: ({ db, input }) => maybe(db.from('goals').select('*').eq('id', input.goal_id).maybeSingle()),
  }),

  dataRoute({
    name: 'goals-create',
    write: true,
    input: z.object({
      id: Id,
      mode: z.enum(['exam_week', 'enem']),
      name: z.string().trim().min(1).max(80),
      start_date: LocalDate,
      end_date: LocalDate,
      term_index: z.number().int().min(1).max(4).nullable(),
      school_year: z.number().int().min(2000).max(2100),
      settings: JsonObject.optional(),
    }),
    example: () => ({ id: crypto.randomUUID(), mode: 'exam_week' as const, name: 'Provas do 2º bimestre', start_date: '2026-05-01', end_date: '2026-05-20', term_index: 2, school_year: 2026 }),
    run: async ({ db, user, input }) => {
      await done(
        db.from('goals').insert({
          id: input.id,
          user_id: user.userId,
          mode: input.mode,
          name: input.name,
          start_date: input.start_date,
          end_date: input.end_date,
          term_index: input.term_index,
          school_year: input.school_year,
          ...(input.settings ? { settings: input.settings } : {}),
        }),
      );
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'goals-update',
    write: true,
    input: z.object({
      goal_id: Id,
      name: z.string().trim().min(1).max(80).optional(),
      start_date: LocalDate.optional(),
      end_date: LocalDate.optional(),
      status: z.enum(['active', 'completed', 'archived']).optional(),
      term_index: z.number().int().min(1).max(4).nullable().optional(),
      settings: JsonObject.optional(),
    }),
    example: (seed) => ({ goal_id: seed.goalId, name: 'Provas' }),
    run: async ({ db, input }) => {
      const patch = pick(input, ['name', 'start_date', 'end_date', 'status', 'term_index', 'settings']);
      if (Object.keys(patch).length > 0) await done(db.from('goals').update(patch).eq('id', input.goal_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'goals-plan-coach',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => maybe(db.from('plan_coach').select('output,local_date').eq('user_id', user.userId).maybeSingle()),
  }),

  // ---------- exams ----------
  dataRoute({
    name: 'goals-exams',
    write: false,
    input: z.object({ goal_id: Id }),
    example: (seed) => ({ goal_id: seed.goalId }),
    run: ({ db, input }) => rows(db.from('exams').select('*').eq('goal_id', input.goal_id).is('deleted_at', null).neq('status', 'cancelled').order('local_date')),
  }),

  dataRoute({
    name: 'goals-exams-upcoming',
    write: false,
    // The student's local date (the app's clock), as the direct query used.
    input: z.object({ today: LocalDate }),
    example: () => ({ today: '2026-01-01' }),
    run: ({ db, user, input }) =>
      rows(db.from('exams').select('*').eq('user_id', user.userId).eq('status', 'scheduled').gte('local_date', input.today).is('deleted_at', null).order('local_date')),
  }),

  dataRoute({
    name: 'goals-exam-get',
    write: false,
    input: z.object({ exam_id: Id }),
    example: (seed) => ({ exam_id: seed.examId }),
    run: ({ db, input }) => maybe(db.from('exams').select('*').eq('id', input.exam_id).maybeSingle()),
  }),

  dataRoute({
    name: 'goals-exam-create',
    write: true,
    input: z.object({ id: Id, goal_id: Id, ...ExamFields }),
    example: (seed) => ({
      id: crypto.randomUUID(),
      goal_id: seed.goalId,
      subject_id: seed.subjectId,
      title: 'Prova de Física 2',
      local_date: '2026-12-01',
      starts_at: null,
      kind: 'regular' as const,
      weight: null,
    }),
    run: async ({ db, user, input }) => {
      const fields = pick(input, ['subject_id', 'title', 'local_date', 'starts_at', 'kind', 'weight', 'teacher_name', 'parent_exam_id']);
      await done(db.from('exams').insert({ id: input.id, ...fields, goal_id: input.goal_id, user_id: user.userId }));
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'goals-exam-update',
    write: true,
    input: z.object({ exam_id: Id, ...ExamFields }),
    example: (seed) => ({ exam_id: seed.missingId, subject_id: seed.subjectId, title: 'Prova', local_date: '2026-12-01', starts_at: null, kind: 'regular' as const, weight: null }),
    run: async ({ db, input }) => {
      const patch = pick(input, ['subject_id', 'title', 'local_date', 'starts_at', 'kind', 'weight', 'teacher_name', 'parent_exam_id']);
      await done(db.from('exams').update(patch).eq('id', input.exam_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'goals-exam-cancel',
    write: true,
    input: z.object({ exam_id: Id }),
    example: (seed) => ({ exam_id: seed.missingId }),
    run: async ({ db, input }) => {
      await done(db.from('exams').update({ status: 'cancelled' }).eq('id', input.exam_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'goals-exam-grade',
    write: true,
    input: z.object({ exam_id: Id, grade: z.number().min(0).max(10_000), grade_max: z.number().positive().max(10_000) }),
    example: (seed) => ({ exam_id: seed.missingId, grade: 7, grade_max: 10 }),
    run: ({ db, input }) => done(db.rpc('log_exam_grade', { p_exam_id: input.exam_id, p_grade: input.grade, p_grade_max: input.grade_max }), 'log_exam_grade'),
  }),

  // ---------- scope ----------
  dataRoute({
    name: 'goals-scope',
    write: false,
    input: z.object({ exam_id: Id }),
    example: (seed) => ({ exam_id: seed.examId }),
    run: async ({ db, input }) => {
      const [items, nodes] = await Promise.all([
        rows(db.from('exam_scope_items').select('*').eq('exam_id', input.exam_id).is('deleted_at', null).order('position')),
        rows(db.from('exam_scope_nodes').select('*').eq('exam_id', input.exam_id)),
      ]);
      return { items, nodes };
    },
  }),

  dataRoute({
    name: 'goals-scope-confirm',
    write: true,
    input: z.object({ exam_id: Id, node_ids: z.array(Id).max(2000), default_all: z.boolean() }),
    example: (seed) => ({ exam_id: seed.missingId, node_ids: [seed.nodeId], default_all: false }),
    run: async ({ db, input }) => {
      await done(db.rpc('confirm_exam_scope', { p_exam_id: input.exam_id, p_node_ids: input.node_ids, p_default_all: input.default_all }), 'confirm_exam_scope');
      return { ok: true };
    },
  }),

  // ---------- plan ----------
  dataRoute({
    name: 'goals-plan-range',
    write: false,
    input: z.object({ from: LocalDate, to: LocalDate }),
    example: () => ({ from: '2026-01-01', to: '2026-01-31' }),
    run: ({ db, user, input }) =>
      rows(
        db
          .from('plan_items')
          .select('*')
          .eq('user_id', user.userId)
          .gte('local_date', input.from)
          .lte('local_date', input.to)
          .is('deleted_at', null)
          .order('local_date')
          .order('order_in_day'),
      ),
  }),

  dataRoute({
    name: 'goals-plan-item-update',
    write: true,
    input: z.object({ item_id: Id, status: z.enum(['planned', 'done', 'skipped', 'moved']).optional(), pinned: z.boolean().optional(), local_date: LocalDate.optional() }),
    example: (seed) => ({ item_id: seed.missingId, status: 'done' as const }),
    run: async ({ db, input }) => {
      const patch = pick(input, ['status', 'pinned', 'local_date']);
      if (Object.keys(patch).length > 0) await done(db.from('plan_items').update(patch).eq('id', input.item_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'goals-vespera-sheet',
    write: false,
    input: z.object({ exam_id: Id }),
    example: (seed) => ({ exam_id: seed.examId }),
    run: ({ db, input }) =>
      maybe(
        db
          .from('plan_items')
          .select('reason_params')
          .eq('exam_id', input.exam_id)
          .eq('unit_type', 'vespera')
          .is('deleted_at', null)
          .order('local_date', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
  }),

  // ---------- study time ----------
  dataRoute({
    name: 'goals-study-preferences',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => maybe(db.from('study_preferences').select('*').eq('user_id', user.userId).maybeSingle()),
  }),

  dataRoute({
    name: 'goals-study-preferences-save',
    write: true,
    input: z.object({
      minutes_by_weekday: z.array(z.number().int().min(0).max(1440)).length(7).optional(),
      window_start: Time.optional(),
      window_end: Time.optional(),
      quiet_start: Time.optional(),
      quiet_end: Time.optional(),
      vespera_time: Time.optional(),
      day_rollover_hour: z.number().int().min(0).max(6).optional(),
    }),
    example: () => ({ minutes_by_weekday: [60, 60, 60, 60, 60, 90, 30] }),
    run: async ({ db, user, input }) => {
      const patch = pick(input, ['minutes_by_weekday', 'window_start', 'window_end', 'quiet_start', 'quiet_end', 'vespera_time', 'day_rollover_hour']);
      await done(db.from('study_preferences').upsert({ user_id: user.userId, ...patch }, { onConflict: 'user_id' }));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'goals-availability',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => rows(db.from('availability_exceptions').select('local_date,minutes,source').eq('user_id', user.userId).order('local_date')),
  }),

  dataRoute({
    name: 'goals-availability-save',
    write: true,
    input: z.object({ local_date: LocalDate, minutes: z.number().int().min(0).max(1440) }),
    example: () => ({ local_date: '2026-12-24', minutes: 30 }),
    run: async ({ db, user, input }) => {
      // Students may update only minutes and deleted_at (column grants), so this is not one upsert, which would also
      // set source and be refused: an existing day is updated, a new one inserted.
      const existing = await rows(db.from('availability_exceptions').select('local_date').eq('user_id', user.userId).eq('local_date', input.local_date).limit(1));
      if (existing.length > 0) {
        await done(db.from('availability_exceptions').update({ minutes: input.minutes, deleted_at: null }).eq('user_id', user.userId).eq('local_date', input.local_date));
      } else {
        await done(
          db.from('availability_exceptions').upsert({ user_id: user.userId, local_date: input.local_date, minutes: input.minutes, source: 'user' }, { onConflict: 'user_id,local_date', ignoreDuplicates: true }),
        );
      }
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'goals-readiness',
    write: false,
    input: z.object({ exam_ids: z.array(Id).min(1).max(200) }),
    example: (seed) => ({ exam_ids: [seed.examId] }),
    run: ({ db, user, input }) =>
      rows(db.from('readiness_snapshots').select('*').eq('user_id', user.userId).in('exam_id', input.exam_ids).order('local_date', { ascending: false })),
  }),

  // ---------- GOL-06 grading ----------
  dataRoute({
    name: 'goals-grading',
    write: false,
    input: z.object({ school_year: z.number().int().min(2000).max(2100) }),
    example: () => ({ school_year: 2026 }),
    run: async ({ db, user, input }) => {
      const [rules, comps] = await Promise.all([
        rows(db.from('grading_rules').select('*').eq('owner_profile_id', user.userId).eq('school_year', input.school_year).is('deleted_at', null)),
        rows(db.from('grade_components').select('*').eq('user_id', user.userId).eq('school_year', input.school_year).is('deleted_at', null).order('position')),
      ]);
      return { rules, comps };
    },
  }),

  dataRoute({
    name: 'goals-grading-rule-save',
    write: true,
    // `existing`: update the rule `id`; otherwise insert a rule with that new id.
    input: z.object({
      id: Id,
      existing: z.boolean(),
      school_year: z.number().int().min(2000).max(2100),
      formula: JsonObject,
      preset_key: z.string().min(1).max(80).nullable(),
      subject_id: Id.nullable(),
    }),
    example: () => ({ id: crypto.randomUUID(), existing: false, school_year: 2026, formula: { kind: 'weighted_average' }, preset_key: null, subject_id: null }),
    run: async ({ db, user, input }) => {
      const payload = { owner_profile_id: user.userId, school_year: input.school_year, formula: input.formula, preset_key: input.preset_key, subject_id: input.subject_id };
      if (input.existing) await done(db.from('grading_rules').update(payload).eq('id', input.id));
      else await done(db.from('grading_rules').insert({ id: input.id, ...payload }));
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'goals-grade-component-save',
    write: true,
    input: z.object({
      id: Id,
      subject_id: Id,
      school_year: z.number().int().min(2000).max(2100),
      term_index: z.number().int().min(1).max(4),
      name: z.string().min(1).max(80),
      kind: z.enum(['exam', 'assignment', 'other']).optional(),
      weight: z.number().nullable().optional(),
      max_points: z.number().nullable().optional(),
      grade: z.number().nullable().optional(),
      exam_id: Id.nullable().optional(),
      position: z.number().int().min(0).max(10_000).optional(),
    }),
    example: (seed) => ({ id: crypto.randomUUID(), subject_id: seed.subjectId, school_year: 2026, term_index: 1, name: 'P1', weight: 1, position: 0 }),
    run: async ({ db, user, input }) => {
      // Same defaults as the app's direct upsert: kind 'exam' and position 0 unless given.
      const fields = pick(input, ['subject_id', 'school_year', 'term_index', 'name', 'kind', 'weight', 'max_points', 'grade', 'exam_id', 'position']);
      // Students may not update user_id or subject_id (column grants), so this is not one upsert: an existing
      // component gets the updatable fields, a new one is inserted whole.
      const existing = await maybe(db.from('grade_components').select('id').eq('id', input.id).maybeSingle());
      if (existing) {
        const { subject_id: _subject, ...updatable } = fields as Record<string, unknown>;
        if (Object.keys(updatable).length > 0) await done(db.from('grade_components').update(updatable).eq('id', input.id));
      } else {
        await done(db.from('grade_components').insert({ id: input.id, kind: 'exam', position: 0, ...fields, user_id: user.userId }));
      }
      return { id: input.id };
    },
  }),

  // ---------- GOL-12 Modo Desespero ----------
  dataRoute({
    name: 'goals-desperate',
    write: false,
    input: z.object({ goal_id: Id }),
    example: (seed) => ({ goal_id: seed.goalId }),
    run: ({ db, user, input }) =>
      maybe(db.from('desperate_modes').select('*').eq('user_id', user.userId).eq('goal_id', input.goal_id).eq('status', 'active').maybeSingle()),
  }),

  dataRoute({
    name: 'goals-desperate-start',
    write: true,
    input: z.object({ goal_id: Id, exam_ids: z.array(Id).min(1).max(50), minutes_per_day: z.number().int().min(1).max(1440) }),
    example: (seed) => ({ goal_id: seed.missingId, exam_ids: [seed.examId], minutes_per_day: 120 }),
    run: ({ db, input }) =>
      done(db.rpc('start_desperate_mode', { p_goal_id: input.goal_id, p_exam_ids: input.exam_ids, p_minutes_per_day: input.minutes_per_day }), 'start_desperate_mode'),
  }),

  dataRoute({
    name: 'goals-desperate-groups',
    write: true,
    input: z.object({ desperate_mode_id: Id, moves: z.array(z.object({ node_id: Id, group: Group })).min(1).max(500) }),
    example: (seed) => ({ desperate_mode_id: seed.missingId, moves: [{ node_id: seed.nodeId, group: 'focus' as const }] }),
    run: ({ db, input }) => done(db.rpc('set_desperate_groups', { p_desperate_mode_id: input.desperate_mode_id, p_moves: input.moves }), 'set_desperate_groups'),
  }),

  dataRoute({
    name: 'goals-desperate-end',
    write: true,
    input: z.object({ desperate_mode_id: Id }),
    example: (seed) => ({ desperate_mode_id: seed.missingId }),
    run: ({ db, input }) => done(db.rpc('end_desperate_mode', { p_desperate_mode_id: input.desperate_mode_id }), 'end_desperate_mode'),
  }),
];
