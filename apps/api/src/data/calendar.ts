// Data endpoints of apps/mobile/src/features/calendar (define.ts explains the contract). Only the free minutes per
// date leave the phone (GOL-09.2); the calendar's events never do.
import { z } from 'zod';
import { dataRoute, done, type DataRoute } from './define.ts';

const LocalDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const routes: DataRoute[] = [
  dataRoute({
    name: 'calendar-availability-set',
    write: true,
    // minutes null clears the date's calendar row (set_calendar_availability).
    input: z.object({ days: z.array(z.object({ local_date: LocalDate, minutes: z.number().int().min(0).max(1440).nullable() })).max(62) }),
    example: () => ({ days: [] }),
    run: async ({ db, input }) => {
      const n = await done<number>(db.rpc('set_calendar_availability', { p_days: input.days }), 'set_calendar_availability');
      return { days: n ?? 0 };
    },
  }),
];
