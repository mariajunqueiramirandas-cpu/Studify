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
  stimulus_md: null,
  explanation: 'A mitocôndria realiza a respiração celular.',
  bloom_level: 'remember',
  difficulty: 2,
  concept_keys: ['c1'],
  source_pages: [ref],
  remediation_card: remediation,
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

/** Payload schemas are exercised through their question variant (same payload object). */
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
  { name: 'TopicQuestions', schema: S.TopicQuestions, valid: { questions: [withPayload('true_false', payloads.true_false)] }, invalid: { questions: [] } },
  { name: 'SingleQuestion', schema: S.SingleQuestion, valid: { question: withPayload('true_false', payloads.true_false) }, invalid: { question: withPayload('numeric', payloads.numeric, { payload: { answer: 'x' } }) } },
  { name: 'DiagnosticQuestions', schema: S.DiagnosticQuestions, valid: { questions: [withPayload('mcq_single', payloads.mcq_single)] }, invalid: { questions: [withPayload('essay_question', payloads.essay_question)] } },
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
  { name: 'Cheatsheet', schema: S.Cheatsheet, valid: { title: 'Prova de Biologia', sections: [{ node_key: 't1', heading: 'Respiração', bullets: [{ text: 'A glicólise ocorre no citoplasma.', source_pages: [ref] }], formula: null }], watch_out: [] }, invalid: { title: 'x', sections: [], watch_out: [] } },
  { name: 'PastTestExtraction', schema: S.PastTestExtraction, valid: { test: { title: null, teacher_guess: 'Prof. Ana', year_guess: 2025, total_points: 10, duration_guess: 50 }, questions: [{ position: 1, page: 2, type: 'mcq_single', statement_md: 'Qual organela?', alternatives: [{ label: 'A', text_md: 'Núcleo' }, { label: 'B', text_md: 'Mitocôndria' }], answer: { value: 'B', source: 'printed' }, solution_md: null, points: 1, format_features: ['contextualized'], bloom: 'remember', difficulty: 1, node_matches: [{ node_key: 't1', confidence: 0.9 }] }] }, invalid: { test: { title: null, teacher_guess: null, year_guess: null, total_points: null, duration_guess: null }, questions: [{ position: 1, page: 2, type: 'trivia', statement_md: 'x', alternatives: null, answer: null, solution_md: null, points: null, format_features: [], bloom: 'remember', difficulty: 1, node_matches: [] }] } },
  { name: 'PredictedTest', schema: S.PredictedTest, valid: { questions: [{ slot_id: 's1', statement_md: 'Calcule.', alternatives: null, answer: '42', solution_md: 'Passo a passo.', explanation_md: 'Porque sim.', source_pages: [ref], rationale: 'Tema frequente no material.' }] }, invalid: { questions: [] } },
  { name: 'TeacherPatterns', schema: S.TeacherPatterns, valid: { patterns: [{ text: 'Pede justificativa.', evidence_question_ids: ['q1', 'q2'] }], style_notes: 'Cobra justificativa.', typical_command_verbs: ['justifique'] }, invalid: { patterns: [{ text: 'x', evidence_question_ids: ['q1'] }], style_notes: 'x', typical_command_verbs: [] } },
  { name: 'FlagVerdict', schema: S.FlagVerdict, valid: { verdict: 'error_confirmed', confidence: 'high', explanation_pt: 'A página 4 diz outra coisa.', evidence_pages: [ref], corrected_item: { fields: [{ name: 'back', value: 'Correto' }] }, answer_changed: true }, invalid: { verdict: 'not_an_error', confidence: 'high', explanation_pt: 'x', evidence_pages: [], corrected_item: { fields: [{ name: 'back', value: 'x' }] }, answer_changed: false } },
  { name: 'ModerationVerdict', schema: S.ModerationVerdict, valid: { allowed: true, category: 'ok' }, invalid: { allowed: true, category: 'offensive' } },
];
