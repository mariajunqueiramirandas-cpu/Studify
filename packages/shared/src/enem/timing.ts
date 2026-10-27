// Simulado modes and time coaching (spec 09 ENM-04.1, §8.5, ENM-04.6).
import type { EnemArea } from '../core/enums.ts';

export const SIMULADO_MODES = ['day1', 'day2', 'area', 'mini'] as const;
export type SimuladoMode = (typeof SIMULADO_MODES)[number];

export const SIMULADO_SOURCES = ['replica', 'misto', 'provavel'] as const;
export type SimuladoSource = (typeof SIMULADO_SOURCES)[number];

/** 2025 edital durations, used when the edition row has none. */
export const DEFAULT_DAY1_MIN = 330;
export const DEFAULT_DAY2_MIN = 300;
export const DEFAULT_MIN_PER_ITEM = 3;
/** Minutes kept for filling the cartão-resposta. */
export const CARTAO_RESERVE_MIN = 30;
/** Day 1 redação reserve (student setting, 60–90). */
export const DEFAULT_ESSAY_RESERVE_MIN = 75;
/** Accuracy is shown by blocks of 15 positions (fatigue). */
export const FATIGUE_BLOCK = 15;

export interface SimuladoShape {
  areas: EnemArea[];
  itemCount: number;
  timeLimitMin: number;
  includesEssay: boolean;
}

/**
 * Areas, item count and time limit of a mode (ENM-04.1). Área: 45 × 3 min (editable); Mini: 15 or 30 items at
 * 3 min/item; full days use the edition's durations.
 */
export function simuladoShape(input: { mode: SimuladoMode; area?: EnemArea; miniSize?: 15 | 30; day1Min?: number | null; day2Min?: number | null; minPerItem?: number }): SimuladoShape {
  const perItem = input.minPerItem ?? DEFAULT_MIN_PER_ITEM;
  switch (input.mode) {
    case 'day1':
      return { areas: ['LC', 'CH'], itemCount: 90, timeLimitMin: input.day1Min ?? DEFAULT_DAY1_MIN, includesEssay: true };
    case 'day2':
      return { areas: ['CN', 'MT'], itemCount: 90, timeLimitMin: input.day2Min ?? DEFAULT_DAY2_MIN, includesEssay: false };
    case 'area':
      if (!input.area) throw new RangeError('area mode needs an area');
      return { areas: [input.area], itemCount: 45, timeLimitMin: 45 * perItem, includesEssay: false };
    case 'mini': {
      if (!input.area) throw new RangeError('mini mode needs an area');
      const n = input.miniSize ?? 15;
      return { areas: [input.area], itemCount: n, timeLimitMin: n * perItem, includesEssay: false };
    }
  }
}

/**
 * Target minutes per item (§8.5): Day 2 = (duration − 30) / 90 ≈ 3.0; Day 1 = (duration − essay reserve − 30) / 90
 * ≈ 2.5; Área/Mini = the configured pace (3 min).
 */
export function targetPaceMin(input: { mode: SimuladoMode; durationMin?: number | null; essayReserveMin?: number; minPerItem?: number }): number {
  if (input.mode === 'day2') return ((input.durationMin ?? DEFAULT_DAY2_MIN) - CARTAO_RESERVE_MIN) / 90;
  if (input.mode === 'day1') return ((input.durationMin ?? DEFAULT_DAY1_MIN) - (input.essayReserveMin ?? DEFAULT_ESSAY_RESERVE_MIN) - CARTAO_RESERVE_MIN) / 90;
  return input.minPerItem ?? DEFAULT_MIN_PER_ITEM;
}

export interface TimedAnswer {
  id: string;
  /** 1-based position in the simulado. */
  position: number;
  seconds: number;
  correct: boolean;
}

export interface TimeAnalysis {
  total_s: number;
  per_item_s: number[];
  /** Items over 2 × target ("você travou aqui"). */
  stuck_ids: string[];
  target_s: number;
  /** Accuracy by blocks of 15 positions. */
  blocks: Array<{ from: number; to: number; n: number; correct: number; accuracy: number }>;
}

/** ENM-04.6. Pauses are excluded upstream (the per-item seconds are active time only). */
export function timeAnalysis(answers: readonly TimedAnswer[], targetMin: number): TimeAnalysis {
  const sorted = [...answers].sort((a, b) => a.position - b.position);
  const target_s = Math.round(targetMin * 60);
  const blocks: TimeAnalysis['blocks'] = [];
  for (const a of sorted) {
    const from = Math.floor((a.position - 1) / FATIGUE_BLOCK) * FATIGUE_BLOCK + 1;
    let block = blocks.find((b) => b.from === from);
    if (!block) {
      block = { from, to: from + FATIGUE_BLOCK - 1, n: 0, correct: 0, accuracy: 0 };
      blocks.push(block);
    }
    block.n += 1;
    if (a.correct) block.correct += 1;
  }
  for (const b of blocks) b.accuracy = b.n ? b.correct / b.n : 0;
  blocks.sort((x, y) => x.from - y.from);
  return {
    total_s: sorted.reduce((s, a) => s + a.seconds, 0),
    per_item_s: sorted.map((a) => a.seconds),
    stuck_ids: sorted.filter((a) => a.seconds > 2 * targetMin * 60).map((a) => a.id),
    target_s,
    blocks,
  };
}

/** Countdown warnings (ENM-04.3): minutes left at which the app warns. */
export const SIMULADO_WARNINGS_MIN = [60, 30, 15] as const;
