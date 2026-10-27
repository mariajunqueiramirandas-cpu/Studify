// Pure helpers for the ENEM screens: skill grid grouping, score scale positions, countdowns and the editor's
// line counter. No React and no network: unit-tested in __tests__/enem-format.test.ts.
import { ENEM_COMPETENCIES, REDACAO_MAX_LINES, REDACAO_ZERO_MAX_LINES, estimateHandwrittenLines, type EnemArea, type EnemAreaResults } from '@studify/shared';

export interface SkillCell {
  code: string;
  skill: number;
  /** Accuracy 0–1 on answered items of the skill, null when none were answered. */
  accuracy: number | null;
  answered: number;
}

export interface CompetencyGroup {
  competency: number;
  skills: SkillCell[];
}

/** H1–H30 grouped by competência (spec 09 §8.2), with the student's accuracy per skill. */
export function skillGrid(area: EnemArea, accuracy: ReadonlyMap<string, { n: number; correct: number }>): CompetencyGroup[] {
  return ENEM_COMPETENCIES[area].map(([lo, hi], i) => ({
    competency: i + 1,
    skills: Array.from({ length: hi - lo + 1 }, (_, k) => {
      const skill = lo + k;
      const code = `${area}-H${skill}`;
      const a = accuracy.get(code);
      return { code, skill, accuracy: a && a.n > 0 ? a.correct / a.n : null, answered: a?.n ?? 0 };
    }),
  }));
}

export type MasteryTone = 'none' | 'low' | 'mid' | 'high';

/** Color band of a skill cell: < 50% low, < 75% mid, else high; fewer than 3 answers counts as no evidence. */
export function masteryTone(cell: Pick<SkillCell, 'accuracy' | 'answered'>): MasteryTone {
  if (cell.accuracy === null || cell.answered < 3) return 'none';
  if (cell.accuracy < 0.5) return 'low';
  if (cell.accuracy < 0.75) return 'mid';
  return 'high';
}

/** Position (0–1) of a score on the display scale used by the score bars (300–900). */
export function scalePos(score: number, min = 300, max = 900): number {
  return Math.min(1, Math.max(0, (score - min) / (max - min)));
}

/** Whole days from `today` to `day` (both YYYY-MM-DD); negative when past. */
export function daysUntil(day: string, today: string): number {
  return Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
}

export interface EditorLines {
  lines: number;
  tooShort: boolean;
  tooLong: boolean;
}

/** Typed redação: estimated handwritten lines (75 characters per line, spec 09 §8.6). */
export function editorLines(text: string): EditorLines {
  const lines = estimateHandwrittenLines(text);
  return { lines, tooShort: lines <= REDACAO_ZERO_MAX_LINES, tooLong: lines > REDACAO_MAX_LINES };
}

export interface AreaRow {
  area: EnemArea;
  score: number;
  low: number;
  high: number;
  correct: number;
  items: number;
  blank: number;
  easyMisses: number;
  luckyHits: number;
  level: 'alta' | 'media' | 'baixa' | null;
  stuck: number;
}

/** Rows of a simulado result in ENEM order (LC, CH, CN, MT). */
export function areaRows(results: EnemAreaResults | null | undefined): AreaRow[] {
  const order: EnemArea[] = ['LC', 'CH', 'CN', 'MT'];
  return order
    .filter((a) => results?.areas?.[a])
    .map((a) => {
      const r = results!.areas[a]!;
      return {
        area: a,
        score: r.score,
        low: r.ci80_low,
        high: r.ci80_high,
        correct: r.n_correct,
        items: r.n_items,
        blank: r.n_blank,
        easyMisses: r.coherence.easy_miss_ids.length,
        luckyHits: r.coherence.lucky_hit_ids.length,
        level: r.coherence.level,
        stuck: r.time.stuck_ids.length,
      };
    });
}

/** "ENEM {ano} · {dia}º dia · Questão {n}" position shown on items (booklet position of the first color). */
export function bookletPosition(positions: ReadonlyArray<{ position: number }> | null | undefined): number | null {
  return positions?.[0]?.position ?? null;
}

export type EnemRoute =
  | { pathname: '/enem/simulado/new'; params: { mode: 'full_day1' | 'full_day2' | 'area'; area?: EnemArea } }
  | { pathname: '/enem/essay/new'; params: Record<string, never> }
  | { pathname: '/enem/reta-final'; params: Record<string, never> }
  | { pathname: '/enem/bank'; params: { area: EnemArea; topicId?: string } };

const MOCK_MODE = { day1: 'full_day1', day2: 'full_day2', area: 'area' } as const;
const OBJECTIVE_AREAS = new Set<string>(['LC', 'CH', 'CN', 'MT']);

/**
 * Where an ENEM plan item opens (ENM-07): simulados go to the setup with the planned mode, redação to the editor,
 * the véspera to the Reta Final, practice to the bank filtered by area/topic. Null for school items and for ENEM
 * learn units, which open the student's own topic like any learn unit.
 */
export function enemRoute(item: { unitType: string; reasonKey: string | null; reasonParams: Record<string, unknown> | null }): EnemRoute | null {
  if (!item.reasonKey?.startsWith('enem.plan.')) return null;
  const p = item.reasonParams ?? {};
  const area = typeof p.area === 'string' && OBJECTIVE_AREAS.has(p.area) ? (p.area as EnemArea) : undefined;
  switch (item.unitType) {
    case 'mock': {
      const mock = p.mock as { mode?: keyof typeof MOCK_MODE; area?: EnemArea } | undefined;
      const mode = MOCK_MODE[mock?.mode ?? 'day2'] ?? 'full_day2';
      return { pathname: '/enem/simulado/new', params: { mode, ...(mode === 'area' && (mock?.area ?? area) ? { area: mock?.area ?? area } : {}) } };
    }
    case 'essay':
      return { pathname: '/enem/essay/new', params: {} };
    case 'vespera':
      return { pathname: '/enem/reta-final', params: {} };
    case 'practice':
      return area ? { pathname: '/enem/bank', params: { area, ...(typeof p.enemTopicId === 'string' ? { topicId: p.enemTopicId } : {}) } } : null;
    default:
      return null;
  }
}
