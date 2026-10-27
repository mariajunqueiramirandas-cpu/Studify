// Push notifications through the Expo Push API (-> FCM). Enforces PLT-05: quiet hours defer delivery to
// the end of the window, unrequested notifications are capped at 3 per study day, disabled channels are
// skipped, and tokens that Expo reports as DeviceNotRegistered are invalidated. Every decision writes a
// notification_log row (no message text is stored there).
import type { Sql } from './db.ts';
import type { Logger } from './logger.ts';
import { quietWindowEnd, studyDayStart } from './timeutil.ts';

export type PushChannel = 'reviews' | 'plan' | 'class' | 'processing';

export interface PushMessage {
  channel: PushChannel;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** True when the user asked for it (material ready, export ready): exempt from the daily cap. */
  requested?: boolean;
}

export type PushOutcome = 'sent' | 'deferred' | 'dropped';

export const DAILY_UNREQUESTED_CAP = 3;

/** The subset of the Expo SDK the worker uses. The real `Expo` class satisfies it. */
export interface ExpoLike {
  chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
  sendPushNotificationsAsync(chunk: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, ExpoPushReceipt>>;
}

export interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: 'default';
  channelId: string;
}

export type ExpoPushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export type ExpoPushReceipt =
  | { status: 'ok' }
  | { status: 'error'; message: string; details?: { error?: string } };

export interface PushDeps {
  sql: Sql;
  expo: ExpoLike | null;
  now: () => Date;
  log: Logger;
  /** Enqueues a worker job (pg-boss send). Returns the job id, or null when a singleton blocked it. */
  enqueue: (name: string, data: Record<string, unknown>, opts?: { startAfter?: Date | number; singletonKey?: string }) => Promise<string | null>;
}

interface PushPrefs {
  timezone: string;
  quietStart: string;
  quietEnd: string;
  rolloverHour: number;
  notifications: Record<string, boolean>;
  tokens: string[];
}

const RECEIPT_DELAY_MS = 15 * 60_000;

export function createPushService(deps: PushDeps) {
  const { sql, now, log } = deps;

  async function loadPrefs(userId: string): Promise<PushPrefs | null> {
    const { rows } = await sql.query<{
      timezone: string;
      settings: Record<string, unknown> | null;
      quiet_start: string | null;
      quiet_end: string | null;
      day_rollover_hour: number | null;
    }>(
      `select p.timezone, p.settings, s.quiet_start::text, s.quiet_end::text, s.day_rollover_hour
         from public.profiles p
         left join public.study_preferences s on s.user_id = p.id
        where p.id = $1 and p.deleted_at is null`,
      [userId],
    );
    const row = rows[0];
    if (!row) return null;
    const tokens = await sql.query<{ token: string }>(
      `select token from public.push_tokens where user_id = $1 and invalidated_at is null`,
      [userId],
    );
    const settings = row.settings ?? {};
    const notifications = (settings.notifications ?? {}) as Record<string, boolean>;
    return {
      timezone: row.timezone || 'America/Sao_Paulo',
      quietStart: row.quiet_start ?? '22:00',
      quietEnd: row.quiet_end ?? '07:00',
      rolloverHour: row.day_rollover_hour ?? 4,
      notifications,
      tokens: tokens.rows.map((t) => t.token),
    };
  }

  async function writeLog(entry: {
    userId: string;
    type: string;
    channel: PushChannel;
    counts: boolean;
    scheduledFor: Date;
    sentAt: Date | null;
    droppedReason: string | null;
  }): Promise<string> {
    const { rows } = await sql.query<{ id: string }>(
      `insert into public.notification_log
         (user_id, type, channel, counts_toward_cap, scheduled_for, sent_at, dropped_reason)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [entry.userId, entry.type, entry.channel, entry.counts, entry.scheduledFor, entry.sentAt, entry.droppedReason],
    );
    return rows[0]?.id ?? '';
  }

  async function countedToday(userId: string, prefs: PushPrefs): Promise<number> {
    const start = studyDayStart(now(), prefs.timezone, prefs.rolloverHour);
    const { rows } = await sql.query<{ n: string }>(
      `select count(*)::text as n from public.notification_log
        where user_id = $1 and counts_toward_cap and sent_at >= $2`,
      [userId, start],
    );
    return Number(rows[0]?.n ?? '0');
  }

  function typeOf(message: PushMessage): string {
    const type = message.data?.type;
    return typeof type === 'string' ? type : message.channel;
  }

  /** Sends now (no quiet-hour check). Used directly and by the deferred notify.deliver job. */
  async function deliverNow(userId: string, message: PushMessage, scheduledFor: Date): Promise<PushOutcome> {
    const prefs = await loadPrefs(userId);
    const type = typeOf(message);
    const counts = message.requested !== true;
    if (!prefs) {
      await writeLog({ userId, type, channel: message.channel, counts, scheduledFor, sentAt: null, droppedReason: 'disabled' });
      return 'dropped';
    }
    if (prefs.notifications[message.channel] === false) {
      await writeLog({ userId, type, channel: message.channel, counts, scheduledFor, sentAt: null, droppedReason: 'disabled' });
      return 'dropped';
    }
    if (prefs.tokens.length === 0) {
      await writeLog({ userId, type, channel: message.channel, counts, scheduledFor, sentAt: null, droppedReason: 'no_token' });
      return 'dropped';
    }
    if (counts && (await countedToday(userId, prefs)) >= DAILY_UNREQUESTED_CAP) {
      await writeLog({ userId, type, channel: message.channel, counts, scheduledFor, sentAt: null, droppedReason: 'daily_cap' });
      return 'dropped';
    }
    if (!deps.expo) {
      // No Expo token configured (local runs and tests): record the decision, deliver nothing.
      log.warn({ type }, 'push skipped: EXPO_ACCESS_TOKEN not configured');
      await writeLog({ userId, type, channel: message.channel, counts, scheduledFor, sentAt: null, droppedReason: 'disabled' });
      return 'dropped';
    }

    const expo = deps.expo;
    const messages: ExpoPushMessage[] = prefs.tokens.map((to) => ({
      to,
      title: message.title,
      body: message.body,
      data: { ...(message.data ?? {}), type },
      sound: 'default',
      channelId: message.channel,
    }));
    const ticketsByToken: Array<{ token: string; ticket: ExpoPushTicket }> = [];
    for (const chunk of expo.chunkPushNotifications(messages)) {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, index) => {
        const token = chunk[index]?.to ?? '';
        ticketsByToken.push({ token, ticket });
      });
    }
    for (const { token, ticket } of ticketsByToken) {
      if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        await invalidateToken(token);
      }
    }
    const receipts = ticketsByToken.flatMap(({ token, ticket }) =>
      ticket.status === 'ok' ? [{ id: ticket.id, token }] : [],
    );
    await writeLog({ userId, type, channel: message.channel, counts, scheduledFor, sentAt: now(), droppedReason: null });
    if (receipts.length > 0) {
      await deps.enqueue('push.receipts', { receipts, attempt: 1 }, { startAfter: new Date(now().getTime() + RECEIPT_DELAY_MS) });
    }
    return 'sent';
  }

  async function invalidateToken(token: string): Promise<void> {
    await sql.query(
      `update public.push_tokens set invalidated_at = now(), updated_at = now() where token = $1 and invalidated_at is null`,
      [token],
    );
  }

  /**
   * Entry point for producers (`JobContext.push`). Quiet hours defer the message to the end of the
   * window; the caller's `requested` flag decides whether it counts toward the daily cap.
   */
  async function push(userId: string, message: PushMessage): Promise<PushOutcome> {
    const prefs = await loadPrefs(userId);
    const current = now();
    if (prefs) {
      const end = quietWindowEnd(current, prefs.timezone, prefs.quietStart, prefs.quietEnd);
      if (end) {
        const type = typeOf(message);
        const counts = message.requested !== true;
        const logId = await writeLog({ userId, type, channel: message.channel, counts, scheduledFor: end, sentAt: null, droppedReason: null });
        const jobId = await deps.enqueue(
          'notify.deliver',
          { userId, message, logId },
          { startAfter: end, singletonKey: `notify:${userId}:${type}:${end.toISOString()}` },
        );
        if (jobId === null) {
          // A notification of this type is already waiting for the same window: keep the first one.
          await sql.query(`update public.notification_log set dropped_reason = 'quiet_hours_superseded' where id = $1`, [logId]);
          return 'dropped';
        }
        return 'deferred';
      }
    }
    return deliverNow(userId, message, current);
  }

  /** Runs a deferred delivery (notify.deliver job). The quiet window has already ended. */
  async function deliverDeferred(data: { userId: string; message: PushMessage; logId: string }): Promise<PushOutcome> {
    const outcome = await deliverNow(data.userId, data.message, now());
    if (data.logId) {
      await sql.query(`delete from public.notification_log where id = $1 and sent_at is null and dropped_reason is null`, [data.logId]);
    }
    return outcome;
  }

  /** Checks Expo receipts and invalidates tokens reported as DeviceNotRegistered (notify.receipts). */
  async function checkReceipts(data: { receipts: Array<{ id: string; token: string }> }): Promise<number> {
    if (!deps.expo || data.receipts.length === 0) return 0;
    const byId = new Map(data.receipts.map((r) => [r.id, r.token]));
    const receipts = await deps.expo.getPushNotificationReceiptsAsync([...byId.keys()]);
    let invalidated = 0;
    for (const [id, receipt] of Object.entries(receipts)) {
      if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
        const token = byId.get(id);
        if (token) {
          await invalidateToken(token);
          invalidated++;
        }
      }
    }
    return invalidated;
  }

  return { push, deliverDeferred, checkReceipts };
}

export type PushService = ReturnType<typeof createPushService>;

/** Creates the real Expo client when a token is configured. Returns null otherwise. */
export async function createExpoClient(accessToken: string | null): Promise<ExpoLike | null> {
  if (!accessToken) return null;
  const { Expo } = await import('expo-server-sdk');
  return new Expo({ accessToken }) as unknown as ExpoLike;
}
