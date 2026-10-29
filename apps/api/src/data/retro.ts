// Data endpoints of apps/mobile/src/features/retro (define.ts explains the contract). The worker writes the
// retrospectives (retro.generate); the app reads them and marks one seen.
import { z } from 'zod';
import { dataRoute, done, rows, type DataRoute } from './define.ts';

const COLUMNS = 'id,period_type,goal_id,period_start,period_end,stats,title,subtitle,generated_at,seen_at';

export const routes: DataRoute[] = [
  dataRoute({
    name: 'retro-list',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => rows(db.from('retrospectives').select(COLUMNS).eq('user_id', user.userId).order('generated_at', { ascending: false }).limit(30)),
  }),

  dataRoute({
    name: 'retro-mark-seen',
    write: true,
    input: z.object({ retro_id: z.string().uuid() }),
    example: (seed) => ({ retro_id: seed.missingId }),
    run: async ({ db, input, now }) => {
      await done(db.from('retrospectives').update({ seen_at: now.toISOString() }).eq('id', input.retro_id).is('seen_at', null));
      return { ok: true };
    },
  }),
];
