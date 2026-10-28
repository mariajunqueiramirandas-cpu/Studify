import type { z } from 'zod';
import * as S from '../src/schemas/index.ts';
import { QuestionVariants } from '../src/schemas/index.ts';

export interface SchemaCase {
  name: string;
  schema: z.ZodType;
  valid: unknown;
  invalid: unknown;
}

const ref = { doc: 'D1', page_start: 3, page_end: 4 };
const remediation = { front: 'O que é fotossíntese?', back: 'Conversão de luz em energia química.' };
const common = {
  stem: 'Qual organela produz ATP?',
  stimulus_md: '',
  explanation: 'A mitocôndria realiza a respiração celular.',
  bloom_level: 'remember',
  difficulty: 2,
  concept_keys: ['c1'],
  source_pages: [ref],
  remediation_card: remediation,
};
/** Model output shape of the question tasks: the payload travels as a JSON string. */
const asDraft = (type: string, payload: unknown) => {
  const { payload: _payload, ...rest } = withPayload(type, payload) as Record<string, unknown>;
  return { ...rest, payload_json: JSON.stringify(payload) };
};
const withPayload = (type: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({
  ...common,
  type,
  payload,
  ...overrides,
});

const mcqOptions = ['A', 'B', 'C', 'D'].map((id) => ({ id, text: `opção ${id}`, rationale: 'motivo', misconception_concept_key: null }));
const payloads = {
  mcq_single: { options: mcqOptions, correct: 'B' },
  multi_select: {
    options: mcqOptions.map((o) => ({ ...o, value: null })),
    correct: ['A', 'C'],
    somatoria: false,
  },
  true_false: { statement: 'A mitocôndria produz ATP.', correct: true, justification: 'É a função dela.' },
  fill_blank: { text: 'A mitocôndria produz {{1}}.', blanks: [{ id: 1, accepted: ['ATP', 'adenosina trifosfato'] }] },
  numeric: { answer: 9.8, tolerance_abs: 0.1, tolerance_rel: null, unit: 'm/s²', unit_required: true },
  matching: {
    left: [{ id: 'L1', text: 'mitocôndria' }, { id: 'L2', text: 'ribossomo' }],
    right: [{ id: 'R1', text: 'ATP' }, { id: 'R2', text: 'proteína' }, { id: 'R3', text: 'glicose' }],
    pairs: [{ left: 'L1', right: 'R1' }, { left: 'L2', right: 'R2' }],
  },
  ordering: {
    items: [{ id: 'I1', text: 'a' }, { id: 'I2', text: 'b' }, { id: 'I3', text: 'c' }],
    correct_order: ['I3', 'I1', 'I2'],
  },
  short_answer: {
    model_answer: 'A mitocôndria produz ATP.',
    rubric: [{ id: 'r1', criterion: 'Cita a organela', points: 1 }, { id: 'r2', criterion: 'Cita o ATP', points: 1 }],
    max_points: 2,
    key_terms: ['ATP'],
  },
  essay_question: {
    model_answer: 'Texto modelo.',
    rubric: [{ id: 'r1', criterion: 'Tese', points: 5 }, { id: 'r2', criterion: 'Argumentos', points: 5 }],
    max_points: 10,
    expected_lines: 20,
  },
  find_error: {
    segments: [{ id: 'S1', text: 'a' }, { id: 'S2', text: 'b' }, { id: 'S3', text: 'c' }],
    error_segment_id: 'S3',
    error_type: 'conceitual',
    explanation: 'O conceito está trocado.',
    corrected_text: 'c corrigido',
  },
  problem: {
    given: [{ name: 'm', value: '2 kg' }],
    final_answer: '4',
    answer_format: 'numeric',
    tolerance: 0.01,
    check_expression: null,
    solution_steps: ['Passo 1'],
    hints: ['dica 1', 'dica 2', 'dica 3'],
  },
} as const;

type Mutator = (p: Record<string, unknown>) => Record<string, unknown>;
const invalidPayloads: Record<string, Mutator> = {
  mcq_single: (p) => ({ ...p, correct: 'Z' }),
  multi_select: (p) => ({ ...p, correct: ['A', 'B', 'C', 'D'] }),
  true_false: (p) => ({ ...p, correct: 'sim' }),
  fill_blank: (p) => ({ ...p, text: 'Sem lacuna.' }),
  numeric: (p) => ({ ...p, unit: null }),
  matching: (p) => ({ ...p, pairs: [{ left: 'L1', right: 'R1' }] }),
  ordering: (p) => ({ ...p, correct_order: ['I1', 'I1', 'I2'] }),
  short_answer: (p) => ({ ...p, max_points: 5 }),
  essay_question: (p) => ({ ...p, max_points: 3 }),
  find_error: (p) => ({ ...p, error_segment_id: 'S9' }),
  problem: (p) => ({ ...p, hints: ['só uma'] }),
};

const questionCases: SchemaCase[] = (Object.keys(QuestionVariants) as Array<keyof typeof QuestionVariants>).map((type) => ({
  name: `question variant ${type}`,
  schema: QuestionVariants[type],
  valid: withPayload(type, payloads[type]),
  invalid: withPayload(type, invalidPayloads[type]!(payloads[type] as Record<string, unknown>)),
}));

const card = { type: 'basic', front: 'O que é ATP?', back: 'Molécula de energia.', cloze_text: null, concept_key: 'c1', source_pages: [ref], difficulty_estimate: 2 };
const cloze = { ...card, type: 'cloze', front: 'A mitocôndria produz ATP.', back: 'ATP', cloze_text: 'A mitocôndria produz {{c1::ATP}}.' };

const outlineTopic = {
  key: 't1', title: 'Respiração celular', summary: 'Como a célula obtém energia.', learning_objectives: ['Explicar a glicólise.'],
  page_start: 3, page_end: 4, match_existing_node_id: null,
};
const outlineUnit = { key: 'u1', title: 'Células', summary: 'Estrutura e funções.', page_start: 3, page_end: 4, match_existing_node_id: null, topics: [outlineTopic] };
const outline = { is_study_material: true, language: 'pt-BR', detected_kind: 'notes', title_suggestion: 'Biologia', units: [outlineUnit] };

const pageRef = (doc = 'D1') => ({ doc, page_start: 3, page_end: 4 });

const feedItemValid = { type: 'diagram', concept_key: 'c1', title: 'Célula', body: 'Organelas.', formula_latex: null, question: null, figure_page: 13, caption: 'Figura 1', external_knowledge: false, source_pages: [ref] };

// ---------------------------------------------------------------- Phase 3 (camera, PRA-06/07/08, INT-01/02)

const understanding = {
  content_type: 'exercise', language: 'pt-BR', is_study_content: true, contains_people: false,
  transcription_md: '1) Calcule 2 + 2.', key_concepts: ['soma'], subject_guess: { subject_key: 'S1', confidence: 0.8 },
  detected_questions: [{ label: '1', preview: 'Calcule 2 + 2', text_md: 'Calcule 2 + 2.', complete: true, has_figure: false }],
  quality_issues: [],
};
const ladder = {
  question_md: 'Calcule 2 + 2.', trivial: false, quantitative: true,
  hints: [1, 2, 3, 4].map((level) => ({ level, text_md: `Dica ${level}` })),
  final_answer: '4', answer_format: 'numeric', why_others_wrong: [], assumptions: [], uncertain_step: null, source_pages: [ref],
};
const transcription = { lines: [{ n: 1, text: 'A resposta é ⟦fotosintese?⟧.' }], uncertain: [{ line: 1, word: 'fotosintese', alternatives: ['fotossíntese'] }], illegible_count: 0, line_count_estimate: 1, title_present: false };
const essayGrade = {
  built_rubric: false,
  criteria: [{ id: 'r1', criterion: 'Tese', points_max: 5, points: 3, verdict: 'partial', justification: 'Tese pouco clara.' }],
  strengths: ['Boa introdução.'], missing: [{ point: 'Exemplo', source_pages: [ref] }], model_answer: 'Resposta modelo.',
  misconceptions: [], suggested_cause: 'didnt_know', grader_confidence: 'medium', feedback: 'Bom começo.', remediation_card: null,
};
const acheItem = {
  statement_kind: 'statement', segments: [{ id: 'S1', text: 'a' }, { id: 'S2', text: 'b' }, { id: 'S3', text: 'c' }],
  error_segment_id: 'S2', error_type: 'conceitual', explanation: 'Conceito trocado.', corrected_text: 'b certo',
  concept_keys: ['c1'], difficulty: 2, source_pages: [ref],
};
const acheNoError = { ...acheItem, error_segment_id: null, error_type: null, corrected_text: null };
const problemItem = {
  statement: 'Um corpo de 2 kg acelera a 3 m/s². Qual a força?', given: [{ name: 'm', value: '2' }, { name: 'a', value: '3' }],
  final_answer: '6', answer_format: 'numeric', unit: 'N', tolerance: 0.01, check_expression: 'm*a',
  solution_steps: ['F = m·a', 'F = 2·3 = 6 N'], hints: ['Segunda lei.', 'Monte F = m·a.', 'Substitua.'], difficulty: 1,
  concept_keys: ['c1'], source_pages: [ref],
};
const worked = { statement: 'Exemplo.', steps: ['Passo 1', 'Passo 2'], answer: '6 N' };
const podcastSegment = (id: string, kind: string) => ({
  id, kind, node_keys: kind === 'topic' ? ['t1'] : [], title: 'Parte', source_pages: kind === 'topic' ? [ref] : [],
  lines: [{ speaker: 'bia', text: 'Oi!', pause_after_ms: null }], recall_question: null,
});
const podcastScriptValid = { title: 'Episódio', segments: [podcastSegment('seg1', 'hook'), podcastSegment('seg2', 'topic'), podcastSegment('seg3', 'outro')] };
const lucasPlanValid = {
  key_concepts: [
    { id: 'k1', statement: 'A glicólise ocorre no citoplasma.', concept_key: 'c1', source_pages: [ref] },
    { id: 'k2', statement: 'Produz piruvato.', concept_key: null, source_pages: [ref] },
  ],
  misconceptions: [{ id: 'm1', lucas_belief: 'Ocorre na mitocôndria.', correct_concept: 'Ocorre no citoplasma.', fix_criteria: ['citoplasma'], trigger: 'early', source_pages: [ref] }],
  naive_questions: ['Por quê?', 'Onde?'],
};
const lucasTurnValid = {
  lucas_reply: 'Ah, então é no citoplasma?', safety: 'ok',
  evaluation: {
    misconception_updates: [{ id: 'm1', status: 'revealed' }], concepts_covered: [{ id: 'k1', quality: 'partial' }],
    errors_taught: [], clarity_signals: { used_example: false, used_analogy: false, checked_understanding: true },
  },
};

const PHASE3_CASES: SchemaCase[] = [
  { name: 'CaptureUnderstanding', schema: S.CaptureUnderstanding, valid: understanding, invalid: { ...understanding, subject_guess: { subject_key: 'Biologia', confidence: 0.8 } } },
  { name: 'HintLadder', schema: S.HintLadder, valid: ladder, invalid: { ...ladder, trivial: true } },
  { name: 'FaithfulTranscription', schema: S.FaithfulTranscription, valid: transcription, invalid: { ...transcription, lines: [{ n: 2, text: 'x' }] } },
  { name: 'EssayQuestionGrade', schema: S.EssayQuestionGrade, valid: essayGrade, invalid: { ...essayGrade, criteria: [] } },
  { name: 'AcheOErroItem', schema: S.AcheOErroItem, valid: acheItem, invalid: { ...acheItem, error_type: null } },
  { name: 'AcheOErroItems', schema: S.AcheOErroItems, valid: { items: [acheItem, acheItem, acheNoError] }, invalid: { items: [acheItem, acheNoError, acheNoError] } },
  { name: 'WorkedExample', schema: S.WorkedExample, valid: worked, invalid: { ...worked, steps: ['só um'] } },
  { name: 'GeneratedProblem', schema: S.GeneratedProblem, valid: problemItem, invalid: { ...problemItem, given: [{ name: '1x', value: '2' }] } },
  { name: 'ProblemSet', schema: S.ProblemSet, valid: { worked_examples: [worked], problems: [problemItem, problemItem, { ...problemItem, difficulty: 3 }] }, invalid: { worked_examples: [], problems: [problemItem, problemItem] } },
  { name: 'FirstWrongStep', schema: S.FirstWrongStep, valid: { student_steps: ['F = m/a'], first_wrong_step_index: 0, what_went_wrong: 'Dividiu em vez de multiplicar.', nudge: 'Releia a segunda lei.' }, invalid: { student_steps: [], first_wrong_step_index: -1, what_went_wrong: 'x', nudge: 'y' } },
  { name: 'PodcastScriptSchema', schema: S.PodcastScriptSchema, valid: podcastScriptValid, invalid: { ...podcastScriptValid, segments: [podcastSegment('seg1', 'hook'), podcastSegment('seg1', 'topic'), podcastSegment('seg3', 'outro')] } },
  { name: 'LucasPlanSchema', schema: S.LucasPlanSchema, valid: lucasPlanValid, invalid: { ...lucasPlanValid, naive_questions: ['só uma'] } },
  { name: 'LucasTurnSchema', schema: S.LucasTurnSchema, valid: lucasTurnValid, invalid: { ...lucasTurnValid, safety: 'unknown' } },
];

/** Payload schemas are exercised through their question variant (same payload object). */
// ---------------------------------------------------------------- Phase 4 (ENEM, INT-03)

const alts = ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label, text_md: `Alternativa ${label}` }));
const rationales = (answer: string) => ['A', 'B', 'C', 'D', 'E'].filter((l) => l !== answer).map((label) => ({ label, why: 'Confunde os conceitos.' }));
const textoWritten = { kind: 'written', content_md: 'Em uma cidade, o transporte…', chart_data: null, source_pages: [], label: 'Texto elaborado pelo Studify' };
const chart = { type: 'bar', title: 'Usuários por modal', x_label: 'Modal', y_label: '%', series: [{ name: '2025', points: [{ x: 'Ônibus', y: 40 }, { x: 'Metrô', y: 20 }] }] };
const enemItem = { texto_base: textoWritten, comando_md: 'Qual é a causa?', alternatives: alts, answer: 'B', explanation_md: 'Porque…', distractor_rationales: rationales('B'), skill_code: 'CN-H17', difficulty: 'media', source_pages: [ref] };
const element = { present: true, quote: 'o Ministério da Educação' };
const competencia = (id: number, score = 160) => ({ id, score, level_text: 'Bom domínio.', justification: 'Poucos desvios.', evidence: [{ quote: 'Nesse contexto', line: 2 }], issues: [], strengths: ['Boa coesão.'] });
const redacaoGrade = {
  zero_check: { is_zero: false, reasons: [], evidence: null },
  competencias: [1, 2, 3, 4, 5].map((id) => competencia(id)),
  proposta: { agente: element, acao: element, meio: element, finalidade: element, detalhamento: { present: false, quote: null }, direitos_humanos_ok: true, note: null },
  repertorio_refs: [{ text: 'Segundo o IBGE…', kind: 'data', line: 3 }],
  rewrites: [],
  top_actions: ['Detalhe a proposta.', 'Use mais conectivos.', 'Revise a crase.'],
};
const writtenQuestion = { texto_base_md: 'Texto elaborado pelo Studify: …', comando_md: 'Qual?', alternatives: alts, answer: 'C', explanation_md: 'Porque…', distractor_rationales: rationales('C'), skill_code: 'CH-H26', difficulty: 'facil' };
const source = { url: 'https://agenciabrasil.ebc.com.br/x', name: 'Agência Brasil', published_at: '2026-10-20' };
const digestItem = { title: 'Seca na Amazônia', summary_md: 'Rios em níveis mínimos.', why_md: 'Meio ambiente.', areas: ['CN', 'RED'], skill_codes: ['CN-H28'], redacao_axes: ['meio ambiente'], repertorio: [{ text: 'Rio Negro em nível mínimo.', source_url: source.url }], sources: [source], questions: [writtenQuestion, writtenQuestion] };
const motivating = { kind: 'summary', text: 'Resumo da fonte.', source_url: source.url, source_name: 'Agência Brasil', published_at: '2026-10-20' };
const predictedTheme = (axis: string) => ({ title: `Caminhos para enfrentar o desafio de ${axis} no Brasil`, axis, rationale: 'Padrão recorrente.', connections: [{ digest_item_key: 'A1', why: 'Relacionado.' }], repertorio_directions: ['dados do IBGE'], prompt: { instruction: 'Redija…', motivating_texts: [motivating, { ...motivating, kind: 'data' }] } });
const axes = ['saúde', 'educação', 'meio ambiente', 'tecnologia', 'cidadania', 'cultura', 'trabalho', 'mobilidade'];
const criteria = { tese: 3, fundamentacao: 2, repertorio: 2, coerencia: 3, refutacao: 1, falacias: 4 };
const outlineArg = { topico: 'Falta investimento.', argumento: 'Sem recursos, o serviço piora.', repertorio: null };
const argumentSummary = {
  rubric: criteria,
  strongest_argument: 'Dados de uso.',
  weakest_point: 'Refutação.',
  fallacies: [{ name: 'generalização apressada', count: 1 }],
  repertorio_suggestions: [{ text: 'Dados do IBGE sobre transporte.', origin: 'geral' }],
  strengths: ['Tese clara.'],
  improve: ['Antecipe o contra-argumento.'],
  outline: {
    introducao: { contexto: 'Cidades cresceram.', tese: 'É preciso investir.' },
    d1: outlineArg,
    d2: outlineArg,
    conclusao: { retomada: 'Portanto…', proposta: { agente: 'Governo federal', acao: 'ampliar o investimento', meio: 'por meio de parcerias', finalidade: 'para reduzir o tempo de deslocamento', detalhamento: 'priorizando periferias' } },
  },
};

const PHASE4_CASES: SchemaCase[] = [
  { name: 'HttpUrl', schema: S.HttpUrl, valid: 'https://ibge.gov.br/x', invalid: 'ftp://x' },
  { name: 'EnemSkillCode', schema: S.EnemSkillCode, valid: 'MT-H21', invalid: 'MT-H31' },
  { name: 'EnemTopicKey', schema: S.EnemTopicKey, valid: 'T12', invalid: 'topic-12' },
  { name: 'EnemNodeTags', schema: S.EnemNodeTags, valid: { nodes: [{ node_key: 'n2', skill_codes: [{ code: 'CN-H14', confidence: 0.8 }], enem_topic_keys: [{ key: 'T1', confidence: 0.7 }] }] }, invalid: { nodes: [{ node_key: 'n2', skill_codes: [{ code: 'BIO-1', confidence: 0.8 }], enem_topic_keys: [] }] } },
  { name: 'EnemItemTranscription', schema: S.EnemItemTranscription, valid: { statement_md: 'Enunciado', alternatives: alts, has_figure: true, alt_text: 'Gráfico de barras.', subject_guess: 'Biologia', unreadable: false }, invalid: { statement_md: 'Enunciado', alternatives: alts, has_figure: true, alt_text: null, subject_guess: null, unreadable: false } },
  { name: 'EnemItemExplanation', schema: S.EnemItemExplanation, valid: { chosen_answer: 'B', solution_md: 'Resolução.', distractors: rationales('B').map((r) => ({ label: r.label, why_wrong: r.why })), skill_explanation: 'Interpretar.' }, invalid: { chosen_answer: 'B', solution_md: 'Resolução.', distractors: rationales('A').map((r) => ({ label: r.label, why_wrong: r.why })), skill_explanation: 'Interpretar.' } },
  { name: 'EnemItemTopics', schema: S.EnemItemTopics, valid: { subject: 'Biologia', enem_topic_keys: [{ key: 'T1', confidence: 0.9 }] }, invalid: { subject: 'Biologia', enem_topic_keys: [] } },
  { name: 'ChartData', schema: S.ChartData, valid: chart, invalid: { ...chart, series: [] } },
  { name: 'TextoBase', schema: S.TextoBase, valid: textoWritten, invalid: { ...textoWritten, label: 'Texto da Folha de S.Paulo' } },
  { name: 'EnemGeneratedItem', schema: S.EnemGeneratedItem, valid: enemItem, invalid: { ...enemItem, texto_base: { kind: 'excerpt', content_md: 'x'.repeat(700), chart_data: null, source_pages: [ref], label: null } } },
  { name: 'EnemGeneratedItems', schema: S.EnemGeneratedItems, valid: { items: [enemItem] }, invalid: { items: [{ ...enemItem, alternatives: alts.slice(0, 4) }] } },
  { name: 'EssayGrade', schema: S.EssayGrade, valid: redacaoGrade, invalid: { ...redacaoGrade, competencias: [1, 2, 3, 4, 5].map((id) => competencia(id, 150)) } },
  { name: 'RepertorioVerdict', schema: S.RepertorioVerdict, valid: { status: 'confirmed', source_url: 'https://ibge.gov.br/x', source_name: 'IBGE', note: 'Confirmado.' }, invalid: { status: 'contradicted', source_url: null, source_name: null, note: 'Errado.' } },
  { name: 'WrittenEnemQuestion', schema: S.WrittenEnemQuestion, valid: writtenQuestion, invalid: { ...writtenQuestion, distractor_rationales: rationales('C').slice(0, 3) } },
  { name: 'AtualidadesDigest', schema: S.AtualidadesDigest, valid: { items: [digestItem], skipped_note: null }, invalid: { items: [{ ...digestItem, sources: [] }], skipped_note: null } },
  { name: 'PredictedThemes', schema: S.PredictedThemes, valid: { themes: axes.map(predictedTheme) }, invalid: { themes: axes.map(() => predictedTheme('saúde')) } },
  { name: 'EssayThemePromptOut', schema: S.EssayThemePromptOut, valid: { title: 'Desafios da mobilidade urbana no Brasil', axis: 'mobilidade', instruction: 'Redija…', motivating_texts: [{ kind: 'context', text: 'Contexto.', source_url: null, source_name: null }] }, invalid: { title: 'Curto', axis: 'x', instruction: 'Redija…', motivating_texts: [] } },
  { name: 'ArgumentCriteria', schema: S.ArgumentCriteria, valid: criteria, invalid: { ...criteria, tese: 5 } },
  { name: 'ArgumentRoundFeedback', schema: S.ArgumentRoundFeedback, valid: { rubric: criteria, fallacies: [{ name: 'ad hominem', quote: 'Você não entende nada.', explanation: 'Ataca a pessoa.' }], tip: 'Traga um dado.' }, invalid: { rubric: criteria, fallacies: [{ name: 'falácia inventada', quote: 'x', explanation: 'y' }], tip: 'z' } },
  { name: 'ThesisFeedback', schema: S.ThesisFeedback, valid: { clear: true, has_position: true, specific: false, feedback: 'Clara, mas genérica.', suggestion: 'Diga qual tipo de celular.' }, invalid: { clear: true, feedback: 'x' } },
  { name: 'ArgumentSummary', schema: S.ArgumentSummary, valid: argumentSummary, invalid: { ...argumentSummary, outline: { ...argumentSummary.outline, conclusao: { retomada: 'x', proposta: { agente: 'Governo' } } } } },
  { name: 'ArgumentThemes', schema: S.ArgumentThemes, valid: { themes: Array.from({ length: 5 }, (_, i) => ({ question: `A escola deve proibir celulares ${i}?`, node_keys: ['n1'], why: 'Dois lados legítimos.' })) }, invalid: { themes: [{ question: 'A escola deve proibir celulares?', node_keys: ['n1'], why: 'x' }] } },
];

const flowVisual = {
  type: 'flowchart',
  title: 'Respiração celular',
  alt_text: 'Fluxo da glicose até o ATP, passando pela glicólise e pelo ciclo de Krebs.',
  nodes: [
    { id: 'n1', label: 'Glicose', detail: null, source: ref },
    { id: 'n2', label: 'Glicólise', detail: null, source: null },
  ],
  edges: [{ from: 'n1', to: 'n2', label: null }],
};
const finding = {
  type: 'contradiction',
  severity: 'high',
  doc: 'D1',
  page_start: 4,
  page_end: 4,
  related: { doc: 'D1', page: 9 },
  node_key: 't1',
  description: 'Possível erro: a p. 4 diz 38 ATP e a p. 9 diz 30–32 ATP.',
  suggested_fix: null,
};
const mnemonicOption = (type: string) => ({ type, title: 'PMAT', text: 'P-M-A-T', how_to_use: 'Lembre da sigla antes de virar o cartão.', loci: null });

const PHASE5_CASES: SchemaCase[] = [
  { name: 'VisualDraft', schema: S.VisualDraft, valid: { fits: true, reason: null, ...flowVisual, nodes: flowVisual.nodes.map((n) => ({ ...n, parent_id: null })), events: [], columns: [], rows: [] }, invalid: { fits: true, reason: null, visual: flowVisual } },
  { name: 'VisualOut', schema: S.VisualOut, valid: { fits: true, reason: null, visual: flowVisual }, invalid: { fits: true, reason: null, visual: null } },
  { name: 'MaterialFindings', schema: S.MaterialFindings, valid: { findings: [finding] }, invalid: { findings: [{ ...finding, related: null }] } },
  { name: 'MnemonicOptions', schema: S.MnemonicOptions, valid: { options: ['acronym', 'phrase', 'rhyme'].map(mnemonicOption) }, invalid: { options: [mnemonicOption('acronym')] } },
  { name: 'ContributionReview', schema: S.ContributionReview, valid: { errors: [{ quote: '38 ATP', correction: 'O material diz 30–32 ATP.', source: ref }], missing_concepts: ['Cadeia respiratória'], ok_to_merge: false, summary: 'Bom começo!' }, invalid: { errors: [], missing_concepts: [], ok_to_merge: true } },
  { name: 'PeerQuestionValidation', schema: S.PeerQuestionValidation, valid: { grounded: true, evidence: [ref], single_correct_answer: true, clarity_issues: [], appropriate: true, duplicate_of: null, suggested_fix: null }, invalid: { grounded: true, evidence: [], single_correct_answer: true, clarity_issues: [], appropriate: true, duplicate_of: 'question-1', suggested_fix: null } },
  { name: 'RetroTitle', schema: S.RetroTitle, valid: { title_pt: 'Seu semestre foi brabo! ✨', subtitle_pt: '42 horas de estudo bem aproveitadas.' }, invalid: { title_pt: 'x'.repeat(61), subtitle_pt: 'ok ok' } },
];

export const PAYLOAD_ALIASES: Record<string, string> = {
  McqSinglePayload: 'question variant mcq_single',
  MultiSelectPayload: 'question variant multi_select',
  TrueFalsePayload: 'question variant true_false',
  FillBlankPayload: 'question variant fill_blank',
  NumericPayload: 'question variant numeric',
  MatchingPayload: 'question variant matching',
  OrderingPayload: 'question variant ordering',
  ShortAnswerPayload: 'question variant short_answer',
  EssayPayload: 'question variant essay_question',
  FindErrorPayload: 'question variant find_error',
  ProblemPayload: 'question variant problem',
};

export const SCHEMA_CASES: SchemaCase[] = [
  { name: 'LanguageTag', schema: S.LanguageTag, valid: 'pt-BR', invalid: 'portugues do brasil' },
  { name: 'Difficulty', schema: S.Difficulty, valid: 3, invalid: 9 },
  { name: 'Confidence', schema: S.Confidence, valid: 0.5, invalid: 1.5 },
  { name: 'BloomLevel', schema: S.BloomLevel, valid: 'apply', invalid: 'memorize' },
  { name: 'MistakeCause', schema: S.MistakeCause, valid: 'confused', invalid: 'lazy' },
  { name: 'ConceptKey', schema: S.ConceptKey, valid: 'c1', invalid: '' },
  { name: 'NodeKey', schema: S.NodeKey, valid: 't1', invalid: '' },
  { name: 'DocLabel', schema: S.DocLabel, valid: 'D2', invalid: 'doc2' },
  { name: 'PageNumber', schema: S.PageNumber, valid: 12, invalid: 0 },
  { name: 'FeedItem', schema: S.FeedItem, valid: feedItemValid, invalid: { ...feedItemValid, figure_page: null } },
  { name: 'ObjectiveQuestionSchema', schema: S.ObjectiveQuestionSchema, valid: withPayload('mcq_single', payloads.mcq_single), invalid: withPayload('essay_question', payloads.essay_question) },
  { name: 'DocPageRef', schema: S.DocPageRef, valid: ref, invalid: { doc: 'D1', page_start: 4, page_end: 3 } },
  { name: 'SourcePages', schema: S.SourcePages, valid: [ref], invalid: [] },
  { name: 'RemediationCard', schema: S.RemediationCard, valid: remediation, invalid: { front: '', back: 'x' } },
  { name: 'CardDraft', schema: S.CardDraft, valid: card, invalid: { ...card, cloze_text: 'sem marcação' } },
  { name: 'CardDraft cloze', schema: S.CardDraft, valid: cloze, invalid: { ...cloze, cloze_text: 'A {{c1::a}} {{c2::b}} {{c3::c}} {{c4::d}}.' } },
  { name: 'TopicCards', schema: S.TopicCards, valid: { cards: [card, cloze] }, invalid: { cards: [] } },
  { name: 'SelectionCard', schema: S.SelectionCard, valid: { type: 'basic', front: 'Pergunta?', back: 'Resposta.', cloze_text: null, concept_key: null }, invalid: { type: 'basic', front: 'x', back: 'x', cloze_text: 'y', concept_key: null } },
  { name: 'TutorCard', schema: S.TutorCard, valid: { type: 'cloze', front: 'Frase.', back: 'termo', cloze_text: 'Frase com {{c1::termo}}.' }, invalid: { type: 'reverse', front: 'a', back: 'b', cloze_text: null } },
  { name: 'QuestionSchema', schema: S.QuestionSchema, valid: withPayload('true_false', payloads.true_false), invalid: withPayload('true_false', { ...payloads.true_false, correct: 'x' }) },
  ...questionCases,
  { name: 'QuestionDraftSchema', schema: S.QuestionDraftSchema, valid: asDraft('numeric', payloads.numeric), invalid: withPayload('numeric', payloads.numeric) },
  { name: 'TopicQuestions', schema: S.TopicQuestions, valid: { questions: [asDraft('true_false', payloads.true_false)] }, invalid: { questions: [] } },
  { name: 'SingleQuestion', schema: S.SingleQuestion, valid: { question: asDraft('true_false', payloads.true_false) }, invalid: { question: withPayload('numeric', payloads.numeric) } },
  { name: 'DiagnosticQuestions', schema: S.DiagnosticQuestions, valid: { questions: [asDraft('mcq_single', payloads.mcq_single)] }, invalid: { questions: [asDraft('essay_question', payloads.essay_question)] } },
  { name: 'Outline', schema: S.Outline, valid: outline, invalid: { ...outline, is_study_material: false } },
  { name: 'TopicConcepts', schema: S.TopicConcepts, valid: { concepts: [{ key: 'c1', title: 'ATP', summary: 'Energia.', page_start: 3, page_end: 3, key_terms: ['ATP'], formulas: [] }] }, invalid: { concepts: [] } },
  { name: 'PrereqEdges', schema: S.PrereqEdges, valid: { edges: [{ node_key: 't2', prerequisite_key: 't1', reason: 'Precisa da glicólise.' }] }, invalid: { edges: [{ node_key: 't1', prerequisite_key: 't1', reason: 'x' }] } },
  { name: 'PageTranscriptions', schema: S.PageTranscriptions, valid: { pages: [{ page: 3, text: 'texto', confidence: 'high' }] }, invalid: { pages: [{ page: 3, text: 'texto', confidence: 'ok' }] } },
  { name: 'ScheduleImport', schema: S.ScheduleImport, valid: { term_name: null, exams: [{ subject_name: 'Biologia', date: '2026-11-10', date_ambiguous: false, time: '07:30', weight: null, label: 'P1', content_items: ['Células'] }], warnings: [] }, invalid: { term_name: null, exams: [{ subject_name: 'Biologia', date: '10/11', date_ambiguous: false, time: null, weight: null, label: null, content_items: [] }], warnings: [] } },
  { name: 'ScopeMatch', schema: S.ScopeMatch, valid: { items: [{ raw_text: 'Células', normalized_title: 'Células', matches: [{ node_key: 'u1', confidence: 0.9 }], status: 'matched', note: null }], detected_exam_info: { subject_guess: null, date_guess: null } }, invalid: { items: [{ raw_text: 'x', normalized_title: 'x', matches: [{ node_key: 'u1', confidence: 0.2 }], status: 'matched', note: null }], detected_exam_info: { subject_guess: null, date_guess: null } } },
  { name: 'GlossaryTerms', schema: S.GlossaryTerms, valid: { terms: [{ term: 'ATP', definition: 'Molécula que armazena energia.', example: null, aliases: ['adenosina trifosfato'], concept_key: 'c1', source_pages: [ref] }] }, invalid: { terms: [{ term: 'ATP', definition: 'palavra '.repeat(45), example: null, aliases: [], concept_key: 'c1', source_pages: [ref] }] } },
  { name: 'Relations', schema: S.Relations, valid: { relations: [{ from_key: 'c1', to_key: 'c2', kind: 'contrast', reason: 'Fácil de confundir.' }] }, invalid: { relations: [{ from_key: 'c1', to_key: 'c1', kind: 'related', reason: 'x' }] } },
  { name: 'RouteNodes', schema: S.RouteNodes, valid: { node_keys: ['t1'] }, invalid: { node_keys: ['a', 'b', 'c', 'd'] } },
  { name: 'RegistrarAvaliacaoInput', schema: S.RegistrarAvaliacaoInput, valid: { verdict: 'partial', score: 0.5, node_key: 't1', misconception: null }, invalid: { verdict: 'ok', score: 0.5, node_key: 't1', misconception: null } },
  { name: 'MarcarForaDoMaterialInput', schema: S.MarcarForaDoMaterialInput, valid: { closest_node_key: null, reason: 'Não aparece no material.' }, invalid: { closest_node_key: null, reason: 'x', extra: true } },
  { name: 'ShortAnswerGrade', schema: S.ShortAnswerGrade, valid: { score: 0.5, criteria: [{ id: 'r1', verdict: 'partial', points: 0.5, justification: 'Faltou o ATP.' }], feedback: 'Boa, falta o ATP.', missing: [{ point: 'ATP', pages: [3] }], suggested_cause: 'didnt_know', remediation_card: null, grader_confidence: 'high' }, invalid: { score: 1.5, criteria: [], feedback: 'x', missing: [], suggested_cause: 'careless_typo', remediation_card: null, grader_confidence: 'high' } },
  { name: 'WrongAnswerExplanation', schema: S.WrongAnswerExplanation, valid: { explanation_md: 'A mitocôndria produz ATP.', chosen_option_rationale_md: null, source_pages: [ref] }, invalid: { explanation_md: 'x', chosen_option_rationale_md: null, source_pages: [] } },
  { name: 'ContrastTable', schema: S.ContrastTable, valid: { title: 'Mitose x Meiose', rows: [{ aspect: 'Divisões', a: '1', b: '2' }, { aspect: 'Células', a: 'somáticas', b: 'germinativas' }], key_difference: 'Número de divisões.', example: 'Pele.', source_pages: [ref] }, invalid: { title: 'x', rows: [{ aspect: 'a', a: 'b', b: 'c' }], key_difference: 'x', example: 'x', source_pages: [ref] } },
  { name: 'FeedItems', schema: S.FeedItems, valid: { items: [{ type: 'quick_question', concept_key: 'c1', title: 'Você sabe?', body: 'Qual organela produz ATP?', formula_latex: null, question: { stem: 'Qual?', options: [{ id: 'A', text: 'Núcleo', rationale: 'Não.' }, { id: 'B', text: 'Mitocôndria', rationale: 'Sim.' }, { id: 'C', text: 'Lisossomo', rationale: 'Não.' }], correct: 'B' }, figure_page: null, caption: null, external_knowledge: false, source_pages: [ref] }] }, invalid: { items: [{ type: 'quick_question', concept_key: 'c1', title: 't', body: 'b', formula_latex: null, question: null, figure_page: null, caption: null, external_knowledge: false, source_pages: [ref] }] } },
  {
    name: 'PlanCoach',
    schema: S.PlanCoach,
    valid: {
      headline: 'Fotossíntese é a prioridade: falta estudar e a prova é em 7 dias.',
      exams: [{ exam_key: 'E1', strategy: 'Aprenda fotossíntese até quinta e use o fim de semana para questões.', risk: 'medium' }],
      topics: [{ topic_key: 'T1', priority: 0.8, approach: 'practice', focus: 'Refaça questões de fase clara.', why: 'Você acertou 5 de 11.' }],
      next_steps: [{ when: 'today', title: 'Fotossíntese: fase clara', detail: '25 minutos de teoria e 5 questões.', topic_key: 'T1' }],
      watch_out: null,
    },
    invalid: { headline: 'x', exams: [], topics: [{ topic_key: 'X1', priority: 2, approach: 'learn', focus: 'a', why: 'b' }], next_steps: [], watch_out: null },
  },
  { name: 'Cheatsheet', schema: S.Cheatsheet, valid: { title: 'Prova de Biologia', sections: [{ node_key: 't1', heading: 'Respiração', bullets: [{ text: 'A glicólise ocorre no citoplasma.', source_pages: [ref] }], formula: null }], watch_out: [] }, invalid: { title: 'x', sections: [], watch_out: [] } },
  { name: 'PastTestExtraction', schema: S.PastTestExtraction, valid: { test: { title: null, teacher_guess: 'Prof. Ana', year_guess: 2025, total_points: 10, duration_guess: 50 }, questions: [{ position: 1, page: 2, type: 'mcq_single', statement_md: 'Qual organela?', alternatives: [{ label: 'A', text_md: 'Núcleo' }, { label: 'B', text_md: 'Mitocôndria' }], answer: { value: 'B', source: 'printed' }, solution_md: null, points: 1, format_features: ['contextualized'], bloom: 'remember', difficulty: 1, node_matches: [{ node_key: 't1', confidence: 0.9 }] }] }, invalid: { test: { title: null, teacher_guess: null, year_guess: null, total_points: null, duration_guess: null }, questions: [{ position: 1, page: 2, type: 'trivia', statement_md: 'x', alternatives: null, answer: null, solution_md: null, points: null, format_features: [], bloom: 'remember', difficulty: 1, node_matches: [] }] } },
  { name: 'PredictedTest', schema: S.PredictedTest, valid: { questions: [{ slot_id: 's1', statement_md: 'Calcule.', alternatives: null, answer: '42', solution_md: 'Passo a passo.', explanation_md: 'Porque sim.', source_pages: [ref], rationale: 'Tema frequente no material.' }] }, invalid: { questions: [] } },
  { name: 'TeacherPatterns', schema: S.TeacherPatterns, valid: { patterns: [{ text: 'Pede justificativa.', evidence_question_ids: ['q1', 'q2'] }], style_notes: 'Cobra justificativa.', typical_command_verbs: ['justifique'] }, invalid: { patterns: [{ text: 'x', evidence_question_ids: ['q1'] }], style_notes: 'x', typical_command_verbs: [] } },
  { name: 'FlagVerdict', schema: S.FlagVerdict, valid: { verdict: 'error_confirmed', confidence: 'high', explanation_pt: 'A página 4 diz outra coisa.', evidence_pages: [ref], corrected_item: { fields: [{ name: 'back', value: 'Correto' }] }, answer_changed: true }, invalid: { verdict: 'not_an_error', confidence: 'high', explanation_pt: 'x', evidence_pages: [], corrected_item: { fields: [{ name: 'back', value: 'x' }] }, answer_changed: false } },
  { name: 'ModerationVerdict', schema: S.ModerationVerdict, valid: { allowed: true, category: 'ok' }, invalid: { allowed: true, category: 'offensive' } },
  ...PHASE3_CASES,
  ...PHASE4_CASES,
  ...PHASE5_CASES,
];
