// Motivation jobs (MOT-01, learning-engine §17): streaks.rollover closes study days into daily_activity
// and the streak state; xp.award writes idempotent XP events. Both use @studify/shared rules.
import { z } from 'zod';
import { initialStreakState, studyDayBounds, studyDayOf, uuidV7, xpFor, type StreakState, type XpDayContext, type XpEvent, type LocalDate, isCountedDay } from '@studify/shared';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { IN_CHUNK, chunk, unwrap, unwrapRows, uniq } from '../lib/db.ts';
import { dailyActivityFor, daysInRange, rollStreak, type DayFacts } from '../lib/streaks.ts';
import { DEFAULT_ROLLOVER_HOUR, addDays, inQuietHours, localDateOf, safeTimeZone, studyDayFor } from '../lib/time.ts';

const RolloverPayload = z.object({ user_ids: z.array(z.string().min(1)).max(1000).optional() });

const XP_KINDS = [
  'card_reviewed', 'question_answered', 'quiz_completed', 'simulado_completed', 'boss_defeated', 'plan_item_completed', 'daily_goal_met',
  'mistake_resolved', 'note_section_read', 'lucas_finished', 'argumentation_finished', 'podcast_completed', 'duel_finished', 'battle_played',
  'error_report_accepted', 'focus_cycle_completed',
] as const;

const XpEventSchema = z.object({
  id: z.string().min(1).optional(),
  event: z.object({ kind: z.enum(XP_KINDS) }).passthrough(),
  ref_type: z.string().min(1),
  ref_id: z.string().min(1),
  source_feature: z.string().min(1),
  occurred_at: z.string().min(1),
});
const XpPayload = z.object({ user_id: z.string().min(1), events: z.array(XpEventSchema).min(1).max(100) });

export interface RolloverOutcome {
  status: 'rolled' | 'up_to_date' | 'no_activity';
  days?: number;
  length?: number;
}

/** Closes the study days after the streak's last evaluated day, up to yesterday (idempotent). */
export async function rolloverUser(ctx: JobContext, userId: string): Promise<RolloverOutcome> {
  const profile = unwrap(
    await ctx.supabase.from('profiles').select('timezone,settings').eq('id', userId).is('deleted_at', null).maybeSingle(),
    'profiles',
  ) as { timezone: string | null; settings: Record<string, unknown> | null } | null;
  if (!profile) return { status: 'no_activity' };
  const timeZone = safeTimeZone(profile.timezone);
  const prefs = unwrap(await ctx.supabase.from('study_preferences').select('day_rollover_hour').eq('user_id', userId).maybeSingle(), 'study_preferences') as
    | { day_rollover_hour: number }
    | null;
  const rollover = prefs?.day_rollover_hour ?? DEFAULT_ROLLOVER_HOUR;
  const goalMinutes = typeof profile.settings?.daily_goal_minutes === 'number' ? (profile.settings.daily_goal_minutes as number) : 20;
  const now = ctx.now();
  const yesterday = addDays(studyDayFor(now, timeZone, rollover), -1);
  const row = unwrap(await ctx.supabase.from('streaks').select('*').eq('user_id', userId).maybeSingle(), 'streaks') as
    | {
        current_length: number;
        longest_length: number;
        last_counted_date: string | null;
        shields_available: number;
        days_since_last_shield_earned: number;
        rest_weekday: number | null;
      }
    | null;
  const state: StreakState = row
    ? {
        length: row.current_length,
        longest: row.longest_length,
        shields: row.shields_available,
        countedRun: row.days_since_last_shield_earned,
        lastEvaluated: row.last_counted_date,
        shieldUsedOn: [],
      }
    : initialStreakState();

  const firstActivity = await earliestActivityDay(ctx, userId, timeZone, rollover);
  const start = state.lastEvaluated ? addDays(state.lastEvaluated, 1) : firstActivity;
  if (!start) return { status: 'no_activity' };
  if (start > yesterday) return { status: 'up_to_date' };

  const days = daysInRange(start, yesterday);
  const { start: fromInstant } = studyDayBounds(start, timeZone, rollover);
  const { end: toInstant } = studyDayBounds(yesterday, timeZone, rollover);
  const within = (t: string | null | undefined): boolean => !!t && new Date(t) >= fromInstant && new Date(t) < toInstant;
  const dayOf = (t: string): LocalDate => studyDayOf(new Date(t), timeZone, rollover);

  const facts = new Map<string, DayFacts>();
  const bump = (day: string, patch: Partial<DayFacts>): void => {
    const f = facts.get(day) ?? { activeMinutes: 0, reviews: 0, questions: 0, sessions: 0, xp: 0 };
    facts.set(day, {
      activeMinutes: f.activeMinutes + (patch.activeMinutes ?? 0),
      reviews: f.reviews + (patch.reviews ?? 0),
      questions: f.questions + (patch.questions ?? 0),
      sessions: f.sessions + (patch.sessions ?? 0),
      xp: f.xp + (patch.xp ?? 0),
    });
  };
  const sessions = unwrapRows<{ started_at: string; active_minutes: number }>(
    await ctx.supabase.from('study_sessions').select('started_at,active_minutes').eq('user_id', userId).gte('started_at', fromInstant.toISOString()).lt('started_at', toInstant.toISOString()),
    'study_sessions',
  );
  for (const s of sessions) bump(dayOf(s.started_at), { activeMinutes: Number(s.active_minutes ?? 0) });
  const reviews = unwrapRows<{ reviewed_at: string }>(
    await ctx.supabase.from('review_logs').select('reviewed_at').eq('user_id', userId).gte('reviewed_at', fromInstant.toISOString()).lt('reviewed_at', toInstant.toISOString()),
    'review_logs',
  );
  for (const r of reviews) if (within(r.reviewed_at)) bump(dayOf(r.reviewed_at), { reviews: 1 });
  const answers = unwrapRows<{ answered_at: string }>(
    await ctx.supabase.from('attempt_answers').select('answered_at').eq('user_id', userId).gte('answered_at', fromInstant.toISOString()).lt('answered_at', toInstant.toISOString()),
    'attempt_answers',
  );
  for (const a of answers) bump(dayOf(a.answered_at), { questions: 1 });
  const quizzes = unwrapRows<{ finished_at: string | null }>(
    await ctx.supabase.from('quiz_attempts').select('finished_at').eq('user_id', userId).eq('status', 'submitted').gte('finished_at', fromInstant.toISOString()).lt('finished_at', toInstant.toISOString()),
    'quiz_attempts',
  );
  for (const q of quizzes) if (q.finished_at) bump(dayOf(q.finished_at), { sessions: 1 });

  const xpByDay = await xpTotals(ctx, userId, fromInstant, toInstant, timeZone, rollover);
  for (const [day, xp] of xpByDay) bump(day, { xp });

  const goals = unwrapRows<{ id: string }>(await ctx.supabase.from('goals').select('id').eq('user_id', userId).eq('status', 'active').is('deleted_at', null), 'goals');
  const goalIds = goals.map((g) => g.id);
  const exams: Array<{ goal_id: string; local_date: string }> = [];
  for (const part of chunk(goalIds, IN_CHUNK)) {
    exams.push(...unwrapRows(await ctx.supabase.from('exams').select('goal_id,local_date').in('goal_id', part).eq('status', 'scheduled').is('deleted_at', null), 'exams'));
  }
  const examDays = new Set(exams.filter((e) => e.local_date >= start && e.local_date <= yesterday).map((e) => e.local_date));
  const goalsForRest = goalIds.map((id) => {
    const dates = exams.filter((e) => e.goal_id === id).map((e) => e.local_date).sort();
    return { examDays: dates, lastExamDay: dates[dates.length - 1] ?? null };
  });

  const activity = dailyActivityFor(days, {
    facts,
    examDays,
    goals: goalsForRest,
    restWeekday: row?.rest_weekday ?? null,
  });
  const next = rollStreak(state, activity);
  const shieldUsed = new Set(next.shieldUsedOn);
  const dailyRows = activity.map((a) => {
    const f = facts.get(a.day) ?? { activeMinutes: 0, reviews: 0, questions: 0, sessions: 0, xp: 0 };
    return {
      user_id: userId,
      local_date: a.day,
      active_minutes: f.activeMinutes,
      reviews: f.reviews,
      questions: f.questions,
      sessions: f.sessions,
      xp: f.xp,
      goal_minutes: goalMinutes,
      goal_met: f.activeMinutes >= goalMinutes,
      counted: isCountedDay(a),
      shield_used: shieldUsed.has(a.day),
      rest_day: a.restDay,
      late_night_minutes: 0,
    };
  });
  for (const part of chunk(dailyRows, 200)) {
    unwrap(await ctx.supabase.from('daily_activity').upsert(part, { onConflict: 'user_id,local_date' }), 'daily_activity');
  }
  unwrap(
    await ctx.supabase.from('streaks').upsert(
      {
        user_id: userId,
        current_length: next.length,
        longest_length: next.longest,
        last_counted_date: next.lastEvaluated,
        shields_available: next.shields,
        days_since_last_shield_earned: next.countedRun,
        rest_weekday: row?.rest_weekday ?? null,
      },
      { onConflict: 'user_id' },
    ),
    'streaks',
  );
  return { status: 'rolled', days: days.length, length: next.length };
}

async function earliestActivityDay(ctx: JobContext, userId: string, timeZone: string, rollover: number): Promise<LocalDate | null> {
  const candidates: string[] = [];
  const reviewed = unwrapRows<{ v: string }>(await ctx.supabase.from('review_logs').select('v:reviewed_at').eq('user_id', userId).order('reviewed_at', { ascending: true }).limit(1), 'review_logs');
  const started = unwrapRows<{ v: string }>(await ctx.supabase.from('study_sessions').select('v:started_at').eq('user_id', userId).order('started_at', { ascending: true }).limit(1), 'study_sessions');
  const answered = unwrapRows<{ v: string }>(await ctx.supabase.from('attempt_answers').select('v:answered_at').eq('user_id', userId).order('answered_at', { ascending: true }).limit(1), 'attempt_answers');
  for (const rows of [reviewed, started, answered]) {
    const value = rows[0]?.v;
    if (value) candidates.push(studyDayOf(new Date(value), timeZone, rollover));
  }
  return candidates.sort()[0] ?? null;
}

async function xpTotals(ctx: JobContext, userId: string, from: Date, to: Date, timeZone: string, rollover: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const rows = unwrapRows<{ amount: number; occurred_at: string }>(
      await ctx.supabase.from('xp_events').select('amount,occurred_at').eq('user_id', userId).gte('occurred_at', from.toISOString()).lt('occurred_at', to.toISOString()),
      'xp_events',
    );
    for (const r of rows) {
      const day = studyDayOf(new Date(r.occurred_at), timeZone, rollover);
      out.set(day, (out.get(day) ?? 0) + Number(r.amount));
    }
  } catch (err) {
    ctx.log.warn({ err }, 'streaks.rollover: xp totals unavailable; daily xp left at 0');
  }
  return out;
}

export async function handleStreaksRollover(ctx: JobContext, raw: Record<string, unknown>): Promise<{ users: number; rolled: number }> {
  const payload = RolloverPayload.parse(raw);
  const userIds = payload.user_ids ?? unwrapRows<{ id: string }>(await ctx.supabase.from('profiles').select('id').is('deleted_at', null), 'profiles').map((p) => p.id);
  let rolled = 0;
  for (const userId of uniq(userIds)) {
    const result = await rolloverUser(ctx, userId);
    if (result.status === 'rolled') rolled++;
  }
  return { users: userIds.length, rolled };
}

/** xp.award (MOT-01): idempotent on (user, ref_type, ref_id, source_feature). Caps per learning-engine §17.1. */
export async function handleXpAward(ctx: JobContext, raw: Record<string, unknown>): Promise<{ awarded: number; inserted: number; skipped: number }> {
  const payload = XpPayload.parse(raw);
  const profile = unwrap(await ctx.supabase.from('profiles').select('timezone').eq('id', payload.user_id).maybeSingle(), 'profiles') as { timezone: string | null } | null;
  const timeZone = safeTimeZone(profile?.timezone);
  const prefs = unwrap(
    await ctx.supabase.from('study_preferences').select('quiet_start,quiet_end').eq('user_id', payload.user_id).maybeSingle(),
    'study_preferences',
  ) as { quiet_start: string; quiet_end: string } | null;
  const quietStart = (prefs?.quiet_start ?? '22:00').slice(0, 5);
  const quietEnd = (prefs?.quiet_end ?? '07:00').slice(0, 5);

  const refIds = uniq(payload.events.map((e) => e.ref_id));
  const existing = new Set<string>();
  for (const part of chunk(refIds, IN_CHUNK)) {
    for (const row of unwrapRows<{ ref_type: string; ref_id: string; source_feature: string }>(
      await ctx.supabase.from('xp_events').select('ref_type,ref_id,source_feature').eq('user_id', payload.user_id).in('ref_id', part),
      'xp_events',
    )) existing.add(keyOf(row.ref_type, row.ref_id, row.source_feature));
  }
  const seen = new Set<string>();
  const fresh = payload.events.filter((e) => {
    const key = keyOf(e.ref_type, e.ref_id, e.source_feature);
    if (existing.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (fresh.length === 0) return { awarded: 0, inserted: 0, skipped: payload.events.length };

  const days = uniq(fresh.map((e) => localDateOf(new Date(e.occurred_at), timeZone)));
  const counters = new Map<string, XpDayContext>();
  for (const day of days) {
    const rows = unwrapRows<{ ref_type: string; amount: number }>(
      await ctx.supabase.from('xp_events').select('ref_type,amount').eq('user_id', payload.user_id).eq('local_date', day),
      'xp_events',
    );
    counters.set(day, {
      dailyGoalXpAwarded: rows.some((r) => r.ref_type === 'daily_goal_met' && Number(r.amount) > 0),
      noteXpToday: rows.filter((r) => r.ref_type === 'note_section_read').reduce((acc, r) => acc + Number(r.amount), 0),
      podcastsToday: rows.filter((r) => r.ref_type === 'podcast_completed' && Number(r.amount) > 0).length,
    });
  }

  const rowsToInsert = fresh.map((e) => {
    const day = localDateOf(new Date(e.occurred_at), timeZone);
    const context = counters.get(day) ?? { dailyGoalXpAwarded: false, noteXpToday: 0, podcastsToday: 0 };
    const amount = xpFor(e.event as XpEvent, context);
    if (e.event.kind === 'daily_goal_met' && amount > 0) context.dailyGoalXpAwarded = true;
    if (e.event.kind === 'note_section_read') context.noteXpToday += amount;
    if (e.event.kind === 'podcast_completed' && amount > 0) context.podcastsToday += 1;
    return {
      id: e.id ?? uuidV7(ctx.now().getTime()),
      user_id: payload.user_id,
      amount,
      source_feature: e.source_feature,
      ref_type: e.ref_type,
      ref_id: e.ref_id,
      occurred_at: e.occurred_at,
      local_date: day,
      in_quiet_hours: inQuietHours(new Date(e.occurred_at), timeZone, quietStart, quietEnd),
    };
  });
  const inserted = unwrapRows<{ id: string; amount: number }>(
    await ctx.supabase.from('xp_events').upsert(rowsToInsert, { onConflict: 'user_id,ref_type,ref_id,source_feature', ignoreDuplicates: true }).select('id,amount'),
    'xp_events',
  );
  const awarded = inserted.reduce((acc, r) => acc + Number(r.amount), 0);
  return { awarded, inserted: inserted.length, skipped: payload.events.length - inserted.length };
}

function keyOf(refType: string, refId: string, feature: string): string {
  return `${refType}|${refId}|${feature}`;
}


export const jobs: JobDefinition[] = [
  { name: 'streaks.rollover', retryLimit: 2, schedule: '5 * * * *', handler: async (ctx, data) => void (await handleStreaksRollover(ctx, data)) },
  { name: 'xp.award', retryLimit: 3, handler: async (ctx, data) => void (await handleXpAward(ctx, data)) },
];
