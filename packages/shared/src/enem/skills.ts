// ENEM structure (spec 09 §1.1, §8.2): areas, days, the Matriz skill codes and their competências.
import { ENEM_AREA, type EnemArea } from '../core/enums.ts';

/** SISU and the result screens add Redação to the four objective areas. */
export const ENEM_SCORE_AREAS = ['LC', 'CH', 'CN', 'MT', 'RED'] as const;
export type EnemScoreArea = (typeof ENEM_SCORE_AREAS)[number];

/** Day of each objective area (Day 1: LC + CH + Redação; Day 2: CN + MT). */
export const ENEM_DAY_OF_AREA: Readonly<Record<EnemArea, 1 | 2>> = { LC: 1, CH: 1, CN: 2, MT: 2 };

/** Items per area test. */
export const ENEM_ITEMS_PER_AREA = 45;

/** Foreign-language items inside Linguagens (positions 1–5 of the LC test). */
export const ENEM_LANGUAGE_ITEMS = 5;

/** Competência → [first, last] skill per area (Matriz de Referência, spec 09 §8.2). */
export const ENEM_COMPETENCIES: Readonly<Record<EnemArea, ReadonlyArray<readonly [number, number]>>> = {
  LC: [[1, 4], [5, 8], [9, 11], [12, 14], [15, 17], [18, 20], [21, 24], [25, 27], [28, 30]],
  MT: [[1, 5], [6, 9], [10, 14], [15, 18], [19, 23], [24, 26], [27, 30]],
  CN: [[1, 4], [5, 7], [8, 12], [13, 16], [17, 19], [20, 23], [24, 27], [28, 30]],
  CH: [[1, 5], [6, 10], [11, 15], [16, 20], [21, 25], [26, 30]],
};

const SKILL_RE = /^(LC|CH|CN|MT)-H([1-9]|[12][0-9]|30)$/;

export interface SkillRef {
  code: string;
  area: EnemArea;
  skill: number;
  competency: number;
}

/** Parses `MT-H21` into its parts; null for anything outside H1–H30 of the four areas. */
export function parseSkillCode(code: string): SkillRef | null {
  const m = SKILL_RE.exec(code.trim());
  if (!m) return null;
  const area = m[1] as EnemArea;
  const skill = Number(m[2]);
  return { code: `${area}-H${skill}`, area, skill, competency: competencyOf(area, skill) };
}

/** Competência number (1-based) of a skill in its area. */
export function competencyOf(area: EnemArea, skill: number): number {
  const idx = ENEM_COMPETENCIES[area].findIndex(([lo, hi]) => skill >= lo && skill <= hi);
  if (idx < 0) throw new RangeError(`skill H${skill} is outside H1–H30`);
  return idx + 1;
}

/** Every skill code of an area, H1 first. */
export function skillCodesOf(area: EnemArea): string[] {
  return Array.from({ length: 30 }, (_, i) => `${area}-H${i + 1}`);
}

/** Every skill code of the Matriz (120 codes). */
export function allSkillCodes(): string[] {
  return ENEM_AREA.flatMap((a) => skillCodesOf(a));
}

/**
 * Converts a microdata skill number (`CO_HABILIDADE`, 1–30) into the app's code; null when missing or out of range
 * (the item then goes to review, ENM-02.9).
 */
export function skillCodeFromMicrodata(area: EnemArea, coHabilidade: number | string | null | undefined): string | null {
  const n = typeof coHabilidade === 'string' ? Number(coHabilidade.trim()) : coHabilidade;
  if (n === null || n === undefined || !Number.isInteger(n) || n < 1 || n > 30) return null;
  return `${area}-H${n}`;
}
