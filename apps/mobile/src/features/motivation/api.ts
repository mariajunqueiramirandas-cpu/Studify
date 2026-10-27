import { useQuery } from '@tanstack/react-query';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { studyDateOf } from '../../lib/dates';
import { levelFor } from '@studify/shared';

export interface MotivationSummary {
  streak: number;
  bestStreak: number;
  shields: number;
  todayMinutes: number;
  dailyGoal: number;
  xp: number;
  level: number;
  /** Shown once, kindly, on the next open after a reset (MOT-01, ux §5.7). */
  streakResetNotice: boolean;
}

/** MOT-01 (Phase 2): streak, daily goal ring, XP. Server-computed tables, pull only. */
export function useMotivation() {
  const { userId, profile } = useSession();
  return useQuery({
    queryKey: ['motivation', userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<MotivationSummary | null> => {
      const today = studyDateOf(Date.now());
      const [streak, day, xp] = await Promise.all([
        supabase.from('streaks').select('*').eq('user_id', userId!).maybeSingle(),
        supabase.from('daily_activity').select('active_minutes').eq('user_id', userId!).eq('local_date', today).maybeSingle(),
        supabase.from('xp_events').select('amount').eq('user_id', userId!),
      ]);
      if (streak.error && day.error) return null; // Phase 2 tables not deployed yet
      const s = (streak.data ?? {}) as { current_length?: number; longest_length?: number; shields_available?: number; reset_notice_pending?: boolean };
      const totalXp = ((xp.data ?? []) as { amount: number }[]).reduce((a, b) => a + (b.amount ?? 0), 0);
      const dailyGoal = Number((profile?.settings as { daily_goal_minutes?: number } | undefined)?.daily_goal_minutes ?? 20);
      return {
        streak: s.current_length ?? 0,
        bestStreak: s.longest_length ?? 0,
        shields: s.shields_available ?? 0,
        todayMinutes: Number((day.data as { active_minutes?: number } | null)?.active_minutes ?? 0),
        dailyGoal,
        xp: totalXp,
        level: levelFor(totalXp),
        streakResetNotice: !!s.reset_notice_pending,
      };
    },
  });
}
