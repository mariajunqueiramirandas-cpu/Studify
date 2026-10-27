import { describe, expect, it } from 'vitest';
import { createPushService, type ExpoLike, type ExpoPushMessage } from '../../src/framework/push.ts';
import type { Sql } from '../../src/framework/db.ts';
import { zonedToInstant } from '../../src/framework/timeutil.ts';
import { createLogger } from '../../src/framework/logger.ts';

const TZ = 'America/Sao_Paulo';
const USER = '0190f3a2-7b1c-7d3e-8f00-000000000009';

interface Db {
  profile?: { settings: Record<string, unknown>; tz?: string };
  prefs?: { quiet_start: string; quiet_end: string };
  tokens: string[];
  sentToday: number;
}

/** Answers the few queries the push service issues. Writes are recorded in `log`. */
function fakeDb(db: Db) {
  const log: Array<{ text: string; values: unknown[] }> = [];
  const invalidated: string[] = [];
  const sql: Sql = {
    async query(text: string, values: unknown[] = []) {
      if (text.includes('from public.profiles p')) {
        return db.profile
          ? { rows: [{ timezone: db.profile.tz ?? TZ, settings: db.profile.settings, quiet_start: db.prefs?.quiet_start ?? '22:00', quiet_end: db.prefs?.quiet_end ?? '07:00', day_rollover_hour: 4 }] }
          : { rows: [] };
      }
      if (text.includes('from public.push_tokens')) return { rows: db.tokens.map((token) => ({ token })) };
      if (text.includes('count(*)::text as n from public.notification_log')) return { rows: [{ n: String(db.sentToday) }] };
      if (text.includes('update public.push_tokens')) {
        invalidated.push(String(values[0]));
        return { rows: [] };
      }
      log.push({ text, values });
      return { rows: [{ id: `log-${log.length}` }] };
    },
  };
  return { sql, log, invalidated };
}

function fakeExpo(errorFor?: string): ExpoLike & { sent: ExpoPushMessage[] } {
  const sent: ExpoPushMessage[] = [];
  return {
    sent,
    chunkPushNotifications: (messages) => [messages],
    async sendPushNotificationsAsync(chunk) {
      sent.push(...chunk);
      return chunk.map((m) =>
        m.to === errorFor ? { status: 'error' as const, message: 'gone', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' as const, id: `t-${m.to}` },
      );
    },
    async getPushNotificationReceiptsAsync() {
      return {};
    },
  };
}

function service(db: Db, opts: { now: Date; expo?: ExpoLike | null; enqueued?: Array<{ name: string; data: Record<string, unknown>; opts?: unknown }>; singletonTaken?: boolean }) {
  const fake = fakeDb(db);
  const enqueued = opts.enqueued ?? [];
  const svc = createPushService({
    sql: fake.sql,
    expo: opts.expo ?? null,
    now: () => opts.now,
    log: createLogger('silent'),
    enqueue: async (name, data, options) => {
      enqueued.push({ name, data, opts: options });
      return opts.singletonTaken ? null : `job-${enqueued.length}`;
    },
  });
  return { svc, fake, enqueued };
}

const message = { channel: 'processing' as const, title: 'Material pronto', body: 'Seu material de Biologia está pronto 📚', data: { type: 'material_ready' }, requested: true };

describe('push service (PLT-05)', () => {
  it('sends to every registered token when the channel is enabled and outside quiet hours', async () => {
    const expo = fakeExpo();
    const { svc, fake } = service({ profile: { settings: {} }, tokens: ['ExponentPushToken[a]', 'ExponentPushToken[b]'], sentToday: 0 }, {
      now: zonedToInstant(2026, 10, 27, 15, 0, TZ),
      expo,
    });
    expect(await svc.push(USER, message)).toBe('sent');
    expect(expo.sent.map((m) => m.to)).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]']);
    expect(expo.sent[0]?.data).toMatchObject({ type: 'material_ready' });
    expect(fake.log.at(-1)?.values).toContain('processing');
  });

  it('defers to the end of quiet hours and schedules a delivery job with a singleton key', async () => {
    const enqueued: Array<{ name: string; data: Record<string, unknown>; opts?: unknown }> = [];
    const { svc } = service({ profile: { settings: {} }, tokens: ['t'], sentToday: 0 }, {
      now: zonedToInstant(2026, 10, 27, 23, 15, TZ),
      expo: fakeExpo(),
      enqueued,
    });
    expect(await svc.push(USER, message)).toBe('deferred');
    expect(enqueued[0]?.name).toBe('notify.deliver');
    const opts = enqueued[0]?.opts as { startAfter: Date; singletonKey: string };
    expect(opts.startAfter.toISOString()).toBe(zonedToInstant(2026, 10, 28, 7, 0, TZ).toISOString());
    expect(opts.singletonKey).toContain(`notify:${USER}:material_ready`);
  });

  it('drops a second deferred notification of the same type in the same window', async () => {
    const { svc, fake } = service({ profile: { settings: {} }, tokens: ['t'], sentToday: 0 }, {
      now: zonedToInstant(2026, 10, 27, 23, 15, TZ),
      expo: fakeExpo(),
      singletonTaken: true,
    });
    expect(await svc.push(USER, message)).toBe('dropped');
    expect(fake.log.some((w) => w.text.includes('insert into public.notification_log'))).toBe(true);
  });

  it('applies the cap of 3 unrequested notifications per study day but not to requested ones', async () => {
    const unrequested = { ...message, requested: false, data: { type: 'reviews_due' }, channel: 'reviews' as const };
    const capped = service({ profile: { settings: {} }, tokens: ['t'], sentToday: 3 }, { now: zonedToInstant(2026, 10, 27, 15, 0, TZ), expo: fakeExpo() });
    expect(await capped.svc.push(USER, unrequested)).toBe('dropped');
    const requested = service({ profile: { settings: {} }, tokens: ['t'], sentToday: 3 }, { now: zonedToInstant(2026, 10, 27, 15, 0, TZ), expo: fakeExpo() });
    expect(await requested.svc.push(USER, message)).toBe('sent');
  });

  it('skips a channel the user turned off', async () => {
    const { svc } = service({ profile: { settings: { notifications: { processing: false } } }, tokens: ['t'], sentToday: 0 }, {
      now: zonedToInstant(2026, 10, 27, 15, 0, TZ),
      expo: fakeExpo(),
    });
    expect(await svc.push(USER, message)).toBe('dropped');
  });

  it('invalidates tokens that Expo reports as DeviceNotRegistered', async () => {
    const { svc, fake } = service({ profile: { settings: {} }, tokens: ['dead', 'alive'], sentToday: 0 }, {
      now: zonedToInstant(2026, 10, 27, 15, 0, TZ),
      expo: fakeExpo('dead'),
    });
    await svc.push(USER, message);
    expect(fake.invalidated).toEqual(['dead']);
  });

  it('records a drop when no token is registered', async () => {
    const { svc, fake } = service({ profile: { settings: {} }, tokens: [], sentToday: 0 }, {
      now: zonedToInstant(2026, 10, 27, 15, 0, TZ),
      expo: fakeExpo(),
    });
    expect(await svc.push(USER, message)).toBe('dropped');
    expect(fake.log.at(-1)?.values).toContain('no_token');
  });
});
