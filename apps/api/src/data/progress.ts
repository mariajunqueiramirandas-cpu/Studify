// Data endpoints of the Progresso screen (apps/mobile/src/app/(tabs)/profile/progress.tsx; define.ts explains the
// contract).
import { z } from 'zod';
import { dataRoute, rows, type DataRoute } from './define.ts';

export const routes: DataRoute[] = [
  dataRoute({
    name: 'progress-daily-activity',
    write: false,
    input: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    example: () => ({ from: '2026-01-01' }),
    run: ({ db, user, input }) => rows(db.from('daily_activity').select('local_date,active_minutes,counted').eq('user_id', user.userId).gte('local_date', input.from)),
  }),
];
