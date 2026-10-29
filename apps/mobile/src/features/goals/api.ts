import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { callFunction } from '../../api/functions';
import { useSession } from '../auth/session';

export interface Goal {
  id: string;
  user_id: string;
  mode: 'exam_week' | 'enem';
  name: string;
  start_date: string;
  end_date: string;
  status: 'active' | 'completed' | 'archived';
  term_index: number | null;
  school_year: number | null;
  settings: Record<string, unknown>;
  created_at: string;
}

export interface Exam {
  id: string;
  goal_id: string;
  user_id: string;
  subject_id: string | null;
  title: string;
  local_date: string;
  starts_at: string | null;
  duration_min: number | null;
  kind: 'regular' | 'recuperacao' | 'final';
  status: 'draft' | 'scheduled' | 'done' | 'cancelled';
  parent_exam_id: string | null;
  teacher_name: string | null;
  weight: number | null;
  scope_status: 'none' | 'pending_review' | 'confirmed';
  grade: number | null;
  grade_max: number | null;
}

export interface PlanItem {
  id: string;
  goal_id: string | null;
  local_date: string;
  subject_id: string | null;
  exam_id: string | null;
  node_ids: string[];
  unit_type: 'learn' | 'learn_light' | 'practice' | 'mock' | 'vespera' | 'warmup' | 'review' | 'upload_material' | 'essay';
  minutes: number;
  priority: number;
  order_in_day: number;
  pinned: boolean;
  status: 'planned' | 'done' | 'skipped' | 'moved';
  reason_key: string | null;
  reason_params: Record<string, unknown> | null;
}

export interface ScopeItem {
  id: string;
  exam_id: string;
  raw_text: string;
  position: number;
  status: 'matched' | 'partial' | 'unmatched';
  placeholder_node_id: string | null;
}

export interface ScopeNode {
  exam_id: string;
  node_id: string;
  scope_item_id: string | null;
  source: 'ai' | 'user' | 'default_all';
  confidence: number;
  confirmed: boolean;
}

export interface Readiness {
  exam_id: string;
  local_date: string;
  readiness: number;
  readiness_proj: number | null;
  pred_low: number | null;
  pred_mid: number | null;
  pred_high: number | null;
}

export function useGoals(status: 'active' | 'all' = 'active') {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['goals', userId, status],
    enabled: !!userId,
    queryFn: () => data<Goal[]>('goals-list', { status }),
  });
}

export function useGoal(goalId: string | undefined) {
  return useQuery({
    queryKey: ['goal', goalId],
    enabled: !!goalId,
    queryFn: () => data<Goal | null>('goals-get', { goal_id: goalId }),
  });
}

export function useGoalExams(goalId: string | undefined) {
  return useQuery({
    queryKey: ['goal', goalId, 'exams'],
    enabled: !!goalId,
    queryFn: () => data<Exam[]>('goals-exams', { goal_id: goalId }),
  });
}

/** All upcoming exams across active goals (Hoje countdowns, review exam tags). */
export function useUpcomingExams() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['exams', userId, 'upcoming'],
    enabled: !!userId,
    queryFn: () => {
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      return data<Exam[]>('goals-exams-upcoming', { today: iso });
    },
  });
}

/** GOL-04.10: the AI coach output the planner used (headline, strategies, priorities, next steps). */
export interface PlanCoach {
  headline: string;
  watch_out: string | null;
  exams: { exam_id: string; title: string; strategy: string; risk: 'low' | 'medium' | 'high' }[];
  topics: { node_id: string; title: string; priority: number; approach: string; focus: string; why: string }[];
  next_steps: { when: 'today' | 'tomorrow' | 'this_week' | 'before_exam'; title: string; detail: string; node_id: string | null }[];
}

export function usePlanCoach() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['plan_coach', userId],
    enabled: !!userId,
    queryFn: async () => {
      const found = await data<{ output: PlanCoach; local_date: string } | null>('goals-plan-coach');
      return found ? { ...found.output, localDate: found.local_date } : null;
    },
  });
}

export function useExam(examId: string | undefined) {
  return useQuery({
    queryKey: ['exam', examId],
    enabled: !!examId,
    queryFn: () => data<Exam | null>('goals-exam-get', { exam_id: examId }),
  });
}

export async function createGoal(
  _userId: string,
  input: { name: string; start_date: string; end_date: string; term_index?: number | null; mode?: 'exam_week' | 'enem'; settings?: Record<string, unknown> },
) {
  const id = uuidv7();
  await data(
    'goals-create',
    {
      id,
      mode: input.mode ?? 'exam_week',
      name: input.name.trim(),
      start_date: input.start_date,
      end_date: input.end_date,
      term_index: input.term_index ?? null,
      school_year: new Date().getFullYear(),
      ...(input.settings ? { settings: input.settings } : {}),
    },
    { idempotencyKey: id },
  );
  return id;
}

export async function updateGoal(goalId: string, patch: Partial<Pick<Goal, 'name' | 'start_date' | 'end_date' | 'status' | 'term_index' | 'settings'>>) {
  await data('goals-update', { goal_id: goalId, ...patch });
}

export interface ExamInput {
  subject_id: string | null;
  title: string;
  local_date: string;
  starts_at: string | null;
  kind: Exam['kind'];
  weight: number | null;
  teacher_name?: string | null;
  parent_exam_id?: string | null;
}

export async function saveExam(_userId: string, goalId: string, input: ExamInput, examId?: string) {
  if (examId) {
    await data('goals-exam-update', { exam_id: examId, ...input });
    return examId;
  }
  const id = uuidv7();
  await data('goals-exam-create', { id, goal_id: goalId, ...input }, { idempotencyKey: id });
  return id;
}

export async function cancelExam(examId: string) {
  await data('goals-exam-cancel', { exam_id: examId });
}

export function useScope(examId: string | undefined) {
  return useQuery({
    queryKey: ['exam', examId, 'scope'],
    enabled: !!examId,
    queryFn: () => data<{ items: ScopeItem[]; nodes: ScopeNode[] }>('goals-scope', { exam_id: examId }),
  });
}

export type ScopeResolveRes = {
  items: { id: string; raw_text: string; status: 'matched' | 'partial' | 'unmatched'; nodes: { node_id: string; confidence: number }[]; placeholder_node_id?: string }[];
  scope_status: 'pending_review';
};

/** GOL-03: typed list, pasted text, or a photo/PDF already uploaded as a content_list document. */
export async function resolveScope(input: { exam_id: string; items?: string[]; text?: string; document_id?: string }) {
  return callFunction<typeof input, ScopeResolveRes>('scope-resolve', input, { idempotencyKey: uuidv7() });
}

export async function confirmScope(examId: string, nodeIds: string[], defaultAll = false) {
  await data('goals-scope-confirm', { exam_id: examId, node_ids: nodeIds, default_all: defaultAll });
}

export function usePlanRange(from: string, to: string) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['plan', userId, from, to],
    enabled: !!userId,
    queryFn: () => data<PlanItem[]>('goals-plan-range', { from, to }),
  });
}

export async function recomputePlan(trigger: string, goalId?: string) {
  return callFunction<{ trigger: string; goal_id?: string }, { plan_run_id: string; version: number; feasible: boolean; triage?: { dropped_node_ids: string[]; reason_key: string }; items_changed: number }>(
    'plan-recompute',
    { trigger, ...(goalId ? { goal_id: goalId } : {}) },
    { idempotencyKey: uuidv7() },
  );
}

export async function updatePlanItem(itemId: string, patch: Partial<Pick<PlanItem, 'status' | 'pinned' | 'local_date'>>) {
  await data('goals-plan-item-update', { item_id: itemId, ...patch });
}

export interface StudyPreferences {
  user_id: string;
  minutes_by_weekday: number[];
  window_start?: string;
  window_end?: string;
  quiet_start: string;
  quiet_end: string;
  vespera_time: string;
  day_rollover_hour: number;
}

export function useStudyPreferences() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['studyPreferences', userId],
    enabled: !!userId,
    queryFn: () => data<StudyPreferences | null>('goals-study-preferences'),
  });
}

export async function saveStudyPreferences(_userId: string, patch: Partial<Omit<StudyPreferences, 'user_id'>>) {
  await data('goals-study-preferences-save', patch);
}

export async function saveAvailabilityException(_userId: string, localDate: string, minutes: number) {
  await data('goals-availability-save', { local_date: localDate, minutes });
}

export function useAvailabilityExceptions() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['availability', userId],
    enabled: !!userId,
    queryFn: () => data<{ local_date: string; minutes: number; source: string }[]>('goals-availability'),
  });
}

export function useReadiness(examIds: string[]) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['readiness', userId, examIds.join(',')],
    enabled: !!userId && examIds.length > 0,
    queryFn: async () => {
      const list = await data<Readiness[]>('goals-readiness', { exam_ids: examIds });
      const latest = new Map<string, Readiness>();
      for (const r of list) if (!latest.has(r.exam_id)) latest.set(r.exam_id, r);
      return latest;
    },
  });
}

// ---------- GOL-06 grading ----------

export interface GradingRuleRow {
  id: string;
  owner_profile_id: string;
  subject_id: string | null;
  school_year: number;
  formula: unknown;
  preset_key: string | null;
}

export interface GradeComponentRow {
  id: string;
  user_id: string;
  subject_id: string;
  school_year: number;
  term_index: number;
  name: string;
  kind: 'exam' | 'assignment' | 'other';
  weight: number | null;
  max_points: number | null;
  grade: number | null;
  exam_id: string | null;
  position: number;
}

export function useGradingData(schoolYear: number) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['grading', userId, schoolYear],
    enabled: !!userId,
    queryFn: () => data<{ rules: GradingRuleRow[]; comps: GradeComponentRow[] }>('goals-grading', { school_year: schoolYear }),
  });
}

export async function saveGradingRule(_userId: string, schoolYear: number, formula: unknown, presetKey: string | null, subjectId: string | null, existingId?: string) {
  const payload = { school_year: schoolYear, formula, preset_key: presetKey, subject_id: subjectId };
  if (existingId) {
    await data('goals-grading-rule-save', { id: existingId, existing: true, ...payload });
  } else {
    const id = uuidv7();
    await data('goals-grading-rule-save', { id, existing: false, ...payload }, { idempotencyKey: id });
  }
}

/** Upserts a component by id (new ones get an id here); the server sets user_id from the session. */
export async function saveGradeComponent(row_: Partial<GradeComponentRow> & { user_id: string; subject_id: string; school_year: number; term_index: number; name: string }) {
  const { id, subject_id, school_year, term_index, name, kind, weight, max_points, grade, exam_id, position } = row_;
  await data('goals-grade-component-save', { id: id ?? uuidv7(), subject_id, school_year, term_index, name, kind, weight, max_points, grade, exam_id, position });
}

export async function logExamGrade(examId: string, grade: number, gradeMax: number) {
  return data<{ required: { exam_id: string; needed: number | null; status: 'secured' | 'needed' | 'impossible' }[] }>('goals-exam-grade', { exam_id: examId, grade, grade_max: gradeMax });
}

// ---------- GOL-12 Modo Desespero ----------

export interface DesperateMode {
  id: string;
  goal_id: string;
  status: 'active' | 'ended' | 'cancelled';
  exam_ids: string[];
  minutes_per_day: number;
  topic_groups: Record<string, 'focus' | 'basic' | 'out'>;
  diagnostic_attempt_id: string | null;
}

export function useDesperateMode(goalId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['desperate', userId, goalId],
    enabled: !!userId && !!goalId,
    queryFn: () => data<DesperateMode | null>('goals-desperate', { goal_id: goalId }),
  });
}

export async function startDesperate(goalId: string, examIds: string[], minutesPerDay: number) {
  return data<{ desperate_mode_id: string; diagnostic_quiz_id?: string | null }>('goals-desperate-start', { goal_id: goalId, exam_ids: examIds, minutes_per_day: minutesPerDay });
}

export async function setDesperateGroups(id: string, moves: { node_id: string; group: 'focus' | 'basic' | 'out' }[]) {
  return data<{ topic_groups: Record<string, 'focus' | 'basic' | 'out'>; coverage: { exam_id: string; pct: number }[] }>('goals-desperate-groups', { desperate_mode_id: id, moves });
}

export async function endDesperate(id: string) {
  return data<{ ok: boolean }>('goals-desperate-end', { desperate_mode_id: id });
}

/** The Modo Véspera sheet (GOL-07) as vespera.prepare stores it, on the exam's véspera plan item. */
export interface VesperaSheet {
  title: string;
  sections: Array<{ node_key: string; heading: string; bullets: Array<{ text: string }>; formula: string | null }>;
  watch_out: Array<{ text: string; from_mistake_id: string | null }>;
}

/**
 * The sheet for an exam, read from the student's own véspera plan item. While `waiting`, it is read again every few
 * seconds, so the sheet appears the moment the server writes it.
 */
export function useVesperaSheet(examId: string | undefined, waiting: boolean) {
  return useQuery({
    queryKey: ['vesperaSheet', examId],
    enabled: !!examId,
    queryFn: async (): Promise<VesperaSheet | null> => {
      const item = await data<{ reason_params: { cheatsheet?: VesperaSheet } | null } | null>('goals-vespera-sheet', { exam_id: examId });
      return item?.reason_params?.cheatsheet ?? null;
    },
    refetchInterval: (q) => (waiting && !q.state.data ? 3000 : false),
  });
}

export async function prepareVespera(examId: string) {
  return callFunction<{ exam_id: string }, { status: 'ready'; sheet_note_id: string } | { status: 'preparing'; job_id: string }>('vespera-prepare', { exam_id: examId }, { idempotencyKey: uuidv7() });
}

export function useInvalidateGoal() {
  const qc = useQueryClient();
  return (goalId?: string) => {
    void qc.invalidateQueries({ queryKey: ['goals'] });
    void qc.invalidateQueries({ queryKey: ['plan'] });
    void qc.invalidateQueries({ queryKey: ['exams'] });
    if (goalId) void qc.invalidateQueries({ queryKey: ['goal', goalId] });
  };
}
