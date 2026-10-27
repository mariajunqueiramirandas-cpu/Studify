import { describe, expect, it } from 'vitest';
import { liveJobProgress, parseRichNotification, RichNotificationSchema, type RichNotificationInput } from '../../src/index.ts';

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
  it('maps ingestion stages to steps and keeps the bar inside the current step', () => {
    const p = liveJobProgress('ingest.document', 'S2', 'running', 0.9);
    expect(p.steps.map((s) => s.state)).toEqual(['done', 'done', 'active', 'pending']);
    expect(p.fraction).toBe(0.75);
    expect(p.state).toBe('running');
    expect(liveJobProgress('ingest.document', 'S0', 'running', null).fraction).toBe(0.13);
  });

  it('finishes and fails cleanly', () => {
    const done = liveJobProgress('podcast.generate', 'done', 'succeeded', 1);
    expect(done).toMatchObject({ fraction: 1, state: 'done' });
    expect(done.steps.every((s) => s.state === 'done')).toBe(true);
    const failed = liveJobProgress('essay.grade', 'repertorio', 'failed', 0.7);
    expect(failed.state).toBe('failed');
    expect(failed.steps.map((s) => s.state)).toEqual(['done', 'failed', 'pending']);
  });

  it('treats an unknown stage as the first step', () => {
    expect(liveJobProgress('pp.generate', 'something_new', 'running', null).steps[0]!.state).toBe('active');
  });
});
