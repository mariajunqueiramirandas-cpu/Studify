// Loads everything the planner, the nightly replan and the véspera need for one user, in one place.
// Reads only. Returns null when the profile is gone (deleted account).
import { forecastReviewLoad, type LearningParams, type QueueCard } from '@studify/shared';
import type { JobContext } from '../framework/types.ts';
import { IN_CHUNK, chunk, unwrap, unwrapRows, uniq } from './db.ts';
import { computeMasteries, loadLearningData, paramsFor, userSubjectIds, type LearningData, type NodeInfo, type NodeMastery } from './learning-state.ts';
import { materialKindOf, mapOrderOf, type DesperateRow, type ExamRow, type PlanItemRow, type PrefsRow, type ScopeRow } from './plan-data.ts';
import { DEFAULT_ROLLOVER_HOUR, addDays, safeTimeZone, studyDayFor } from './time.ts';

export interface PlanContext {
  userId: string;
  now: Date;
  timeZone: string;
  today: string;
  rollover: number;
  prefs: PrefsRow | null;
  retention: number | null;
  params: LearningParams;
  exams: ExamRow[];
  scope: ScopeRow[];
  nodes: NodeInfo[];
  excludedNodeIds: Set<string>;
  sourcesByNode: Map<string, Array<{ kind: 'slides' | 'notes' | 'textbook' | 'other'; pages: number }>>;
  learning: LearningData;
  masteries: Map<string, NodeMastery>;
  exceptions: Array<{ local_date: string; minutes: number }>;
  desperate: DesperateRow | null;
  previousRows: PlanItemRow[];
  latestRun: { id: string; version: number; input_hash: string } | null;
  reviewMinutesByDay: Record<string, number>;
  mapOrder: Map<string, number>;
}

interface ProfileRow {
  timezone: string | null;
  settings: Record<string, unknown> | null;
}

export async function loadPlanContext(ctx: JobContext, userId: string): Promise<PlanContext | null> {
  const profile = unwrap(
    await ctx.supabase.from('profiles').select('timezone,settings').eq('id', userId).is('deleted_at', null).maybeSingle(),
    'profiles',
  ) as ProfileRow | null;
  if (!profile) return null;

  const timeZone = safeTimeZone(profile.timezone);
  const prefs = unwrap(
    await ctx.supabase
      .from('study_preferences')
      .select('minutes_by_weekday,window_start,window_end,min_block_min,max_block_min,max_subjects_per_day,review_seconds_estimate,day_rollover_hour,quiet_start,quiet_end,vespera_time')
      .eq('user_id', userId)
      .maybeSingle(),
    'study_preferences',
  ) as PrefsRow | null;
  const rollover = prefs?.day_rollover_hour ?? DEFAULT_ROLLOVER_HOUR;
  const memory = (profile.settings?.memory ?? null) as { desired_retention?: number } | null;
  const retention = typeof memory?.desired_retention === 'number' ? memory.desired_retention : null;
  const now = ctx.now();
  const today = studyDayFor(now, timeZone, rollover);

  const goals = unwrapRows<{ id: string }>(
    await ctx.supabase.from('goals').select('id').eq('user_id', userId).eq('status', 'active').is('deleted_at', null),
    'goals',
  );
  const goalIds = new Set(goals.map((g) => g.id));
  const allExams = unwrapRows<ExamRow>(
    await ctx.supabase
      .from('exams')
      .select('id,goal_id,subject_id,title,local_date,starts_at,kind,status,weight')
      .eq('user_id', userId)
      .eq('status', 'scheduled')
      .is('deleted_at', null),
    'exams',
  );
  const exams = allExams.filter((e) => goalIds.has(e.goal_id));
  const examIds = exams.map((e) => e.id);

  let scope: ScopeRow[] = [];
  for (const part of chunk(examIds, IN_CHUNK)) {
    scope = scope.concat(
      unwrapRows<ScopeRow>(await ctx.supabase.from('exam_scope_nodes').select('exam_id,node_id,confirmed,source').in('exam_id', part), 'exam_scope_nodes'),
    );
  }

  const subjectIds = uniq([...exams.map((e) => e.subject_id).filter((s): s is string => s !== null), ...(await userSubjectIds(ctx, userId))]);
  const learning = await loadLearningData(ctx, userId, subjectIds);
  const nodes = [...learning.nodes.values()];

  const excludedRows = unwrapRows<{ node_id: string }>(
    await ctx.supabase.from('node_user_settings').select('node_id').eq('user_id', userId).eq('excluded', true),
    'node_user_settings',
  );
  const excludedNodeIds = new Set(excludedRows.map((r) => r.node_id));

  const topicIds = nodes.filter((n) => n.kind === 'topic').map((n) => n.id);
  const sourceRows: Array<{ node_id: string; document_id: string; page_start: number; page_end: number }> = [];
  for (const part of chunk(topicIds, IN_CHUNK)) {
    sourceRows.push(...unwrapRows(await ctx.supabase.from('node_sources').select('node_id,document_id,page_start,page_end').in('node_id', part), 'node_sources'));
  }
  const docIds = uniq(sourceRows.map((s) => s.document_id));
  const kindOf = new Map<string, string>();
  for (const part of chunk(docIds, IN_CHUNK)) {
    for (const d of unwrapRows<{ id: string; kind: string }>(await ctx.supabase.from('documents').select('id,kind').in('id', part), 'documents')) {
      kindOf.set(d.id, d.kind);
    }
  }
  const sourcesByNode = new Map<string, Array<{ kind: 'slides' | 'notes' | 'textbook' | 'other'; pages: number }>>();
  for (const s of sourceRows) {
    const list = sourcesByNode.get(s.node_id) ?? [];
    list.push({ kind: materialKindOf(kindOf.get(s.document_id) ?? 'other'), pages: s.page_end - s.page_start + 1 });
    sourcesByNode.set(s.node_id, list);
  }

  const masteries = computeMasteries(learning, now, paramsFor(retention, timeZone));
  const exceptions = unwrapRows<{ local_date: string; minutes: number }>(
    await ctx.supabase.from('availability_exceptions').select('local_date,minutes').eq('user_id', userId).gte('local_date', today).is('deleted_at', null),
    'availability_exceptions',
  );

  const params = paramsFor(retention, timeZone);
  const reviewMinutesByDay = reviewForecast(learning, exams, today, now, params, prefs, nodes);

  const desperate = unwrap(
    await ctx.supabase
      .from('desperate_modes')
      .select('exam_ids,minutes_per_day,topic_groups,user_moves')
      .eq('user_id', userId)
      .eq('status', 'active')
      .maybeSingle(),
    'desperate_modes',
  ) as DesperateRow | null;

  const latestRun = unwrap(
    await ctx.supabase.from('plan_runs').select('id,version,input_hash').eq('user_id', userId).order('version', { ascending: false }).limit(1).maybeSingle(),
    'plan_runs',
  ) as { id: string; version: number; input_hash: string } | null;
  const previousRows = latestRun
    ? unwrapRows<PlanItemRow>(
        await ctx.supabase.from('plan_items').select('*').eq('plan_run_id', latestRun.id).is('deleted_at', null),
        'plan_items',
      )
    : [];

  return {
    userId,
    now,
    timeZone,
    today,
    rollover,
    prefs,
    retention,
    params,
    exams,
    scope,
    nodes,
    excludedNodeIds,
    sourcesByNode,
    learning,
    masteries,
    exceptions,
    desperate,
    previousRows,
    latestRun,
    reviewMinutesByDay,
    mapOrder: mapOrderOf(nodes),
  };
}

function reviewForecast(
  learning: LearningData,
  exams: readonly ExamRow[],
  today: string,
  now: Date,
  params: LearningParams,
  prefs: PrefsRow | null,
  nodes: readonly NodeInfo[],
): Record<string, number> {
  const horizonEnd = exams.reduce((acc, e) => (e.local_date > acc ? e.local_date : acc), addDays(today, 30));
  const to = horizonEnd > addDays(today, 60) ? addDays(today, 60) : horizonEnd;
  const order = mapOrderOf(nodes);
  const cards: QueueCard[] = learning.cards.map((c) => ({
    cardId: c.cardId,
    subjectId: c.subjectId,
    conceptId: c.conceptId ?? c.nodeId ?? '',
    mapOrder: order.get(c.nodeId ?? '') ?? 0,
    state: c.state,
  }));
  const days = forecastReviewLoad(cards, [], today, to, now, params, {
    reviewSeconds: prefs?.review_seconds_estimate ?? params.reviewSecondsDefault,
  });
  return Object.fromEntries(days.map((d) => [d.date, d.estMinutes]));
}
