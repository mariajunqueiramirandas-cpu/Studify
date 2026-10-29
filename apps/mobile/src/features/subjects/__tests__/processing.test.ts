/// <reference types="jest" />
import { ingestionJob, ingestionView, topicProgress } from '../progress';
import type { AiJob } from '../api';

jest.mock('../../../api/supabase', () => ({ supabase: {} }));

const job = (over: Partial<AiJob>): AiJob => ({
  id: 'j1',
  type: 'ingest.document',
  stage: 'S0',
  status: 'running',
  items_total: null,
  items_done: null,
  progress: null,
  error_code: null,
  subject_id: 's1',
  document_id: 'd1',
  created_at: '2026-10-27T21:56:00Z',
  updated_at: '2026-10-27T21:56:00Z',
  ...over,
});

describe('ingestion progress view', () => {
  it('follows the material\'s own job, never a newer side job', () => {
    const side = job({ id: 'j2', type: 'ingest.material_check', stage: null, status: 'failed' });
    const main = job({ stage: 'S2' });
    expect(ingestionJob([side, main])).toBe(main);
    expect(ingestionJob([side, main], 'd1')).toBe(main);
    expect(ingestionJob([side, main], 'other')).toBeUndefined();
  });

  it('names the same four steps as the live notification and counts topics where they apply', () => {
    const v = ingestionView(job({ stage: 'S4', items_total: 20, items_done: 5 }), { status: 'processing' });
    expect(v.steps.map((s) => s.label)).toEqual(['Lendo o material', 'Montando o mapa', 'Encontrando conceitos', 'Resumos e cartões']);
    expect(v.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'active']);
    expect(v.label).toBe('Resumos e cartões… · 5 de 20 tópicos');
    expect(ingestionView(job({ stage: 'S1' }), { status: 'processing' }).label).toBe('Montando o mapa…');
  });

  it('moves the bar forward only, across the whole material', () => {
    const at = (stage: string, done: number | null, total: number | null) => ingestionView(job({ stage, items_done: done, items_total: total }), { status: 'processing' }).fraction;
    const series = [at('S0', null, null), at('S1', null, null), at('S2', 0, 20), at('S2', 20, 20), at('S4', 0, 20), at('S4', 10, 20), at('S4', 20, 20)];
    for (let i = 1; i < series.length; i++) expect(series[i]!).toBeGreaterThanOrEqual(series[i - 1]!);
    // A finished concepts stage is not shown as a full bar: content is still ahead.
    expect(at('S2', 20, 20)).toBeLessThanOrEqual(0.5);
  });

  it('shows done, failed and paused plainly', () => {
    expect(ingestionView(job({ status: 'succeeded', stage: 'S4' }), { status: 'ready' })).toMatchObject({ fraction: 1 });
    expect(ingestionView(job({ status: 'running' }), { status: 'failed' }).steps.some((s) => s.state === 'failed')).toBe(true);
    expect(ingestionView(undefined, { status: 'uploaded' }).fraction).toBe(0);
  });
});

describe('topics ready while the material is written', () => {
  it('counts the ready topics and the ones still being written, leaving out excluded and failed ones', () => {
    const tp = (content_status: string, excluded = false) => ({ id: content_status, excluded, content_status });
    const { ready, writing } = topicProgress([tp('ready'), tp('generating'), tp('pending'), tp('failed'), tp('ready', true)]);
    expect(ready.map((r) => r.id)).toEqual(['ready']);
    expect(writing).toBe(2);
  });
});
