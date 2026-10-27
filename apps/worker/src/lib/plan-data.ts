// Planner inputs and outputs as plain data (GOL-04, learning-engine §11). Everything here is pure:
// the planning job loads rows, these functions shape them for buildPlan and shape the result back
// into plan_runs / plan_items rows.
import {
  DEFAULT_AVAILABILITY_MINUTES,
  DEFAULT_PLAN_SETTINGS,
  type DesperateOptions,
  type MaterialKind,
  type PlanExam,
  type PlanInput,
  type PlanItem,
  type PlanPreviousItem,
  type PlanRun,
  type PlanSettings,
  type PlanTopic,
  type ReplanTrigger,
} from '@studify/shared';
import { minutesOf } from './time.ts';
import type { NodeInfo, NodeMastery } from './learning-state.ts';

/** Trigger values stored in plan_runs.trigger (data-model §5.5) mapped to the planner's triggers. */
export function plannerTriggerOf(stored: string): ReplanTrigger {
  switch (stored) {
    case 'goal_created':
    case 'exam_changed':
    case 'desperate_on':
    case 'desperate_off':
      return 'exam_changed';
    case 'scope_changed':
      return 'scope_changed';
    case 'day_missed':
    case 'nightly':
      return 'nightly';
    case 'grade_logged':
      return 'grade_logged';
    case 'availability_changed':
      return 'availability_changed';
    case 'material_added':
    case 'material_ready':
      return 'material_ready';
    case 'mastery_shift':
      return 'mastery_shift';
    case 'user_rebalance':
    case 'manual_edit':
      return 'manual_edit';
    default:
      return 'nightly';
  }
}

/**
 * Planner trigger → plan_runs.trigger. `mastery_shift` and `manual_edit` have no value of their own
 * in the current CHECK list, so they are stored as user_rebalance; the exact planner trigger is kept
 * in triage.trigger (see planRunTriage).
 */
export function storedTriggerOf(trigger: ReplanTrigger): string {
  switch (trigger) {
    case 'nightly':
      return 'nightly';
    case 'exam_changed':
      return 'exam_changed';
    case 'scope_changed':
      return 'scope_changed';
    case 'grade_logged':
      return 'grade_logged';
    case 'availability_changed':
      return 'availability_changed';
    case 'material_ready':
      return 'material_added';
    case 'mastery_shift':
    case 'manual_edit':
      return 'user_rebalance';
  }
}

export interface ExamRow {
  id: string;
  goal_id: string;
  subject_id: string | null;
  title: string;
  local_date: string;
  starts_at: string | null;
  kind: string;
  status: string;
  weight: number | null;
}

export interface ScopeRow {
  exam_id: string;
  node_id: string;
  confirmed: boolean;
  source: 'ai' | 'user' | 'default_all';
}

export interface PrefsRow {
  minutes_by_weekday: number[];
  window_start: string;
  window_end: string;
  min_block_min: number;
  max_block_min: number;
  max_subjects_per_day: number;
  review_seconds_estimate: number;
  day_rollover_hour: number;
  quiet_start: string;
  quiet_end: string;
  vespera_time: string;
}

export interface PlanItemRow {
  id: string;
  user_id: string;
  goal_id: string | null;
  plan_run_id: string;
  local_date: string;
  subject_id: string | null;
  exam_id: string | null;
  node_ids: string[];
  unit_type: string;
  minutes: number;
  deadline: string | null;
  priority: number;
  order_in_day: number;
  demanding: boolean;
  pinned: boolean;
  status: string;
  reason_key: string | null;
  reason_params: Record<string, unknown> | null;
}

export interface DesperateRow {
  exam_ids: string[];
  minutes_per_day: number;
  topic_groups: Record<string, 'focus' | 'basic' | 'out'> | null;
  user_moves: Record<string, 'focus' | 'basic' | 'out'> | null;
}

export interface PlanBuildData {
  today: string;
  timeZone: string;
  prefs: PrefsRow | null;
  exams: ExamRow[];
  scope: ScopeRow[];
  nodes: NodeInfo[];
  excludedNodeIds: ReadonlySet<string>;
  sourcesByNode: ReadonlyMap<string, Array<{ kind: MaterialKind; pages: number }>>;
  masteries: ReadonlyMap<string, NodeMastery>;
  exceptions: Array<{ local_date: string; minutes: number }>;
  /** Review minutes per planned day from forecastReviewLoad (learning-engine §3.4). */
  reviewMinutesByDay: Record<string, number>;
  previousItems: PlanItemRow[];
  desperate: DesperateRow | null;
  mode: 'normal' | 'desperate';
  editedDay?: string;
  sessionStartedToday?: boolean;
}

export interface BuiltPlanInput {
  input: PlanInput;
  /** Topic id → subject id, for plan_items.subject_id. */
  subjectOfTopic: Map<string, string>;
  /** Exam id → goal id, for plan_items.goal_id. */
  goalOfExam: Map<string, string>;
}

const MATERIAL_KIND: Record<string, MaterialKind> = { slides: 'slides', notes: 'notes', textbook: 'textbook' };

export function materialKindOf(documentKind: string): MaterialKind {
  return MATERIAL_KIND[documentKind] ?? 'other';
}

/** Topic (or unit) ancestor of a node: a concept rolls up to its topic (GOL-03.8). */
export function topicOf(nodeId: string, nodes: ReadonlyMap<string, NodeInfo>): string | null {
  let current = nodes.get(nodeId);
  for (let guard = 0; current && guard < 8; guard++) {
    if (current.kind === 'topic') return current.id;
    if (current.kind === 'unit') return null;
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return null;
}

/** Knowledge-map order of topics: unit position, then topic position, then id (ties, learning-engine §11.5). */
export function mapOrderOf(nodes: readonly NodeInfo[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const topics = nodes.filter((n) => n.kind === 'topic');
  const unitPos = (t: NodeInfo): number => (t.parentId ? (byId.get(t.parentId)?.position ?? 0) : 0);
  const sorted = topics.slice().sort((a, b) => unitPos(a) - unitPos(b) || a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(sorted.map((t, i) => [t.id, i] as const));
}

function availabilityFrom(prefs: PrefsRow | null): number[] {
  return prefs && prefs.minutes_by_weekday.length === 7 ? prefs.minutes_by_weekday : [...DEFAULT_AVAILABILITY_MINUTES];
}

function settingsFrom(prefs: PrefsRow | null): Partial<PlanSettings> {
  if (!prefs) return {};
  return {
    maxBlockMin: prefs.max_block_min,
    minBlockMin: prefs.min_block_min,
    maxSubjectsPerDay: prefs.max_subjects_per_day,
    windowStartMin: minutesOf(prefs.window_start),
    windowEndMin: minutesOf(prefs.window_end),
  };
}

/** Builds the PlanInput for buildPlan from loaded rows. Scope: confirmed rows, else all topics (GOL-03.5). */
export function buildPlanInput(data: PlanBuildData): BuiltPlanInput {
  const topicNodes = data.nodes.filter((n) => n.kind === 'topic' && !data.excludedNodeIds.has(n.id));
  const nodeById = new Map(data.nodes.map((n) => [n.id, n] as const));
  const order = mapOrderOf(data.nodes);
  const subjectOfTopic = new Map<string, string>();
  for (const n of topicNodes) subjectOfTopic.set(n.id, n.subjectId);
  const goalOfExam = new Map<string, string>();
  for (const e of data.exams) goalOfExam.set(e.id, e.goal_id);

  const exams: PlanExam[] = data.exams
    .filter((e) => e.status === 'scheduled')
    .map((e) => {
      const confirmed = data.scope.filter((s) => s.exam_id === e.id && (s.confirmed || s.source === 'default_all'));
      let scopeTopicIds = uniqueSorted(
        confirmed.map((s) => topicOf(s.node_id, nodeById)).filter((t): t is string => t !== null && subjectOfTopic.has(t)),
      );
      if (scopeTopicIds.length === 0) {
        scopeTopicIds = topicNodes.filter((n) => n.subjectId === e.subject_id).map((n) => n.id).sort();
      }
      return {
        id: e.id,
        subjectId: e.subject_id ?? '',
        title: e.title,
        localDate: e.local_date,
        status: 'scheduled' as const,
        weight: e.weight && e.weight > 0 ? e.weight : 1,
        scopeTopicIds,
        topicWeights: null,
        requiredRatio: null,
      };
    });

  const planTopics: PlanTopic[] = topicNodes.map((n) => {
    const m = data.masteries.get(n.id);
    return {
      id: n.id,
      subjectId: n.subjectId,
      order: order.get(n.id) ?? 0,
      sources: data.sourcesByNode.get(n.id) ?? [],
      isPlaceholder: n.isPlaceholder,
      studied: m?.studied ?? false,
      mastery: m?.mastery ?? null,
    };
  });

  const availability = {
    minutesByWeekday: availabilityFrom(data.prefs),
    exceptions: Object.fromEntries(data.exceptions.map((e) => [e.local_date, e.minutes])),
  };

  const previous: PlanPreviousItem[] = data.previousItems.map(previousItemOf);
  const input: PlanInput = {
    today: data.today,
    timeZone: data.timeZone,
    exams,
    topics: planTopics,
    availability,
    reviewForecast: data.reviewMinutesByDay,
    previous,
    mode: data.mode,
    settings: settingsFrom(data.prefs),
  };
  if (data.editedDay) input.editedDay = data.editedDay;
  if (data.sessionStartedToday !== undefined) input.sessionStartedToday = data.sessionStartedToday;
  if (data.mode === 'desperate' && data.desperate) {
    const desperate: DesperateOptions = {
      minutesPerDay: Math.min(240, data.desperate.minutes_per_day),
      coveredExamIds: data.desperate.exam_ids,
    };
    if (data.desperate.topic_groups) desperate.groups = data.desperate.topic_groups;
    if (data.desperate.user_moves) desperate.userMoves = data.desperate.user_moves;
    input.desperate = desperate;
  }
  return { input, subjectOfTopic, goalOfExam };
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Reads a previous plan_items row back as a PlanPreviousItem (block id and unit key live in reason_params). */
export function previousItemOf(row: PlanItemRow): PlanPreviousItem {
  const params = row.reason_params ?? {};
  const examIds = Array.isArray(params.examIds) ? (params.examIds as string[]) : row.exam_id ? [row.exam_id] : [];
  const item: PlanPreviousItem = {
    id: typeof params.blockId === 'string' ? params.blockId : row.id,
    unitKey: typeof params.unitKey === 'string' ? params.unitKey : row.id,
    unitType: row.unit_type as PlanPreviousItem['unitType'],
    examIds,
    topicId: row.node_ids[0] ?? null,
    day: row.local_date,
    minutes: row.minutes,
    status: row.status === 'done' ? 'done' : row.status === 'skipped' ? 'skipped' : 'planned',
    pinned: row.pinned,
    priority: row.priority,
  };
  if (row.deadline) item.deadline = row.deadline;
  return item;
}

export interface PlanRunRecord {
  user_id: string;
  version: number;
  trigger: string;
  input_hash: string;
  feasible: boolean;
  triage: Record<string, unknown>;
  computed_by: 'server';
}

/** Summary notice data (GOL-04.5, spec 07 §8.2.6): "Reorganizei seu plano" only when ≥ 15 min changed day. */
export function planNotices(run: PlanRun): Array<{ key: string; params: Record<string, string | number> }> {
  const notices: Array<{ key: string; params: Record<string, string | number> }> = [];
  if (run.reorganized) {
    notices.push({ key: 'plan.replanned', params: { summary: `${run.movedMinutes} min de estudo mudaram de dia`, minutes: run.movedMinutes } });
  }
  if (run.triage.length > 0) {
    notices.push({ key: 'plan.tight', params: { items: run.triage.map((s) => s.unitKey).join(', ') } });
  }
  return notices;
}

export function planRunRecord(
  userId: string,
  version: number,
  trigger: ReplanTrigger,
  run: PlanRun,
): PlanRunRecord {
  return {
    user_id: userId,
    version,
    trigger: storedTriggerOf(trigger),
    input_hash: run.inputHash,
    feasible: run.feasible,
    triage: {
      trigger,
      steps: run.triage,
      tight: run.tight,
      outOfPlan: run.outOfPlan,
      skipped: run.skipped,
      reviewOverflow: run.reviewOverflow,
      excludedExams: run.excludedExams,
      movedMinutes: run.movedMinutes,
      reorganized: run.reorganized,
      notices: planNotices(run),
    },
    computed_by: 'server',
  };
}

/** Plan item rows for one run. The block id, unit key and layout travel in reason_params. */
export function planItemRows(
  userId: string,
  planRunId: string,
  run: PlanRun,
  built: Pick<BuiltPlanInput, 'subjectOfTopic' | 'goalOfExam'>,
): Array<Omit<PlanItemRow, 'id'>> {
  return run.items
    .filter((item) => item.minutes >= 1)
    .map((item: PlanItem) => {
      const examId = item.examIds[0] ?? null;
      return {
        user_id: userId,
        goal_id: examId ? (built.goalOfExam.get(examId) ?? null) : null,
        plan_run_id: planRunId,
        local_date: item.day,
        subject_id: item.topicId ? (built.subjectOfTopic.get(item.topicId) ?? null) : null,
        exam_id: examId,
        node_ids: item.topicId ? [item.topicId] : [],
        unit_type: item.unitType,
        minutes: Math.min(240, Math.max(1, Math.round(item.minutes))),
        deadline: item.deadline,
        priority: item.priority,
        order_in_day: item.orderInDay,
        demanding: item.demanding,
        pinned: item.pinned,
        status: item.status,
        reason_key: item.reason.key,
        reason_params: {
          ...item.reason.params,
          blockId: item.id,
          unitKey: item.unitKey,
          examIds: item.examIds,
          startMin: item.startMin,
          endMin: item.endMin,
        },
      };
    });
}

/**
 * Done items never move (learning-engine §11.7). Rows of the previous run that are done and whose
 * block is missing from the new run are copied into the new run unchanged.
 */
export function carryOverDone(previous: readonly PlanItemRow[], run: PlanRun, newRunId: string): Array<Omit<PlanItemRow, 'id'>> {
  const inRun = new Set(run.items.map((i) => i.id));
  return previous
    .filter((row) => row.status === 'done')
    .filter((row) => !inRun.has(typeof row.reason_params?.blockId === 'string' ? row.reason_params.blockId : row.id))
    .map((row) => {
      const { id: _id, ...rest } = row;
      void _id;
      return { ...rest, plan_run_id: newRunId };
    });
}

/** Planner settings from a study_preferences row, for logs and tests. */
export function settingsForRow(prefs: PrefsRow | null): PlanSettings {
  return { ...DEFAULT_PLAN_SETTINGS, ...settingsFrom(prefs) };
}
