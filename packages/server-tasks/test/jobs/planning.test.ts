import { beforeEach, describe, expect, it } from 'vitest';
import { handlePlanNightly, handlePlanRecompute, handleScopeMatch, handleVesperaPrepare, readinessFor, scopeTopicsByExam } from '../../src/jobs/planning.ts';
import { loadPlanContext } from '../../src/lib/plan-context.ts';
import { DOC, EXAM, FakeEnv, NOW, SUBJECT, TOPIC, TOPIC_B, USER, fakeEnv } from './fakes.ts';
import { seedStudent } from './seed.ts';

let env: FakeEnv;
beforeEach(() => {
  env = fakeEnv(NOW);
  seedStudent(env.db);
});

const COACH_REPLY = {
  headline: 'Foque no tópico mais fraco antes da prova.',
  exams: [{ exam_key: 'E1', strategy: 'Primeiro a base do tópico fraco, depois questões.', risk: 'medium' }],
  topics: [
    { topic_key: 'T1', priority: 1, approach: 'learn', focus: 'Comece pela teoria.', why: 'Nunca estudado e pesa na prova.' },
    { topic_key: 'T2', priority: 0, approach: 'maintain', focus: 'Só revisão.', why: 'Já está bom.' },
    { topic_key: 'T9', priority: 1, approach: 'learn', focus: 'x', why: 'chave inexistente' },
  ],
  next_steps: [{ when: 'today', title: 'Teoria do tópico fraco', detail: '25 minutos e 3 questões.', topic_key: 'T1' }],
  watch_out: null,
};

describe('study time: the model estimate and the measured pace (spec 07 §8.2.1–§8.2.2)', () => {
  const learnMinutesOf = (node: string) =>
    env.db.rows('plan_items').filter((i) => i.node_ids?.includes(node) && (i.unit_type === 'learn' || i.unit_type === 'learn_light')).reduce((acc, i) => acc + Number(i.minutes), 0);

  beforeEach(() => {
    env.db.seed('documents', [{ id: DOC, subject_id: SUBJECT, kind: 'slides', deleted_at: null }]);
    env.db.seed('node_sources', [{ node_id: TOPIC, document_id: DOC, page_start: 1, page_end: 10, origin: 'ai', deleted_at: null }]);
  });

  it('plans the page formula without an estimate, and the model estimate when there is one', async () => {
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    expect(learnMinutesOf(TOPIC)).toBe(15); // 10 slides × 1.5 min
    env.db.rows('plan_items').length = 0;
    env.db.rows('plan_runs').length = 0;
    env.db.seed('topic_study_estimates', [{ node_id: TOPIC, document_id: DOC, minutes: 40, prompt_version: 'ingest.topicDetail@v2' }]);
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    expect(learnMinutesOf(TOPIC)).toBe(40);
  });

  it("scales learn time by the student's measured pace in the subject", async () => {
    env.db.seed('topic_study_estimates', [{ node_id: TOPIC, document_id: DOC, minutes: 30, prompt_version: 'ingest.topicDetail@v2' }]);
    const done = [1, 2, 3, 4, 5, 6].map((i) => `f000000${i}-0000-4000-8000-000000000000`);
    env.db.seed('plan_items', done.map((id, i) => ({ id, user_id: USER, plan_run_id: 'old-run', local_date: `2026-10-2${i}`, subject_id: SUBJECT, unit_type: 'learn', minutes: 20, status: 'done', node_ids: [], deleted_at: null })));
    env.db.seed('study_sessions', done.map((id, i) => ({ id: `s${i}`, user_id: USER, plan_item_id: id, active_minutes: 40, started_at: `2026-10-2${i}T15:00:00.000Z`, kind: 'mixed' })));
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    // Six blocks at 2× the plan move κ from 1 to 1.88 (EMA α = 0.3): 30 min × 1.88 ≈ 57.
    expect(learnMinutesOf(TOPIC)).toBeGreaterThanOrEqual(55);
    expect(learnMinutesOf(TOPIC)).toBeLessThanOrEqual(60);
  });
});

describe('plan.coach (GOL-04.10)', () => {
  const coachCalls = () => env.claude.calls.filter((c) => JSON.stringify(c).includes('estrategista de estudos')).length;

  it('turns the coach priorities into topic weights and writes its texts on the plan items', async () => {
    env.claude.reply('estrategista de estudos', COACH_REPLY);
    const res = await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    expect(res).toMatchObject({ status: 'planned' });
    const [row] = env.db.rows('plan_coach');
    expect(row).toMatchObject({ user_id: USER, prompt_version: 'plan.coach@v1', calls_today: 1 });
    const topics = row!.output.topics as Array<{ node_id: string; priority: number }>;
    expect(topics.map((t) => t.priority)).toEqual([1, 0]);
    const [high, low] = topics.map((t) => t.node_id);
    expect([high, low].sort()).toEqual([TOPIC, TOPIC_B].sort());
    const items = env.db.rows('plan_items');
    const prio = (node: string) => Math.max(...items.filter((i) => i.node_ids?.includes(node)).map((i) => Number(i.priority)));
    expect(prio(high!)).toBeGreaterThan(prio(low!));
    expect(items.find((i) => i.node_ids?.includes(high!))?.reason_params?.coach).toEqual({ why: 'Nunca estudado e pesa na prova.', focus: 'Comece pela teoria.', approach: 'learn' });
    expect(row!.output.next_steps[0]).toMatchObject({ when: 'today', node_id: high });
  });

  it('does not call the model again when the signals did not change', async () => {
    env.claude.reply('estrategista de estudos', COACH_REPLY);
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'nightly' });
    expect(coachCalls()).toBe(1);
  });

  it('still plans with the default weights when the coach fails', async () => {
    env.claude.reply('estrategista de estudos', { refusal: true });
    const res = await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'exam_changed' });
    expect(res).toMatchObject({ status: 'planned' });
    expect(env.db.rows('plan_coach')).toHaveLength(0);
    expect(env.db.rows('plan_items').some((i) => i.reason_params?.coach)).toBe(false);
  });
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

  it('surfaces a database failure to the direct caller', async () => {
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
