// Data endpoints of apps/mobile/src/features/rooms (define.ts explains the contract): the study_rooms reads. The
// room actions go through room-control and the live channel through realtime-*.
import { z } from 'zod';
import { dataRoute, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();

export const routes: DataRoute[] = [
  dataRoute({
    name: 'rooms-open',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: ({ db, input }) =>
      rows(db.from('study_rooms').select('*').eq('class_group_id', input.class_group_id).eq('status', 'open').order('created_at', { ascending: false })),
  }),

  dataRoute({
    name: 'rooms-get',
    write: false,
    input: z.object({ room_id: Id }),
    example: (seed) => ({ room_id: seed.missingId }),
    run: async ({ db, input }) => (await rows(db.from('study_rooms').select('*').eq('id', input.room_id)))[0] ?? null,
  }),
];
