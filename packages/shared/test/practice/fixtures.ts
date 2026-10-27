// Valid question payloads, one per type (spec 05 §8.1), shared by the practice tests.
import type {
  FillBlankPayload,
  FindErrorPayload,
  MatchingPayload,
  McqSinglePayload,
  MultiSelectPayload,
  NumericPayload,
  OrderingPayload,
  ProblemPayload,
  TrueFalsePayload,
} from '../../src/practice/index.ts';

const MCQ_OPTIONS = [
  { id: 'A', text: 'Síntese de proteínas', rationale: 'Ocorre nos ribossomos.' },
  { id: 'B', text: 'Armazenamento do DNA nuclear', rationale: 'Ocorre no núcleo.', misconception_concept_id: 'c-nucleo' },
  { id: 'C', text: 'Produção de ATP por respiração celular', rationale: 'Função central da mitocôndria.' },
  { id: 'D', text: 'Fotossíntese', rationale: 'Ocorre nos cloroplastos.' },
  { id: 'E', text: 'Digestão intracelular', rationale: 'Função dos lisossomos.' },
];

/** Stem without a qualifier; key C. */
export const MCQ_STEM = 'Qual das alternativas descreve a função da mitocôndria?';
export const MCQ: McqSinglePayload = { options: MCQ_OPTIONS, correct: 'C' };

/** Negative stem ("NÃO"): the key is the one alternative that is NOT a mitochondrial function (A). */
export const MCQ_NEG_STEM = 'Qual das alternativas NÃO descreve a função da mitocôndria?';
export const MCQ_NEG: McqSinglePayload = { options: MCQ_OPTIONS, correct: 'A' };

export const MULTI: MultiSelectPayload = {
  options: [
    { id: 'A', text: 'Mitose gera duas células-filhas', rationale: 'Correta.' },
    { id: 'B', text: 'Meiose gera duas células-filhas', rationale: 'Gera quatro.' },
    { id: 'C', text: 'Replicação ocorre na fase G1', rationale: 'Ocorre na fase S.' },
    { id: 'D', text: 'Crossing-over ocorre na prófase I', rationale: 'Correta.' },
  ],
  correct: ['A', 'D'],
  somatoria: false,
};

export const TRUE_FALSE: TrueFalsePayload = {
  statement: 'A mitocôndria possui DNA próprio.',
  correct: true,
  justification: 'Possui DNA circular próprio.',
};

export const FILL_BLANK: FillBlankPayload = {
  text: 'A mitocôndria produz {{1}} e consome {{2}}.',
  blanks: [
    { id: 1, accepted: ['ATP', 'adenosina trifosfato'] },
    { id: 2, accepted: ['oxigênio'] },
  ],
};

/** Typo fixture from spec 05 §11: accepts "mitocondria" and "mitocôndira" for "mitocôndria", rejects "mitose". */
export const FILL_BLANK_TYPO: FillBlankPayload = {
  text: 'A organela chamada {{1}} produz energia.',
  blanks: [{ id: 1, accepted: ['mitocôndria'] }],
};

export const NUMERIC: NumericPayload = { answer: 9.8, tolerance_abs: 0.1, unit: 'm/s²', unit_required: true };

export const NUMERIC_NO_UNIT_REQUIRED: NumericPayload = {
  answer: 10,
  tolerance_rel: 0.01,
  unit: 'm',
  unit_required: false,
};

export const MATCHING: MatchingPayload = {
  left: [
    { id: 'L1', text: 'Mitocôndria' },
    { id: 'L2', text: 'Ribossomo' },
    { id: 'L3', text: 'Núcleo' },
  ],
  right: [
    { id: 'R1', text: 'Síntese proteica' },
    { id: 'R2', text: 'Respiração celular' },
    { id: 'R3', text: 'Armazena o DNA' },
    { id: 'R4', text: 'Fotossíntese' },
  ],
  pairs: [
    ['L1', 'R2'],
    ['L2', 'R1'],
    ['L3', 'R3'],
  ],
};

export const ORDERING: OrderingPayload = {
  items: [
    { id: 'I1', text: 'Glicólise' },
    { id: 'I2', text: 'Ciclo de Krebs' },
    { id: 'I3', text: 'Quebra da glicose' },
  ],
  correct_order: ['I3', 'I1', 'I2'],
};

export const SHORT_ANSWER = {
  model_answer: 'A mitocôndria produz ATP pela respiração celular.',
  rubric: [
    { id: 'r1', criterion: 'Cita a produção de ATP', points: 1 },
    { id: 'r2', criterion: 'Relaciona à respiração celular', points: 1 },
  ],
  max_points: 2,
  key_terms: ['ATP'],
};

export const ESSAY = {
  model_answer: 'A fotossíntese converte energia luminosa em química nos cloroplastos.',
  rubric: [{ id: 'r1', criterion: 'Explica a conversão de energia', points: 5 }],
  max_points: 10,
  expected_lines: 12,
};

export const FIND_ERROR: FindErrorPayload = {
  segments: [
    { id: 'S1', text: 'A fotossíntese ocorre nas mitocôndrias.' },
    { id: 'S2', text: 'Ela libera oxigênio.' },
    { id: 'S3', text: 'Usa a luz do sol.' },
  ],
  error_segment_id: 'S1',
  error_type: 'wrong cause→effect',
  explanation: 'A fotossíntese ocorre nos cloroplastos.',
  corrected_text: 'A fotossíntese ocorre nos cloroplastos.',
};

export const FIND_ERROR_NONE: FindErrorPayload = { ...FIND_ERROR, error_segment_id: null };

const HINTS = ['Use a segunda lei de Newton.', 'Escreva F = m · a.', 'Isole a aceleração.'] as const;

/** Problem with a numeric answer and a tolerance of 0.01. */
export const PROBLEM_NUMERIC: ProblemPayload = {
  given: { m: 2, g: 4.9 },
  final_answer: 4,
  answer_format: 'numeric',
  tolerance: 0.01,
  solution_steps: ['F = m · a', 'a = 2'],
  hints: [...HINTS],
};

export const PROBLEM_CHOICE: ProblemPayload = {
  given: {},
  final_answer: 'C',
  answer_format: 'choice',
  solution_steps: ['Escolha a alternativa correta.'],
  hints: [...HINTS],
};

export const PROBLEM_EXPRESSION: ProblemPayload = {
  given: { x: 2 },
  final_answer: 'x^2 + 1',
  answer_format: 'expression',
  check_expression: 'x^2 + 1',
  solution_steps: ['Substitua x.'],
  hints: [...HINTS],
};
