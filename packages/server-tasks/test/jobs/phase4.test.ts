import { beforeEach, describe, expect, it } from 'vitest';
import { handleEssayGrade, handleRetaFinal, handleTagNodes, handleThemesPredict, handleTopicStats, sheetLines, themeKey, titleSimilarity } from '../../src/jobs/enem.ts';
import { handleAtualidadesNotify, handleAtualidadesWeekly, validateDigest, weekStartOf } from '../../src/jobs/atualidades.ts';
import { handlePlanRecompute } from '../../src/jobs/planning.ts';
import { cropRegions, findQuestionMarkers, groupItems, itemForMarker, parseAnswerKey, parseItensProva } from '../../src/enem/import-parse.ts';
import { NOW, SUBJECT, TOPIC, TOPIC_B, USER, USER_B, fakeEnv, type FakeEnv } from './fakes.ts';
import { seedStudent } from './seed.ts';

let env: FakeEnv;
const ESSAY = '0190a000-0000-7000-8000-00000000e55a';
const ENEM_GOAL = '0190a000-0000-7000-8000-00000000e60a';

beforeEach(() => {
  env = fakeEnv(NOW);
  seedStudent(env.db);
});

const LONG = 'A mobilidade urbana brasileira enfrenta desafios históricos de planejamento e de investimento público. '.repeat(14);

function grade(overrides: Record<string, unknown> = {}) {
  const c = (id: number, score: number) => ({ id, score, level_text: 'Bom.', justification: 'Ok.', evidence: [{ quote: 'mobilidade', line: 1 }], issues: [], strengths: [] });
  const el = { present: true, quote: 'o governo' };
  return {
    zero_check: { is_zero: false, reasons: [], evidence: null },
    competencias: [c(1, 160), c(2, 160), c(3, 120), c(4, 160), c(5, 160)],
    proposta: { agente: el, acao: el, meio: el, finalidade: el, detalhamento: { present: false, quote: null }, direitos_humanos_ok: true, note: null },
    repertorio_refs: [
      { text: 'Segundo o IBGE, 40% usam ônibus.', kind: 'data', line: 2 },
      { text: 'Como disse Platão, a cidade é o homem.', kind: 'quote', line: 3 },
    ],
    rewrites: [],
    top_actions: ['a', 'b', 'c'],
    ...overrides,
  };
}

/** A research reply with one web citation (raw content blocks). */
function research(url: string, text = 'Encontrei o dado no IBGE.') {
  return {
    content: [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url, title: 'Fonte', encrypted_content: 'e', page_age: null }] },
      { type: 'text', text, citations: [{ type: 'web_search_result_location', url, title: 'Fonte', cited_text: 'dado', encrypted_index: 'i' }] },
    ],
  };
}

describe('essay.grade (ENM-05)', () => {
  function seedEssay(text = LONG, extra: Record<string, unknown> = {}) {
    env.db.seed('essays', [{ id: ESSAY, user_id: USER, kind: 'enem_redacao', theme_id: null, prompt: { theme: 'Desafios da mobilidade urbana no Brasil' }, text, input_mode: 'typed', status: 'grading', deleted_at: null, ...extra }]);
  }

  it('grades with the total in code, verifies repertório against cited URLs, and notifies', async () => {
    seedEssay();
    env.claude.reply('avaliador de redações do ENEM', grade());
    // Structuring step first (the fake answers the first matching rule): its prompt carries the research text.
    // IBGE is confirmed with its cited URL; Platão "confirmed" with a URL the research never cited.
    env.claude.reply('Encontrei o dado no IBGE', { status: 'confirmed', source_url: 'https://www.ibge.gov.br/dado', source_name: 'IBGE', note: 'Confirmado.' });
    env.claude.reply('Não achei essa frase', { status: 'confirmed', source_url: 'https://site-inventado.com/x', source_name: 'Site', note: 'Ok.' });
    env.claude.reply('IBGE, 40% usam', research('https://www.ibge.gov.br/dado'));
    env.claude.reply('Platão', research('https://pt.wikipedia.org/platao', 'Não achei essa frase.'));
    const out = await handleEssayGrade(env.ctx, { essay_id: ESSAY, user_id: USER }, { aiJobId: null });
    expect(out).toEqual({ status: 'graded', total: 760 });
    const row = env.db.rows('essays')[0]!;
    expect(row.status).toBe('graded');
    expect(row.total).toBe(760);
    expect(row.is_zero).toBe(false);
    expect(row.competencias.c3.score).toBe(120);
    const rep = row.repertorio as Array<{ status: string; source_url: string | null }>;
    expect(rep[0]).toMatchObject({ status: 'confirmed', source_url: 'https://www.ibge.gov.br/dado' });
    expect(rep[1]).toMatchObject({ status: 'not_found', source_url: null });
    expect(row.feedback.calibration).toBe('pending');
    expect(row.est_handwritten_lines).toBeGreaterThan(7);
    expect(env.enqueued.find((e) => e.name === 'notify.dispatch')?.data).toEqual({ user_id: USER, type: 'essay_graded', data: { essay_id: ESSAY } });
  });

  it('a human-rights violation zeroes only C5; a zero condition zeroes the total', async () => {
    seedEssay();
    env.claude.reply('avaliador de redações do ENEM', grade({ proposta: { ...grade().proposta, direitos_humanos_ok: false }, repertorio_refs: [] }));
    expect(await handleEssayGrade(env.ctx, { essay_id: ESSAY, user_id: USER }, { aiJobId: null })).toEqual({ status: 'graded', total: 600 });
    expect(env.db.rows('essays')[0]!.competencias.c5.score).toBe(0);

    env = fakeEnv(NOW);
    seedStudent(env.db);
    seedEssay();
    env.claude.reply('avaliador de redações do ENEM', grade({ zero_check: { is_zero: true, reasons: ['fuga_tema'], evidence: 'Fala de outro tema.' }, repertorio_refs: [] }));
    await handleEssayGrade(env.ctx, { essay_id: ESSAY, user_id: USER }, { aiJobId: null });
    const row = env.db.rows('essays')[0]!;
    expect(row).toMatchObject({ total: 0, is_zero: true, zero_reasons: ['fuga_tema'] });
  });

  it('marks the essay failed when the grader is unavailable, and skips another user’s essay', async () => {
    seedEssay();
    env.claude.reply('avaliador de redações do ENEM', { refusal: true });
    expect(await handleEssayGrade(env.ctx, { essay_id: ESSAY, user_id: USER }, { aiJobId: null })).toEqual({ status: 'failed' });
    expect(env.db.rows('essays')[0]!.status).toBe('failed');
    expect(await handleEssayGrade(env.ctx, { essay_id: ESSAY, user_id: USER_B }, { aiJobId: null })).toEqual({ status: 'skipped' });
  });

  it('wraps typed essays into 75-character sheet lines', () => {
    const lines = sheetLines(`${'palavra '.repeat(20)}\n\nSegundo parágrafo.`, 'typed');
    expect(lines.every((l) => l.length <= 75)).toBe(true);
    expect(lines.at(-1)).toBe('Segundo parágrafo.');
    expect(sheetLines('linha 1\n\nlinha 2', 'photo')).toEqual(['linha 1', 'linha 2']);
  });
});

describe('enem.tag_nodes (ENM-01.4)', () => {
  it('writes skill codes and ENEM topic links above the confidence floor, with valid codes only', async () => {
    env.db.table('subjects')[0]!.enem_area = 'CN';
    env.db.seed('enem_skills', [
      { code: 'CN-H14', area: 'CN', competency_no: 4, skill_no: 14, description: null },
      { code: 'CN-H17', area: 'CN', competency_no: 5, skill_no: 17, description: null },
    ]);
    env.db.seed('enem_topics', [{ id: 'topic-cito', area: 'CN', subject: 'Biologia', title: 'Citologia', position: 0 }]);
    env.claude.reply('Matriz de Referência', {
      nodes: [
        { node_key: 'n2', skill_codes: [{ code: 'CN-H14', confidence: 0.9 }, { code: 'CN-H17', confidence: 0.3 }], enem_topic_keys: [{ key: 'T1', confidence: 0.8 }] },
        { node_key: 'n3', skill_codes: [{ code: 'MT-H1', confidence: 0.9 }], enem_topic_keys: [{ key: 'T9', confidence: 0.9 }] },
      ],
    });
    const out = await handleTagNodes(env.ctx, { subject_id: SUBJECT });
    expect(out).toEqual({ tagged: 1, links: 1 });
    const topic = env.db.rows('knowledge_nodes').find((n) => n.id === TOPIC)!;
    expect(topic.enem_skill_codes).toEqual(['CN-H14']);
    expect(env.db.rows('knowledge_nodes').find((n) => n.id === TOPIC_B)!.enem_skill_codes).toEqual([]);
    expect(env.db.rows('knowledge_node_enem_topics')).toEqual([expect.objectContaining({ node_id: TOPIC, enem_topic_id: 'topic-cito', confidence: 0.8 })]);
  });
});

describe('enem.topic_stats (ENM-08.1–08.2, ENM-02.3)', () => {
  it('recomputes stats, trends and difficulty bands from the published bank', async () => {
    env.db.seed('enem_topics', [
      { id: 'tA', area: 'MT', subject: 'Matemática', title: 'Funções', position: 0 },
      { id: 'tB', area: 'MT', subject: 'Matemática', title: 'Geometria', position: 1 },
    ]);
    const items = [];
    const params = [];
    for (let y = 2015; y <= 2024; y++) {
      for (let i = 0; i < 10; i++) {
        const id = `item-${y}-${i}`;
        items.push({ id, question_id: `q-${id}`, edition_year: y, area: 'MT', application: 'regular', annulled: false, review_status: 'ok', enem_topic_ids: [i < (y >= 2020 ? 6 : 3) ? 'tA' : 'tB'] });
        params.push({ enem_item_id: id, a: 1, b: -2 + i * 0.4, c: 0.2, scale: 'std', logistic_d: 1 });
      }
    }
    env.db.seed('enem_items', items);
    env.db.seed('enem_item_params', params);
    env.db.seed('questions', items.map((i) => ({ id: i.question_id, difficulty_band: null })));
    const out = await handleTopicStats(env.ctx);
    expect(out.stats).toBe(20);
    const trends = env.db.rows('enem_topic_trends');
    expect(trends.find((t) => t.enem_topic_id === 'tA')!.trend).toBe('up');
    expect(trends.find((t) => t.enem_topic_id === 'tB')!.trend).toBe('down');
    expect(trends.reduce((s, t) => s + t.predicted_share, 0)).toBeCloseTo(1, 6);
    const bands = env.db.rows('questions').map((q) => q.difficulty_band);
    expect(new Set(bands)).toEqual(new Set(['facil', 'media', 'dificil', 'muito_dificil']));
    expect(env.pgQueries.some((q) => q.text.includes('delete from public.enem_topic_stats'))).toBe(true);
  });
});

describe('enem.themes.predict (ENM-08.6)', () => {
  const TITLES: Record<string, string> = {
    saúde: 'Desafios para o enfrentamento da invisibilidade do trabalho de cuidado realizado pela mulher no Brasil',
    educação: 'Caminhos para ampliar o acesso à leitura entre jovens brasileiros',
    'meio ambiente': 'Os impactos da seca prolongada nos rios da Amazônia',
    tecnologia: 'Limites para o uso de algoritmos na vida cotidiana',
    cidadania: 'A participação juvenil nas decisões das cidades',
    cultura: 'A valorização das culturas populares regionais',
    trabalho: 'Perspectivas do trabalho por aplicativos na economia nacional',
    mobilidade: 'Mobilidade urbana e o tempo perdido no transporte coletivo',
    segurança: 'Prevenção de golpes digitais contra idosos',
  };
  const themes = (axes: string[]) => ({
    themes: axes.map((axis) => ({
      title: TITLES[axis]!,
      axis,
      rationale: 'Padrão.',
      connections: [{ digest_item_key: 'A1', why: 'Relacionado.' }],
      repertorio_directions: ['dados'],
      prompt: {
        instruction: 'Redija…',
        motivating_texts: [
          { kind: 'summary', text: 'Resumo.', source_url: 'https://agenciabrasil.ebc.com.br/x', source_name: 'Agência Brasil', published_at: '2026-10-20' },
          { kind: 'data', text: 'Dado inventado.', source_url: 'https://fora-da-lista.com/y', source_name: 'Outro', published_at: null },
        ],
      },
    })),
  });

  it('runs on the first Monday only, drops themes too close to past ones and replaces the active list', async () => {
    env.setNow('2026-11-02T13:00:00.000Z'); // Monday, day 2
    env.db.seed('enem_redacao_themes', [{ edition_year: 2023, theme: 'Desafios para o enfrentamento da invisibilidade do trabalho de cuidado realizado pela mulher no Brasil' }]);
    env.db.seed('atualidades_digests', [{ id: 'd1', status: 'published', published_at: '2026-10-20T09:00:00Z' }]);
    env.db.seed('atualidades_items', [{ id: 'item-1', digest_id: 'd1', title: 'Seca', summary_md: 'Rios baixos.', redacao_axes: ['meio ambiente'], sources: [{ url: 'https://agenciabrasil.ebc.com.br/x', name: 'Agência Brasil', published_at: '2026-10-20' }], withdrawn: false }]);
    env.db.seed('essay_themes', [{ id: 'old', title: 'Tema antigo previsto', source: 'predicted', deleted_at: null }]);
    env.claude.reply('temas de TREINO', themes(['saúde', 'educação', 'meio ambiente', 'tecnologia', 'cidadania', 'cultura', 'trabalho', 'mobilidade', 'segurança']));
    const out = await handleThemesPredict(env.ctx, {});
    expect(out).toEqual({ status: 'done', themes: 8 }); // the copy of the 2023 theme is dropped
    const rows = env.db.rows('essay_themes');
    expect(rows.find((r) => r.id === 'old')!.deleted_at).toBeTruthy();
    const fresh = rows.filter((r) => r.source === 'predicted' && !r.deleted_at);
    expect(fresh).toHaveLength(8);
    expect(fresh[0]!.prompt.motivating_texts).toHaveLength(1);
    expect(fresh[0]!.connections).toEqual([{ atualidades_item_id: 'item-1', why: 'Relacionado.' }]);

    env.setNow('2026-11-09T13:00:00.000Z');
    expect(await handleThemesPredict(env.ctx, {})).toEqual({ status: 'skipped' });
  });

  it('compares titles without accents, case or punctuation', () => {
    expect(themeKey('Desafios: Saúde Mental!')).toBe('desafios saude mental');
    expect(titleSimilarity('Desafios da saúde mental no Brasil', 'Desafios para a saúde mental no Brasil')).toBeGreaterThan(0.6);
  });
});

describe('Atualidades (ENM-09)', () => {
  const item = (title: string, url: string) => ({
    title,
    summary_md: 'Resumo neutro.',
    why_md: 'Importa.',
    areas: ['CH'],
    skill_codes: ['CH-H26', 'MT-H30'],
    redacao_axes: ['meio ambiente'],
    repertorio: [{ text: 'Dado.', source_url: url }],
    sources: [{ url, name: 'Fonte', published_at: '2026-10-20' }],
    questions: [0, 1].map(() => ({
      texto_base_md: 'Texto elaborado pelo Studify: …',
      comando_md: 'Qual?',
      alternatives: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label, text_md: `Opção ${label}` })),
      answer: 'C',
      explanation_md: 'Porque…',
      distractor_rationales: ['A', 'B', 'D', 'E'].map((label) => ({ label, why: 'Não.' })),
      skill_code: 'CH-H26',
      difficulty: 'media',
    })),
  });

  beforeEach(() => {
    env.setNow('2026-10-26T09:00:00.000Z'); // Monday 06:00 in Brasília
    env.pgRows.push({ match: 'atualidades_sources', rows: [{ domain: 'agenciabrasil.ebc.com.br' }, { domain: 'ibge.gov.br' }] });
    env.db.table('profiles').push({ id: 'admin-1', app_role: 'app_admin', timezone: 'America/Sao_Paulo', settings: {}, deleted_at: null });
    env.db.seed('enem_skills', [{ code: 'CH-H26', area: 'CH', description: null }]);
  });

  it('drafts a digest whose sources are cited, allowlisted URLs, with 2 practice questions per item', async () => {
    env.claude.reply('notícias da semana', {
      content: [
        { type: 'text', text: 'Notícias.', citations: ['a', 'b', 'c'].map((p) => ({ type: 'web_search_result_location', url: `https://agenciabrasil.ebc.com.br/${p}`, title: p, cited_text: p, encrypted_index: p })) },
      ],
    });
    env.claude.reply('resumo semanal de Atualidades', {
      items: [item('Item um', 'https://agenciabrasil.ebc.com.br/a'), item('Item dois', 'https://agenciabrasil.ebc.com.br/b'), item('Item três', 'https://agenciabrasil.ebc.com.br/c'), item('Inventado', 'https://outro-site.com/z')],
      skipped_note: null,
    });
    const out = await handleAtualidadesWeekly(env.ctx, {});
    expect(out).toMatchObject({ status: 'drafted', items: 3 });
    expect(env.db.rows('atualidades_digests')[0]).toMatchObject({ week_start: '2026-10-26', status: 'draft' });
    const items = env.db.rows('atualidades_items');
    expect(items.map((i) => i.title)).toEqual(['Item um', 'Item dois', 'Item três']);
    expect(items[0]!.skill_codes).toEqual(['CH-H26']);
    expect(items[0]!.question_ids).toHaveLength(2);
    const q = env.db.rows('questions').find((x) => x.id === items[0]!.question_ids[0])!;
    expect(q).toMatchObject({ enem_style: true, texto_base: { kind: 'written', label: 'Texto elaborado pelo Studify' } });
    expect(env.db.rows('subjects').find((s) => s.system_kind === 'atualidades')).toBeTruthy();
    // Running again the same week does nothing.
    expect(await handleAtualidadesWeekly(env.ctx, {})).toEqual({ status: 'exists' });
  });

  it('skips a week with fewer than 3 usable items', async () => {
    env.claude.reply('notícias da semana', research('https://agenciabrasil.ebc.com.br/a'));
    env.claude.reply('resumo semanal de Atualidades', { items: [item('Item um', 'https://agenciabrasil.ebc.com.br/a')], skipped_note: 'Semana fraca.' });
    expect(await handleAtualidadesWeekly(env.ctx, {})).toEqual({ status: 'skipped', reason: 'too_few_items' });
    expect(env.db.rows('atualidades_digests')).toHaveLength(0);
  });

  it('validateDigest keeps only cited, allowlisted URLs; weekStartOf is the Monday in Brasília', () => {
    const kept = validateDigest({ items: [item('Item um', 'https://ibge.gov.br/x')], skipped_note: null } as never, [{ url: 'https://ibge.gov.br/x' }], ['ibge.gov.br'], new Set(['CH-H26']));
    expect(kept).toHaveLength(1);
    expect(validateDigest({ items: [item('Item um', 'https://ibge.gov.br/x')], skipped_note: null } as never, [], ['ibge.gov.br'], new Set())).toHaveLength(0);
    expect(weekStartOf(new Date('2026-10-26T02:00:00Z'))).toBe('2026-10-19'); // Sunday 23:00 in Brasília
  });

  it('atualidades.notify pushes only to opted-in ENEM students', async () => {
    env.db.seed('goals', [
      { id: 'g1', user_id: USER, mode: 'enem', status: 'active', deleted_at: null },
      { id: 'g2', user_id: USER_B, mode: 'enem', status: 'active', deleted_at: null },
    ]);
    env.db.seed('profiles', [
      { id: USER, settings: { notify_atualidades: true }, deleted_at: null },
      { id: USER_B, settings: {}, deleted_at: null },
    ]);
    expect(await handleAtualidadesNotify(env.ctx, { digest_id: '0190a000-0000-7000-8000-0000000000d1' })).toEqual({ sent: 1 });
    expect(env.enqueued[0]!.data).toMatchObject({ user_id: USER, type: 'atualidades_published' });
  });
});

describe('enem.reta_final (ENM-10)', () => {
  it('sends the exam-day message at 08:00 local only', async () => {
    env.db.seed('goals', [{ id: ENEM_GOAL, user_id: USER, mode: 'enem', status: 'active', settings: { enem_edition: 2026 }, deleted_at: null }]);
    env.db.seed('enem_editions', [{ year: 2026, day1_date: '2026-11-08', day2_date: '2026-11-15' }]);
    env.setNow('2026-11-08T11:00:00.000Z'); // 08:00 in São Paulo
    expect(await handleRetaFinal(env.ctx)).toEqual({ sent: 1 });
    expect(env.enqueued[0]!.data).toMatchObject({ type: 'enem_exam_day' });
    env.setNow('2026-11-08T14:00:00.000Z');
    expect(await handleRetaFinal(env.ctx)).toEqual({ sent: 0 });
    env.setNow('2026-11-07T22:00:00.000Z'); // eve, 19:00
    expect(await handleRetaFinal(env.ctx)).toEqual({ sent: 1 });
    expect(env.enqueued[1]!.data).toMatchObject({ type: 'enem_eve' });
  });
});

describe('plan.recompute with an ENEM goal (ENM-07, 07 §8.9)', () => {
  it('writes ENEM units under the ENEM goal and keeps the school test its share', async () => {
    env.db.seed('goals', [
      { id: '77777777-7777-4777-8777-777777777777', user_id: USER, mode: 'exam_week', name: 'Semestre', status: 'active', start_date: '2026-10-01', end_date: '2026-12-15', deleted_at: null },
      { id: ENEM_GOAL, user_id: USER, mode: 'enem', name: 'ENEM 2027', status: 'active', start_date: '2026-10-01', end_date: '2027-11-14', settings: { enem_edition: 2027 }, deleted_at: null },
    ]);
    env.db.seed('enem_editions', [{ year: 2027, day1_date: '2027-11-07', day2_date: '2027-11-14', start_time: '13:30:00', day1_duration_min: 330, day2_duration_min: 300 }]);
    const out = await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'manual_edit' });
    expect(out).toMatchObject({ status: 'planned' });
    const items = env.db.rows('plan_items');
    const enem = items.filter((i) => i.goal_id === ENEM_GOAL);
    const school = items.filter((i) => i.goal_id !== ENEM_GOAL);
    expect(enem.length).toBeGreaterThan(0);
    expect(school.length).toBeGreaterThan(0);
    expect(enem.some((i) => i.reason_key === 'enem.plan.essay')).toBe(true);
    // The Bio test on 2026-11-03 is within 14 days: ENEM keeps at most 20% of those days.
    const day = '2026-10-28';
    const enemMin = enem.filter((i) => i.local_date === day).reduce((s, i) => s + i.minutes, 0);
    expect(enemMin).toBeLessThanOrEqual(12);
    // Same inputs again: nothing new is written.
    expect(await handlePlanRecompute(env.ctx, { user_id: USER, trigger: 'manual_edit' })).toEqual({ status: 'unchanged' });
  });
});

describe('bank import parsing (spec 09 §8.1)', () => {
  const CSV = [
    'CO_POSICAO;SG_AREA;CO_ITEM;TX_GABARITO;CO_HABILIDADE;IN_ITEM_ABAN;TX_MOTIVO_ABAN;NU_PARAM_A;NU_PARAM_B;NU_PARAM_C;TX_COR;CO_PROVA;TP_LINGUA',
    '1;LC;100;A;5;0;;1,2;-0,5;0,2;AZUL;1191;0',
    '1;LC;101;B;6;0;;1,1;0,3;0,15;AZUL;1191;1',
    '6;LC;102;C;18;1;Problema;;;;AZUL;1191;',
    '2;LC;100;A;5;0;;1,2;-0,5;0,2;AMARELA;1192;0',
    '136;MT;200;D;21;0;;2,0;1,4;0,1;AZUL;1211;',
  ].join('\n');

  it('parses ITENS_PROVA with decimal commas, languages, annulled items and one group per CO_ITEM', () => {
    const rows = parseItensProva(CSV);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ area: 'LC', key: 'A', skill: 'LC-H5', a: 1.2, b: -0.5, language: 'en' });
    expect(rows[1]!.language).toBe('es');
    expect(rows[2]).toMatchObject({ annulled: true, annulReason: 'Problema', a: null });
    const groups = groupItems(rows);
    expect(groups).toHaveLength(4);
    expect(groups.find((g) => g.coItem === '100')!.positions).toEqual([
      { co_prova: '1191', color: 'AZUL', position: 1 },
      { co_prova: '1192', color: 'AMARELA', position: 2 },
    ]);
  });

  it('reads answer keys in several layouts', () => {
    const keys = parseAnswerKey('QUESTÃO GABARITO\n1 A\n2 - C\n3 Anulado\n4: E 5) B');
    expect([...keys.entries()]).toEqual([
      [1, 'A'],
      [2, 'C'],
      [3, null],
      [4, 'E'],
      [5, 'B'],
    ]);
  });

  it('finds markers column by column (split spans included) and crops to the next marker or the column end', () => {
    const span = (text: string, x: number, y: number) => ({ text, x, y, w: 0.1, h: 0.01 });
    const pages = [
      { pageNumber: 1, spans: [span('QUESTÃO 01', 0.05, 0.1), span('QUESTÃO', 0.05, 0.5), span('02', 0.16, 0.5), span('QUESTÃO 03', 0.55, 0.4)] },
      { pageNumber: 2, spans: [span('texto', 0.05, 0.1), span('QUESTÃO 01', 0.05, 0.3)] },
    ];
    const markers = findQuestionMarkers(pages);
    expect(markers.map((m) => [m.position, m.page, m.column, m.occurrence])).toEqual([
      [1, 1, 0, 1],
      [2, 1, 0, 1],
      [3, 1, 1, 1],
      [1, 2, 0, 2],
    ]);
    const crops = cropRegions(markers, 2);
    expect(crops.get(markers[0]!)).toEqual([{ page: 1, x0: 0.03, x1: 0.5, y0: 0.095, y1: 0.495 }]);
    // Q2 runs to the end of the left column and continues at the top of the right column (above Q3).
    expect(crops.get(markers[1]!)!.map((r) => [r.page, r.x0])).toEqual([
      [1, 0.03],
      [1, 0.5],
    ]);
    // Q3 continues on the next page's left column, above its first marker.
    expect(crops.get(markers[2]!)!.at(-1)).toMatchObject({ page: 2, x0: 0.03, y1: 0.295 });
  });

  it('matches the second occurrence of a foreign-language position to the Spanish item', () => {
    const groups = groupItems(parseItensProva(CSV));
    const marker = { position: 1, occurrence: 2, page: 2, column: 0 as const, y: 0.3 };
    expect(itemForMarker(groups, { LC: '1191' }, marker)!.coItem).toBe('101');
    expect(itemForMarker(groups, { LC: '1191' }, { ...marker, occurrence: 1 })!.coItem).toBe('100');
    expect(itemForMarker(groups, { MT: '1211' }, { ...marker, position: 136 })!.coItem).toBe('200');
  });
});

void NOW;
