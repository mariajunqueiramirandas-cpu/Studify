import { describe, expect, it } from 'vitest';
import { createPushService, type ExpoLike, type ExpoPushMessage, type PushMessage } from '../../src/framework/push.ts';
import type { Sql } from '../../src/framework/db.ts';
import { zonedToInstant } from '../../src/framework/timeutil.ts';
import { createLogger } from '../../src/framework/logger.ts';
import { basicRich, liveRich, nextEnemStart, richFor, RICH_MAX_BYTES, type LiveJobRow } from '../../src/lib/rich.ts';
import { handleNotifyLive } from '../../src/jobs/notify.ts';
import type { JobContext } from '../../src/framework/types.ts';

const TZ = 'America/Sao_Paulo';
const USER = '0190f3a2-7b1c-7d3e-8f00-000000000009';
const DOC = '0190f3a2-7b1c-7d3e-8f00-0000000000d1';
const SUBJECT = '0190f3a2-7b1c-7d3e-8f00-0000000000s1'.replace('s', 'a');

type Handler = (text: string, values: unknown[]) => { rows: unknown[]; rowCount?: number } | null;

/** A SQL fake answering by substring; every statement is recorded. */
function fakeSql(handlers: Handler[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      for (const h of handlers) {
        const r = h(text, values);
        if (r) return { rowCount: r.rows.length, ...r };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Sql;
  return { sql, calls };
}

const profile = (tokens: string[], settings: Record<string, unknown> = {}): Handler[] => [
  (t) => (t.includes('from public.profiles p') ? { rows: [{ timezone: TZ, settings, quiet_start: '22:00', quiet_end: '07:00', day_rollover_hour: 4 }] } : null),
  (t) => (t.includes('from public.push_tokens') ? { rows: tokens.map((token) => ({ token })) } : null),
  (t) => (t.includes('count(*)::text as n from public.notification_log') ? { rows: [{ n: '0' }] } : null),
  (t) => (t.includes('insert into public.notification_log') ? { rows: [{ id: 'log-1' }] } : null),
];

const subjectRow: Handler = (t) => (t.includes('from public.subjects') ? { rows: [{ name: 'Biologia', color: '#16A34A' }] } : null);

function fakeExpo(): ExpoLike & { sent: ExpoPushMessage[] } {
  const sent: ExpoPushMessage[] = [];
  return {
    sent,
    chunkPushNotifications: (m) => [m],
    async sendPushNotificationsAsync(chunk) {
      sent.push(...chunk);
      return chunk.map((m) => ({ status: 'ok' as const, id: `t-${m.to}` }));
    },
    async getPushNotificationReceiptsAsync() {
      return {};
    },
  };
}

function service(sql: Sql, now: Date, expo: ExpoLike | null) {
  const enqueued: Array<{ name: string; data: Record<string, unknown> }> = [];
  const svc = createPushService({
    sql,
    expo,
    now: () => now,
    log: createLogger('silent'),
    enqueue: async (name, data) => {
      enqueued.push({ name, data });
      return `job-${enqueued.length}`;
    },
  });
  return { svc, enqueued };
}

const materialReady: PushMessage = {
  channel: 'processing',
  title: 'Material pronto',
  body: 'Seu material de Biologia está pronto 📚',
  data: { type: 'material_ready', subject_id: SUBJECT, document_id: DOC, deep_link: `studify://subjects/${SUBJECT}` },
  requested: true,
};

describe('rich pushes (api.md §9.1)', () => {
  it('attaches the enriched payload to the push and keeps it in the inbox', async () => {
    const { sql, calls } = fakeSql([...profile(['ExponentPushToken[a]']), subjectRow]);
    const expo = fakeExpo();
    const { svc } = service(sql, zonedToInstant(2026, 10, 27, 15, 0, TZ), expo);
    expect(await svc.push(USER, materialReady)).toBe('sent');
    const rich = expo.sent[0]!.data.rich as Record<string, unknown>;
    expect(rich).toMatchObject({ key: `doc:${DOC}`, template: 'progress', accent: '#16A34A', sub: 'Biologia' });
    expect((rich.progress as { state: string; fraction: number })).toMatchObject({ state: 'done', fraction: 1 });
    expect(rich.actions).toEqual([{ id: 'open', label: 'Estudar agora', kind: 'open', deep_link: `studify://subjects/${SUBJECT}` }]);
    const inbox = calls.find((c) => c.text.includes('insert into public.notification_inbox'));
    expect(inbox?.values.slice(0, 4)).toEqual([USER, `doc:${DOC}`, 'material_ready', 'processing']);
  });

  it('keeps the inbox row even when the push is deferred to the end of quiet hours', async () => {
    const { sql, calls } = fakeSql([...profile(['t']), subjectRow]);
    const { svc, enqueued } = service(sql, zonedToInstant(2026, 10, 27, 23, 30, TZ), fakeExpo());
    expect(await svc.push(USER, materialReady)).toBe('deferred');
    expect(calls.some((c) => c.text.includes('insert into public.notification_inbox'))).toBe(true);
    // The deferred delivery carries the payload built now.
    const deferred = enqueued.find((e) => e.name === 'notify.deliver')!.data.message as PushMessage;
    expect((deferred.data?.rich as { key: string }).key).toBe(`doc:${DOC}`);
  });

  it('writes the inbox without any device token (the app shows it anyway)', async () => {
    const { sql, calls } = fakeSql([...profile([]), subjectRow]);
    const { svc } = service(sql, zonedToInstant(2026, 10, 27, 15, 0, TZ), fakeExpo());
    expect(await svc.push(USER, materialReady)).toBe('dropped');
    expect(calls.some((c) => c.text.includes('insert into public.notification_inbox'))).toBe(true);
  });

  it('sends live progress data-only, without inbox, log or cap, and never in quiet hours', async () => {
    const job: LiveJobRow = { id: 'j1', type: 'ingest.document', stage: 'S2', status: 'running', progress: 0.6, user_id: USER, subject_id: SUBJECT, document_id: DOC, started_at: null };
    const rich = liveRich(job, { name: 'Biologia', color: '#16A34A' })!;
    const live: PushMessage = { channel: 'processing', title: rich.title, body: rich.body, data: { type: 'live_progress' }, rich, ephemeral: true, requested: true };
    const day = fakeSql(profile(['t']));
    const expo = fakeExpo();
    expect(await service(day.sql, zonedToInstant(2026, 10, 27, 15, 0, TZ), expo).svc.push(USER, live)).toBe('sent');
    expect(expo.sent[0]).toMatchObject({ priority: 'high' });
    expect(expo.sent[0]!.title).toBeUndefined();
    expect(day.calls.some((c) => c.text.includes('notification_inbox') || c.text.includes('insert into public.notification_log'))).toBe(false);
    const night = fakeSql(profile(['t']));
    expect(await service(night.sql, zonedToInstant(2026, 10, 27, 23, 30, TZ), fakeExpo()).svc.push(USER, live)).toBe('dropped');
  });
});

describe('rich payload builders', () => {
  const src = (type: string, data: Record<string, unknown>) => ({ type, channel: 'processing' as const, title: 'Título', body: 'Corpo', data });

  it('falls back to a basic payload for unknown types and failed lookups', async () => {
    const { sql } = fakeSql([]);
    expect((await richFor(sql, USER, src('export_ready', { export_id: 'e1', deep_link: 'studify://profile/privacy' })))).toMatchObject({
      template: 'basic',
      key: 'export_ready:e1',
      glyph: 'check',
      deep_link: 'studify://profile/privacy',
    });
    const broken = { async query() { throw new Error('db down'); } } as unknown as Sql;
    expect((await richFor(broken, USER, src('essay_graded', { essay_id: 'x' }))).template).toBe('basic');
  });

  it('builds the redação score with competências and the change since the last one', async () => {
    const { sql } = fakeSql([
      (t) => (t.includes('from public.essays where id') ? { rows: [{ total: 840, competencias: { c1: { score: 160 }, c2: { score: 200 }, c3: { score: 160 }, c4: { score: 160 }, c5: { score: 160 } }, created_at: '2026-10-27T10:00:00Z' }] } : null),
      (t) => (t.includes('order by created_at desc limit 1') && t.includes('public.essays') ? { rows: [{ total: 760 }] } : null),
    ]);
    const rich = await richFor(sql, USER, { ...src('essay_graded', { essay_id: 'es1', deep_link: 'studify://enem/essay/es1' }), channel: 'processing' });
    expect(rich.template).toBe('score');
    expect(rich.score).toMatchObject({ value: 840, max: 1000, delta: 80 });
    expect(rich.score!.breakdown.map((b) => b.value)).toEqual([0.8, 1, 0.8, 0.8, 0.8]);
  });

  it('builds a duel challenge with the challenger name and a snooze button', async () => {
    const { sql } = fakeSql([
      (t) => (t.includes('from public.duels') ? { rows: [{ challenger_id: 'other', opponent_id: USER, challenger_score: null, opponent_score: null, quiz_id: 'q' }] } : null),
    ]);
    const rich = await richFor(sql, USER, { type: 'duel_challenge', channel: 'class', title: 'Novo duelo', body: 'Ana te desafiou', data: { duel_id: 'd1', nome: 'Ana', materia: 'Química', deep_link: 'studify://class/g/duel/d1' } });
    expect(rich).toMatchObject({ template: 'duel', key: 'duel:d1', group: 'turma' });
    expect(rich.duel).toMatchObject({ them: { name: 'Ana' }, state: 'challenge', subject: 'Química' });
    expect(rich.actions.map((a) => a.kind)).toEqual(['open', 'snooze']);
  });

  it('never sends a payload over the FCM budget', async () => {
    const { sql } = fakeSql([(t) => (t.includes('atualidades_items') ? { rows: Array.from({ length: 5 }, () => ({ title: 'x'.repeat(200) })) } : null)]);
    const rich = await richFor(sql, USER, src('atualidades_published', { digest_id: 'dg' }));
    expect(JSON.stringify(rich).length).toBeLessThanOrEqual(RICH_MAX_BYTES);
    expect(rich.template).toBe('digest');
  });

  it('keys live progress by material so "Material pronto" replaces it, and estimates time left', () => {
    const now = new Date('2026-10-27T15:10:00Z');
    const job: LiveJobRow = { id: 'j1', type: 'ingest.document', stage: 'S2', status: 'running', progress: 0.6, user_id: USER, subject_id: SUBJECT, document_id: DOC, started_at: '2026-10-27T15:04:00Z' };
    const rich = liveRich(job, null, now)!;
    expect(rich).toMatchObject({ key: `doc:${DOC}`, channel: 'live', template: 'progress', body: 'Resumos…' });
    expect(rich.progress!.fraction).toBe(0.6);
    expect(rich.progress!.eta_s).toBe(240);
    expect(liveRich({ ...job, type: 'mastery.recompute' }, null, now)).toBeNull();
    expect(liveRich({ ...job, status: 'succeeded' }, null, now)).toBeNull();
  });

  it('finds the next ENEM day start in Brasília time', () => {
    const e = { day1_date: '2026-11-08', day2_date: '2026-11-15', start_time: '13:30:00' };
    expect(nextEnemStart(e, new Date('2026-11-01T12:00:00Z'))).toBe('2026-11-08T16:30:00.000Z');
    expect(nextEnemStart(e, new Date('2026-11-10T12:00:00Z'))).toBe('2026-11-15T16:30:00.000Z');
    expect(nextEnemStart(e, new Date('2026-11-20T12:00:00Z'))).toBeNull();
  });

  it('basic payloads are always valid', () => {
    expect(basicRich({ type: 'x', channel: 'plan', title: 'T'.repeat(200), body: 'B'.repeat(500), data: {} })).toMatchObject({ key: 'x:latest' });
  });
});

describe('notify.live', () => {
  function ctxWith(job: Partial<LiveJobRow> | null) {
    const pushes: Array<{ userId: string; message: PushMessage }> = [];
    const ctx = {
      db: {
        async query(text: string) {
          if (text.includes('from public.ai_jobs')) return { rows: job ? [{ id: 'job1', type: 'podcast.generate', stage: 'audio', status: 'running', progress: 0.6, user_id: USER, subject_id: null, document_id: null, started_at: null, ...job }] : [] };
          return { rows: [] };
        },
      },
      now: () => new Date('2026-10-27T15:00:00Z'),
      push: async (userId: string, message: PushMessage) => void pushes.push({ userId, message }),
    } as unknown as JobContext;
    return { ctx, pushes };
  }

  it('pushes the live payload for a running job', async () => {
    const { ctx, pushes } = ctxWith({});
    expect(await handleNotifyLive(ctx, { ai_job_id: '0190f3a2-7b1c-7d3e-8f00-000000000001' })).toBe('updated');
    expect(pushes[0]!.message).toMatchObject({ ephemeral: true, rich: { key: 'job:job1', title: 'Gravando seu podcast' } });
  });

  it('cancels the bar when a podcast finishes; a material waits for its own "pronto"', async () => {
    const done = ctxWith({ status: 'succeeded' });
    expect(await handleNotifyLive(done.ctx, { ai_job_id: '0190f3a2-7b1c-7d3e-8f00-000000000001' })).toBe('ended');
    expect(done.pushes[0]!.message.data).toMatchObject({ rich_cancel: 'job:job1' });
    const material = ctxWith({ type: 'ingest.document', status: 'succeeded', document_id: DOC });
    expect(await handleNotifyLive(material.ctx, { ai_job_id: '0190f3a2-7b1c-7d3e-8f00-000000000001' })).toBe('ended');
    expect(material.pushes).toHaveLength(0);
  });

  it('skips jobs that are not shown live', async () => {
    const { ctx, pushes } = ctxWith({ type: 'mastery.recompute' });
    expect(await handleNotifyLive(ctx, { ai_job_id: '0190f3a2-7b1c-7d3e-8f00-000000000001' })).toBe('skipped');
    expect(pushes).toHaveLength(0);
  });
});
