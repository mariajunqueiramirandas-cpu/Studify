// AI plan coach (GOL-04.10). The model decides what matters (topic priorities, focus, why) and writes the
// strategy and next steps until the tests; buildPlan still owns the time math (minutes per day, deadlines,
// feasibility). One call per student when their situation changes, at most COACH_CALLS_PER_DAY a day.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { estLearnMinutes, type ReplanTrigger } from '@studify/shared';
import { getTask, PlanCoach, type PlanCoachInput } from '@studify/prompts';
import { BudgetExceededError } from '@studify/ai';
import type { OperationContext } from '../framework/types.ts';
import { runPrompt } from './ai-adapter.ts';
import { chunk, unwrap, unwrapRows, uniq } from './db.ts';
import type { NodeInfo } from './learning-state.ts';
import type { PlanContext } from './plan-context.ts';
import { availabilityFrom, topicOf } from './plan-data.ts';
import { addDays } from './time.ts';

type CoachOut = z.infer<typeof PlanCoach>;

/** Most topics sent to the model: the ones with the most at stake (exam weight × gap). */
export const COACH_MAX_TOPICS = 40;
/** Tests further away than this are left to the next runs. */
export const COACH_HORIZON_DAYS = 45;
/** AI calls per student and study day. Further changes reuse the last output until tomorrow. */
export const COACH_CALLS_PER_DAY = 3;
/** Triggers that justify a second call on the same day (the situation really changed). */
const URGENT_TRIGGERS: ReadonlySet<ReplanTrigger> = new Set(['exam_changed', 'scope_changed', 'material_ready', 'grade_logged', 'mastery_shift']);
/** Weight multiplier range applied to the planner's topic weights: the coach can boost and demote, never erase. */
const MIN_FACTOR = 0.3;
const MAX_FACTOR = 1.7;

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** What the planner and plan items use from the coach, by stored ids. */
export interface CoachGuidance {
  /** topic id → priority 0–1. */
  priorities: Map<string, number>;
  /** topic id → texts shown on that topic's plan items. */
  reasons: Map<string, { why: string; focus: string; approach: CoachOut['topics'][number]['approach'] }>;
  /** True when this run produced a new output (plan items must be rewritten to carry the new texts). */
  fresh: boolean;
}

/** The stored and displayed coach output, with ids instead of the prompt keys. */
export interface StoredCoach {
  headline: string;
  watch_out: string | null;
  exams: Array<{ exam_id: string; title: string; strategy: string; risk: 'low' | 'medium' | 'high' }>;
  topics: Array<{ node_id: string; title: string; priority: number; approach: string; focus: string; why: string }>;
  next_steps: Array<{ when: string; title: string; detail: string; node_id: string | null }>;
}

export interface CoachExtras {
  subjectNames: Map<string, string>;
  /** topic id → open mistakes by cause. */
  mistakes: Map<string, Record<string, number>>;
  /** topic ids with ≥ 2 sure-but-wrong answers in the last 30 days. */
  overconfident: Set<string>;
  /** topic id → teacher points share 0–1. */
  teacherShare: Map<string, number>;
  /** Active study minutes in the last 7 days. */
  studiedMinutes7: number;
}

export interface ReadinessLike {
  examId: string;
  row: { readiness: number; pred_low: number | null; pred_mid: number | null; pred_high: number | null };
}

export interface BuiltCoachInput {
  input: PlanCoachInput;
  topicByKey: Map<string, string>;
  examByKey: Map<string, string>;
  hash: string;
}

const round = (x: number, step: number) => Math.round(x / step) * step;

function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

/**
 * The model input for one student, or null without an upcoming test. Topic and exam ids become short keys
 * (T1…, E1…). The hash covers the signals rounded to steps that matter, so small drifts reuse the last output.
 */
export function buildCoachInput(
  planCtx: PlanContext,
  scopeByExam: ReadonlyMap<string, string[]>,
  readiness: readonly ReadinessLike[],
  extras: CoachExtras,
  previousHeadline: string | null,
): BuiltCoachInput | null {
  const horizon = addDays(planCtx.today, COACH_HORIZON_DAYS);
  const exams = planCtx.exams
    .filter((e) => e.status === 'scheduled' && e.local_date >= planCtx.today && e.local_date <= horizon)
    .sort((a, b) => (a.local_date < b.local_date ? -1 : a.local_date > b.local_date ? 1 : a.id < b.id ? -1 : 1));
  if (exams.length === 0) return null;

  const nodeById = new Map<string, NodeInfo>(planCtx.nodes.map((n) => [n.id, n] as const));
  const readinessByExam = new Map(readiness.map((r) => [r.examId, r.row] as const));
  const examKey = new Map(exams.map((e, i) => [e.id, `E${i + 1}`] as const));

  // Topic stakes: Σ over its tests of (test weight × topic share of the test) × (1 − mastery).
  const stakes = new Map<string, number>();
  const examsOfTopic = new Map<string, string[]>();
  for (const e of exams) {
    const scope = scopeByExam.get(e.id) ?? [];
    const minutes = scope.map((id) => estLearnMinutes(planCtx.sourcesByNode.get(id) ?? []));
    const total = minutes.reduce((a, b) => a + b, 0);
    scope.forEach((id, i) => {
      const share = total > 0 ? (minutes[i] ?? 0) / total : 1 / scope.length;
      const gap = 1 - (planCtx.masteries.get(id)?.mastery ?? 0);
      stakes.set(id, (stakes.get(id) ?? 0) + (e.weight && e.weight > 0 ? e.weight : 1) * share * gap);
      examsOfTopic.set(id, [...(examsOfTopic.get(id) ?? []), examKey.get(e.id)!]);
    });
  }
  const topicIds = [...stakes.keys()]
    .filter((id) => nodeById.get(id)?.kind === 'topic' && !nodeById.get(id)?.isPlaceholder)
    .sort((a, b) => (stakes.get(b) ?? 0) - (stakes.get(a) ?? 0) || (planCtx.mapOrder.get(a) ?? 0) - (planCtx.mapOrder.get(b) ?? 0))
    .slice(0, COACH_MAX_TOPICS)
    .sort((a, b) => (planCtx.mapOrder.get(a) ?? 0) - (planCtx.mapOrder.get(b) ?? 0));
  if (topicIds.length === 0) return null;
  const topicKey = new Map(topicIds.map((id, i) => [id, `T${i + 1}`] as const));

  const lastStudied = new Map<string, number>();
  for (const ev of planCtx.learning.evidence) {
    const t = topicOf(ev.nodeId, nodeById);
    if (t && topicKey.has(t)) lastStudied.set(t, Math.max(lastStudied.get(t) ?? 0, ev.occurredAt.getTime()));
  }

  const weekly = availabilityFrom(planCtx.prefs);
  const exceptions = new Map(planCtx.exceptions.map((x) => [x.local_date, x.minutes] as const));
  const availableOn = (day: string) => exceptions.get(day) ?? weekly[(weekdayOf(day) + 6) % 7] ?? 0;
  const next7 = Array.from({ length: 7 }, (_, i) => addDays(planCtx.today, i));
  const last7 = Array.from({ length: 7 }, (_, i) => addDays(planCtx.today, -(i + 1)));
  const skippedItems = planCtx.previousRows.filter((r) => r.status === 'skipped' && r.local_date < planCtx.today && r.local_date >= last7[6]!).length;

  const input: PlanCoachInput = {
    today: planCtx.today,
    weekday: WEEKDAYS[weekdayOf(planCtx.today)]!,
    minutesNext7: next7.map(availableOn),
    adherence: { availableMinutes: last7.reduce((acc, d) => acc + availableOn(d), 0), studiedMinutes: Math.round(extras.studiedMinutes7), skippedItems },
    reviewMinutesNext7: next7.map((d) => Math.round(planCtx.reviewMinutesByDay[d] ?? 0)),
    exams: exams.map((e) => {
      const r = readinessByExam.get(e.id);
      return {
        key: examKey.get(e.id)!,
        title: e.title,
        subject: extras.subjectNames.get(e.subject_id ?? '') ?? '',
        date: e.local_date,
        daysLeft: daysBetween(planCtx.today, e.local_date),
        kind: e.kind,
        weight: e.weight && e.weight > 0 ? e.weight : 1,
        readiness: round(r?.readiness ?? 0, 0.01),
        predicted: r && r.pred_mid !== null && r.pred_low !== null && r.pred_high !== null ? { low: round(r.pred_low, 0.1), mid: round(r.pred_mid, 0.1), high: round(r.pred_high, 0.1) } : null,
      };
    }),
    topics: topicIds.map((id) => {
      const m = planCtx.masteries.get(id);
      const last = lastStudied.get(id);
      return {
        key: topicKey.get(id)!,
        title: nodeById.get(id)?.title ?? '',
        examKeys: examsOfTopic.get(id) ?? [],
        mastery: m?.mastery === null || m?.mastery === undefined ? null : round(m.mastery, 0.01),
        studied: m?.studied ?? false,
        accuracy: m && m.questionCount > 0 ? round(m.accuracy, 0.01) : null,
        answeredQuestions: m?.questionCount ?? 0,
        // This student's minutes: the topic's estimate times their measured pace in the subject.
        learnMinutes: Math.round(estLearnMinutes(planCtx.sourcesByNode.get(id) ?? []) * (planCtx.pace.bySubject.get(nodeById.get(id)?.subjectId ?? '') ?? planCtx.pace.overall)),
        mistakes: extras.mistakes.get(id) ?? {},
        overconfident: extras.overconfident.has(id),
        teacherShare: extras.teacherShare.has(id) ? round(extras.teacherShare.get(id)!, 0.01) : null,
        daysSinceStudied: last ? Math.max(0, Math.floor((planCtx.now.getTime() - last) / 86_400_000)) : null,
      };
    }),
    previousHeadline,
  };

  // Hash: coarse steps, so a coach call follows a real change (a grade band, a new mistake, a day closer).
  const signature = {
    today: input.today,
    minutes: input.minutesNext7.map((x) => round(x, 15)),
    studied: round(input.adherence.studiedMinutes, 30),
    skipped: input.adherence.skippedItems,
    exams: input.exams.map((e) => [e.key, e.date, e.weight, round(e.readiness, 0.1)]),
    topics: input.topics.map((t) => [t.key, t.title, t.examKeys, t.mastery === null ? null : round(t.mastery, 0.1), t.studied, t.answeredQuestions >= 5, t.mistakes, t.overconfident, t.teacherShare === null ? null : round(t.teacherShare, 0.1)]),
  };
  const hash = createHash('sha256').update(JSON.stringify(signature)).digest('hex').slice(0, 32);
  return {
    input,
    topicByKey: new Map([...topicKey].map(([id, key]) => [key, id] as const)),
    examByKey: new Map([...examKey].map(([id, key]) => [key, id] as const)),
    hash,
  };
}

/** Maps the model output back to ids. Unknown keys are dropped; topics the model skipped get no guidance. */
export function resolveCoach(out: CoachOut, built: BuiltCoachInput): StoredCoach {
  const titleOf = new Map(built.input.topics.map((t) => [t.key, t.title] as const));
  const examTitle = new Map(built.input.exams.map((e) => [e.key, e.title] as const));
  const seen = new Set<string>();
  return {
    headline: out.headline,
    watch_out: out.watch_out,
    exams: out.exams
      .filter((e) => built.examByKey.has(e.exam_key))
      .map((e) => ({ exam_id: built.examByKey.get(e.exam_key)!, title: examTitle.get(e.exam_key) ?? '', strategy: e.strategy, risk: e.risk })),
    topics: out.topics
      .filter((t) => built.topicByKey.has(t.topic_key) && !seen.has(t.topic_key) && (seen.add(t.topic_key), true))
      .map((t) => ({ node_id: built.topicByKey.get(t.topic_key)!, title: titleOf.get(t.topic_key) ?? '', priority: t.priority, approach: t.approach, focus: t.focus, why: t.why })),
    next_steps: out.next_steps.map((s) => ({
      when: s.when,
      title: s.title,
      detail: s.detail,
      node_id: s.topic_key && built.topicByKey.has(s.topic_key) ? built.topicByKey.get(s.topic_key)! : null,
    })),
  };
}

export function guidanceOf(stored: StoredCoach, fresh: boolean): CoachGuidance {
  const priorities = new Map<string, number>();
  const reasons: CoachGuidance['reasons'] = new Map();
  for (const t of stored.topics) {
    priorities.set(t.node_id, Math.min(1, Math.max(0, t.priority)));
    reasons.set(t.node_id, { why: t.why, focus: t.focus, approach: t.approach as CoachOut['topics'][number]['approach'] });
  }
  return { priorities, reasons, fresh };
}

/**
 * Topic weights ω for one test from the coach priorities: the planner's default (∝ learn minutes) times a factor
 * in [MIN_FACTOR, MAX_FACTOR]. Topics without a priority keep factor 1. Null when the coach has nothing for the test.
 */
export function coachTopicWeights(scope: readonly string[], learnMinutes: (id: string) => number, guidance: CoachGuidance | null): Record<string, number> | null {
  if (!guidance || !scope.some((id) => guidance.priorities.has(id))) return null;
  const out: Record<string, number> = {};
  for (const id of scope) {
    const p = guidance.priorities.get(id);
    const factor = p === undefined ? 1 : MIN_FACTOR + (MAX_FACTOR - MIN_FACTOR) * p;
    out[id] = Math.max(1, learnMinutes(id)) * factor;
  }
  return out;
}

interface CoachRow {
  signals_hash: string;
  local_date: string;
  output: StoredCoach;
  calls_date: string;
  calls_today: number;
}

/** The signals the plan context does not carry: subject names, open mistakes, overconfidence, teacher shares, minutes studied. */
export async function loadCoachExtras(ctx: OperationContext, planCtx: PlanContext): Promise<CoachExtras> {
  const nodeById = new Map<string, NodeInfo>(planCtx.nodes.map((n) => [n.id, n] as const));
  const subjectIds = uniq(planCtx.exams.map((e) => e.subject_id).filter((s): s is string => !!s));
  const subjects = subjectIds.length
    ? unwrapRows<{ id: string; name: string }>(await ctx.supabase.from('subjects').select('id,name').in('id', subjectIds), 'subjects')
    : [];

  const mistakes = new Map<string, Record<string, number>>();
  for (const row of unwrapRows<{ node_id: string; cause: string }>(
    await ctx.supabase.from('mistakes').select('node_id,cause').eq('user_id', planCtx.userId).is('resolved_at', null).is('deleted_at', null).limit(500),
    'mistakes',
  )) {
    const t = topicOf(row.node_id, nodeById);
    if (!t) continue;
    const by = mistakes.get(t) ?? {};
    by[row.cause] = (by[row.cause] ?? 0) + 1;
    mistakes.set(t, by);
  }

  const since30 = new Date(planCtx.now.getTime() - 30 * 86_400_000).toISOString();
  const sureWrong = unwrapRows<{ question_id: string }>(
    await ctx.supabase.from('attempt_answers').select('question_id').eq('user_id', planCtx.userId).eq('confidence', 4).eq('correct', false).gte('answered_at', since30).limit(300),
    'attempt_answers',
  );
  const perTopic = new Map<string, number>();
  for (const part of chunk(uniq(sureWrong.map((a) => a.question_id)), 100)) {
    const nodes = unwrapRows<{ id: string; node_id: string }>(await ctx.supabase.from('questions').select('id,node_id').in('id', part), 'questions');
    const nodeOf = new Map(nodes.map((q) => [q.id, q.node_id] as const));
    for (const a of sureWrong) {
      const node = nodeOf.get(a.question_id);
      const t = node ? topicOf(node, nodeById) : null;
      if (t) perTopic.set(t, (perTopic.get(t) ?? 0) + 1);
    }
  }
  const overconfident = new Set([...perTopic].filter(([, n]) => n >= 2).map(([t]) => t));

  const teacherShare = new Map<string, number>();
  if (subjectIds.length) {
    const profiles = unwrapRows<{ subject_id: string; n_tests: number; profile: { statistics?: { pointsShare?: Record<string, number> } } }>(
      await ctx.supabase.from('teacher_profiles').select('subject_id,n_tests,profile').in('subject_id', subjectIds),
      'teacher_profiles',
    );
    const best = new Map<string, (typeof profiles)[number]>();
    for (const p of profiles) if (!best.has(p.subject_id) || (best.get(p.subject_id)!.n_tests < p.n_tests)) best.set(p.subject_id, p);
    for (const p of best.values()) {
      for (const [node, share] of Object.entries(p.profile?.statistics?.pointsShare ?? {})) {
        const t = topicOf(node, nodeById) ?? node;
        if (typeof share === 'number') teacherShare.set(t, (teacherShare.get(t) ?? 0) + share);
      }
    }
  }

  const since7 = new Date(planCtx.now.getTime() - 7 * 86_400_000).toISOString();
  const sessions = unwrapRows<{ active_minutes: number | null }>(
    await ctx.supabase.from('study_sessions').select('active_minutes').eq('user_id', planCtx.userId).gte('started_at', since7),
    'study_sessions',
  );
  return {
    subjectNames: new Map(subjects.map((s) => [s.id, s.name] as const)),
    mistakes,
    overconfident,
    teacherShare,
    studiedMinutes7: sessions.reduce((acc, s) => acc + (s.active_minutes ?? 0), 0),
  };
}

/**
 * The coach guidance for this replan: the stored output when the signals did not change (or today's call cap is
 * spent), else a new call. Any failure falls back to the stored output, then to none: the plan never waits on AI.
 */
export async function coachFor(
  ctx: OperationContext,
  planCtx: PlanContext,
  trigger: ReplanTrigger,
  scopeByExam: ReadonlyMap<string, string[]>,
  readiness: readonly ReadinessLike[],
): Promise<{ guidance: CoachGuidance | null; stored: StoredCoach | null }> {
  const row = unwrap(
    await ctx.supabase.from('plan_coach').select('signals_hash,local_date,output,calls_date,calls_today').eq('user_id', planCtx.userId).maybeSingle(),
    'plan_coach',
  ) as CoachRow | null;
  const reuse = row ? { guidance: guidanceOf(row.output, false), stored: row.output } : { guidance: null, stored: null };

  const extras = await loadCoachExtras(ctx, planCtx);
  const built = buildCoachInput(planCtx, scopeByExam, readiness, extras, row?.output.headline ?? null);
  if (!built) return { guidance: null, stored: null };
  if (row && row.signals_hash === built.hash) return reuse;
  const callsToday = row && row.calls_date === planCtx.today ? row.calls_today : 0;
  if (row && row.local_date === planCtx.today && !URGENT_TRIGGERS.has(trigger)) return reuse;
  if (callsToday >= COACH_CALLS_PER_DAY) return reuse;

  let outcome;
  try {
    outcome = await runPrompt(ctx.ai, {
      task: getTask('plan.coach'),
      schema: PlanCoach as unknown as z.ZodType<CoachOut>,
      input: built.input,
      scope: { userId: planCtx.userId, feature: 'GOL-04.10' },
      choices: { topic: [...built.topicByKey.keys()], exam: [...built.examByKey.keys()] },
    });
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) ctx.log.warn({ err: err instanceof Error ? err.name : 'unknown' }, 'plan.coach: call failed');
    return reuse;
  }
  if (outcome.result.status !== 'ok') {
    ctx.log.warn({ status: outcome.result.status }, 'plan.coach: no output');
    return reuse;
  }
  const stored = resolveCoach(outcome.result.data, built);
  unwrap(
    await ctx.supabase.from('plan_coach').upsert(
      {
        user_id: planCtx.userId,
        local_date: planCtx.today,
        signals_hash: built.hash,
        output: stored,
        prompt_version: getTask('plan.coach').promptVersion,
        calls_date: planCtx.today,
        calls_today: callsToday + 1,
      },
      { onConflict: 'user_id' },
    ),
    'plan_coach',
  );
  return { guidance: guidanceOf(stored, true), stored };
}
