import { beforeEach, describe, expect, it } from 'vitest';
import { handleFlagApply, handleFlagTriage } from '../../src/jobs/trust.ts';
import { ANSWER, CARD, DOC, FLAG, FakeEnv, NOW, QUESTION, SUBJECT, TOPIC, USER, USER_B, fakeEnv } from './fakes.ts';
import { seedStudent } from './seed.ts';

const GROUP = 'ccccccc1-cccc-4ccc-8ccc-ccccccccccc1';
let env: FakeEnv;

function seedCardFlag(opts: { classGroup?: string | null; reason?: string; reporters?: number } = {}) {
  env.db.seed('documents', [{ id: DOC, subject_id: SUBJECT, kind: 'notes', title: 'Aula 3', mime_type: 'application/pdf', page_count: 40, storage_path: 'documents/aula.pdf', teacher_name: null, deleted_at: null }]);
  env.db.seed('document_slices', [
    { document_id: DOC, page_start: 14, page_end: 16, storage_path: 'slices/doc-14.pdf', anthropic_file_id: 'file_slice_1', anthropic_file_expires_at: '2030-01-01T00:00:00.000Z' },
  ]);
  env.db.seed('cards', [
    {
      id: CARD,
      subject_id: SUBJECT,
      node_id: TOPIC,
      type: 'basic',
      front: 'Quem regula a passagem?',
      back: 'A parede celular',
      source_pages: [{ document_id: DOC, page_start: 14, page_end: 14 }],
      version: 1,
      hidden_reason: null,
      status: 'active',
      deleted_at: null,
    },
  ]);
  env.db.seed('knowledge_nodes', [{ id: TOPIC, subject_id: SUBJECT, title: 'Membrana', summary: 'Transporte', kind: 'topic', parent_id: null, position: 0, deleted_at: null }]);
  env.db.seed('subjects', [{ id: SUBJECT, owner_profile_id: USER, owner_class_group_id: opts.classGroup ?? null, content_language: 'pt-BR', is_language_subject: false, created_by: USER, name: 'Bio', color: '#000000', icon: 'x', deleted_at: null }]);
  const flags = [
    { id: FLAG, item_type: 'card', item_id: CARD, item_version: 1, class_group_id: opts.classGroup ?? null, reporter_id: USER_B, reason: opts.reason ?? 'Gabarito errado', comment: 'A página diz outra coisa', status: 'open', reporter_weight: 1, resolved_by: null, ai_proposed_fix: null, created_at: '2026-10-27T10:00:00Z' },
  ];
  for (let i = 0; i < (opts.reporters ?? 0); i++) {
    flags.push({ id: `flag-extra-${i}`, item_type: 'card', item_id: CARD, item_version: 1, class_group_id: opts.classGroup ?? null, reporter_id: `reporter-${i}`, reason: 'Confuso', comment: null, status: 'open', reporter_weight: 1, resolved_by: null, ai_proposed_fix: null, created_at: '2026-10-27T10:00:00Z' } as never);
  }
  env.db.seed('content_flags', flags as never);
}

beforeEach(() => {
  env = fakeEnv(NOW);
  seedStudent(env.db);
});

describe('flag.triage (TRU-02.4)', () => {
  const confirmed = {
    verdict: 'error_confirmed',
    confidence: 'high',
    explanation_pt: 'A página 14 diz que a parede regula a passagem; a membrana é quem regula.',
    evidence_pages: [{ doc: 'D1', page_start: 14, page_end: 14 }],
    corrected_item: { fields: [{ name: 'back', value: 'A membrana plasmática' }] },
    answer_changed: true,
  };

  it('confirms a card error with evidence inside the slice and keeps a personal item visible', async () => {
    seedCardFlag();
    env.claude.reply('Tarefa: avalie uma denúncia', confirmed);
    const result = await handleFlagTriage(env.ctx, { flag_id: FLAG });
    expect(result).toMatchObject({ status: 'triaged', verdict: 'error_confirmed', hidden: false });
    const flag = env.db.rows('content_flags').find((f) => f.id === FLAG);
    expect(flag).toMatchObject({ status: 'triaged', ai_verdict: 'confirmed', ai_confidence: 'high', reporter_weight: 1 });
    expect(flag?.ai_source_pages).toEqual([{ document_id: DOC, page_start: 14, page_end: 14 }]);
    expect(flag?.ai_proposed_fix).toEqual({ fields: [{ name: 'back', value: 'A membrana plasmática' }], answer_changed: true });
    expect(env.db.rows('cards')[0]?.hidden_reason).toBeNull();
  });

  it('hides a shared item for everyone and notifies the moderators (TRU-02.7)', async () => {
    seedCardFlag({ classGroup: GROUP });
    env.db.seed('class_group_members', [
      { class_group_id: GROUP, user_id: 'mod-1', role: 'moderator', status: 'active' },
      { class_group_id: GROUP, user_id: 'owner-1', role: 'owner', status: 'active' },
      { class_group_id: GROUP, user_id: 'member-1', role: 'member', status: 'active' },
    ]);
    env.claude.reply('Tarefa: avalie uma denúncia', confirmed);
    const result = await handleFlagTriage(env.ctx, { flag_id: FLAG });
    expect(result).toMatchObject({ hidden: true, moderatorsNotified: 2 });
    expect(env.db.rows('cards')[0]?.hidden_reason).toBe('under_review');
    expect(env.enqueued.map((e) => e.name)).toEqual(['notify.dispatch', 'notify.dispatch']);
    expect(env.pgQueries.some((q) => q.text.includes('private.moderation_actions'))).toBe(true);
  });

  it('turns an evidence page outside the slices into "unclear" (server check, ai-pipeline §5)', async () => {
    seedCardFlag();
    env.claude.reply('Tarefa: avalie uma denúncia', { ...confirmed, evidence_pages: [{ doc: 'D1', page_start: 99, page_end: 99 }] });
    const result = await handleFlagTriage(env.ctx, { flag_id: FLAG });
    expect(result.verdict).toBe('unclear');
    expect(env.db.rows('content_flags').find((f) => f.id === FLAG)).toMatchObject({ ai_verdict: 'unsure', ai_confidence: 'low' });
  });

  it('a refused triage throws so the job retries and the flag stays open (failure path)', async () => {
    seedCardFlag();
    env.claude.reply('Tarefa: avalie uma denúncia', { refusal: true });
    await expect(handleFlagTriage(env.ctx, { flag_id: FLAG })).rejects.toThrow(/refused/);
    expect(env.db.rows('content_flags').find((f) => f.id === FLAG)?.status).toBe('open');
  });
});

describe('flag.apply_fix (TRU-02.9)', () => {
  it('publishes the fix as a new version, resets reviewed cards whose answer changed, and notifies affected users', async () => {
    seedCardFlag();
    const flag = env.db.rows('content_flags').find((f) => f.id === FLAG)!;
    Object.assign(flag, { status: 'accepted', ai_proposed_fix: { fields: [{ name: 'back', value: 'A membrana plasmática' }], answer_changed: true }, resolved_by: 'owner-1' });
    env.db.seed('card_states', [
      { user_id: USER, card_id: CARD, subject_id: SUBJECT, reps: 3, state: 2, due: '2026-10-30T00:00:00Z', stability: 5, difficulty: 3, lapses: 0, scheduled_days: 5, learning_steps: 0, last_review: '2026-10-20T00:00:00Z', suspended: false, hidden: false, is_leech: false, introduced_at: '2026-10-01T00:00:00Z' },
      { user_id: USER_B, card_id: CARD, subject_id: SUBJECT, reps: 0, state: 0, due: '2026-10-27T00:00:00Z', stability: 0, difficulty: 0, lapses: 0, scheduled_days: 0, learning_steps: 0, last_review: null, suspended: false, hidden: false, is_leech: false, introduced_at: null },
    ]);
    const outcome = await handleFlagApply(env.ctx, { flag_id: FLAG });
    expect(outcome).toMatchObject({ status: 'applied', version: 2, affectedUsers: 1 });
    expect(env.db.rows('cards')[0]).toMatchObject({ back: 'A membrana plasmática', version: 2, hidden_reason: null });
    expect(env.db.rows('item_revisions')).toEqual([expect.objectContaining({ item_type: 'card', version: 2, flag_id: FLAG, answer_changed: true })]);
    const states = env.db.rows('card_states');
    expect(states.find((s) => s.user_id === USER)).toMatchObject({ reps: 0, state: 0, last_review: null });
    expect(env.enqueued.some((e) => e.name === 'notify.dispatch' && e.data.user_id === USER)).toBe(true);
    expect(env.enqueued.some((e) => e.name === 'xp.award' && e.data.user_id === USER_B)).toBe(true);
    const again = await handleFlagApply(env.ctx, { flag_id: FLAG });
    expect(again).toEqual({ status: 'skipped', reason: 'already_applied' });
  });

  it('a corrected gabarito re-grades attempts and adds the Caderno entry for answers that became wrong', async () => {
    seedCardFlag();
    const flag = env.db.rows('content_flags').find((f) => f.id === FLAG)!;
    flag.item_type = 'question';
    flag.item_id = QUESTION;
    flag.status = 'accepted';
    const options = ['A', 'B', 'C', 'D'].map((id) => ({ id, text: `opção ${id}`, rationale: 'razão' }));
    env.db.seed('questions', [{ id: QUESTION, subject_id: SUBJECT, node_id: TOPIC, type: 'mcq_single', stem: 'Qual?', payload: { options, correct: 'B' }, version: 1, status: 'active', deleted_at: null, hidden_reason: null, explanation: null }]);
    flag.ai_proposed_fix = { fields: [{ name: 'payload', value: JSON.stringify({ options, correct: 'C' }) }], answer_changed: true };
    flag.item_version = 1;
    env.db.seed('attempt_answers', [{ id: ANSWER, attempt_id: 'att-1', user_id: USER, question_id: QUESTION, response: { choice: 'B' }, correct: true, score: 1, points_awarded: 1, points_max: 1 }]);
    env.db.seed('quiz_attempts', [{ id: 'att-1', quiz_id: 'quiz-1' }]);
    env.db.seed('quizzes', [{ id: 'quiz-1', kind: 'practice' }]);
    const outcome = await handleFlagApply(env.ctx, { flag_id: FLAG });
    expect(outcome).toMatchObject({ status: 'applied', regraded: 1 });
    expect(env.db.rows('attempt_answers')[0]).toMatchObject({ correct: false, score: 0, question_version: 2 });
    expect(env.db.rows('mistakes')).toEqual([expect.objectContaining({ user_id: USER, question_id: QUESTION, attempt_answer_id: ANSWER })]);
    expect(env.enqueued.some((e) => e.name === 'mastery.recompute')).toBe(true);
  });

  it('an invalid question payload is not applied (no partial write)', async () => {
    seedCardFlag();
    const flag = env.db.rows('content_flags').find((f) => f.id === FLAG)!;
    flag.item_type = 'question';
    flag.item_id = QUESTION;
    flag.status = 'accepted';
    flag.ai_proposed_fix = { fields: [{ name: 'payload', value: '{"correct":"Z"}' }], answer_changed: true };
    env.db.seed('questions', [{ id: QUESTION, subject_id: SUBJECT, node_id: TOPIC, type: 'mcq_single', stem: 'Qual?', payload: {}, version: 1, deleted_at: null }]);
    expect(await handleFlagApply(env.ctx, { flag_id: FLAG })).toEqual({ status: 'skipped', reason: 'invalid_fix' });
    expect(env.db.rows('questions')[0]?.version).toBe(1);
  });
});
