import { useQuery, useQueryClient } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { row, rows, rpc } from '../common/query';

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
    queryFn: () => {
      let q = supabase.from('goals').select('*').eq('user_id', userId!).is('deleted_at', null).order('start_date', { ascending: false });
      if (status === 'active') q = q.eq('status', 'active');
      return rows<Goal>(q);
    },
  });
}

export function useGoal(goalId: string | undefined) {
  return useQuery({
    queryKey: ['goal', goalId],
    enabled: !!goalId,
    queryFn: () => row<Goal>(supabase.from('goals').select('*').eq('id', goalId!).maybeSingle()),
  });
}

export function useGoalExams(goalId: string | undefined) {
  return useQuery({
    queryKey: ['goal', goalId, 'exams'],
    enabled: !!goalId,
    queryFn: () => rows<Exam>(supabase.from('exams').select('*').eq('goal_id', goalId!).is('deleted_at', null).neq('status', 'cancelled').order('local_date')),
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
      return rows<Exam>(supabase.from('exams').select('*').eq('user_id', userId!).eq('status', 'scheduled').gte('local_date', iso).is('deleted_at', null).order('local_date'));
    },
  });
}

export function useExam(examId: string | undefined) {
  return useQuery({
    queryKey: ['exam', examId],
    enabled: !!examId,
    queryFn: () => row<Exam>(supabase.from('exams').select('*').eq('id', examId!).maybeSingle()),
  });
}

export async function createGoal(
  userId: string,
  input: { name: string; start_date: string; end_date: string; term_index?: number | null; mode?: 'exam_week' | 'enem'; settings?: Record<string, unknown> },
) {
  const id = uuidv7();
  const { error } = await supabase.from('goals').insert({
    id,
    user_id: userId,
    mode: input.mode ?? 'exam_week',
    name: input.name.trim(),
    start_date: input.start_date,
    end_date: input.end_date,
    term_index: input.term_index ?? null,
    school_year: new Date().getFullYear(),
    ...(input.settings ? { settings: input.settings } : {}),
  });
  if (error) throw error;
  return id;
}

export async function updateGoal(goalId: string, patch: Partial<Pick<Goal, 'name' | 'start_date' | 'end_date' | 'status' | 'term_index' | 'settings'>>) {
  const { error } = await supabase.from('goals').update(patch).eq('id', goalId);
  if (error) throw error;
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

export async function saveExam(userId: string, goalId: string, input: ExamInput, examId?: string) {
  const id = examId ?? uuidv7();
  const payload = { ...input, goal_id: goalId, user_id: userId };
  const { error } = examId ? await supabase.from('exams').update(input).eq('id', examId) : await supabase.from('exams').insert({ id, ...payload });
  if (error) throw error;
  return id;
}

export async function cancelExam(examId: string) {
  const { error } = await supabase.from('exams').update({ status: 'cancelled' }).eq('id', examId);
  if (error) throw error;
}

export function useScope(examId: string | undefined) {
  return useQuery({
    queryKey: ['exam', examId, 'scope'],
    enabled: !!examId,
    queryFn: async () => {
      const [items, nodes] = await Promise.all([
        rows<ScopeItem>(supabase.from('exam_scope_items').select('*').eq('exam_id', examId!).is('deleted_at', null).order('position')),
        rows<ScopeNode>(supabase.from('exam_scope_nodes').select('*').eq('exam_id', examId!)),
      ]);
      return { items, nodes };
    },
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
  return rpc<void>('confirm_exam_scope', { exam_id: examId, node_ids: nodeIds, default_all: defaultAll });
}

export function usePlanRange(from: string, to: string) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['plan', userId, from, to],
    enabled: !!userId,
    queryFn: () =>
      rows<PlanItem>(supabase.from('plan_items').select('*').eq('user_id', userId!).gte('local_date', from).lte('local_date', to).is('deleted_at', null).order('local_date').order('order_in_day')),
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
  const { error } = await supabase.from('plan_items').update(patch).eq('id', itemId);
  if (error) throw error;
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
    queryFn: () => row<StudyPreferences>(supabase.from('study_preferences').select('*').eq('user_id', userId!).maybeSingle()),
  });
}

export async function saveStudyPreferences(userId: string, patch: Partial<Omit<StudyPreferences, 'user_id'>>) {
  const { error } = await supabase.from('study_preferences').upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' });
  if (error) throw error;
}

export async function saveAvailabilityException(userId: string, localDate: string, minutes: number) {
  const { error } = await supabase.from('availability_exceptions').upsert({ user_id: userId, local_date: localDate, minutes, source: 'user' }, { onConflict: 'user_id,local_date' });
  if (error) throw error;
}

export function useAvailabilityExceptions() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['availability', userId],
    enabled: !!userId,
    queryFn: () => rows<{ local_date: string; minutes: number; source: string }>(supabase.from('availability_exceptions').select('local_date,minutes,source').eq('user_id', userId!).order('local_date')),
  });
}

export function useReadiness(examIds: string[]) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['readiness', userId, examIds.join(',')],
    enabled: !!userId && examIds.length > 0,
    queryFn: async () => {
      const list = await rows<Readiness>(supabase.from('readiness_snapshots').select('*').eq('user_id', userId!).in('exam_id', examIds).order('local_date', { ascending: false }));
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
    queryFn: async () => {
      const [rules, comps] = await Promise.all([
        rows<GradingRuleRow>(supabase.from('grading_rules').select('*').eq('owner_profile_id', userId!).eq('school_year', schoolYear).is('deleted_at', null)),
        rows<GradeComponentRow>(supabase.from('grade_components').select('*').eq('user_id', userId!).eq('school_year', schoolYear).is('deleted_at', null).order('position')),
      ]);
      return { rules, comps };
    },
  });
}

export async function saveGradingRule(userId: string, schoolYear: number, formula: unknown, presetKey: string | null, subjectId: string | null, existingId?: string) {
  const payload = { owner_profile_id: userId, school_year: schoolYear, formula, preset_key: presetKey, subject_id: subjectId };
  const { error } = existingId ? await supabase.from('grading_rules').update(payload).eq('id', existingId) : await supabase.from('grading_rules').insert({ id: uuidv7(), ...payload });
  if (error) throw error;
}

export async function saveGradeComponent(row_: Partial<GradeComponentRow> & { user_id: string; subject_id: string; school_year: number; term_index: number; name: string }) {
  const { error } = await supabase.from('grade_components').upsert({ id: row_.id ?? uuidv7(), kind: 'exam', position: 0, ...row_ });
  if (error) throw error;
}

export async function logExamGrade(examId: string, grade: number, gradeMax: number) {
  return rpc<{ required: { exam_id: string; needed: number | null; status: 'secured' | 'needed' | 'impossible' }[] }>('log_exam_grade', { exam_id: examId, grade, grade_max: gradeMax });
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
    queryFn: () => row<DesperateMode>(supabase.from('desperate_modes').select('*').eq('user_id', userId!).eq('goal_id', goalId!).eq('status', 'active').maybeSingle()),
  });
}

export async function startDesperate(goalId: string, examIds: string[], minutesPerDay: number) {
  return rpc<{ desperate_mode_id: string; diagnostic_quiz_id?: string | null }>('start_desperate_mode', { goal_id: goalId, exam_ids: examIds, minutes_per_day: minutesPerDay });
}

export async function setDesperateGroups(id: string, moves: { node_id: string; group: 'focus' | 'basic' | 'out' }[]) {
  return rpc<{ topic_groups: Record<string, 'focus' | 'basic' | 'out'>; coverage: { exam_id: string; pct: number }[] }>('set_desperate_groups', { desperate_mode_id: id, moves });
}

export async function endDesperate(id: string) {
  return rpc<{ ok: boolean }>('end_desperate_mode', { desperate_mode_id: id });
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
