// Motivation: XP, levels, streaks and active minutes (learning-engine §17; MOT-01, spec 13 §8.1–8.4).
import { MOTIVATION } from './params.ts';
import { addDays, DEFAULT_TIME_ZONE, studyDay } from './time.ts';
import type { LocalDate } from './types.ts';
import { compareStrings } from './util.ts';

// ---------- XP (§17.1) ----------

export type XpEvent =
  | { kind: 'card_reviewed'; sameCardWithinCooldown?: boolean }
  | { kind: 'question_answered'; firstAttemptToday: boolean; correct: boolean }
  | { kind: 'quiz_completed'; questionCount: number }
  | { kind: 'simulado_completed'; questionCount: number }
  | { kind: 'boss_defeated'; retry: boolean }
  | { kind: 'plan_item_completed' }
  | { kind: 'daily_goal_met' }
  | { kind: 'mistake_resolved' }
  | { kind: 'note_section_read' }
  | { kind: 'lucas_finished'; score: number }
  | { kind: 'argumentation_finished' }
  | { kind: 'podcast_completed' }
  | { kind: 'duel_finished'; won: boolean }
  | { kind: 'battle_played'; rank?: number | null }
  | { kind: 'error_report_accepted' }
  | { kind: 'focus_cycle_completed' };

/** Per-day counters the XP rules need for their caps (§17.1). */
export interface XpDayContext {
  dailyGoalXpAwarded: boolean;
  noteXpToday: number;
  podcastsToday: number;
}

/**
 * XP for one event (§17.1, spec 13 §8.1). Same XP for every FSRS rating, so a lying "Fácil" earns
 * nothing extra. Caps: notes ≤ 20 per day, podcasts ≤ 3 per day, daily goal once per day.
 * Question XP applies only to the first attempt of the day (assumption, see report).
 */
export function xpFor(event: XpEvent, today: XpDayContext): number {
  switch (event.kind) {
    case 'card_reviewed':
      return event.sameCardWithinCooldown ? 0 : 1;
    case 'question_answered':
      if (!event.firstAttemptToday) return 0;
      return 2 + (event.correct ? 1 : 0);
    case 'quiz_completed':
      return event.questionCount >= 5 ? 5 : 0;
    case 'simulado_completed':
      return 20 + Math.max(0, event.questionCount);
    case 'boss_defeated':
      return event.retry ? 10 : 50;
    case 'plan_item_completed':
      return 5;
    case 'daily_goal_met':
      return today.dailyGoalXpAwarded ? 0 : MOTIVATION.dailyGoalXp;
    case 'mistake_resolved':
      return 3;
    case 'note_section_read':
      return Math.max(0, Math.min(2, MOTIVATION.noteXpDailyCap - today.noteXpToday));
    case 'lucas_finished':
      return 10 + Math.floor(Math.max(0, event.score) / 10);
    case 'argumentation_finished':
      return 10;
    case 'podcast_completed':
      return today.podcastsToday >= MOTIVATION.podcastDailyCap ? 0 : 5;
    case 'duel_finished':
      return event.won ? 10 : 5;
    case 'battle_played': {
      const bonus = event.rank === 1 ? 10 : event.rank === 2 ? 6 : event.rank === 3 ? 3 : 0;
      return 5 + bonus;
    }
    case 'error_report_accepted':
      return 5;
    case 'focus_cycle_completed':
      return 3;
  }
}

// ---------- levels (§17.2) ----------

/** Total XP needed for level L: 50·L·(L+1). */
export function levelThreshold(level: number): number {
  return 50 * level * (level + 1);
}

/** Highest level whose threshold is at or below `totalXp`. 0 below 100 XP. */
export function levelFor(totalXp: number): number {
  let level = 0;
  while (levelThreshold(level + 1) <= totalXp) level += 1;
  return level;
}

// ---------- streaks (§17.3) ----------

export interface DailyActivity {
  /** Study day (04:00 boundary, §0.2). */
  day: LocalDate;
  activeMinutes: number;
  cardReviews: number;
  /** Completed quiz, duel, battle, Lucas or debate sessions. */
  completedSessions: number;
  /** An exam of an active goal falls on this day (counted automatically). */
  examOfActiveGoal: boolean;
  /** User-chosen rest day: neither a break nor an extension. */
  restDay: boolean;
  /** Auto rest day (see autoRestDays). */
  autoRest: boolean;
}

export interface StreakState {
  length: number;
  longest: number;
  shields: number;
  /** Consecutive counted days since the last lapse (drives the shield refill). */
  countedRun: number;
  lastEvaluated: LocalDate | null;
  shieldUsedOn: LocalDate[];
}

export function initialStreakState(): StreakState {
  return { length: 0, longest: 0, shields: 0, countedRun: 0, lastEvaluated: null, shieldUsedOn: [] };
}

/** counted(d): ≥ 5 active minutes, or ≥ 10 card reviews, or a completed session, or an exam of an active goal. */
export function isCountedDay(a: DailyActivity): boolean {
  return (
    a.activeMinutes >= MOTIVATION.countedMinutes ||
    a.cardReviews >= MOTIVATION.countedReviews ||
    a.completedSessions >= 1 ||
    a.examOfActiveGoal
  );
}

/**
 * Auto rest days: exam dates of active goals, and the day after each goal's last exam (§17.3).
 * `goals` lists, per active goal, its exam days and its last exam day.
 */
export function autoRestDays(goals: ReadonlyArray<{ examDays: readonly LocalDate[]; lastExamDay: LocalDate | null }>): Set<LocalDate> {
  const out = new Set<LocalDate>();
  for (const goal of goals) {
    for (const d of goal.examDays) out.add(d);
    if (goal.lastExamDay) out.add(addDays(goal.lastExamDay, 1));
  }
  return out;
}

/**
 * evaluateStreak (§17.3). Processes every day after `state.lastEvaluated` up to the last day given.
 * Days missing from `days` count as empty days. Evaluation is idempotent for already-processed days.
 *   counted → length += 1; every 7 counted days in a row, shields = min(2, shields + 1)
 *   rest or auto-rest → nothing (neither break nor extension; the run continues)
 *   otherwise → spend a shield (the length is kept), or reset length and the run to 0
 */
export function evaluateStreak(days: readonly DailyActivity[], state: StreakState): StreakState {
  if (days.length === 0) return state;
  const byDay = new Map<LocalDate, DailyActivity>();
  for (const d of days) byDay.set(d.day, d);
  const sortedDays = [...byDay.keys()].sort(compareStrings);
  const last = sortedDays[sortedDays.length - 1];
  if (!last) return state;

  let cursor = state.lastEvaluated ? addDays(state.lastEvaluated, 1) : (sortedDays[0] ?? last);
  let next: StreakState = { ...state, shieldUsedOn: [...state.shieldUsedOn] };
  while (cursor <= last) {
    next = stepDay(next, byDay.get(cursor) ?? emptyDay(cursor));
    cursor = addDays(cursor, 1);
  }
  return next;
}

function emptyDay(day: LocalDate): DailyActivity {
  return {
    day,
    activeMinutes: 0,
    cardReviews: 0,
    completedSessions: 0,
    examOfActiveGoal: false,
    restDay: false,
    autoRest: false,
  };
}

function stepDay(state: StreakState, a: DailyActivity): StreakState {
  const base: StreakState = { ...state, lastEvaluated: a.day };
  if (isCountedDay(a)) {
    const countedRun = state.countedRun + 1;
    let shields = state.shields;
    if (countedRun % MOTIVATION.shieldEveryCountedDays === 0) {
      shields = Math.min(MOTIVATION.shieldsMax, shields + 1);
    }
    const length = state.length + 1;
    return { ...base, length, longest: Math.max(state.longest, length), countedRun, shields };
  }
  if (a.restDay || a.autoRest) return base;
  if (state.shields > 0) {
    return { ...base, shields: state.shields - 1, shieldUsedOn: [...state.shieldUsedOn, a.day] };
  }
  return { ...base, length: 0, countedRun: 0 };
}

/**
 * Active minutes from interaction timestamps (§17.4, spec 13 §8.2). A minute is active when the user
 * interacted in it, and minutes between two interactions less than 90 s apart are active too. Each
 * active minute is attributed to the study day of its start. Returns minutes per study day.
 */
export function activeMinutesByStudyDay(
  timestampsMs: readonly number[],
  timeZone: string = DEFAULT_TIME_ZONE,
  idleGapMs: number = MOTIVATION.activeIdleGapMs,
): Record<LocalDate, number> {
  const minute = 60_000;
  const sorted = [...new Set(timestampsMs)].sort((a, b) => a - b);
  const marked = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i] ?? 0;
    marked.add(Math.floor(t / minute) * minute);
    const nextT = sorted[i + 1];
    if (nextT !== undefined && nextT - t <= idleGapMs) {
      for (let m = Math.floor(t / minute) * minute; m <= nextT; m += minute) marked.add(m);
    }
  }
  const out: Record<LocalDate, number> = {};
  for (const m of marked) {
    const day = studyDay(new Date(m), timeZone);
    out[day] = (out[day] ?? 0) + 1;
  }
  return out;
}

// ---------- achievements (MOT-01.8; spec 13 §8.5) ----------

/**
 * Canonical achievement catalog (v1). `code` is the value stored in achievements.code (migration
 * 20260103000000_phase2: `^[a-z][a-z0-9_]{1,40}$`). `computable: false` marks achievements whose
 * condition needs data the schema does not hold yet; the worker never unlocks those.
 */
export const ACHIEVEMENTS = [
  { code: 'first_material', name: 'Primeiro material', criterion: 'Enviar o primeiro material.', metric: 'documents', threshold: 1, computable: true },
  { code: 'first_review', name: 'Primeira revisão', criterion: 'Revisar o primeiro cartão.', metric: 'reviews', threshold: 1, computable: true },
  { code: 'streak_7', name: '7 dias', criterion: 'Chegar a 7 dias de sequência.', metric: 'longestStreak', threshold: 7, computable: true },
  { code: 'streak_30', name: '30 dias', criterion: 'Chegar a 30 dias de sequência.', metric: 'longestStreak', threshold: 30, computable: true },
  { code: 'streak_100', name: '100 dias', criterion: 'Chegar a 100 dias de sequência.', metric: 'longestStreak', threshold: 100, computable: true },
  { code: 'cards_100', name: '100 cartões', criterion: 'Revisar 100 cartões no total.', metric: 'reviews', threshold: 100, computable: true },
  { code: 'cards_1000', name: '1.000 cartões', criterion: 'Revisar 1.000 cartões no total.', metric: 'reviews', threshold: 1000, computable: true },
  { code: 'questions_500', name: '500 questões', criterion: 'Responder 500 questões no total.', metric: 'questions', threshold: 500, computable: true },
  { code: 'first_mock', name: 'Primeiro simulado', criterion: 'Concluir um simulado.', metric: 'mockExams', threshold: 1, computable: true },
  { code: 'clean_notebook', name: 'Caderno limpo', criterion: 'Resolver 20 erros do Caderno de Erros.', metric: 'mistakesResolved', threshold: 20, computable: true },
  { code: 'calibrated', name: 'Calibrado(a)', criterion: 'Ficar bem calibrado nas últimas 50 respostas com confiança (PRA-05).', metric: 'calibrated', threshold: 1, computable: true },
  { code: 'duelist', name: 'Duelista', criterion: 'Terminar 10 duelos.', metric: 'duelsFinished', threshold: 10, computable: true },
  { code: 'rematch', name: 'Revanche!', criterion: 'Vencer uma revanche.', metric: 'rematchWins', threshold: 1, computable: true },
  { code: 'bug_hunter', name: 'Caçador de erros', criterion: '3 relatos de erro aceitos (TRU-02).', metric: 'errorReportsAccepted', threshold: 3, computable: true },
  {
    code: 'week_won',
    name: 'Semana vencida',
    criterion: 'Terminar todas as provas de uma Semana de Provas com todos os dias do plano contados ou de descanso.',
    metric: null,
    threshold: 1,
    computable: false,
  },
  { code: 'consistent_week', name: 'Semana consistente', criterion: 'Bater a meta do dia em 4 dias de uma mesma semana.', metric: 'bestWeekGoalDays', threshold: 4, computable: true },
  // Phase 5 (spec 13 §8.5 "Later")
  { code: 'boss_first', name: 'Caçador de chefões', criterion: 'Derrotar o primeiro chefão de uma unidade (MOT-02).', metric: 'bossesDefeated', threshold: 1, computable: true },
  { code: 'lucas_90', name: 'Nasceu pra ensinar', criterion: 'Tirar 90 ou mais no Ensine o Lucas.', metric: 'bestLucasScore', threshold: 90, computable: true },
  { code: 'debate_5', name: 'Bom de argumento', criterion: 'Terminar 5 Treinos de Argumentação.', metric: 'debatesFinished', threshold: 5, computable: true },
  { code: 'turma_10', name: 'Líder da turma', criterion: '10 contribuições aprovadas na turma (resumos ou perguntas).', metric: 'turmaContributions', threshold: 10, computable: true },
  { code: 'focus_10', name: 'Foco total', criterion: 'Completar 10 ciclos do Modo foco.', metric: 'focusCycles', threshold: 10, computable: true },
] as const;

export type AchievementDefinition = (typeof ACHIEVEMENTS)[number];
export type AchievementCode = AchievementDefinition['code'];
export type AchievementMetricName = Exclude<AchievementDefinition['metric'], null>;

/** Measured values per metric, read by the worker from the tables named in the catalog comments. */
export interface AchievementMetrics {
  /** documents (not deleted) uploaded by the user. */
  documents: number;
  /** review_logs rows. */
  reviews: number;
  /** streaks.longest_length. */
  longestStreak: number;
  /** attempt_answers rows (not deleted). */
  questions: number;
  /** Submitted attempts of mock_exam / enem_simulado quizzes. */
  mockExams: number;
  /** mistakes with resolved_at set. */
  mistakesResolved: number;
  /** calibration(last 50 rated answers).calibrated. */
  calibrated: boolean;
  /** Duels finished where the user took part. */
  duelsFinished: number;
  /** Duels won that were rematches (rematch_of set). */
  rematchWins: number;
  /** content_flags reported by the user and accepted. */
  errorReportsAccepted: number;
  /** Most days with the daily goal met in one study week (Monday start). */
  bestWeekGoalDays: number;
  /** Distinct units whose boss was passed (boss_attempts.passed). */
  bossesDefeated: number;
  /** Best teaching_sessions.score. */
  bestLucasScore: number;
  /** argument_sessions with status finished. */
  debatesFinished: number;
  /** Approved contributions plus approved peer questions authored by the user. */
  turmaContributions: number;
  /** Σ study_sessions.cycles_done of focus sessions. */
  focusCycles: number;
}

export interface AchievementProgress {
  code: AchievementCode;
  name: string;
  /** Measured value, capped at the threshold (what achievements.progress stores). */
  progress: number;
  threshold: number;
  unlocked: boolean;
  computable: boolean;
}

/**
 * Progress and unlock state for every catalog entry. A non-computable entry is never unlocked.
 * `calibrated` counts as 1 when true, 0 otherwise.
 */
export function achievementProgress(metrics: AchievementMetrics): AchievementProgress[] {
  return ACHIEVEMENTS.map((def) => {
    if (!def.computable || def.metric === null) {
      return { code: def.code, name: def.name, progress: 0, threshold: def.threshold, unlocked: false, computable: false };
    }
    const raw = metrics[def.metric];
    const value = typeof raw === 'boolean' ? (raw ? 1 : 0) : Math.max(0, Number(raw) || 0);
    return {
      code: def.code,
      name: def.name,
      progress: Math.min(value, def.threshold),
      threshold: def.threshold,
      unlocked: value >= def.threshold,
      computable: true,
    };
  });
}

/** Most days with goal_met in one study week (Monday to Sunday, local dates). Days not in the list count as unmet. */
export function bestWeekGoalDays(days: ReadonlyArray<{ day: LocalDate; goalMet: boolean }>): number {
  const perWeek = new Map<LocalDate, number>();
  for (const d of days) {
    if (!d.goalMet) continue;
    const week = mondayOf(d.day);
    perWeek.set(week, (perWeek.get(week) ?? 0) + 1);
  }
  return Math.max(0, ...perWeek.values());
}

function mondayOf(day: LocalDate): LocalDate {
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}
