// ENEM helpers shared by enem-simulado-create and quiz-submit (spec 09 ENM-04, spec 08 §8.5): the bank pool with
// TRI parameters, the student's answered questions, and the per-area TRI result of a submitted simulado.
import type { Db } from '@studify/db';
import {
  scoreArea,
  targetPaceMin,
  timeAnalysis,
  toStdParams,
  type EnemArea,
  type EnemAreaResults,
  type EnemSimuladoConfig,
  type PoolItem,
  type SimuladoItemResponse,
  type TriParamScale,
} from '@studify/shared';

interface EnemItemRow {
  id: string;
  question_id: string;
  edition_year: number;
  application: 'regular' | 'ppl' | 'other';
  area: EnemArea;
  positions: Array<{ co_prova?: string; color?: string; position?: number }> | null;
  answer_key: string | null;
  language: 'en' | 'es' | null;
  annulled: boolean;
  enem_topic_ids: string[] | null;
}

interface ParamRow {
  enem_item_id: string;
  a: number | string;
  b: number | string;
  c: number | string;
  scale: TriParamScale;
  logistic_d: number | string | null;
}

const ITEM_COLUMNS = 'id, question_id, edition_year, application, area, positions, answer_key, language, annulled, enem_topic_ids';

/** Position inside the area test (1–45): booklet positions run 1–180 across the two days. */
export function positionInArea(positions: EnemItemRow['positions']): number {
  const raw = positions?.find((p) => typeof p.position === 'number')?.position ?? 45;
  return ((raw - 1) % 45) + 1;
}

function chunk<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

async function paramsFor(db: Db, itemIds: readonly string[]): Promise<Map<string, ParamRow>> {
  const out = new Map<string, ParamRow>();
  for (const part of chunk(itemIds, 300)) {
    const res = await db.from('enem_item_params').select('enem_item_id, a, b, c, scale, logistic_d').in('enem_item_id', part);
    if (res.error) throw res.error;
    for (const p of res.data as ParamRow[]) out.set(p.enem_item_id, p);
  }
  return out;
}

const num = (v: number | string | null | undefined): number => (typeof v === 'string' ? Number(v) : (v ?? 0));

function stdParams(p: ParamRow | undefined) {
  if (!p) return null;
  return toStdParams({ a: num(p.a), b: num(p.b), c: num(p.c), scale: p.scale, logistic_d: p.logistic_d === null ? 1 : num(p.logistic_d) });
}

/** Published, non-annulled regular items of the areas with their standardized `b` (the simulado pool). */
export async function loadSimuladoPool(db: Db, areas: readonly EnemArea[]): Promise<PoolItem[]> {
  const items: EnemItemRow[] = [];
  for (const area of areas) {
    const res = await db.from('enem_items').select(ITEM_COLUMNS).eq('area', area).eq('review_status', 'ok').eq('annulled', false).eq('application', 'regular').limit(5000);
    if (res.error) throw res.error;
    items.push(...(res.data as EnemItemRow[]));
  }
  const params = await paramsFor(
    db,
    items.map((i) => i.id),
  );
  return items.map((i) => {
    const p = stdParams(params.get(i.id));
    return {
      id: i.id,
      question_id: i.question_id,
      edition_year: i.edition_year,
      application: i.application,
      area: i.area,
      position: positionInArea(i.positions),
      language: i.language,
      annulled: i.annulled,
      b: p ? p.b : null,
      enem_topic_ids: i.enem_topic_ids ?? [],
    };
  });
}

/** Question ids among `questionIds` the student already answered (ENM-08.4 "avoid answered items"). */
export async function answeredQuestionIds(db: Db, userId: string, questionIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunk(questionIds, 300)) {
    const res = await db.from('attempt_answers').select('question_id').eq('user_id', userId).in('question_id', part);
    if (res.error) throw res.error;
    for (const r of res.data as Array<{ question_id: string }>) out.add(r.question_id);
  }
  return out;
}

export interface SimuladoAnswer {
  questionId: string;
  /** Chosen letter, or null for a blank. */
  response: string | null;
  timeSeconds: number;
  correct: boolean | null;
}

/** mcq_single responses are stored as the option id; anything else counts as blank. */
export function letterOf(response: unknown): string | null {
  if (typeof response === 'string' && /^[A-Ea-e]$/.test(response)) return response.toUpperCase();
  if (response && typeof response === 'object' && 'choice' in response) return letterOf((response as { choice: unknown }).choice);
  return null;
}

/**
 * TRI result per area of a submitted simulado (ENM-04.5–04.7): EAP estimate, 80% interval, coherence and time
 * analysis. Items keep the quiz order, so positions are the simulado's own (fatigue blocks of 15).
 */
export async function simuladoAreaResults(
  db: Db,
  config: Pick<EnemSimuladoConfig, 'mode'>,
  questionIds: readonly string[],
  answers: ReadonlyMap<string, SimuladoAnswer>,
  pausedSeconds: number,
  durations: { day1: number | null; day2: number | null },
): Promise<EnemAreaResults> {
  const rows: EnemItemRow[] = [];
  for (const part of chunk(questionIds, 300)) {
    const res = await db.from('enem_items').select(ITEM_COLUMNS).in('question_id', part);
    if (res.error) throw res.error;
    rows.push(...(res.data as EnemItemRow[]));
  }
  const byQuestion = new Map(rows.map((r) => [r.question_id, r] as const));
  const params = await paramsFor(
    db,
    rows.map((r) => r.id),
  );
  const mode = config.mode === 'full_day1' ? 'day1' : config.mode === 'full_day2' ? 'day2' : config.mode;
  const pace = targetPaceMin({ mode, durationMin: mode === 'day1' ? durations.day1 : mode === 'day2' ? durations.day2 : null });
  const perArea = new Map<EnemArea, { items: SimuladoItemResponse[]; timed: Array<{ id: string; position: number; seconds: number; correct: boolean }> }>();
  questionIds.forEach((qid, index) => {
    const item = byQuestion.get(qid);
    if (!item) return;
    const answer = answers.get(qid);
    const entry = perArea.get(item.area) ?? { items: [], timed: [] };
    entry.items.push({ id: item.id, params: stdParams(params.get(item.id)), annulled: item.annulled, answerKey: item.answer_key, response: answer?.response ?? null });
    const correct = !item.annulled && answer?.response != null && item.answer_key !== null && answer.response === item.answer_key;
    entry.timed.push({ id: item.id, position: index + 1, seconds: answer?.timeSeconds ?? 0, correct });
    perArea.set(item.area, entry);
  });
  const areas: EnemAreaResults['areas'] = {};
  for (const [area, entry] of perArea) {
    const tri = scoreArea(entry.items);
    const time = timeAnalysis(entry.timed, pace);
    areas[area] = { ...tri, time };
  }
  return { areas, paused: pausedSeconds > 0 && (mode === 'day1' || mode === 'day2') };
}
