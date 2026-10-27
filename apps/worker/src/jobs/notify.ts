// notify.dispatch (PLT-05): turns a producer's event into a push message from the catalog (copy, channel,
// deep link, whether it counts toward the daily cap) and hands it to ctx.push. The framework push service
// owns the whole delivery policy (channel toggles, device tokens, quiet hours with deferred delivery, the
// 3-per-day cap, notification_log), so that logic is not repeated here: it would count every push twice.
import { z } from 'zod';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { fillTemplate, notifyEntry } from '../lib/notify-catalog.ts';

const DispatchPayload = z.object({
  user_id: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type DispatchOutcome = { status: 'handed_off' } | { status: 'local_only' | 'unknown_type' };

export async function handleNotifyDispatch(ctx: JobContext, raw: Record<string, unknown>): Promise<DispatchOutcome> {
  const payload = DispatchPayload.parse(raw);
  const entry = notifyEntry(payload.type);
  if (!entry) {
    ctx.log.warn({ type: payload.type }, 'notify.dispatch: unknown notification type');
    return { status: 'unknown_type' };
  }
  // Local types are scheduled on the device (api.md §9); the server never pushes them.
  if (entry.delivery === 'local') return { status: 'local_only' };

  // A producer may send its own PT-BR copy (e.g. duel-create sends `body`, spec 10 §8.2); it wins over the catalog.
  await ctx.push(payload.user_id, {
    channel: entry.channel,
    title: nonEmpty(payload.data.title) ?? entry.title,
    body: nonEmpty(payload.data.body) ?? fillTemplate(entry.body, payload.data),
    data: { ...payload.data, type: payload.type, deep_link: fillTemplate(entry.deepLink, payload.data) },
    // requested = not counted toward the cap (PLT-05.4); the push service reads this flag.
    requested: !entry.countsTowardCap,
  });
  return { status: 'handed_off' };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export const jobs: JobDefinition[] = [
  { name: 'notify.dispatch', retryLimit: 3, handler: async (ctx, data) => void (await handleNotifyDispatch(ctx, data)) },
];
