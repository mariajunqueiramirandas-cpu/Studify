import { beforeEach, describe, expect, it } from 'vitest';
import {
  closedWeekStart,
  findingRows,
  handleDivideMerge,
  handleEnergyWindows,
  handleLeagueWeekly,
  handleMaterialCheck,
  handleRetroGenerate,
  retroTitleStats,
} from '../../src/jobs/phase5.ts';
import { DOC, GROUP_ID, NOW, SUBJECT, TOPIC, TOPIC_B, USER, USER_B, fakeEnv, type FakeEnv } from './fakes.ts';
import { seedStudent } from './seed.ts';

let env: FakeEnv;

beforeEach(() => {
  env = fakeEnv(NOW);
  seedStudent(env.db);
});

describe('material checker (ING-06)', () => {
  const base = {
    documentId: DOC,
    subjectId: SUBJECT,
    labels: { D1: DOC },
    topicByKey: new Map([['t1', TOPIC]]),
    topicRanges: [{ nodeId: TOPIC_B, start: 10, end: 20 }],
    otherByKey: new Map([['O1', 'other-doc']]),
  };

  it('maps labels, topics and the other side of a contradiction', () => {
    const rows = findingRows(
      {
        findings: [
          { type: 'contradiction', severity: 'high', doc: 'D1', page_start: 12, page_end: 12, related: { doc: 'O1', page: 4 }, node_key: null, description: 'Possível erro: a p. 12 diz 38 ATP e o slide diz 30.', suggested_fix: '30 a 32 ATP.' },
          { type: 'numeric_or_formula_typo', severity: 'low', doc: 'D1', page_start: 3, page_end: 3, related: null, node_key: 't1', description: 'Parece que o expoente está trocado.', suggested_fix: null },
          { type: 'unclear', severity: 'medium', doc: 'D2', page_start: 1, page_end: 1, related: null, node_key: null, description: 'Documento que a chamada não viu.', suggested_fix: null },
        ],
      },
      base,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ node_id: TOPIC_B, related_document_id: 'other-doc', related_page: 4, severity: 'high' });
    expect(rows[1]).toMatchObject({ node_id: TOPIC, related_document_id: null });
  });

  it('runs once per document and skips documents without pages', async () => {
    env.db.seed('documents', [{ id: DOC, subject_id: SUBJECT, title: 'Apostila', page_count: null, deleted_at: null }]);
    expect(await handleMaterialCheck(env.ctx, { document_id: DOC })).toEqual({ status: 'skipped' });
    env.db.rows('documents')[0]!.page_count = 10;
    env.db.seed('material_findings', [{ id: 'f1', document_id: DOC }]);
    expect(await handleMaterialCheck(env.ctx, { document_id: DOC })).toEqual({ status: 'skipped' });
    expect(env.claude.calls).toHaveLength(0);
  });
});

describe('divide.merge (SOC-06)', () => {
  it('only merges a divisão that is merging', async () => {
    env.db.seed('divide_plans', [{ id: 'p1', class_group_id: GROUP_ID, subject_id: SUBJECT, status: 'open', created_by: USER, title: 'P1' }]);
    expect(await handleDivideMerge(env.ctx, { divide_plan_id: 'p1' })).toEqual({ status: 'skipped' });
    expect(env.claude.calls).toHaveLength(0);
  });

  it('closes a merging divisão with no approved summary and tells the Turma', async () => {
    env.db.seed('divide_plans', [{ id: 'p1', class_group_id: GROUP_ID, subject_id: SUBJECT, status: 'merging', created_by: USER, title: 'P1' }]);
    env.db.seed('class_group_members', [
      { class_group_id: GROUP_ID, user_id: USER, status: 'active' },
      { class_group_id: GROUP_ID, user_id: USER_B, status: 'active' },
    ]);
    expect(await handleDivideMerge(env.ctx, { divide_plan_id: 'p1' })).toEqual({ status: 'done', notes: 0 });
    expect(env.db.rows('divide_plans')[0]!.status).toBe('done');
    expect(env.enqueued.filter((e) => e.name === 'notify.dispatch').map((e) => e.data.type)).toEqual(['divide_merged', 'divide_merged']);
  });
});

describe('league.weekly (SOC-08)', () => {
  it('closes last week with capped XP outside quiet hours, ranks and badges', async () => {
    expect(closedWeekStart(new Date(NOW))).toBe('2026-10-19');
    env.db.seed('class_group_members', [
      { class_group_id: GROUP_ID, user_id: USER, status: 'active', league_opt_in: true },
      { class_group_id: GROUP_ID, user_id: USER_B, status: 'active', league_opt_in: true },
      { class_group_id: GROUP_ID, user_id: 'not-in', status: 'active', league_opt_in: false },
    ]);
    env.db.seed('xp_events', [
      { user_id: USER, local_date: '2026-10-20', amount: 700, in_quiet_hours: false, occurred_at: '2026-10-20T15:00:00Z' },
      { user_id: USER, local_date: '2026-10-21', amount: 50, in_quiet_hours: true, occurred_at: '2026-10-22T02:00:00Z' },
      { user_id: USER_B, local_date: '2026-10-21', amount: 300, in_quiet_hours: false, occurred_at: '2026-10-21T15:00:00Z' },
      { user_id: USER_B, local_date: '2026-10-27', amount: 900, in_quiet_hours: false, occurred_at: '2026-10-27T15:00:00Z' },
    ]);
    env.db.seed('daily_activity', ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22'].map((d) => ({ user_id: USER_B, local_date: d, goal_met: true })));
    expect(await handleLeagueWeekly(env.ctx, {})).toEqual({ groups: 1, entries: 2 });
    const entries = Object.fromEntries(env.db.rows('league_entries').map((e) => [e.user_id, e]));
    expect(entries[USER]).toMatchObject({ league_xp: 500, rank: 1, badges: ['podium_1'], week_start: '2026-10-19' });
    expect(entries[USER_B]).toMatchObject({ league_xp: 300, rank: 2, badges: ['podium_2', 'consistent_week'] });
  });
});

describe('retro.generate (MOT-04)', () => {
  it('builds the goal recap the day after the last exam with an AI title, and only once', async () => {
    env.setNow('2026-11-21T12:00:00.000Z');
    env.db.seed('goals', [{ id: 'g-retro', user_id: USER, mode: 'exam_week', start_date: '2026-11-01', deleted_at: null }]);
    env.db.seed('exams', [{ goal_id: 'g-retro', user_id: USER, local_date: '2026-11-20', subject_id: SUBJECT, grade: 8.5, grade_max: 10, deleted_at: null }]);
    env.db.seed('daily_activity', [
      { user_id: USER, local_date: '2026-11-18', active_minutes: 50, reviews: 40, questions: 10, counted: true },
      { user_id: USER, local_date: '2026-11-19', active_minutes: 70, reviews: 20, questions: 15, counted: true },
    ]);
    env.claude.reply('Retrospectiva', { title_pt: 'Semana de provas no modo turbo!', subtitle_pt: '2 horas de foco e 60 cartões.' });
    expect(await handleRetroGenerate(env.ctx)).toEqual({ created: 1 });
    const retro = env.db.rows('retrospectives')[0]!;
    expect(retro).toMatchObject({ user_id: USER, period_type: 'goal', goal_id: 'g-retro', period_start: '2026-11-01', period_end: '2026-11-20', title: 'Semana de provas no modo turbo!' });
    expect(retro.stats).toMatchObject({ active_minutes: 120, days_studied: 2, cards_reviewed: 60, questions_answered: 25, longest_streak: 2 });
    expect(retro.stats.grades).toEqual([{ subject: expect.any(String), grade: '8,5/10' }]);
    expect(env.enqueued.find((e) => e.name === 'notify.dispatch')?.data).toMatchObject({ type: 'retro_ready' });
    // The title prompt only sees numbers.
    expect(JSON.stringify(env.claude.calls[0])).not.toContain('8,5');
    expect(await handleRetroGenerate(env.ctx)).toEqual({ created: 0 });
  });

  it('title stats are numbers only', () => {
    const stats = retroTitleStats({ period: 'year', active_minutes: 125, days_studied: 3, cards_reviewed: 9, questions_answered: 4, accuracy: 0.756, best_subject: { name: 'Bio', accuracy: 1 }, most_improved_topic: null, longest_streak: 2, best_lucas_score: null, duels_won: 0, calibration_gain: null, grades: [{ subject: 'Bio', grade: '9' }] });
    expect(stats).toEqual({ active_hours: 2, days_studied: 3, cards_reviewed: 9, questions_answered: 4, accuracy_pct: 76, longest_streak: 2 });
  });
});

describe('energy.windows (GOL-10)', () => {
  it('writes one row per bucket and marks good windows once there is enough data', async () => {
    const reviews = [];
    for (let d = 0; d < 16; d++) {
      for (let i = 0; i < 20; i++) {
        const morning = i % 2 === 0;
        const day = `2026-10-${String(d + 1).padStart(2, '0')}`;
        // Mornings (09:xx local = 12:xx UTC) are always right; evenings (19:xx = 22:xx UTC) right only every third time.
        reviews.push({ user_id: USER, rating: morning || i % 3 === 0 ? 3 : 1, reviewed_at: `${day}T${morning ? '12' : '22'}:${String(i).padStart(2, '0')}:00Z`, state_before: 2 });
      }
    }
    env.db.seed('review_logs', reviews);
    expect(await handleEnergyWindows(env.ctx, { user_ids: [USER] })).toEqual({ users: 1 });
    const rows = env.db.rows('performance_windows');
    expect(rows.map((r) => r.bucket).sort()).toEqual([4, 9]);
    expect(rows.find((r) => r.bucket === 4)).toMatchObject({ good: true });
    expect(rows.find((r) => r.bucket === 9)).toMatchObject({ good: false });
  });

  it('skips students with too little history', async () => {
    env.db.seed('review_logs', [{ user_id: USER, rating: 3, reviewed_at: '2026-10-20T12:00:00Z', state_before: 2 }]);
    expect(await handleEnergyWindows(env.ctx, { user_ids: [USER] })).toEqual({ users: 0 });
  });
});
