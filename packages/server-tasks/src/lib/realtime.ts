// Realtime broadcast from server operations (api §8.2). Battle events go to the private channel `battle:{id}` on the
// API's own WebSocket hub (ADR 0012). The state change is committed before the broadcast, so a failed send is
// logged and never thrown: clients refetch on their next event.
import type { OperationContext } from '../framework/types.ts';

export interface RealtimeEvent {
  event: string;
  payload: Record<string, unknown>;
}

export async function broadcastPrivate(ctx: OperationContext, topic: string, events: readonly RealtimeEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await ctx.broadcast(topic, events);
  } catch (err) {
    ctx.log.warn({ err, topic }, 'realtime broadcast failed; clients refetch on their next event');
  }
}
