// Social scoring: duels, battles and class insights (learning-engine §18; SOC-02, SOC-03, SOC-04).
// Scoring is pure. Server-measured times are passed in by the Edge Function or the worker (anti-cheat, SOC-02/03).
import { SOCIAL } from './params.ts';
import { roundToStep } from './util.ts';

/**
 * Answer time for duels (§18.1): time from `servedAt` to receipt minus 0.5 s, clamped to [0, T].
 * Both instants are server clock values in milliseconds.
 */
export function duelAnswerSeconds(servedAtMs: number, receivedAtMs: number, limitSeconds: number = SOCIAL.duelMaxSeconds): number {
  const raw = (receivedAtMs - servedAtMs) / 1000 - 0.5;
  return clamp(raw, 0, limitSeconds);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Duel points (§18.1): correct ? 100 + round(50·(1 − t/T)) : 0. Times are clamped to [0, T]. */
export function duelPoints(correct: boolean, tSeconds: number, limitSeconds: number = SOCIAL.duelMaxSeconds): number {
  if (!correct) return 0;
  const t = clamp(tSeconds, 0, limitSeconds);
  return 100 + Math.round(50 * (1 - t / limitSeconds));
}

/** An answer received after deadline_at + 3 s is a timeout and scores 0 (§18.1). */
export function isDuelTimeout(receivedAtMs: number, deadlineAtMs: number): boolean {
  return receivedAtMs > deadlineAtMs + SOCIAL.duelDeadlineGraceMs;
}

/**
 * Battle points (§18.2): base + streak. base = correct ? round(1000·(1 − 0.5·t/T)) : 0 (500–1000 when
 * correct); streak = correct ? min(50·(answerStreak − 1), 200) : 0, where answerStreak includes this answer.
 */
export function battlePoints(
  correct: boolean,
  tSeconds: number,
  limitSeconds: number,
  answerStreak: number,
): number {
  if (!correct) return 0;
  const t = clamp(tSeconds, 0, limitSeconds);
  const base = Math.round(1000 * (1 - (0.5 * t) / limitSeconds));
  const streak = Math.min(SOCIAL.battleStreakStep * Math.max(0, answerStreak - 1), SOCIAL.battleStreakCap);
  return base + streak;
}

/** Answers after closes_at + 1 s are rejected (§18.2). */
export function isBattleAnswerRejected(receivedAtMs: number, closesAtMs: number): boolean {
  return receivedAtMs > closesAtMs + SOCIAL.battleClosesGraceMs;
}

// ---------- class insights (§18.3, SOC-04) ----------

/** Aggregate for one question across the class. Members with contribute_insights = false are excluded from `answerers`. */
export interface InsightAggregate {
  /** Distinct contributing answerers (n). */
  answerers: number;
  /** Wrong answers (w). Correct count is answerers − wrong. */
  wrong: number;
  /** Times the most-chosen wrong option was picked, for the "pegadinha" rule. */
  topWrongOptionCount?: number;
}

export type InsightDisplay =
  | { kind: 'none' }
  | { kind: 'band'; band: 'hard' | 'easy'; label: string }
  | { kind: 'error_rate'; errorRate: number };

export interface ClassInsight {
  display: InsightDisplay;
  /** "Pegadinha": shown only when chosen by ≥ 3 people and n ≥ 10. */
  pitfallRate: number | null;
}

/** Rounds to a 5% step and clamps to [5%, 95%] (§18.3). */
export function roundRate(rate: number): number {
  return clamp(roundToStep(rate, 0.05), 0.05, 0.95);
}

/**
 * Question insight, mirroring the SQL RPC `class_insights_for` (§18.3). Rules, in order:
 *  - n < 5: nothing (k-anonymity, k = 5);
 *  - 5 ≤ n < 10, or fewer than 2 correct or fewer than 2 wrong: band only, "Difícil para a turma"
 *    at error ≥ 60%, "Tranquila para a turma" at ≤ 20%, else nothing;
 *  - n ≥ 10 and min(correct, wrong) ≥ 2: error rate rounded to 5%, clamped to [5%, 95%].
 * The pitfall (wrong option) is shown only with ≥ 3 choosers and n ≥ 10, rounded to 5%.
 */
export function classInsightDisplay(agg: InsightAggregate): ClassInsight {
  const n = agg.answerers;
  const w = agg.wrong;
  const c = n - w;
  const topWrong = agg.topWrongOptionCount ?? 0;
  const pitfallRate = n >= 10 && topWrong >= 3 ? roundRate(topWrong / n) : null;

  if (n < SOCIAL.insightK) return { display: { kind: 'none' }, pitfallRate: null };

  const errorRate = n > 0 ? w / n : 0;
  if (n < 10 || Math.min(c, w) < 2) {
    if (errorRate >= 0.6) return { display: { kind: 'band', band: 'hard', label: 'Difícil para a turma' }, pitfallRate: null };
    if (errorRate <= 0.2) return { display: { kind: 'band', band: 'easy', label: 'Tranquila para a turma' }, pitfallRate: null };
    return { display: { kind: 'none' }, pitfallRate: null };
  }

  return { display: { kind: 'error_rate', errorRate: roundRate(errorRate) }, pitfallRate };
}

/**
 * Topic aggregate (§18.3): mean error rate over the topic's questions with n ≥ 5, shown only when
 * there are at least 3 such questions. Rounded to 5%.
 */
export function topicInsight(questions: readonly InsightAggregate[]): InsightDisplay {
  const eligible = questions.filter((q) => q.answerers >= 5);
  if (eligible.length < 3) return { kind: 'none' };
  const mean = eligible.reduce((s, q) => s + q.wrong / q.answerers, 0) / eligible.length;
  return { kind: 'error_rate', errorRate: roundRate(mean) };
}

// ---------- battle Realtime payloads (api §8.2, SOC-03.10) ----------
// Pure builders shared by the worker (battle.tick) and, as a copy, by the battle Edge Functions. Every
// payload is broadcast on the private channel `battle:{id}`. Lower leaderboard positions are never sent.

/** Distribution is shown only with at least this many answers (SOC-03.10). */
export const DISTRIBUTION_MIN_ANSWERS = 5;
/** Leaderboard length on the reveal screen (SOC-03.10). */
export const LEADERBOARD_SIZE = 5;
/** Podium length (spec 10 §8.3). */
export const PODIUM_SIZE = 3;

export type BattleStatusName = 'lobby' | 'question_open' | 'question_closed' | 'reveal' | 'podium' | 'ended' | 'cancelled';

export interface BattlePlayerScore {
  user_id: string;
  nickname: string;
  score: number;
}

export interface BattleLeaderboardEntry {
  user_id: string;
  nickname: string;
  score: number;
  rank: number;
}

export interface BattleRealtimeEvent {
  event: 'state' | 'reveal' | 'podium';
  payload: Record<string, unknown>;
}

/** Realtime topic of a battle (private channel, api §8.2). */
export function battleTopic(battleId: string): string {
  return `battle:${battleId}`;
}

/** Top `size` players with competition ranking (equal scores share a rank), best first. */
export function leaderboardTop(players: readonly BattlePlayerScore[], size: number = LEADERBOARD_SIZE): BattleLeaderboardEntry[] {
  const sorted = [...players].sort((a, b) =>
    b.score - a.score || a.nickname.localeCompare(b.nickname) || a.user_id.localeCompare(b.user_id),
  );
  const out: BattleLeaderboardEntry[] = [];
  let rank = 0;
  let previous: number | null = null;
  sorted.forEach((p, i) => {
    if (previous === null || p.score !== previous) rank = i + 1;
    previous = p.score;
    if (i < size) out.push({ user_id: p.user_id, nickname: p.nickname, score: p.score, rank });
  });
  return out;
}

/**
 * Share of each option among the answers, in whole percent. `null` when fewer than
 * DISTRIBUTION_MIN_ANSWERS players answered: the client then shows no distribution at all.
 * `choices` holds the chosen option id per player (null = no answer).
 */
export function battleDistributionOf(choices: readonly (string | null)[], optionIds: readonly string[]): Record<string, number> | null {
  const answered = choices.filter((c): c is string => c !== null);
  if (answered.length < DISTRIBUTION_MIN_ANSWERS) return null;
  const counts: Record<string, number> = {};
  for (const id of optionIds) counts[id] = 0;
  for (const c of answered) if (c in counts) counts[c] = (counts[c] ?? 0) + 1;
  const out: Record<string, number> = {};
  for (const id of optionIds) out[id] = Math.round(((counts[id] ?? 0) / answered.length) * 100);
  return out;
}

/** Choice id of a response in the practice shape `{choice}` (mcq_single). Null for anything else. */
export function battleChoiceOf(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const choice = (response as { choice?: unknown }).choice;
  return typeof choice === 'string' ? choice : null;
}

/** The question as players see it before the reveal: never the answer key, rationale or explanation. */
export function battlePublicQuestion(q: {
  id: string;
  type: string;
  stem: string;
  stimulus?: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const base: Record<string, unknown> = { id: q.id, type: q.type, stem: q.stem, stimulus: q.stimulus ?? null };
  if (q.type === 'mcq_single') {
    const options = (q.payload.options as Array<{ id: string; text: string }> | undefined) ?? [];
    base.payload = { options: options.map((o) => ({ id: o.id, text: o.text })) };
  } else if (q.type === 'true_false') {
    base.payload = { statement: q.payload.statement };
  } else {
    base.payload = null;
  }
  return base;
}

/** `state` (api §8.2): status and index, plus the question window when a question is open. */
export function battleStateEvent(args: {
  status: BattleStatusName;
  currentIndex: number;
  total: number;
  question?: Record<string, unknown> | null;
  opensAt?: Date | null;
  closesAt?: Date | null;
  players?: number;
}): BattleRealtimeEvent {
  const payload: Record<string, unknown> = { status: args.status, current_index: args.currentIndex, total: args.total };
  if (args.question) payload.question = args.question;
  if (args.opensAt) payload.opens_at = args.opensAt.toISOString();
  if (args.closesAt) payload.closes_at = args.closesAt.toISOString();
  if (args.players !== undefined) payload.players = args.players;
  return { event: 'state', payload };
}

/** `reveal` (api §8.2): correct response, optional explanation, distribution (null below 5 answers), top leaderboard. */
export function battleRevealEvent(args: {
  index: number;
  correctResponse: unknown;
  explanation?: string | null;
  distribution: Record<string, number> | null;
  leaderboard: BattleLeaderboardEntry[];
}): BattleRealtimeEvent {
  const payload: Record<string, unknown> = {
    index: args.index,
    correct_response: args.correctResponse,
    distribution: args.distribution,
    leaderboard: args.leaderboard,
  };
  if (args.explanation) payload.explanation = args.explanation;
  return { event: 'reveal', payload };
}

/** `podium` (api §8.2): the top standings after the last question or when the host ends the battle. */
export function battlePodiumEvent(leaderboard: BattleLeaderboardEntry[]): BattleRealtimeEvent {
  return { event: 'podium', payload: { leaderboard } };
}
