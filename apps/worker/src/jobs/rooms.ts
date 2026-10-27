// rooms.sweep (SOC-05.6): closes study rooms that have been empty for 10 minutes or open for 4 hours, marks
// whoever was still inside as having left, and tells the channel. Runs every 5 minutes.
import { roomShouldClose } from '@studify/shared';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { unwrap, unwrapRows } from '../lib/db.ts';
import { broadcastPrivate } from '../lib/realtime.ts';

export async function handleRoomsSweep(ctx: JobContext): Promise<{ closed: number }> {
  const now = ctx.now();
  const rooms = unwrapRows<{ id: string; created_at: string; last_active_at: string }>(
    await ctx.supabase.from('study_rooms').select('id,created_at,last_active_at').eq('status', 'open'),
    'study_rooms',
  );
  let closed = 0;
  for (const room of rooms) {
    const inside = unwrapRows<{ user_id: string }>(
      await ctx.supabase.from('study_room_members').select('user_id').eq('room_id', room.id).is('left_at', null),
      'study_room_members',
    );
    if (!roomShouldClose(room, inside.length, now)) continue;
    const at = now.toISOString();
    unwrap(await ctx.supabase.from('study_rooms').update({ status: 'closed', closed_at: at }).eq('id', room.id).eq('status', 'open'), 'study_rooms');
    if (inside.length > 0) unwrap(await ctx.supabase.from('study_room_members').update({ left_at: at }).eq('room_id', room.id).is('left_at', null), 'study_room_members');
    await broadcastPrivate(ctx, `room:${room.id}`, [{ event: 'closed', payload: { reason: inside.length > 0 ? 'lifetime' : 'empty' } }]);
    closed++;
  }
  return { closed };
}

export const jobs: JobDefinition<any>[] = [
  {
    name: 'rooms.sweep',
    schedule: '*/5 * * * *',
    retryLimit: 1,
    expireInSeconds: 240,
    handler: async (ctx) => {
      const result = await handleRoomsSweep(ctx);
      if (result.closed > 0) ctx.log.info(result, 'rooms closed');
    },
  },
];
