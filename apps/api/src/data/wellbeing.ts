// Data endpoints of apps/mobile/src/features/wellbeing (define.ts explains the contract): the last week's active
// minutes the burnout guard reads, and the nudge log (R10).
import { z } from 'zod';
import { dataRoute, done, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();
const NudgeKind = z.enum(['prerequisite_detective', 'long_session', 'daily_load', 'late_night', 'performance_drop', 'overload_trend', 'checkin_low']);

export const routes: DataRoute[] = [
  dataRoute({
    name: 'wellbeing-daily-activity',
    write: false,
    input: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    example: () => ({ from: '2026-01-01' }),
    run: ({ db, user, input }) => rows(db.from('daily_activity').select('local_date,active_minutes').eq('user_id', user.userId).gte('local_date', input.from)),
  }),

  dataRoute({
    name: 'wellbeing-nudge-shown',
    write: true,
    input: z.object({ id: Id, kind: NudgeKind, surface: z.enum(['today', 'review', 'session']) }),
    example: () => ({ id: crypto.randomUUID(), kind: 'daily_load' as const, surface: 'today' as const }),
    run: async ({ db, user, input }) => {
      await done(db.from('nudge_events').insert({ id: input.id, user_id: user.userId, kind: input.kind, surface: input.surface }));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'wellbeing-nudge-action',
    write: true,
    input: z.object({ nudge_id: Id, action: z.enum(['acted', 'dismissed', 'accepted', 'disabled']) }),
    example: (seed) => ({ nudge_id: seed.missingId, action: 'dismissed' as const }),
    run: async ({ db, input, now }) => {
      await done(db.from('nudge_events').update({ action: input.action, action_at: now.toISOString() }).eq('id', input.nudge_id));
      return { ok: true };
    },
  }),
];
