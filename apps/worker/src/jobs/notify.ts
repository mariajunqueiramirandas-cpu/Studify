// notify.dispatch (PLT-05): every server push goes through here. Policy (channel toggles, device
// tokens, the 3-per-day cap for unrequested types, quiet hours) is decided by lib/notify-policy.ts; the
// delivery itself is ctx.push. Every decision that is not a local-only type is written to notification_log.
import { z } from 'zod';
import { studyDayBounds } from '@studify/shared';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { unwrap, unwrapRows } from '../lib/db.ts';
import { fillTemplate, notifyEntry } from '../lib/notify-catalog.ts';
import { channelEnabled, decideDelivery } from '../lib/notify-policy.ts';
import { inQuietHours, quietEndInstant, safeTimeZone, studyDayFor, DEFAULT_ROLLOVER_HOUR } from '../lib/time.ts';

const DispatchPayload = z.object({
  user_id: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).default({}),
  deferred: z.boolean().optional(),
});

export type DispatchOutcome =
  | { status: 'sent' }
  | { status: 'deferred'; until: string }
  | { status: 'dropped'; reason: string }
  | { status: 'local_only' | 'unknown_type' | 'no_profile' };

export async function handleNotifyDispatch(ctx: JobContext, raw: Record<string, unknown>): Promise<DispatchOutcome> {
  const payload = DispatchPayload.parse(raw);
  const entry = notifyEntry(payload.type);
  if (!entry) {
    ctx.log.warn({ type: payload.type }, 'notify.dispatch: unknown notification type');
    return { status: 'unknown_type' };
  }
  if (entry.delivery === 'local') return { status: 'local_only' };

  const profile = unwrap(
    await ctx.supabase.from('profiles').select('timezone,settings').eq('id', payload.user_id).is('deleted_at', null).maybeSingle(),
    'profiles',
  ) as { timezone: string | null; settings: Record<string, unknown> | null } | null;
  if (!profile) return { status: 'no_profile' };
  const timeZone = safeTimeZone(profile.timezone);
  const prefs = unwrap(
    await ctx.supabase.from('study_preferences').select('quiet_start,quiet_end,day_rollover_hour').eq('user_id', payload.user_id).maybeSingle(),
    'study_preferences',
  ) as { quiet_start: string; quiet_end: string; day_rollover_hour: number } | null;
  const quietStart = (prefs?.quiet_start ?? '22:00').slice(0, 5);
  const quietEnd = (prefs?.quiet_end ?? '07:00').slice(0, 5);
  const rollover = prefs?.day_rollover_hour ?? DEFAULT_ROLLOVER_HOUR;
  const now = ctx.now();

  const tokens = unwrapRows<{ id: string }>(
    await ctx.supabase.from('push_tokens').select('id').eq('user_id', payload.user_id).is('invalidated_at', null),
    'push_tokens',
  );
  let sentToday = 0;
  if (entry.countsTowardCap) {
    const { start, end } = studyDayBounds(studyDayFor(now, timeZone, rollover), timeZone, rollover);
    sentToday = unwrapRows<{ id: string }>(
      await ctx.supabase
        .from('notification_log')
        .select('id')
        .eq('user_id', payload.user_id)
        .eq('counts_toward_cap', true)
        .not('sent_at', 'is', null)
        .gte('sent_at', start.toISOString())
        .lt('sent_at', end.toISOString()),
      'notification_log',
    ).length;
  }

  const decision = decideDelivery({
    delivery: entry.delivery,
    channel: entry.channel,
    countsTowardCap: entry.countsTowardCap,
    channelEnabled: channelEnabled(profile.settings, entry.channel),
    hasToken: tokens.length > 0,
    sentToday,
    inQuiet: inQuietHours(now, timeZone, quietStart, quietEnd),
  });

  const log = (fields: Record<string, unknown>) =>
    ctx.supabase.from('notification_log').insert({
      user_id: payload.user_id,
      type: payload.type,
      channel: entry.channel,
      counts_toward_cap: entry.countsTowardCap,
      scheduled_for: now.toISOString(),
      ...fields,
    });

  if (decision.action === 'defer') {
    // Quiet hours: the most recent notification of each type is delivered at the end of the window (PLT-05.3).
    const until = quietEndInstant(now, timeZone, quietEnd);
    const queued = await ctx.enqueue('notify.dispatch', { ...payload, deferred: true }, {
      singletonKey: `notify:${payload.user_id}:${payload.type}`,
      startAfter: until,
    });
    if (queued === null) unwrap(await log({ dropped_reason: 'quiet_hours_superseded' }), 'notification_log');
    return queued === null ? { status: 'dropped', reason: 'quiet_hours_superseded' } : { status: 'deferred', until: until.toISOString() };
  }
  if (decision.action === 'drop') {
    if (decision.reason === 'local_only') return { status: 'local_only' };
    unwrap(await log({ dropped_reason: decision.reason }), 'notification_log');
    return { status: 'dropped', reason: decision.reason };
  }

  const title = entry.title;
  const body = fillTemplate(entry.body, payload.data);
  await ctx.push(payload.user_id, {
    channel: entry.channel,
    title,
    body,
    data: { ...payload.data, type: payload.type, deep_link: fillTemplate(entry.deepLink, payload.data) },
    requested: false,
  });
  unwrap(await log({ sent_at: now.toISOString() }), 'notification_log');
  return { status: 'sent' };
}

export const jobs: JobDefinition[] = [
  { name: 'notify.dispatch', retryLimit: 3, handler: async (ctx, data) => void (await handleNotifyDispatch(ctx, data)) },
];
