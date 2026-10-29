// Plano até o ENEM inside plan.recompute (spec 09 ENM-07, §8.7; spec 07 §8.9). Loads the active ENEM goal, the
// edition dates, the student's estimates and Meta SISU target, the ENEM topic priorities mapped to the student's
// own nodes, and splits each day's capacity between the school plan and the ENEM plan. Pure shaping lives here;
// the planner itself is @studify/shared buildEnemPlan.
import {
  DEFAULT_AVAILABILITY_MINUTES,
  ENEM_MIN_SHARE_DEFAULT,
  buildEnemPlan,
  currentEstimates,
  enemAreaShares,
  enemShareOfDay,
  enemTopicMastery,
  estLearnMinutes,
  sisuTargets,
  topicPriorities,
  type EnemArea,
  type EnemPlanItem,
  type EnemPlanTopic,
  type EnemRolloverUnit,
  type SisuScores,
} from '@studify/shared';
import type { OperationContext } from '../framework/types.ts';
import { IN_CHUNK, chunk, unwrap, unwrapRows, uniq } from './db.ts';
import type { PlanContext } from './plan-context.ts';
import type { PlanItemRow } from './plan-data.ts';
import { addDays } from './time.ts';

/** ENEM plans are rolling: 4 weeks ahead, extended by the nightly replan. */
export const ENEM_HORIZON_WEEKS = 4;
/** ENEM topics considered per area (highest priority first). */
const TOPICS_PER_AREA = 25;

export interface EnemGoalSettings {
  enem_edition?: number;
  enem_date_override?: string;
  enem_min_share?: number;
  reta_final_weeks?: number;
  language?: 'en' | 'es';
}

export interface EnemPlanContext {
  goalId: string;
  day1: string;
  day2: string;
  startTime: string | null;
  durations: { day1: number | null; day2: number | null };
  minShare: number;
  retaFinalWeeks: number;
  areaShares: Record<EnemArea, number>;
  topics: EnemPlanTopic[];
  subjectOfNode: Map<string, string>;
}

/** Base availability A(d): weekday preference, replaced by a date exception when there is one. */
export function availabilityOf(planCtx: Pick<PlanContext, 'prefs' | 'exceptions'>, day: string): number {
  const exception = planCtx.exceptions.find((e) => e.local_date === day);
  if (exception) return exception.minutes;
  const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  return (planCtx.prefs?.minutes_by_weekday ?? DEFAULT_AVAILABILITY_MINUTES)[weekday] ?? 0;
}

/**
 * Capacity split per day (07 §8.9): reviews come out first; ENEM gets the rest, or only `minShare` of it when a
 * school test is within 14 days. The school planner sees the remainder as that day's availability.
 */
export function splitCapacity(
  planCtx: Pick<PlanContext, 'prefs' | 'exceptions' | 'reviewMinutesByDay' | 'exams'>,
  days: readonly string[],
  minShare: number,
): { enem: Record<string, number>; school: Array<{ local_date: string; minutes: number }> } {
  const examDates = planCtx.exams.map((e) => e.local_date);
  const enem: Record<string, number> = {};
  const school: Array<{ local_date: string; minutes: number }> = [];
  for (const day of days) {
    const available = availabilityOf(planCtx, day);
    const reviews = Math.round(planCtx.reviewMinutesByDay[day] ?? 0);
    const units = Math.max(0, available - reviews);
    const share = examDates.length === 0 ? 1 : enemShareOfDay(day, examDates, minShare);
    const forEnem = Math.floor(units * share);
    enem[day] = forEnem;
    school.push({ local_date: day, minutes: Math.max(0, available - forEnem) });
  }
  return { enem, school };
}

/** Loads the ENEM side of a replan. Null when the user has no active ENEM goal (or no exam date yet). */
export async function loadEnemPlanContext(ctx: OperationContext, planCtx: PlanContext): Promise<EnemPlanContext | null> {
  const goal = unwrap(
    await ctx.db.from('goals').select('id,end_date,settings').eq('user_id', planCtx.userId).eq('mode', 'enem').eq('status', 'active').is('deleted_at', null).limit(1).maybeSingle(),
    'goals',
  ) as { id: string; end_date: string | null; settings: EnemGoalSettings | null } | null;
  if (!goal) return null;
  const settings = goal.settings ?? {};
  const editions = unwrapRows<{ year: number; day1_date: string | null; day2_date: string | null; start_time: string | null; day1_duration_min: number | null; day2_duration_min: number | null }>(
    await ctx.db.from('enem_editions').select('year,day1_date,day2_date,start_time,day1_duration_min,day2_duration_min'),
    'enem_editions',
  );
  const edition =
    editions.find((e) => e.year === settings.enem_edition) ?? editions.filter((e) => e.day1_date && e.day1_date >= planCtx.today).sort((a, b) => a.year - b.year)[0] ?? null;
  // Provisional date (ENM-01.2): the student's override, the edition, or the goal's end date (Day 2).
  const day2Fallback = goal.end_date ?? null;
  const day1 = settings.enem_date_override ?? edition?.day1_date ?? (day2Fallback ? addDays(day2Fallback, -7) : null);
  if (!day1 || day1 < planCtx.today) return null;
  const day2 = edition?.day2_date ?? addDays(day1, 7);

  // Estimates: latest simulados (area_results) and graded essays; Meta SISU target of priority 1.
  const attempts = unwrapRows<{ finished_at: string | null; area_results: { areas?: Partial<Record<EnemArea, { score: number }>> } | null }>(
    await ctx.db.from('quiz_attempts').select('finished_at,area_results').eq('user_id', planCtx.userId).eq('status', 'submitted').not('area_results', 'is', null).order('finished_at', { ascending: false }).limit(20),
    'quiz_attempts',
  );
  const simulados = attempts.flatMap((a) => Object.entries(a.area_results?.areas ?? {}).map(([area, r]) => ({ area: area as EnemArea, score: r!.score, at: a.finished_at ?? '' })));
  const essays = unwrapRows<{ total: number | null; updated_at: string }>(
    await ctx.db.from('essays').select('total,updated_at').eq('user_id', planCtx.userId).eq('kind', 'enem_redacao').eq('status', 'graded').is('deleted_at', null).order('updated_at', { ascending: false }).limit(3),
    'essays',
  );
  const estimates = currentEstimates(simulados, essays.filter((e) => e.total !== null).map((e) => ({ total: e.total!, at: e.updated_at })));
  const target = unwrap(
    await ctx.db.from('sisu_targets').select('targets,manual,offer_id,cutoff_used,margin').eq('goal_id', goal.id).eq('priority', 1).is('deleted_at', null).maybeSingle(),
    'sisu_targets',
  ) as { targets: { targets?: SisuScores | null } | null; manual: { weights?: SisuScores } | null; offer_id: string | null; cutoff_used: number; margin: number } | null;
  let weights: SisuScores | null = target?.manual?.weights ?? null;
  if (target?.offer_id && !weights) {
    const offer = unwrap(await ctx.db.from('sisu_offers').select('weights').eq('id', target.offer_id).maybeSingle(), 'sisu_offers') as { weights: SisuScores } | null;
    weights = offer?.weights ?? null;
  }
  let targets: Partial<Record<EnemArea, number>> | null = target?.targets?.targets ?? null;
  const full = estimates as Partial<SisuScores>;
  if (!targets && weights && target && (['LC', 'CH', 'CN', 'MT', 'RED'] as const).every((k) => full[k] !== undefined)) {
    targets = sisuTargets({ weights, estimates: full as SisuScores, cutoff: Number(target.cutoff_used), margin: Number(target.margin) }).targets;
  }
  const areaShares = enemAreaShares({ estimates, targets, weights });

  // ENEM topics: predicted shares × (1 − mastery) × area weight, mapped to the student's topic nodes.
  const trends = unwrapRows<{ enem_topic_id: string; predicted_share: number }>(await ctx.db.from('enem_topic_trends').select('enem_topic_id,predicted_share').gt('predicted_share', 0), 'enem_topic_trends');
  const topicRows = unwrapRows<{ id: string; area: EnemArea }>(await ctx.db.from('enem_topics').select('id,area'), 'enem_topics');
  const areaOf = new Map(topicRows.map((t) => [t.id, t.area] as const));
  const topicNodeIds = planCtx.nodes.filter((n) => n.kind === 'topic' && !planCtx.excludedNodeIds.has(n.id)).map((n) => n.id);
  const links: Array<{ node_id: string; enem_topic_id: string; confidence: number }> = [];
  for (const part of chunk(topicNodeIds, IN_CHUNK)) {
    links.push(...unwrapRows<{ node_id: string; enem_topic_id: string; confidence: number }>(await ctx.db.from('knowledge_node_enem_topics').select('node_id,enem_topic_id,confidence').in('node_id', part), 'knowledge_node_enem_topics'));
  }
  const nodeMastery = new Map(topicNodeIds.map((id) => [id, planCtx.masteries.get(id)?.mastery ?? null] as const));
  const mastery = enemTopicMastery(links, nodeMastery);
  const priorities = topicPriorities(
    trends.filter((t) => areaOf.has(t.enem_topic_id)).map((t) => ({ enem_topic_id: t.enem_topic_id, area: areaOf.get(t.enem_topic_id)!, predicted_share: Number(t.predicted_share) })),
    mastery,
    weights ? { LC: weights.LC, CH: weights.CH, CN: weights.CN, MT: weights.MT } : {},
  );
  const nodesOf = new Map<string, string[]>();
  for (const l of links) if (l.confidence >= 0.5) nodesOf.set(l.enem_topic_id, uniq([...(nodesOf.get(l.enem_topic_id) ?? []), l.node_id]));
  const topics: EnemPlanTopic[] = [];
  for (const area of ['LC', 'CH', 'CN', 'MT'] as const) {
    for (const p of priorities.filter((x) => x.area === area).slice(0, TOPICS_PER_AREA)) {
      const nodeIds = nodesOf.get(p.enem_topic_id) ?? [];
      topics.push({
        enemTopicId: p.enem_topic_id,
        area,
        priority: p.priority,
        mastery: p.mastery,
        nodeIds,
        studied: nodeIds.length > 0 && nodeIds.every((id) => planCtx.masteries.get(id)?.studied ?? false),
        learnMinutes: nodeIds.reduce((s, id) => s + estLearnMinutes(planCtx.sourcesByNode.get(id) ?? []), 0),
      });
    }
  }

  return {
    goalId: goal.id,
    day1,
    day2,
    startTime: edition?.start_time ? edition.start_time.slice(0, 5) : null,
    durations: { day1: edition?.day1_duration_min ?? null, day2: edition?.day2_duration_min ?? null },
    minShare: typeof settings.enem_min_share === 'number' ? Math.min(1, Math.max(0, settings.enem_min_share)) : ENEM_MIN_SHARE_DEFAULT,
    retaFinalWeeks: settings.reta_final_weeks ?? 4,
    areaShares,
    topics,
    subjectOfNode: new Map(planCtx.nodes.map((n) => [n.id, n.subjectId] as const)),
  };
}

/** Monday of the week that contains `day`. */
function mondayOf(day: string): string {
  return addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}

export interface EnemPlanOutcome {
  items: EnemPlanItem[];
  /** Day → ENEM minutes; the rest of the day goes to the school plan. */
  schoolExceptions: Array<{ local_date: string; minutes: number }>;
}

/** Runs the ENEM planner for the context: capacity split, done and rolled-over units from the last run. */
export function planEnem(planCtx: PlanContext, enem: EnemPlanContext): EnemPlanOutcome {
  const days: string[] = [];
  for (let d = planCtx.today; d <= enem.day2 && days.length < ENEM_HORIZON_WEEKS * 7 + 7; d = addDays(d, 1)) days.push(d);
  const split = splitCapacity(planCtx, days, enem.minShare);
  const mine = planCtx.previousRows.filter((r) => r.goal_id === enem.goalId);
  const keyOf = (r: PlanItemRow) => (typeof r.reason_params?.unitKey === 'string' ? r.reason_params.unitKey : null);
  const weekStart = mondayOf(planCtx.today);
  const doneThisWeek = mine.filter((r) => r.status === 'done' && r.local_date >= weekStart && r.local_date < planCtx.today);
  const minutesByArea: Partial<Record<EnemArea, number>> = {};
  for (const r of doneThisWeek) {
    const area = r.reason_params?.area as EnemArea | undefined;
    if ((r.unit_type === 'learn' || r.unit_type === 'practice') && area && ['LC', 'CH', 'CN', 'MT'].includes(area)) minutesByArea[area] = (minutesByArea[area] ?? 0) + r.minutes;
  }
  const rollover: EnemRolloverUnit[] = mine
    .filter((r) => r.status === 'planned' && r.local_date < planCtx.today && (r.unit_type === 'learn' || r.unit_type === 'practice') && keyOf(r))
    .map((r) => ({
      unitKey: keyOf(r)!,
      unitType: r.unit_type as 'learn' | 'practice',
      area: (r.reason_params?.area as EnemArea | undefined) ?? 'MT',
      enemTopicId: (r.reason_params?.enemTopicId as string | undefined) ?? null,
      nodeIds: r.node_ids,
      minutes: r.minutes,
      priority: Number(r.priority) || 0.01,
    }));
  const plan = buildEnemPlan({
    today: planCtx.today,
    day1: enem.day1,
    day2: enem.day2,
    capacity: split.enem,
    areaShares: enem.areaShares,
    topics: enem.topics,
    startTime: enem.startTime,
    day1DurationMin: enem.durations.day1,
    day2DurationMin: enem.durations.day2,
    retaFinalWeeks: enem.retaFinalWeeks,
    horizonWeeks: ENEM_HORIZON_WEEKS,
    doneThisWeek: {
      essays: doneThisWeek.filter((r) => r.reason_key === 'enem.plan.essay').length,
      mocks: new Set(doneThisWeek.filter((r) => r.unit_type === 'mock').map((r) => keyOf(r))).size,
      minutesByArea,
    },
    rollover,
    doneKeys: mine.filter((r) => r.status === 'done').map(keyOf).filter((k): k is string => !!k),
  });
  return { items: plan.items, schoolExceptions: split.school };
}

/** plan_items rows of the ENEM plan, ordered after the school units of the same day. */
export function enemItemRows(userId: string, planRunId: string, enem: EnemPlanContext, items: readonly EnemPlanItem[], schoolOrder: ReadonlyMap<string, number>): Array<Omit<PlanItemRow, 'id'>> {
  return items.map((item) => ({
    user_id: userId,
    goal_id: enem.goalId,
    plan_run_id: planRunId,
    local_date: item.day,
    subject_id: item.nodeIds[0] ? (enem.subjectOfNode.get(item.nodeIds[0]) ?? null) : null,
    exam_id: null,
    node_ids: item.nodeIds,
    unit_type: item.unitType,
    minutes: Math.min(240, Math.max(1, Math.round(item.minutes))),
    deadline: item.deadline,
    priority: item.priority,
    order_in_day: (schoolOrder.get(item.day) ?? -1) + 1 + item.orderInDay,
    demanding: item.unitType === 'mock' || item.unitType === 'essay' || item.unitType === 'learn',
    pinned: false,
    status: 'planned',
    reason_key: item.reason.key,
    reason_params: {
      ...item.reason.params,
      blockId: item.id,
      unitKey: item.unitKey,
      area: item.area,
      enemTopicId: item.enemTopicId,
      ...(item.mock ? { mock: item.mock } : {}),
      ...(item.startMin !== null ? { startMin: item.startMin } : {}),
    },
  }));
}

/**
 * ENM-01.4: ENEM-mapped subjects whose topics carry no skill code yet get one enem.tagNodes run (once a day at
 * most, singleton key), so the ENEM plan can link the student's material to the ENEM topics.
 */
export async function ensureEnemTags(ctx: OperationContext, planCtx: PlanContext): Promise<number> {
  const subjectIds = uniq(planCtx.nodes.filter((n) => n.kind === 'topic').map((n) => n.subjectId));
  if (subjectIds.length === 0) return 0;
  let queued = 0;
  for (const part of chunk(subjectIds, IN_CHUNK)) {
    const subjects = unwrapRows<{ id: string; enem_area: string | null; system_kind: string | null }>(await ctx.db.from('subjects').select('id,enem_area,system_kind').in('id', part), 'subjects');
    for (const s of subjects.filter((x) => x.enem_area && !x.system_kind)) {
      const nodes = unwrapRows<{ enem_skill_codes: string[] | null }>(await ctx.db.from('knowledge_nodes').select('enem_skill_codes').eq('subject_id', s.id).eq('kind', 'topic').is('deleted_at', null).limit(200), 'knowledge_nodes');
      if (nodes.length === 0 || nodes.some((n) => (n.enem_skill_codes ?? []).length > 0)) continue;
      await ctx.execute('enem.tag_nodes', { subject_id: s.id, user_id: planCtx.userId }, { singletonKey: `enem.tag_nodes:${s.id}:${planCtx.today}` });
      queued++;
    }
  }
  return queued;
}
