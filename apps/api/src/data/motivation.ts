// Data endpoints of apps/mobile/src/features/motivation (define.ts explains the contract). Streaks, daily activity,
// XP and achievements are server-computed tables; the app only reads them.
import { z } from 'zod';
import { dataRoute, rows, type DataRoute } from './define.ts';

export const routes: DataRoute[] = [
  dataRoute({
    name: 'motivation-summary',
    write: false,
    // The student's study date (the app's clock and day rollover), as the direct query used.
    input: z.object({ today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    example: () => ({ today: '2026-01-01' }),
    run: async ({ db, user, input }) => {
      const [streak, day, xp] = await Promise.all([
        db.from('streaks').select('*').eq('user_id', user.userId).maybeSingle(),
        db.from('daily_activity').select('active_minutes').eq('user_id', user.userId).eq('local_date', input.today).maybeSingle(),
        db.from('xp_events').select('amount').eq('user_id', user.userId),
      ]);
      // As the app did: null only when neither the streak nor the day could be read; a failed part reads as empty.
      if (streak.error && day.error) return null;
      const xpTotal = ((xp.data ?? []) as { amount: number | null }[]).reduce((a, b) => a + Number(b.amount ?? 0), 0);
      return {
        streak: streak.error ? null : (streak.data ?? null),
        active_minutes: day.error ? null : ((day.data as { active_minutes?: number } | null)?.active_minutes ?? null),
        xp_total: xpTotal,
      };
    },
  }),

  dataRoute({
    name: 'motivation-achievements',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => rows(db.from('achievements').select('code,progress,unlocked_at').eq('user_id', user.userId).is('deleted_at', null)),
  }),
];
