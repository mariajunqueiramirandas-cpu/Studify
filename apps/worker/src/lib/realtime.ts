// Realtime broadcast from the worker (api §8.2). Battle events go to the private channel `battle:{id}` through
// the service-role client, with channel.httpSend (REST, no subscription needed). The state change is committed
// before the broadcast, so a failed send is logged and never thrown: clients refetch on their next event.
import type { JobContext } from '../framework/types.ts';

export interface RealtimeEvent {
  event: string;
  payload: Record<string, unknown>;
}

export async function broadcastPrivate(ctx: JobContext, topic: string, events: readonly RealtimeEvent[]): Promise<void> {
  if (events.length === 0) return;
  const channel = ctx.supabase.channel(topic, { config: { private: true } });
  try {
    for (const e of events) {
      await channel.httpSend(e.event, e.payload);
    }
  } catch (err) {
    ctx.log.warn({ err, topic }, 'realtime broadcast failed; clients refetch on their next event');
  } finally {
    try {
      await ctx.supabase.removeChannel(channel);
    } catch (err) {
      ctx.log.warn({ err, topic }, 'realtime channel cleanup failed');
    }
  }
}
