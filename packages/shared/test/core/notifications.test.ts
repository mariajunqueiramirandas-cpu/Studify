import { describe, expect, it } from 'vitest';
import { LIVE_JOB_STEPS, liveJobProgress, liveRich, parseRichNotification, RichNotificationSchema, type RichNotificationInput } from '../../src/index.ts';

const base: RichNotificationInput = { v: 1, key: 'k1', template: 'basic', channel: 'plan', title: 'Oi', body: 'Corpo' };

describe('rich notification payloads (PLT-05)', () => {
  it('fills defaults for a basic notification', () => {
    const n = parseRichNotification(base)!;
    expect(n.glyph).toBe('sparkles');
    expect(n.actions).toEqual([]);
  });

  it('requires the block of its template', () => {
    expect(parseRichNotification({ ...base, template: 'goal' })).toBeNull();
    expect(parseRichNotification({ ...base, template: 'goal', goal: { done_min: 12, goal_min: 20, streak: 4, shields: 1 } })).not.toBeNull();
  });

  it('keeps running progress on the silent live channel', () => {
    const progress = { steps: [{ label: 'Lendo o PDF', state: 'active' as const }], fraction: 0.1, state: 'running' as const };
    expect(RichNotificationSchema.safeParse({ ...base, template: 'progress', channel: 'processing', progress }).success).toBe(false);
    expect(RichNotificationSchema.safeParse({ ...base, template: 'progress', channel: 'live', progress }).success).toBe(true);
    // A finished job may land on its regular channel (it is the "material pronto" notification).
    expect(RichNotificationSchema.safeParse({ ...base, template: 'progress', channel: 'processing', progress: { ...progress, state: 'done', fraction: 1 } }).success).toBe(true);
  });

  it('validates actions: open needs a studify deep link, ids are unique, at most 3', () => {
    const open = { id: 'a', label: 'Abrir', kind: 'open' as const };
    expect(parseRichNotification({ ...base, actions: [open] })).toBeNull();
    expect(parseRichNotification({ ...base, actions: [{ ...open, deep_link: 'https://evil.example' }] })).toBeNull();
    expect(parseRichNotification({ ...base, actions: [{ ...open, deep_link: 'studify://today' }] })).not.toBeNull();
    const snooze = { id: 'a', label: 'Depois', kind: 'snooze' as const, snooze_min: 60 };
    expect(parseRichNotification({ ...base, actions: [{ ...open, deep_link: 'studify://today' }, snooze] })).toBeNull();
    const four = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, kind: 'dismiss' as const }));
    expect(parseRichNotification({ ...base, actions: four })).toBeNull();
  });

  it('rejects colors and deep links in the wrong shape', () => {
    expect(parseRichNotification({ ...base, accent: 'red' })).toBeNull();
    expect(parseRichNotification({ ...base, accent: '#3A6FD8', deep_link: 'studify://subjects/1' })).not.toBeNull();
  });
});

describe('live job progress', () => {
  it('maps ingestion stages to steps and fills the current step\'s band with its stage progress', () => {
    const p = liveJobProgress('ingest.document', 'S2', 'running', 0.5);
    expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'active', 'pending']);
    // Bands: reading 0–0.1, map 0.1–0.25, concepts 0.25–0.5, content 0.5–1.
    expect(p.fraction).toBe(0.38);
    expect(p.state).toBe('running');
    expect(liveJobProgress('ingest.document', 'S0', 'running', null).fraction).toBe(0.01);
    expect(liveJobProgress('ingest.document', 'S3', 'running', 0).steps[2]!.state).toBe('active');
    expect(liveJobProgress('ingest.document', 'transcription', 'running', null).steps[0]!.state).toBe('active');
  });

  it('keeps every step label within the notification\'s 24 characters', () => {
    for (const steps of Object.values(LIVE_JOB_STEPS)) for (const s of steps) expect(s.label.length).toBeLessThanOrEqual(24);
  });

  it('only moves forward across ingestion stages', () => {
    const points: Array<[string, number]> = [['S0', 0], ['S0', 1], ['S1', 0], ['S1', 1], ['S2', 0], ['S2', 1], ['S4', 0], ['S4', 0.5], ['S4', 1]];
    const fractions = points.map(([stage, progress]) => liveJobProgress('ingest.document', stage, 'running', progress).fraction);
    for (let i = 1; i < fractions.length; i++) expect(fractions[i]!).toBeGreaterThanOrEqual(fractions[i - 1]!);
    expect(fractions.at(-1)).toBe(0.99);
  });

  it('finishes and fails cleanly', () => {
    const done = liveJobProgress('podcast.generate', 'done', 'succeeded', 1);
    expect(done).toMatchObject({ fraction: 1, state: 'done' });
    expect(done.steps.every((s) => s.state === 'done')).toBe(true);
    const failed = liveJobProgress('essay.grade', 'repertorio', 'failed', 0.7);
    expect(failed.state).toBe('failed');
    expect(failed.steps.map((s) => s.state)).toEqual(['done', 'failed', 'pending']);
  });

  it('fills podcast and essay bands with the progress their jobs report', () => {
    expect(liveJobProgress('podcast.generate', 'script', 'running', 0.1).fraction).toBe(0.1);
    expect(liveJobProgress('podcast.generate', 'audio', 'running', 0.6).fraction).toBe(0.6);
    expect(liveJobProgress('podcast.generate', 'audio', 'running', 0.8).fraction).toBe(0.8);
    expect(liveJobProgress('essay.grade', 'repertorio', 'running', 0.7).fraction).toBe(0.7);
  });

  it('treats an unknown stage as the first step', () => {
    expect(liveJobProgress('pp.generate', 'something_new', 'running', null).steps[0]!.state).toBe('active');
  });
});

describe('live material notification', () => {
  const job = { id: 'j1', type: 'ingest.document', stage: 'S4', status: 'running', progress: 0.5, user_id: 'u1', subject_id: 's1', document_id: 'd1', started_at: '2026-10-29T12:00:00Z' };
  const subject = { name: 'Biologia', color: '#16A34A' };

  it('names the step and opens the processing screen before any topic is ready', () => {
    const rich = liveRich({ ...job, stage: 'S2', items_total: 5, items_done: 2 }, subject)!;
    expect(rich.body).toBe('Encontrando conceitos…');
    expect(rich.deep_link).toBe('studify://subjects/s1/processing');
    expect(rich.actions).toEqual([]);
  });

  it('says how many topics are ready and opens the subject on them while the rest is written', () => {
    const rich = liveRich({ ...job, items_total: 5, items_done: 2 }, subject)!;
    expect(rich.body).toBe('2 de 5 tópicos prontos: já dá pra estudar');
    expect(rich.deep_link).toBe('studify://subjects/s1');
    expect(rich.actions).toEqual([expect.objectContaining({ id: 'open', label: 'Estudar agora', deep_link: 'studify://subjects/s1' })]);
  });
});
