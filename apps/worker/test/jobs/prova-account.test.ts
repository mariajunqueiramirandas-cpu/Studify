import { beforeEach, describe, expect, it } from 'vitest';
import { handleAnalyzePastTest, handleGeneratePredicted, handleScheduleImport } from '../../src/jobs/prova.ts';
import { handleAccountDelete, handleAccountExport, handleStoragePurge } from '../../src/jobs/account.ts';
import { DOC, EXAM, FakeEnv, GOAL, NOW, SUBJECT, TOPIC, USER, fakeEnv } from './fakes.ts';
import { seedStudent } from './seed.ts';

const PDF = new TextEncoder().encode('%PDF-1.4 fake');
let env: FakeEnv;

function seedPastTest() {
  env.db.seed('documents', [{ id: DOC, subject_id: SUBJECT, kind: 'past_test', title: 'P1 2025', mime_type: 'application/pdf', page_count: 2, storage_path: 'past/p1.pdf', teacher_name: 'Prof. Ana', uploaded_by: USER, status: 'uploaded', deleted_at: null }]);
  env.storage.objects.set('documents/past/p1.pdf', PDF);
}

beforeEach(() => {
  env = fakeEnv(NOW);
  seedStudent(env.db);
});

describe('pp.analyze_past_test (PRA-09.2–9.4)', () => {
  it('extracts questions with validated payloads and writes the teacher profile', async () => {
    seedPastTest();
    env.claude.reply('extraia as questões de uma prova antiga', {
      test: { title: 'P1', teacher_guess: 'Prof. Ana', year_guess: 2025, total_points: null, duration_guess: null },
      questions: [
        {
          position: 1,
          page: 1,
          type: 'mcq_single',
          statement_md: 'Qual organela produz ATP?',
          alternatives: [
            { label: 'A', text_md: 'Ribossomo' },
            { label: 'B', text_md: 'Mitocôndria' },
            { label: 'C', text_md: 'Golgi' },
            { label: 'D', text_md: 'Lisossomo' },
          ],
          answer: { value: 'B', source: 'printed' },
          solution_md: 'A mitocôndria faz a respiração celular.',
          points: 1,
          format_features: [],
          bloom: 'understand',
          difficulty: 2,
          node_matches: [{ node_key: TOPIC, confidence: 0.9 }],
        },
        {
          position: 2,
          page: 2,
          type: 'problem',
          statement_md: 'Calcule.',
          alternatives: null,
          answer: null,
          solution_md: null,
          points: null,
          format_features: ['calculation'],
          bloom: 'apply',
          difficulty: 4,
          node_matches: [{ node_key: TOPIC, confidence: 0.9 }],
        },
      ],
    });
    env.claude.reply('Tarefa: descreva o estilo', { patterns: [], style_notes: 'Pede justificativa.', typical_command_verbs: ['justifique'] });
    const result = await handleAnalyzePastTest(env.ctx, { document_id: DOC });
    expect(result).toMatchObject({ status: 'ready', questions: 1, skipped: { unsupported_type: 1 }, teacherTests: 1 });
    const questions = env.db.rows('questions');
    expect(questions).toEqual([expect.objectContaining({ origin: 'past_test', source_document_id: DOC, node_id: TOPIC, type: 'mcq_single', answer_key_source: 'printed' })]);
    expect(questions[0]?.source_pages).toEqual([{ document_id: DOC, page_start: 1, page_end: 1 }]);
    expect(env.db.rows('teacher_profiles')[0]).toMatchObject({ subject_id: SUBJECT, teacher_key: 'prof. ana', n_tests: 1, confidence: 'low' });
    expect(env.db.rows('documents')[0]?.status).toBe('ready');
  });

  it('re-analysing the same past test updates its teacher profile and replaces its questions', async () => {
    seedPastTest();
    const extraction = {
      test: { title: 'P1', teacher_guess: 'Prof. Ana', year_guess: 2025, total_points: null, duration_guess: null },
      questions: [{ position: 1, page: 1, type: 'short_answer', statement_md: 'Defina membrana.', alternatives: null, answer: { value: 'Bicamada lipídica.', source: 'printed' }, solution_md: null, points: 2, format_features: [], bloom: 'remember', difficulty: 1, node_matches: [{ node_key: TOPIC, confidence: 0.9 }] }],
    };
    env.claude.reply('extraia as questões de uma prova antiga', extraction);
    env.claude.reply('Tarefa: descreva o estilo', { patterns: [], style_notes: 'Direto.', typical_command_verbs: ['defina'] });
    await handleAnalyzePastTest(env.ctx, { document_id: DOC });
    env.db.rows('documents')[0]!.status = 'uploaded';
    await handleAnalyzePastTest(env.ctx, { document_id: DOC });
    expect(env.db.rows('teacher_profiles')).toHaveLength(1);
    expect(env.db.rows('questions')).toHaveLength(1);
  });

  it('a refused extraction marks the document failed and throws for retry (failure path)', async () => {
    seedPastTest();
    env.claude.reply('extraia as questões de uma prova antiga', { refusal: true });
    await expect(handleAnalyzePastTest(env.ctx, { document_id: DOC })).rejects.toThrow(/refused/);
    expect(env.db.rows('documents')[0]).toMatchObject({ status: 'failed', error_code: 'ai_refused' });
  });
});

describe('pp.generate (PRA-09.6–9.7)', () => {
  function seedExamScope() {
    env.db.seed('exam_scope_nodes', [{ exam_id: EXAM, node_id: TOPIC, source: 'user', confirmed: true }]);
    env.db.seed('node_sources', [{ node_id: TOPIC, document_id: DOC, page_start: 1, page_end: 2 }]);
    env.db.seed('documents', [{ id: DOC, subject_id: SUBJECT, kind: 'notes', title: 'Aula', mime_type: 'application/pdf', page_count: 2, storage_path: 'x.pdf', deleted_at: null }]);
    env.db.seed('document_slices', [{ document_id: DOC, page_start: 1, page_end: 2, storage_path: 'slices/d.pdf', anthropic_file_id: 'file_9', anthropic_file_expires_at: '2030-01-01T00:00:00Z' }]);
  }

  it('builds a quiz of predicted questions whose pages were actually sent', async () => {
    seedExamScope();
    env.claude.reply('Tarefa: escreva uma Prova Provável', {
      questions: [
        {
          slot_id: 's1',
          statement_md: 'Qual a função da membrana?',
          alternatives: [
            { label: 'A', text_md: 'Transporte' },
            { label: 'B', text_md: 'Digestão' },
            { label: 'C', text_md: 'Sustentação' },
            { label: 'D', text_md: 'Reprodução' },
          ],
          answer: 'A',
          solution_md: 'A membrana regula o transporte.',
          explanation_md: 'Por isso o transporte é a resposta.',
          source_pages: [{ doc: 'D1', page_start: 1, page_end: 1 }, { doc: 'D1', page_start: 40, page_end: 40 }],
          rationale: 'Tema central da unidade.',
        },
      ],
    });
    const result = await handleGeneratePredicted(env.ctx, { exam_id: EXAM, user_id: USER });
    expect(result.status).toBe('generated');
    expect(result.questions).toBe(1);
    const quiz = env.db.rows('quizzes')[0];
    expect(quiz).toMatchObject({ kind: 'predicted_test', exam_id: EXAM, owner_id: USER, goal_id: GOAL });
    expect(quiz?.question_ids).toHaveLength(1);
    const question = env.db.rows('questions')[0];
    expect(question).toMatchObject({ origin: 'generated', rationale: 'Tema central da unidade.', node_id: TOPIC });
    expect(question?.source_pages).toEqual([{ document_id: DOC, page_start: 1, page_end: 1 }]);
  });

  it('fails for retry when the model produces nothing usable (failure path)', async () => {
    seedExamScope();
    env.claude.reply('Tarefa: escreva uma Prova Provável', { questions: [{ slot_id: 's1', statement_md: 'x', alternatives: null, answer: 'y', solution_md: 'z', explanation_md: 'w', source_pages: [{ doc: 'D1', page_start: 90, page_end: 90 }], rationale: 'r' }] });
    await expect(handleGeneratePredicted(env.ctx, { exam_id: EXAM, user_id: USER })).rejects.toThrow(/no valid question/);
    expect(env.db.rows('quizzes')).toHaveLength(0);
  });
});

describe('schedule.import (ING-07)', () => {
  it('stores the extracted calendar on the draft with the local start time as an instant', async () => {
    env.db.seed('schedule_imports', [{ id: 'sched-1', user_id: USER, document_id: 'doc-sched', status: 'draft', extracted: null }]);
    env.db.seed('documents', [{ id: 'doc-sched', subject_id: SUBJECT, kind: 'content_list', title: 'Cronograma', mime_type: 'application/pdf', page_count: 1, storage_path: 'cron.pdf', deleted_at: null }]);
    env.storage.objects.set('documents/cron.pdf', PDF);
    env.claude.reply('extraia o calendário de provas', {
      term_name: '3º bimestre',
      exams: [{ subject_name: 'Biologia', date: '2026-11-03', date_ambiguous: false, time: '08:00', weight: 40, label: 'P1', content_items: ['Membrana'] }],
      warnings: [],
    });
    const result = await handleScheduleImport(env.ctx, { schedule_import_id: 'sched-1' });
    expect(result).toEqual({ status: 'extracted', exams: 1 });
    const extracted = env.db.rows('schedule_imports')[0]?.extracted as Array<Record<string, unknown>>;
    expect(extracted[0]).toMatchObject({ subject_name: 'Biologia', local_date: '2026-11-03', starts_at: '2026-11-03T11:00:00.000Z', title: 'P1' });
  });

  it('a refused extraction throws and leaves the draft untouched (failure path)', async () => {
    env.db.seed('schedule_imports', [{ id: 'sched-2', user_id: USER, document_id: 'doc-s2', status: 'draft', extracted: null }]);
    env.db.seed('documents', [{ id: 'doc-s2', subject_id: SUBJECT, kind: 'content_list', title: 'C', mime_type: 'image/jpeg', page_count: null, storage_path: 'p.jpg', deleted_at: null }]);
    env.storage.objects.set('photos/p.jpg', PDF);
    env.claude.reply('extraia o calendário de provas', { refusal: true });
    await expect(handleScheduleImport(env.ctx, { schedule_import_id: 'sched-2' })).rejects.toThrow(/refused/);
    expect(env.db.rows('schedule_imports')[0]?.extracted).toBeNull();
  });
});

describe('account.export (SP-14)', () => {
  beforeEach(() => {
    env.db.seed('data_exports', [{ id: 'exp-1', user_id: USER, status: 'queued', storage_path: null }]);
    env.db.seed('cards', [{ id: 'card-x', personal_for_user_id: USER, subject_id: SUBJECT, node_id: TOPIC, type: 'basic', front: 'Pergunta, com vírgula', back: 'Resposta', origin: 'user', status: 'active', created_at: NOW, updated_at: NOW }]);
    env.db.seed('goals', [{ user_id: USER, name: 'Semestre', mode: 'exam_week', status: 'active' }]);
  });

  it('writes a ZIP with the JSON tables and cards CSV, marks the export ready and pushes export_ready', async () => {
    const result = await handleAccountExport(env.ctx, { export_id: 'exp-1' });
    expect(result).toMatchObject({ status: 'ready', path: `${USER}/exp-1.zip`, signedUrl: expect.stringContaining('ttl=604800') });
    const zip = env.storage.objects.get(`exports/${USER}/exp-1.zip`);
    expect(zip && String.fromCharCode(zip[0]!, zip[1]!)).toBe('PK');
    expect(new TextDecoder().decode(zip!)).toContain('cards.csv');
    expect(new TextDecoder().decode(zip!)).toContain('"Pergunta, com vírgula"');
    const row = env.db.rows('data_exports')[0];
    expect(row).toMatchObject({ status: 'ready', storage_path: `${USER}/exp-1.zip` });
    expect(env.enqueued).toEqual([expect.objectContaining({ name: 'notify.dispatch', data: { user_id: USER, type: 'export_ready', data: { export_id: 'exp-1' } } })]);
  });

  it('an upload failure marks the export failed and throws (failure path)', async () => {
    env.storage.failUpload = 'bucket quota exceeded';
    await expect(handleAccountExport(env.ctx, { export_id: 'exp-1' })).rejects.toThrow(/quota/);
    expect(env.db.rows('data_exports')[0]?.status).toBe('failed');
  });
});

describe('account.delete (SP-14)', () => {
  it('anonymizes AI usage, removes the account, and records completion', async () => {
    env.db.seed('ai_usage', [{ id: 'u1', user_id: USER, feature: 'PRA-01.6', task: 'grade.shortAnswer', cost_micro_usd: 10, price_version: 'v1' }]);
    env.db.seed('account_deletions', [{ id: 'del-1', user_id: USER, delete_shared_uploads: false, status: 'pending' }]);
    const outcome = await handleAccountDelete(env.ctx, { deletion_id: 'del-1' });
    expect(outcome).toEqual({ status: 'done' });
    expect(env.db.rows('ai_usage')[0]?.user_id).toBeNull();
    expect(env.auth.deleted).toEqual([USER]);
    expect(env.db.rows('account_deletions')[0]).toMatchObject({ status: 'done' });
  });

  it('a student who still owns a Turma is blocked until ownership is transferred', async () => {
    env.db.seed('class_groups', [{ id: 'cg-1', owner_id: USER, deleted_at: null }]);
    env.db.seed('account_deletions', [{ id: 'del-2', user_id: USER, delete_shared_uploads: false, status: 'pending' }]);
    expect(await handleAccountDelete(env.ctx, { deletion_id: 'del-2' })).toEqual({ status: 'blocked', reason: 'owner_transfer_required' });
    expect(env.auth.deleted).toEqual([]);
  });

  it('an auth failure keeps the deletion failed for retry (failure path)', async () => {
    env.auth.failDelete = 'auth unavailable';
    env.db.seed('account_deletions', [{ id: 'del-3', user_id: USER, delete_shared_uploads: false, status: 'pending' }]);
    await expect(handleAccountDelete(env.ctx, { deletion_id: 'del-3' })).rejects.toThrow(/auth unavailable/);
    expect(env.db.rows('account_deletions')[0]?.status).toBe('failed');
  });
});

describe('storage.purge', () => {
  it('hard-deletes tombstones older than 30 days and expires old export archives', async () => {
    env.db.seed('cards', [
      { id: 'old', deleted_at: '2026-08-01T00:00:00Z' },
      { id: 'recent', deleted_at: '2026-10-20T00:00:00Z' },
      { id: 'live', deleted_at: null },
    ]);
    env.db.seed('data_exports', [{ id: 'exp-old', user_id: USER, status: 'ready', storage_path: `${USER}/exp-old.zip`, expires_at: '2026-10-01T00:00:00Z' }]);
    env.storage.objects.set(`exports/${USER}/exp-old.zip`, PDF);
    const outcome = await handleStoragePurge(env.ctx, {});
    expect(outcome.purged.cards).toBe(1);
    expect(env.db.rows('cards').map((c) => c.id).sort()).toEqual(['live', 'recent']);
    expect(outcome.exportsExpired).toBe(1);
    expect(env.db.rows('data_exports')[0]).toMatchObject({ status: 'expired', storage_path: null });
    expect(env.pgQueries.some((q) => q.text.includes('idempotency_keys'))).toBe(true);
  });
});

