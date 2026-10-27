import { beforeEach, describe, expect, it } from 'vitest';
import { handlePlanNightly, handlePlanRecompute, handleScopeMatch, handleVesperaPrepare, readinessFor, scopeTopicsByExam } from '../../src/jobs/planning.ts';
import { loadPlanContext } from '../../src/lib/plan-context.ts';
import { EXAM, FakeEnv, GOAL, NOW, SUBJECT, TOPIC, TOPIC_B, USER, fakeEnv } from './fakes.ts';
import { seedStudent } from './seed.ts';

let env: FakeEnv;
beforeEach(() => {
  env = fakeEnv(NOW);
  seedStudent(env.db);
});

describe('plan.recompute (GOL-04)', () => {
  it('writes a plan run with items, and a second identical run writes nothing new', async () => {
    const first = await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    expect(first).toMatchObject({ status: 'planned', version: 1 });
    const runs = env.db.rows('plan_runs');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ user_id: USER, version: 1, trigger: 'exam_changed', computed_by: 'server' });
    const items = env.db.rows('plan_items');
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.plan_run_id === runs[0]?.id)).toBe(true);
    expect(items.some((i) => i.unit_type === 'learn' && Array.isArray(i.node_ids) && i.node_ids.includes(TOPIC))).toBe(true);
    expect(items.some((i) => i.reason_params?.blockId && i.reason_params?.unitKey)).toBe(true);

    const second = await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    expect(second).toEqual({ status: 'unchanged' });
    expect(env.db.rows('plan_runs')).toHaveLength(1);
  });

  it('keeps done items when a later run replans (learning-engine §11.7)', async () => {
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    const items = env.db.rows('plan_items');
    items[0]!.status = 'done';
    const doneId = items[0]!.id;
    const doneDay = items[0]!.local_date;
    env.setNow('2026-10-28T15:00:00.000Z');
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'nightly' });
    const latest = env.db.rows('plan_runs').sort((a, b) => b.version - a.version)[0];
    const carried = env.db.rows('plan_items').filter((i) => i.plan_run_id === latest?.id && i.status === 'done');
    expect(carried.map((r) => r.local_date)).toContain(doneDay);
    expect(env.db.rows('plan_items').some((i) => i.id === doneId)).toBe(true);
  });

  it('returns null for an account that no longer has a profile', async () => {
    env.db.seed('profiles', []);
    expect(await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'nightly' })).toBeNull();
  });

  it('rejects a payload without a user (failure path)', async () => {
    await expect(handlePlanRecompute(env.ctx, { trigger: 'nightly' })).rejects.toThrow();
  });

  it('surfaces a database failure so pg-boss retries', async () => {
    env.db.failures.set('plan_runs', 'connection reset');
    await expect(handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'nightly' })).rejects.toThrow(/connection reset/);
  });
});

describe('plan.nightly (GOL-04, GOL-08, GOL-11)', () => {
  it('fans out to the 03:xx local users when no ids are given', async () => {
    env.setNow('2026-10-27T06:30:00.000Z'); // 03:30 in São Paulo
    const result = await handlePlanNightly(env.ctx, {});
    expect(result.fanout).toBe(1);
    expect(env.enqueued[0]).toMatchObject({ name: 'plan.nightly', data: { user_ids: [USER] } });
  });

  it('replans and writes readiness snapshots for each user it is given', async () => {
    const result = await handlePlanNightly(env.ctx, { user_ids: [USER] });
    expect(result).toMatchObject({ planned: 1 });
    const snapshots = env.db.rows('readiness_snapshots');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ user_id: USER, exam_id: EXAM, pred_mid: null });
    expect(snapshots[0]?.evidence).toMatchObject({ notEnough: true });
  });

  it('readiness is computed from the scope and mastery (pure helper)', async () => {
    const planCtx = await loadPlanContext(env.ctx, USER);
    const scope = scopeTopicsByExam(planCtx!);
    expect(scope.get(EXAM)).toEqual([TOPIC, TOPIC_B].sort());
    const rows = readinessFor(planCtx!, scope);
    expect(rows[0]?.row.readiness).toBe(0);
    expect(rows[0]?.scopeTopicIds).toHaveLength(2);
  });

  it('fails the chunk for retry when a user fails (failure path)', async () => {
    env.db.failures.set('plan_runs', 'boom');
    await expect(handlePlanNightly(env.ctx, { user_ids: [USER] })).rejects.toThrow(/failed/);
  });
});

describe('vespera.prepare (GOL-07)', () => {
  it('attaches the cheat sheet to the véspera plan item, keeping only source-backed bullets', async () => {
    env.setNow('2026-11-02T15:00:00.000Z'); // the day before the test
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'nightly' });
    const vespera = env.db.rows('plan_items').find((i) => i.unit_type === 'vespera') ?? env.db.rows('plan_items')[0]!;
    vespera.unit_type = 'vespera';
    vespera.exam_id = EXAM;
    vespera.local_date = '2026-11-02';
    env.db.seed('notes', [{ node_id: TOPIC, depth: 'tldr', status: 'ready', deleted_at: null, body: 'A membrana regula a passagem.', citations: [{ document_id: 'doc-1', page_start: 14, page_end: 16, start: 0, end: 5, cited_text: 'x' }] }]);
    env.claude.reply('Tarefa: escreva a cola da véspera', {
      title: 'Cola da véspera',
      sections: [
        {
          node_key: TOPIC,
          heading: 'Membrana',
          bullets: [
            { text: 'Regula a passagem.', source_pages: [{ doc: 'D1', page_start: 14, page_end: 14 }] },
            { text: 'Página inventada.', source_pages: [{ doc: 'D1', page_start: 99, page_end: 99 }] },
          ],
          formula: null,
        },
      ],
      watch_out: [{ text: 'Cuidado com osmose', from_mistake_id: null }],
    });
    const result = await handleVesperaPrepare(env.ctx, { exam_id: EXAM, user_id: USER });
    expect(result).toMatchObject({ status: 'prepared', sections: 1 });
    const cheat = (vespera.reason_params as Record<string, any>).cheatsheet;
    expect(cheat.sections[0].bullets).toHaveLength(1);
    expect((vespera.reason_params as Record<string, any>).session.parts.length).toBe(6);
  });

  it('is skipped for tests that are not tomorrow', async () => {
    const result = await handleVesperaPrepare(env.ctx, { exam_id: EXAM, user_id: USER });
    expect(result).toMatchObject({ status: 'not_eve' });
  });

  it('throws for a refused cheat sheet so the job retries (failure path)', async () => {
    env.setNow('2026-11-02T15:00:00.000Z');
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'nightly' });
    const vespera = env.db.rows('plan_items')[0]!;
    vespera.unit_type = 'vespera';
    vespera.exam_id = EXAM;
    env.claude.reply('Tarefa: escreva a cola da véspera', { refusal: true });
    await expect(handleVesperaPrepare(env.ctx, { exam_id: EXAM, user_id: USER })).rejects.toThrow(/ai_failed|refused/);
  });
});

describe('scope.match (GOL-03 fallback)', () => {
  it('stores the AI mapping unconfirmed and moves the test to pending review', async () => {
    env.db.seed('exam_scope_items', [{ exam_id: EXAM, raw_text: 'membrana e mitocôndria', position: 0, source_document_id: null }]);
    env.claude.reply('a partir da lista de conteúdo de uma prova', {
      items: [
        { raw_text: 'membrana', normalized_title: 'Membrana', matches: [{ node_key: TOPIC, confidence: 0.9 }], status: 'matched', note: null },
        { raw_text: 'mitocôndria', normalized_title: 'Mitocôndria', matches: [{ node_key: 'inventado', confidence: 0.95 }], status: 'matched', note: null },
      ],
      detected_exam_info: { subject_guess: null, date_guess: null },
    });
    const result = await handleScopeMatch(env.ctx, { exam_id: EXAM });
    expect(result).toEqual({ status: 'matched', items: 2 });
    const nodes = env.db.rows('exam_scope_nodes');
    expect(nodes).toEqual([expect.objectContaining({ node_id: TOPIC, source: 'ai', confirmed: false })]);
    expect(env.db.rows('exams')[0]?.scope_status).toBe('pending_review');
  });

  it('fails when the AI does not answer usably (failure path)', async () => {
    env.db.seed('exam_scope_items', [{ exam_id: EXAM, raw_text: 'x', position: 0 }]);
    env.claude.reply('a partir da lista de conteúdo de uma prova', { items: 'nope' });
    await expect(handleScopeMatch(env.ctx, { exam_id: EXAM })).rejects.toThrow();
  });
});
