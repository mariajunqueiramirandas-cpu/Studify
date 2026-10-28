// notify.dispatch (PLT-05): turns a producer's event into a push message from the catalog (copy, channel,
// deep link, whether it counts toward the daily cap) and hands it to ctx.push. The framework push service
// owns the whole delivery policy (channel toggles, device tokens, quiet hours with deferred delivery, the
// 3-per-day cap, notification_log), so that logic is not repeated here: it would count every push twice.
import { isLiveJobType } from '@studify/shared';
import { z } from 'zod';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { fillTemplate, notifyEntry } from '../lib/notify-catalog.ts';
import { liveKeyOf, liveRich, type LiveJobRow } from '../lib/rich.ts';

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

const LivePayload = z.object({ ai_job_id: z.uuid() });

export type LiveOutcome = 'updated' | 'ended' | 'skipped';

/**
 * notify.live (api.md §9.1): the Uber-style progress notification of a running job (material processing,
 * podcast, redação, Prova Provável), sent data-only so only the Android module draws it. When the job ends
 * the live notification is cancelled, except for materials: their "Material pronto" notification uses the
 * same key and replaces it in place.
 */
export async function handleNotifyLive(ctx: JobContext, raw: Record<string, unknown>): Promise<LiveOutcome> {
  const { ai_job_id } = LivePayload.parse(raw);
  const { rows } = await ctx.db.query<LiveJobRow>(
    `select id, type, stage, status, progress, user_id, subject_id, document_id, started_at::text
       from public.ai_jobs where id = $1`,
    [ai_job_id],
  );
  const job = rows[0];
  if (!job?.user_id || !isLiveJobType(job.type)) return 'skipped';
  if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') {
    // Materials end with material_ready / material_failed under the same key; the rest cancel the bar.
    if (job.type === 'ingest.document') return 'ended';
    await ctx.push(job.user_id, { channel: 'processing', title: 'Studify', body: '', data: { type: 'live_cancel', rich_cancel: liveKeyOf(job) }, rich: null, ephemeral: true, requested: true });
    return 'ended';
  }
  const subject = job.subject_id
    ? ((await ctx.db.query<{ name: string; color: string }>(`select name, color from public.subjects where id = $1`, [job.subject_id])).rows[0] ?? null)
    : null;
  const rich = liveRich(job, subject, ctx.now());
  if (!rich) return 'skipped';
  await ctx.push(job.user_id, { channel: 'processing', title: rich.title, body: rich.body, data: { type: 'live_progress' }, rich, ephemeral: true, requested: true });
  return 'updated';
}

export const jobs: JobDefinition[] = [
  { name: 'notify.dispatch', retryLimit: 3, handler: async (ctx, data) => void (await handleNotifyDispatch(ctx, data)) },
  // Not tracked: marking the job running here would queue another notify.live (and revive finished jobs).
  // Each run is one Expo push (~4-8 s), and a stage change queues several at once: with one slot the
  // backlog waited ~80-100 s (p50) and up to ~15 min during the progress loop, so run four at a time.
  { name: 'notify.live', retryLimit: 1, expireInSeconds: 120, tracksProgress: false, concurrency: 4, handler: async (ctx, data) => void (await handleNotifyLive(ctx, data)) },
];
