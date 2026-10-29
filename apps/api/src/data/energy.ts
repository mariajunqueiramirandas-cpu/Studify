// Data endpoints of apps/mobile/src/features/energy (define.ts explains the contract). performance_windows is
// computed by the worker (energy.windows); the app reads it.
import { z } from 'zod';
import { dataRoute, rows, type DataRoute } from './define.ts';

export const routes: DataRoute[] = [
  dataRoute({
    name: 'energy-windows',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => rows(db.from('performance_windows').select('bucket,n_events,mean_residual,ci_low,ci_high,good').eq('user_id', user.userId).order('bucket')),
  }),
];
