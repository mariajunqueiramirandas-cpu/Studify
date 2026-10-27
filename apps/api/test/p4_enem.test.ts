import { test } from 'bun:test';
// Phase 4 (ENEM mode, INT-03): simulados built from published official items only and scored with TRI on
// submission; redação pre-checks without a model call; theme generator; Treino de Argumentação; admin gates;
// ENEM-style generation with the excerpt check; bank answers through sync only for published items.
import { assert, assertEquals } from './assert.ts';
import { ALICE, BOB, json, makeHarness, parseSse, request, type FakeReply, type Harness } from './fakes.ts';
import { IDS, seedWorld, v7 } from './world.ts';
import { handler as simuladoCreate } from '../src/functions/enem-simulado-create.ts';
import { handler as quizSubmit } from '../src/functions/quiz-submit.ts';
import { handler as gradeEssay } from '../src/functions/grade-essay.ts';
import { handler as themeGenerate } from '../src/functions/essay-theme-generate.ts';
import { handler as argumentStart } from '../src/functions/argument-start.ts';
import { handler as argumentTurn } from '../src/functions/argument-turn.ts';
import { handler as argumentFinish } from '../src/functions/argument-finish.ts';
import { handler as adminImport } from '../src/functions/admin-enem-import.ts';
import { handler as adminPublish } from '../src/functions/admin-atualidades-publish.ts';
import { handler as generateMore } from '../src/functions/questions-generate-more.ts';
import { handler as syncPush } from '../src/functions/sync-push.ts';
import { excerptMatches } from '../src/shared-p4/enem-questions.ts';

const reply = (value: unknown): FakeReply => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });

const SYS = '5e000000-0000-4000-8000-0000000000a1';
const ENEM_GOAL = '60000000-0000-4000-8000-0000000000e1';
const ADMIN = '0190a000-0000-7000-8000-00000000ad00';
const item = (n: number) => `e1000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const qid = (n: number) => `9e000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** 2 editions × 45 MT items, the 2023 edition fully published with parameters; one 2023 item under review. */
function seedBank(h: Harness): void {
  h.db.seed('subjects', { id: SYS, owner_profile_id: ADMIN, owner_class_group_id: null, created_by: ADMIN, name: 'ENEM Matemática', color: '#3355aa', icon: 'calc', content_language: 'pt-BR', is_language_subject: false, enem_area: 'MT', system_kind: 'enem_bank', deleted_at: null });
  h.db.seed('goals', { id: ENEM_GOAL, user_id: ALICE.id, mode: 'enem', name: 'ENEM 2027', start_date: '2026-10-01', end_date: '2027-11-14', status: 'active', deleted_at: null });
  h.db.seed('enem_editions', { year: 2026, day1_date: '2026-11-08', day2_date: '2026-11-15', dates_status: 'provisional', day1_duration_min: 330, day2_duration_min: 300 });
  let n = 0;
  for (const year of [2022, 2023]) {
    for (let pos = 1; pos <= 45; pos++) {
      n++;
      const review = year === 2023 && pos === 45 ? 'needs_review' : 'ok';
      h.db.seed('questions', {
        id: qid(n),
        subject_id: SYS,
        node_id: null,
        type: 'mcq_single',
        stem: `MT ${year} Q${pos}`,
        payload: { options: ['A', 'B', 'C', 'D', 'E'].map((id) => ({ id, text: id, rationale: id })), correct: 'C' },
        origin: 'enem_official',
        personal_for_user_id: null,
        status: 'active',
        deleted_at: null,
        version: 1,
      });
      h.db.seed('enem_items', {
        id: item(n),
        question_id: qid(n),
        edition_year: year,
        application: 'regular',
        day: 2,
        area: 'MT',
        co_item: `${year}${pos}`,
        positions: [{ co_prova: '1', color: 'azul', position: 135 + pos }],
        answer_key: 'C',
        skill_code: 'MT-H21',
        language: null,
        annulled: false,
        enem_topic_ids: [pos % 2 ? 'topic-func' : 'topic-geo'],
        transcription_md: `Questão ${pos}`,
        review_status: review,
        explanation_status: 'ok',
      });
      h.db.seed('enem_item_params', { enem_item_id: item(n), a: 1.4, b: -2 + (pos % 15) * 0.3, c: 0.18, scale: 'std', source: `microdata_${year}`, logistic_d: 1 });
    }
  }
  h.db.seed('enem_topic_trends', [
    { enem_topic_id: 'topic-func', predicted_share: 0.6, trend: 'up' },
    { enem_topic_id: 'topic-geo', predicted_share: 0.4, trend: 'flat' },
  ]);
}

test('enem-simulado-create: Réplica of an edition, only published items, stored ids; Provável follows the shares', async () => {
  const h = makeHarness();
  await seedWorld(h);
  seedBank(h);
  const res = await simuladoCreate(request('enem-simulado-create', { body: { goal_id: ENEM_GOAL, mode: 'area', area: 'MT', source: 'replica', edition: 2023, language: 'en' }, idem: v7(1) }), h.deps);
  assertEquals(res.status, 201, await res.clone().text());
  const body = await json(res);
  assertEquals(body.item_count, 44); // the item under review is not used
  assertEquals(body.time_limit_min, 135);
  assertEquals(body.shortfall, { MT: 1 });
  const quiz = h.db.rows('quizzes').find((q) => q.id === body.quiz_id)!;
  assertEquals(quiz.kind, 'enem_simulado');
  const config = quiz.config as { item_ids: string[]; source: string; seed: string };
  assertEquals(config.item_ids.length, 44);
  assert(!(quiz.question_ids as string[]).includes(qid(90)));
  assertEquals((quiz.question_ids as string[])[0], qid(46)); // edition order: position 1 first

  const prov = await json(await simuladoCreate(request('enem-simulado-create', { body: { goal_id: ENEM_GOAL, mode: 'mini', area: 'MT', mini_size: 15, source: 'provavel', language: 'en' }, idem: v7(2) }), h.deps));
  assertEquals(prov.item_count, 15);
  const provQuiz = h.db.rows('quizzes').find((q) => q.id === prov.quiz_id)!;
  const items = (provQuiz.config as { item_ids: string[] }).item_ids.map((id) => h.db.rows('enem_items').find((i) => i.id === id)!);
  assertEquals(items.filter((i) => (i.enem_topic_ids as string[]).includes('topic-func')).length, 9);

  // Only the owner of an ENEM goal can build one.
  const wrong = await simuladoCreate(request('enem-simulado-create', { body: { goal_id: IDS.goal, mode: 'area', area: 'MT', source: 'misto', language: 'en' }, idem: v7(3) }), h.deps);
  assertEquals(wrong.status, 400);
  const bob = await simuladoCreate(request('enem-simulado-create', { token: BOB.jwt, body: { goal_id: ENEM_GOAL, mode: 'area', area: 'MT', source: 'misto', language: 'en' }, idem: v7(4) }), h.deps);
  assertEquals(bob.status, 404);
});

test('quiz-submit on an ENEM simulado: TRI per area with interval, blanks count as wrong, time coaching', async () => {
  const h = makeHarness();
  await seedWorld(h);
  seedBank(h);
  const created = await json(await simuladoCreate(request('enem-simulado-create', { body: { goal_id: ENEM_GOAL, mode: 'area', area: 'MT', source: 'replica', edition: 2023, language: 'en' }, idem: v7(1) }), h.deps));
  const quiz = h.db.rows('quizzes').find((q) => q.id === created.quiz_id)!;
  const ids = quiz.question_ids as string[];
  // Right on the first 30, wrong on 10, blank on the rest; one item took 8 minutes.
  const answers = ids.slice(0, 40).map((q, i) => ({ id: v7(100 + i), question_id: q, response: { choice: i < 30 ? 'C' : 'A' }, time_spent_ms: i === 4 ? 480_000 : 120_000 }));
  const res = await quizSubmit(request('quiz-submit', { body: { attempt_id: created.attempt_id, answers, finished_at: '2026-10-27T17:00:00Z' }, idem: v7(2) }), h.deps);
  assertEquals(res.status, 200, await res.clone().text());
  const body = await json(res);
  const mt = body.attempt.area_results.areas.MT;
  assertEquals(mt.n_items, 44);
  assertEquals(mt.n_correct, 30);
  assertEquals(mt.n_blank, 4);
  assert(mt.ci80_low < mt.score && mt.score < mt.ci80_high);
  assertEquals(mt.time.stuck_ids.length, 1);
  assertEquals(mt.time.target_s, 180);
  const attempt = h.db.rows('quiz_attempts').find((a) => a.id === created.attempt_id)!;
  assertEquals((attempt.area_results as { areas: { MT: { score: number } } }).areas.MT.score, mt.score);
});

test('grade-essay (ENEM): theme required, ≤ 7 lines is zero without a model call, weekly limit of 3', async () => {
  const h = makeHarness();
  await seedWorld(h);
  const essay = (id: string, text: string, extra: Record<string, unknown> = {}) =>
    h.db.seed('essays', { id, user_id: ALICE.id, kind: 'enem_redacao', theme_id: null, question_id: null, prompt: { theme: 'Mobilidade urbana' }, text, input_mode: 'typed', image_paths: [], capture_id: null, status: 'draft', deleted_at: null, updated_at: '2026-10-27T10:00:00Z', ...extra });
  essay(v7(1), 'Uma frase só.', { prompt: null });
  const noTheme = await gradeEssay(request('grade-essay', { body: { essay_id: v7(1) }, idem: v7(11) }), h.deps);
  assertEquals(noTheme.status, 400);

  essay(v7(2), 'A mobilidade urbana é um desafio. '.repeat(10)); // ≈ 340 chars → 5 lines
  const zero = await json(await gradeEssay(request('grade-essay', { body: { essay_id: v7(2) }, idem: v7(12) }), h.deps));
  assertEquals(zero.mode, 'zero');
  assertEquals(zero.essay.zero_reasons, ['texto_insuficiente']);
  const row = h.db.rows('essays').find((e) => e.id === v7(2))!;
  assertEquals(row.status, 'graded');
  assertEquals(row.total, 0);
  assertEquals(row.is_zero, true);
  assertEquals(h.claude.calls.length, 0);

  const long = 'A mobilidade urbana brasileira enfrenta desafios históricos de planejamento e investimento. '.repeat(12);
  essay(v7(3), long);
  const queued = await json(await gradeEssay(request('grade-essay', { body: { essay_id: v7(3) }, idem: v7(13) }), h.deps));
  assertEquals(queued.mode, 'async');
  assert(h.enqueued.some((e) => e.queue === 'essay.grade'));
  assert(Number(h.db.rows('essays').find((e) => e.id === v7(3))!.est_handwritten_lines) > 7);

  // Two more graded this week reach the limit of 3 (the zero one above counts too).
  essay(v7(4), long, { status: 'graded' });
  essay(v7(5), long);
  const limited = await gradeEssay(request('grade-essay', { body: { essay_id: v7(5) }, idem: v7(14) }), h.deps);
  assertEquals(limited.status, 429);
});

test('essay-theme-generate: past ENEM themes are reused rows; predicted pick; a typed theme is moderated first', async () => {
  const replies: FakeReply[] = [
    reply({ allowed: false, category: 'offensive' }),
    reply({ allowed: true, category: 'ok' }),
    reply({ title: 'Caminhos para ampliar a leitura entre jovens no Brasil', axis: 'educação', instruction: 'Redija…', motivating_texts: [{ kind: 'context', text: 'Contexto.', source_url: null, source_name: null }, { kind: 'data', text: 'Dado inventado.', source_url: 'https://site-falso.com/x', source_name: 'Site' }] }),
  ];
  const h = makeHarness(() => replies.shift() ?? reply('{}'));
  await seedWorld(h);
  h.db.seed('enem_redacao_themes', { edition_year: 2023, application: 'regular', theme: 'Desafios para o enfrentamento da invisibilidade do trabalho de cuidado realizado pela mulher no Brasil' });
  const past = await json(await themeGenerate(request('essay-theme-generate', { body: { source: 'past_enem' }, idem: v7(1) }), h.deps));
  assertEquals(past.source, 'past_enem');
  const again = await json(await themeGenerate(request('essay-theme-generate', { body: { source: 'past_enem' }, idem: v7(2) }), h.deps));
  assertEquals(again.theme_id, past.theme_id);
  assertEquals(h.db.rows('essay_themes').length, 1);

  const none = await themeGenerate(request('essay-theme-generate', { body: { source: 'predicted' }, idem: v7(3) }), h.deps);
  assertEquals(none.status, 404);
  h.db.seed('essay_themes', { id: v7(50), title: 'Tema previsto de treino sobre saúde mental', axis: 'saúde', source: 'predicted', valid_until: '2026-12-01', deleted_at: null, created_at: '2026-10-01T00:00:00Z' });
  const predicted = await json(await themeGenerate(request('essay-theme-generate', { body: { source: 'predicted' }, idem: v7(4) }), h.deps));
  assertEquals(predicted.theme_id, v7(50));

  const blocked = await themeGenerate(request('essay-theme-generate', { body: { source: 'custom', title: 'tema ofensivo qualquer' }, idem: v7(5) }), h.deps);
  assertEquals(blocked.status, 400);
  const custom = await json(await themeGenerate(request('essay-theme-generate', { body: { source: 'custom', title: 'Leitura entre jovens' }, idem: v7(6) }), h.deps));
  const row = h.db.rows('essay_themes').find((t) => t.id === custom.theme_id)!;
  assertEquals(row.created_by, ALICE.id);
  const texts = (row.prompt as { motivating_texts: Array<{ source_url: string | null }> }).motivating_texts;
  assertEquals(texts.length, 1, 'a URL that was not among the given sources is dropped');
  assertEquals(texts[0]!.source_url, null);
});

const FEEDBACK = { rubric: { tese: 3, fundamentacao: 2, repertorio: 1, coerencia: 3, refutacao: 1, falacias: 3 }, fallacies: [], tip: 'Traga um dado.' };
const SUMMARY = {
  rubric: { tese: 3, fundamentacao: 3, repertorio: 2, coerencia: 3, refutacao: 2, falacias: 4 },
  strongest_argument: 'O tempo de deslocamento.',
  weakest_point: 'Refutação.',
  fallacies: [],
  repertorio_suggestions: [{ text: 'Dados do IBGE.', origin: 'geral' }],
  strengths: ['Tese clara.'],
  improve: ['Antecipe objeções.'],
  outline: {
    introducao: { contexto: 'As cidades cresceram.', tese: 'É preciso investir no transporte público.' },
    d1: { topico: 'Tempo perdido.', argumento: 'Deslocamentos longos.', repertorio: null },
    d2: { topico: 'Desigualdade.', argumento: 'Periferias sem acesso.', repertorio: null },
    conclusao: { retomada: 'Portanto…', proposta: { agente: 'O governo federal', acao: 'ampliar o investimento', meio: 'por meio de parcerias', finalidade: 'para reduzir o tempo de deslocamento', detalhamento: 'priorizando periferias' } },
  },
};

test('argumentação (ENEM): thesis first, rounds with parallel feedback, summary with outline and a redação draft', async () => {
  const replies: FakeReply[] = [
    reply({ clear: true, has_position: true, specific: true, feedback: 'Tese clara.', suggestion: null }),
    reply('Mas investir não basta se a gestão for ruim. Que dado sustenta sua ideia?'),
    reply(FEEDBACK),
    reply(SUMMARY),
  ];
  const h = makeHarness(() => replies.shift() ?? reply('{}'));
  await seedWorld(h);
  const start = await json(await argumentStart(request('argument-start', { body: { goal_mode: 'enem', theme: 'Desafios da mobilidade urbana no Brasil', theme_source: 'enem', mode: 'debate' }, idem: v7(1) }), h.deps));
  assert(start.opening.includes('tese'));
  const sid = start.session_id;
  const raw = h.db.rows('argument_sessions')[0]!;
  assertEquals(raw.round_limit, 4);

  const finishEarly = await argumentFinish(request('argument-finish', { body: { session_id: sid }, idem: v7(2) }), h.deps);
  assertEquals(finishEarly.status, 400);

  const thesis = parseSse(await (await argumentTurn(request('argument-turn', { body: { session_id: sid, message: 'É preciso investir no transporte público.' }, idem: v7(3) }), h.deps)).text());
  assertEquals((thesis.at(-1)!.data as { result: { stage: string } }).result.stage, 'thesis');
  const round = parseSse(await (await argumentTurn(request('argument-turn', { body: { session_id: sid, message: 'Ônibus lotados fazem as pessoas perderem horas.' }, idem: v7(4) }), h.deps)).text());
  const done = round.at(-1)!.data as { result: { stage: string; round: number; final: boolean; feedback: typeof FEEDBACK } };
  assertEquals(done.result.stage, 'round');
  assertEquals(done.result.round, 1);
  assertEquals(done.result.feedback.tip, 'Traga um dado.');
  assert((round.find((f) => f.event === 'delta')!.data as { text: string }).text.startsWith('Mas investir'));
  // ENEM sessions send no documents; the reply and the feedback were separate calls.
  const replyCall = h.claude.calls[1]!.params;
  assert(!JSON.stringify(replyCall.messages).includes('"type":"document"'));

  const bob = await argumentTurn(request('argument-turn', { token: BOB.jwt, body: { session_id: sid, message: 'oi' }, idem: v7(5) }), h.deps);
  assertEquals(bob.status, 404);

  const fin = await json(await argumentFinish(request('argument-finish', { body: { session_id: sid, create_essay: true }, idem: v7(6) }), h.deps));
  assertEquals(fin.rubric.total, Math.round((17 / 24) * 100));
  assertEquals(fin.outline.conclusao.proposta.agente, 'O governo federal');
  const essay = h.db.rows('essays').find((e) => e.id === fin.essay_id)!;
  assertEquals(essay.kind, 'enem_redacao');
  assertEquals((essay.prompt as { theme: string }).theme, 'Desafios da mobilidade urbana no Brasil');
  assert(String(essay.text).includes('O governo federal deve ampliar o investimento'));
  assertEquals(h.db.rows('argument_sessions')[0]!.status, 'finished');
});

test('admin endpoints: 403 for students; import enqueues; publishing a digest notifies; withdrawn items disappear', async () => {
  const h = makeHarness();
  await seedWorld(h);
  h.db.users.set('jwt-admin', { id: ADMIN, email: 'adm@example.com' });
  h.db.seed('profiles', { id: ADMIN, display_name: 'Adm', app_role: 'app_admin', timezone: 'America/Sao_Paulo', settings: {}, deleted_at: null });
  const denied = await adminImport(request('admin-enem-import', { body: { year: 2025 }, idem: v7(1) }), h.deps);
  assertEquals(denied.status, 403);
  const ok = await adminImport(request('admin-enem-import', { token: 'jwt-admin', body: { year: 2025 }, idem: v7(2) }), h.deps);
  assertEquals(ok.status, 202);
  assertEquals(h.enqueued.find((e) => e.queue === 'enem.import_edition')!.data, { year: 2025, application: 'regular', ai_job_id: (await json(ok)).job_id, requested_by: ADMIN });

  h.db.seed('atualidades_digests', { id: v7(30), week_start: '2026-10-26', status: 'draft', published_at: null });
  h.db.seed('atualidades_items', { id: v7(31), digest_id: v7(30), title: 'Item', summary_md: 'x', why_md: 'y', sources: [{ url: 'https://a.b/c', name: 'A' }], question_ids: [qid(1)], withdrawn: false });
  const pub = await adminPublish(request('admin-atualidades-publish', { token: 'jwt-admin', body: { action: 'publish', digest_id: v7(30) }, idem: v7(3) }), h.deps);
  assertEquals(pub.status, 200);
  assertEquals(h.db.rows('atualidades_digests')[0]!.status, 'published');
  assert(h.enqueued.some((e) => e.queue === 'atualidades.notify'));
  await adminPublish(request('admin-atualidades-publish', { token: 'jwt-admin', body: { action: 'withdraw_item', item_id: v7(31) }, idem: v7(4) }), h.deps);
  assertEquals(h.db.rows('atualidades_items')[0]!.withdrawn, true);
});

test('ENEM-style generation: excerpt must match the page text; rows carry texto_base, skill and band', async () => {
  const good = {
    texto_base: { kind: 'excerpt', content_md: 'a clorofila capta luz', chart_data: null, source_pages: [{ doc: 'D1', page_start: 13, page_end: 13 }], label: null },
    comando_md: 'Segundo o texto, qual é o papel da clorofila?',
    alternatives: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label, text_md: `Opção ${label}` })),
    answer: 'B',
    explanation_md: 'A clorofila capta luz.',
    distractor_rationales: ['A', 'C', 'D', 'E'].map((label) => ({ label, why: 'Não.' })),
    skill_code: 'CN-H14',
    difficulty: 'media',
    source_pages: [{ doc: 'D1', page_start: 13, page_end: 13 }],
  };
  const invented = { ...good, texto_base: { ...good.texto_base, content_md: 'texto que não está em página nenhuma do material' } };
  const h = makeHarness(reply({ items: [good, invented] }));
  await seedWorld(h);
  h.db.table('subjects').find((s) => s.id === IDS.subject)!.enem_area = 'CN';
  h.db.seed('enem_skills', { code: 'CN-H14', area: 'CN', competency_no: 4, skill_no: 14, description: null });
  const res = await generateMore(request('enem-questions-generate', { body: { node_id: IDS.topic, enem_style: true }, idem: v7(1) }), h.deps);
  assertEquals(res.status, 200, await res.clone().text());
  const body = await json(res);
  assertEquals(body.question_ids.length, 1);
  const row = h.db.rows('questions').find((q) => q.id === body.question_ids[0])!;
  assertEquals(row.enem_style, true);
  assertEquals(row.enem_skill_code, 'CN-H14');
  assertEquals(row.difficulty_band, 'media');
  assertEquals((row.texto_base as { kind: string }).kind, 'excerpt');
  assertEquals((row.payload as { correct: string }).correct, 'B');

  assert(excerptMatches('A clorofila — capta a luz…  [...] na página 13', ['Fotossíntese na página 13: a clorofila capta luz.']) === false);
  assert(excerptMatches('a clorofila capta luz', ['Fotossíntese na página 13: a clorofila capta luz.']));
});

test('sync-push: bank answers count only for published items', async () => {
  const h = makeHarness();
  await seedWorld(h);
  seedBank(h);
  h.db.seed('quizzes', { id: v7(60), owner_id: ALICE.id, kind: 'practice', mode: 'practice', question_ids: [qid(1), qid(90)], config: {}, deleted_at: null });
  h.db.seed('quiz_attempts', { id: v7(61), user_id: ALICE.id, quiz_id: v7(60), status: 'in_progress', started_at: '2026-10-27T10:00:00Z' });
  const answer = (id: number, question: string) => ({
    id: v7(id),
    kind: 'attempt_answer',
    created_at: '2026-10-27T14:00:00Z',
    payload: { attempt_id: v7(61), question_id: question, question_version: 1, response: { choice: 'C' }, time_spent_ms: 30_000, answered_at: '2026-10-27T14:00:00Z' },
  });
  const res = await json(
    await syncPush(request('sync-push', { idem: v7(62), body: { schema_version: 1, device_id: 'device-1', items: [answer(70, qid(1)), answer(71, qid(90))] } }), h.deps),
  );
  assert(res.acked.includes(v7(70)), JSON.stringify(res));
  assertEquals(res.rejected.find((r: { id: string }) => r.id === v7(71))?.code, 'forbidden');
});
