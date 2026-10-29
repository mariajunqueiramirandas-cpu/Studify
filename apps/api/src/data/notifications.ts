// Data endpoints of apps/mobile/src/features/notifications: the Central de notificações (inbox.ts) and the push token
// of this install (push-token.ts). define.ts explains the contract.
import { z } from 'zod';
import { count, dataRoute, done, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();
const DeviceId = z.string().min(1).max(200);

export const routes: DataRoute[] = [
  dataRoute({
    name: 'notifications-list',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) =>
      rows(
        db
          .from('notification_inbox')
          .select('id,key,type,channel,title,body,deep_link,rich,read_at,created_at,updated_at')
          .eq('user_id', user.userId)
          .order('created_at', { ascending: false })
          .limit(100),
        'notification_inbox',
      ),
  }),

  dataRoute({
    name: 'notifications-unread-count',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: async ({ db, user }) => ({
      count: await count(db.from('notification_inbox').select('id', { count: 'exact', head: true }).eq('user_id', user.userId).is('read_at', null), 'notification_inbox.count'),
    }),
  }),

  dataRoute({
    name: 'notifications-mark-read',
    write: true,
    input: z.object({ id: Id }),
    example: (seed) => ({ id: seed.missingId }),
    run: async ({ db, input, now }) => {
      await done(db.from('notification_inbox').update({ read_at: now.toISOString() }).eq('id', input.id).is('read_at', null), 'notification_inbox.read');
      return { ok: true };
    },
  }),

  dataRoute({
    // Opening a notification from the shade: its key travels as `notif`.
    name: 'notifications-mark-read-key',
    write: true,
    input: z.object({ key: z.string().min(1).max(80) }),
    example: () => ({ key: `missing:${crypto.randomUUID()}` }),
    run: async ({ db, user, input, now }) => {
      await done(
        db.from('notification_inbox').update({ read_at: now.toISOString() }).eq('user_id', user.userId).eq('key', input.key).is('read_at', null),
        'notification_inbox.read_key',
      );
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'notifications-mark-all-read',
    write: true,
    input: z.object({}),
    example: () => ({}),
    run: async ({ db, user, now }) => {
      await done(db.from('notification_inbox').update({ read_at: now.toISOString() }).eq('user_id', user.userId).is('read_at', null), 'notification_inbox.read_all');
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'notifications-delete',
    write: true,
    input: z.object({ id: Id }),
    example: (seed) => ({ id: seed.missingId }),
    run: async ({ db, input }) => {
      await done(db.from('notification_inbox').delete().eq('id', input.id), 'notification_inbox.delete');
      return { ok: true };
    },
  }),

  dataRoute({
    // PLT-05.6: one active token per install. Same token: touch it; new token: retire the old row, insert the new one.
    name: 'push-token-save',
    write: true,
    input: z.object({ token: z.string().min(1).max(500), device_id: DeviceId, app_version: z.string().max(40).nullable().optional() }),
    example: () => ({ token: `ExponentPushToken[${crypto.randomUUID()}]`, device_id: `device-${crypto.randomUUID()}`, app_version: '1.0.0' }),
    run: async ({ db, user, input, now }) => {
      const appVersion = input.app_version ?? null;
      // A failed lookup counts as "no current row", as it did when the app queried directly.
      const lookup = await db
        .from('push_tokens')
        .select('id, token')
        .eq('user_id', user.userId)
        .eq('device_id', input.device_id)
        .is('invalidated_at', null)
        .maybeSingle();
      const current = (lookup.error ? null : lookup.data) as { id: string; token: string } | null;
      if (current?.token === input.token) {
        await db.from('push_tokens').update({ last_seen_at: now.toISOString(), app_version: appVersion }).eq('id', current.id);
        return { outcome: 'unchanged' };
      }
      if (current) await db.from('push_tokens').update({ invalidated_at: now.toISOString() }).eq('id', current.id);
      await done(
        db.from('push_tokens').insert({ user_id: user.userId, token: input.token, device_id: input.device_id, platform: 'android', app_version: appVersion }),
        'push_tokens.insert',
      );
      return { outcome: 'registered' };
    },
  }),

  dataRoute({
    // Sign-out: this install stops receiving the user's pushes (security §9).
    name: 'push-token-invalidate',
    write: true,
    input: z.object({ device_id: DeviceId }),
    example: () => ({ device_id: `device-${crypto.randomUUID()}` }),
    run: async ({ db, user, input, now }) => {
      await done(
        db.from('push_tokens').update({ invalidated_at: now.toISOString() }).eq('user_id', user.userId).eq('device_id', input.device_id).is('invalidated_at', null),
        'push_tokens.invalidate',
      );
      return { ok: true };
    },
  }),

  // features/notifications/live-jobs.ts: the student's recent top-level jobs (last 6 h) for the live progress cards.
  dataRoute({
    name: 'notifications-live-jobs',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user, now }) =>
      rows(
        db
          .from('ai_jobs')
          .select('id,type,stage,status,progress,user_id,subject_id,document_id,started_at,items_total,items_done')
          .eq('user_id', user.userId)
          .is('parent_job_id', null)
          .gte('created_at', new Date(now.getTime() - 6 * 3600_000).toISOString())
          .order('created_at', { ascending: false })
          .limit(10),
        'ai_jobs',
      ),
  }),
];
