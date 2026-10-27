// Redação rules (spec 09 §8.6, ENM-05): the 40-point grid per competência, the deterministic zero pre-check
// by line count, handwritten-line estimation for typed essays, the human-rights rule for C5 and the INEP-like
// aggregation for dual correction. The model's scores never become the total without passing through here.

export const COMPETENCIA_SCORES = [0, 40, 80, 120, 160, 200] as const;
export type CompetenciaScore = (typeof COMPETENCIA_SCORES)[number];
export const COMPETENCIA_IDS = [1, 2, 3, 4, 5] as const;

/** ENM-05.9 default weekly correction budget per student (owner-configurable). */
export const ENEM_ESSAYS_PER_WEEK = 3;

/** Lines on the official answer sheet. */
export const REDACAO_MAX_LINES = 30;
/** Up to 7 lines is "texto insuficiente": zero, decided before any model call (ENM-05.2). */
export const REDACAO_ZERO_MAX_LINES = 7;
/** Typed-text heuristic: characters per handwritten line (unverified; calibrated with photographed essays). */
export const CHARS_PER_LINE = 75;

/** Zero reasons (spec 09 §1.1), the keys shown in the result screen. */
export const REDACAO_ZERO_REASONS = [
  'fuga_tema',
  'tipo_textual',
  'em_branco',
  'texto_insuficiente',
  'anulacao',
  'parte_desconectada',
  'identificacao',
  'lingua_estrangeira',
  'ilegivel',
] as const;
export type RedacaoZeroReason = (typeof REDACAO_ZERO_REASONS)[number];

export function isCompetenciaScore(n: number): n is CompetenciaScore {
  return (COMPETENCIA_SCORES as readonly number[]).includes(n);
}

/** Nearest grid value, clamped to 0–200. */
export function snapToGrid(n: number): CompetenciaScore {
  const clamped = Math.min(200, Math.max(0, n));
  return (Math.round(clamped / 40) * 40) as CompetenciaScore;
}

function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Typed essays: Σ ceil(chars_per_paragraph / chars_per_line) over non-empty paragraphs. */
export function estimateHandwrittenLines(text: string, charsPerLine: number = CHARS_PER_LINE): number {
  return paragraphs(text).reduce((sum, p) => sum + Math.ceil([...p].length / charsPerLine), 0);
}

/** Photographed essays use the transcription's line breaks (non-empty lines). */
export function transcriptionLineCount(text: string): number {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.trim().length > 0).length;
}

export interface LineCheck {
  lines: number;
  /** ≤ 7 lines: zero without a model call. */
  tooShort: boolean;
  /** > 30 lines: "Na folha oficial só cabem 30 linhas" (warning only). */
  tooLong: boolean;
  blank: boolean;
}

/** The deterministic pre-check for an essay (typed → estimated lines; photo → transcription lines). */
export function redacaoLineCheck(text: string, inputMode: 'typed' | 'photo', charsPerLine: number = CHARS_PER_LINE): LineCheck {
  const blank = text.trim().length === 0;
  const lines = inputMode === 'photo' ? transcriptionLineCount(text) : estimateHandwrittenLines(text, charsPerLine);
  return { lines, blank, tooShort: blank || lines <= REDACAO_ZERO_MAX_LINES, tooLong: lines > REDACAO_MAX_LINES };
}

export interface CompetenciaInput {
  id: number;
  score: number;
}

export interface RedacaoTotal {
  total: number;
  isZero: boolean;
  zeroReasons: string[];
  /** Grid scores per competência (C5 = 0 on a human-rights violation); empty when the essay is zero. */
  scores: Record<string, CompetenciaScore>;
  /** Scores that were off the grid and were snapped (logged as a model quality signal). */
  snapped: number[];
}

/**
 * Total in code (§8.6): Σ of the five grid scores, or 0 with the reasons when any zero condition applies
 * (per-competência scores are hidden then). A proposta that disrespects human rights sets only C5 to 0.
 */
export function redacaoTotal(input: { competencias: readonly CompetenciaInput[]; zeroReasons: readonly string[]; humanRightsOk: boolean }): RedacaoTotal {
  if (input.zeroReasons.length > 0) {
    return { total: 0, isZero: true, zeroReasons: [...new Set(input.zeroReasons)], scores: {}, snapped: [] };
  }
  const scores: Record<string, CompetenciaScore> = {};
  const snapped: number[] = [];
  for (const id of COMPETENCIA_IDS) {
    const c = input.competencias.find((x) => x.id === id);
    if (!c) throw new RangeError(`competência C${id} missing`);
    if (!isCompetenciaScore(c.score)) snapped.push(id);
    scores[`c${id}`] = snapToGrid(c.score);
  }
  if (!input.humanRightsOk) scores.c5 = 0;
  const total = Object.values(scores).reduce<number>((s, x) => s + x, 0);
  return { total, isZero: false, zeroReasons: [], scores, snapped };
}

/** Discrepancy rule (spec 09 §1.1): totals differ by > 100 or any competência by > 80. */
export function discrepant(a: readonly number[], b: readonly number[]): boolean {
  const ta = a.reduce((s, x) => s + x, 0);
  const tb = b.reduce((s, x) => s + x, 0);
  if (Math.abs(ta - tb) > 100) return true;
  return a.some((x, i) => Math.abs(x - (b[i] ?? 0)) > 80);
}

export type DualCorrection = { status: 'needs_third' } | { status: 'final'; scores: number[]; total: number };

/**
 * INEP-like aggregation over 2 or 3 runs (each the 5 competência scores): 2 concordant runs → mean; discrepant →
 * a third run is needed; with 3 runs → mean of the two closest totals.
 */
export function aggregateCorrections(runs: ReadonlyArray<readonly number[]>): DualCorrection {
  if (runs.length < 2) throw new RangeError('dual correction needs at least 2 runs');
  const mean = (x: readonly number[], y: readonly number[]) => x.map((v, i) => (v + (y[i] ?? 0)) / 2);
  const total = (x: readonly number[]) => x.reduce((s, v) => s + v, 0);
  if (runs.length === 2) {
    if (discrepant(runs[0]!, runs[1]!)) return { status: 'needs_third' };
    const scores = mean(runs[0]!, runs[1]!);
    return { status: 'final', scores, total: total(scores) };
  }
  const [r0, r1, r2] = runs as [readonly number[], readonly number[], readonly number[]];
  const pairs: Array<[readonly number[], readonly number[]]> = [
    [r0, r1],
    [r0, r2],
    [r1, r2],
  ];
  pairs.sort((p, q) => Math.abs(total(p[0]) - total(p[1])) - Math.abs(total(q[0]) - total(q[1])));
  const scores = mean(pairs[0]![0], pairs[0]![1]);
  return { status: 'final', scores, total: total(scores) };
}
