// Burnout guard (WEL-03, spec 13 §8.10). The heuristics are the shared `burnoutNudges`; this module feeds them
// with what the phone knows, keeps the per-day caps in MMKV and logs each nudge to nudge_events (R10).
import { BURNOUT, burnoutNudges, isLateNight, parseProfileSettings, type BurnoutInput, type BurnoutNudge, type BurnoutNudgeKind } from '@studify/shared';
import { useQuery } from '@tanstack/react-query';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { useCallback, useEffect, useState } from 'react';
import { uuidv7 } from 'uuidv7';
import { supabase } from '../../api/supabase';
import { useDb } from '../../db/DatabaseProvider';
import type { AppDb } from '../../db/client';
import { exams, reviewLogs } from '../../db/schema';
import { localDateOf } from '../../lib/dates';
import { getKv } from '../../lib/kv';
import { useFocusStore } from '../../stores/focus';
import { useSession } from '../auth/session';
import { rows } from '../common/query';
import { useMotivation } from '../motivation/api';
import { updateSettings } from '../profile/api';
import { recomputePlan } from '../goals/api';
import { continuousMinutes } from './activity';
import { checkinMoods } from './checkin';

const CAPS_KEY = 'wellbeing.caps';

interface Caps {
  date: string;
  shown: Partial<Record<BurnoutNudgeKind, number>>;
  /** Local date the last late-night nudge's night started on. */
  lateNight: string | null;
}

/** The night of 00:30 belongs to the previous calendar day (it is still "tonight"). */
function nightOf(now: Date): string {
  return localDateOf(now.getHours() < 5 ? new Date(now.getTime() - 6 * 3600_000) : now);
}

function readCaps(today: string): Caps {
  try {
    const c = JSON.parse(getKv().getString(CAPS_KEY) ?? 'null') as Caps | null;
    if (c && c.date === today) return c;
    return { date: today, shown: {}, lateNight: c?.lateNight ?? null };
  } catch {
    return { date: today, shown: {}, lateNight: null };
  }
}

function recordShown(kind: BurnoutNudgeKind, now: Date): void {
  const caps = readCaps(localDateOf(now));
  caps.shown[kind] = (caps.shown[kind] ?? 0) + 1;
  if (kind === 'late_night') caps.lateNight = nightOf(now);
  getKv().set(CAPS_KEY, JSON.stringify(caps));
}

/** Last 7 days of reviews on this phone: accuracy per day (Errei = wrong). */
function reviewAccuracyByDay(db: AppDb, since: Date): Map<string, number> {
  const logs = db
    .select({ rating: reviewLogs.rating, at: reviewLogs.reviewedAt })
    .from(reviewLogs)
    .where(and(gte(reviewLogs.reviewedAt, since), isNull(reviewLogs.undoesLogId)))
    .all();
  const by = new Map<string, { n: number; ok: number }>();
  for (const l of logs) {
    const d = localDateOf(l.at);
    const s = by.get(d) ?? { n: 0, ok: 0 };
    s.n++;
    if (l.rating > 1) s.ok++;
    by.set(d, s);
  }
  return new Map([...by].filter(([, v]) => v.n >= 5).map(([d, v]) => [d, v.ok / v.n]));
}

export interface GuardOptions {
  surface: 'today' | 'review' | 'session';
  /** Items answered in the current session, oldest first (performance drop). */
  sessionItems?: readonly { correct: boolean; ms: number }[];
  /** Duel, battle or simulado running: nudges wait (WEL-03.2). */
  inTimedActivity?: boolean;
}

export interface ActiveNudge extends BurnoutNudge {
  id: string;
}

/** The nudge to show on this surface now, if any, with its actions. Re-evaluated every minute. */
export function useBurnoutNudge(opts: GuardOptions) {
  const db = useDb();
  const { userId, profile, refreshProfile } = useSession();
  const motivation = useMotivation();
  const inFocusTimer = useFocusStore((s) => s.run !== null);
  const [nudge, setNudge] = useState<ActiveNudge | null>(null);
  const week = useQuery({
    queryKey: ['dailyActivity7', userId],
    enabled: !!userId,
    staleTime: 30 * 60_000,
    queryFn: () => {
      const from = localDateOf(new Date(Date.now() - 7 * 86_400_000));
      return rows<{ local_date: string; active_minutes: number }>(supabase.from('daily_activity').select('local_date,active_minutes').eq('user_id', userId!).gte('local_date', from)).catch(() => []);
    },
  });

  const settings = (() => {
    try {
      return parseProfileSettings(profile?.settings);
    } catch {
      return parseProfileSettings({});
    }
  })();
  const nudgesEnabled = settings.wellbeing_nudges_enabled !== false;
  const dailyGoal = motivation.data?.dailyGoal ?? Number(settings.daily_goal_minutes ?? 20);
  const todayMinutes = motivation.data?.todayMinutes ?? 0;
  const items = opts.sessionItems;
  const timed = !!opts.inTimedActivity;

  const evaluate = useCallback(() => {
    if (!userId) return;
    const now = new Date();
    const today = localDateOf(now);
    const caps = readCaps(today);
    const minuteOfDay = now.getHours() * 60 + now.getMinutes();
    const night = nightOf(now);
    const tomorrow = localDateOf(new Date(now.getTime() + 86_400_000));
    const examEve = !!db.select({ id: exams.id }).from(exams).where(and(eq(exams.localDate, now.getHours() < 5 ? today : tomorrow), isNull(exams.deletedAt))).get();
    const cont = continuousMinutes(now.getTime());
    const late = isLateNight(minuteOfDay, examEve);
    const lateStart = examEve ? BURNOUT.examEveLateNightStart : BURNOUT.lateNightStart;
    const sinceLate = minuteOfDay >= lateStart ? minuteOfDay - lateStart : minuteOfDay + 1440 - lateStart;
    const acc = reviewAccuracyByDay(db, new Date(now.getTime() - 7 * 86_400_000));
    const activeBy = new Map((week.data ?? []).map((d) => [d.local_date, d.active_minutes]));
    const last7 = Array.from({ length: 7 }, (_, i) => localDateOf(new Date(now.getTime() - (6 - i) * 86_400_000))).map((d) => ({
      activeMinutes: d === today ? Math.max(todayMinutes, activeBy.get(d) ?? 0) : (activeBy.get(d) ?? 0),
      accuracy: acc.get(d) ?? null,
    }));
    const [ny, nm, nd] = night.split('-').map(Number);
    const input: BurnoutInput = {
      minuteOfDay,
      nightWeekday: new Date(ny!, nm! - 1, nd!).getDay(),
      examEve,
      dailyGoalMinutes: dailyGoal,
      todayActiveMinutes: todayMinutes,
      continuousMinutes: cont,
      inFocusTimer,
      inTimedActivity: timed,
      lateNightMinutesTonight: late ? Math.min(cont, sinceLate) : 0,
      sessionItems: items ?? [],
      last7,
      checkins: checkinMoods(db),
      shownToday: caps.shown,
      lateNightShownTonight: caps.lateNight === night,
      nudgesEnabled,
    };
    const next = burnoutNudges(input)[0] ?? null;
    if (!next) return;
    // Long-session and drop nudges belong to study screens; the rest show anywhere.
    if (opts.surface === 'today' && (next.kind === 'long_session' || next.kind === 'performance_drop')) return;
    const id = uuidv7();
    recordShown(next.kind, now);
    void supabase.from('nudge_events').insert({ id, user_id: userId, kind: next.kind, surface: opts.surface }).then(
      () => undefined,
      () => undefined,
    );
    setNudge({ ...next, id });
  }, [db, userId, week.data, todayMinutes, dailyGoal, nudgesEnabled, inFocusTimer, timed, items, opts.surface]);

  useEffect(() => {
    if (nudge) return;
    const first = setTimeout(evaluate, 1500);
    const timer = setInterval(evaluate, 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [evaluate, nudge]);

  const log = (action: 'acted' | 'dismissed' | 'accepted' | 'disabled') => {
    if (!nudge) return;
    void supabase.from('nudge_events').update({ action, action_at: new Date().toISOString() }).eq('id', nudge.id).then(
      () => undefined,
      () => undefined,
    );
  };

  return {
    nudge,
    /** "Agora não". */
    dismiss: () => {
      log('dismissed');
      setNudge(null);
    },
    /** WEL-03.3: replan with lighter days. */
    rebalance: async () => {
      log('accepted');
      setNudge(null);
      await recomputePlan('user_rebalance');
    },
    acted: () => {
      log('acted');
      setNudge(null);
    },
    /** Turns wellbeing nudges off (the help card stays available, WEL-03.2). */
    disable: async () => {
      log('disabled');
      setNudge(null);
      await updateSettings({ wellbeing_nudges_enabled: false });
      await refreshProfile();
    },
  };
}
