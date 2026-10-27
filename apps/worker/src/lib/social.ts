// Social scoring and state transitions (SOC-02, SOC-03, SOC-04; learning-engine §18). Pure: the jobs
// read rows, call these, and write the results. Times are server clock values in milliseconds.
import { battlePoints, classInsightDisplay, isBattleAnswerRejected, type InsightAggregate } from '@studify/shared';


/**
 * What battle.tick does for (battle, index). Idempotent: a tick for an index the battle has already
 * left (or a status it is no longer in) is a no-op (api.md §7, battle.tick key).
 */
export type BattleStep = { kind: 'close' } | { kind: 'advance'; nextIndex: number } | { kind: 'podium' } | { kind: 'end' } | { kind: 'noop' };

export function battleStep(battle: { status: string; current_index: number }, index: number, questionCount: number): BattleStep {
  if (battle.current_index !== index) return { kind: 'noop' };
  if (battle.status === 'question_open') return { kind: 'close' };
  if (battle.status === 'question_reveal') {
    return index + 1 < questionCount ? { kind: 'advance', nextIndex: index + 1 } : { kind: 'podium' };
  }
  if (battle.status === 'podium') return { kind: 'end' };
  return { kind: 'noop' };
}

export interface BattleAnswerFact {
  correct: boolean;
  receivedAtMs: number | null;
}

export interface BattleScoreResult {
  points: number;
  nextStreak: number;
  timedOut: boolean;
}

/**
 * Score for one player on one question (§18.2). `opensAtMs` is the server time the question opened;
 * answers after closes_at + 1 s are rejected (score 0, streak reset). The streak counts this answer.
 */
export function scoreBattleAnswer(
  answer: BattleAnswerFact | null,
  priorStreak: number,
  opensAtMs: number,
  closesAtMs: number,
  secondsPerQuestion: number,
): BattleScoreResult {
  if (!answer || answer.receivedAtMs === null || isBattleAnswerRejected(answer.receivedAtMs, closesAtMs)) {
    return { points: 0, nextStreak: 0, timedOut: true };
  }
  const elapsed = (answer.receivedAtMs - opensAtMs) / 1000 - 0.5;
  if (!answer.correct) return { points: 0, nextStreak: 0, timedOut: false };
  const nextStreak = priorStreak + 1;
  return { points: battlePoints(true, elapsed, secondsPerQuestion, nextStreak), nextStreak, timedOut: false };
}


export interface AnswerRow {
  user_id: string;
  question_id: string;
  correct: boolean | null;
  response: unknown;
  answered_at: string;
}

export interface QuestionAggregate {
  questionId: string;
  answerers: number;
  wrong: number;
  /** Count of each option chosen by the members, keyed by choice id (wrong answers only, for the pitfall). */
  optionCounts: Record<string, number>;
  topWrongOptionCount: number;
}

/**
 * First answer of each contributing member per question (SOC-04.2). Opted-out members are dropped
 * before counting, so they never change n (SOC-04.6). Returns only questions with n ≥ minAnswerers.
 */
export function aggregateInsights(rows: readonly AnswerRow[], optedOut: ReadonlySet<string>, minAnswerers: number): QuestionAggregate[] {
  const firstByKey = new Map<string, AnswerRow>();
  for (const row of rows) {
    if (optedOut.has(row.user_id) || row.correct === null) continue;
    const key = `${row.user_id}|${row.question_id}`;
    const current = firstByKey.get(key);
    if (!current || row.answered_at < current.answered_at) firstByKey.set(key, row);
  }
  const byQuestion = new Map<string, AnswerRow[]>();
  for (const row of firstByKey.values()) {
    const list = byQuestion.get(row.question_id) ?? [];
    list.push(row);
    byQuestion.set(row.question_id, list);
  }
  const out: QuestionAggregate[] = [];
  for (const [questionId, list] of byQuestion) {
    if (list.length < minAnswerers) continue;
    const optionCounts: Record<string, number> = {};
    let wrong = 0;
    for (const row of list) {
      if (row.correct) continue;
      wrong++;
      const choice = choiceOf(row.response);
      if (choice) optionCounts[choice] = (optionCounts[choice] ?? 0) + 1;
    }
    out.push({
      questionId,
      answerers: list.length,
      wrong,
      optionCounts,
      topWrongOptionCount: Math.max(0, ...Object.values(optionCounts)),
    });
  }
  return out.sort((a, b) => (a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0));
}

function choiceOf(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  return typeof r.choice === 'string' ? r.choice : null;
}

/** The display rules of §18.3 for one aggregate (mirrors the SQL RPC; used in tests and the job's log). */
export function insightDisplayOf(agg: QuestionAggregate): ReturnType<typeof classInsightDisplay> {
  const input: InsightAggregate = { answerers: agg.answerers, wrong: agg.wrong, topWrongOptionCount: agg.topWrongOptionCount };
  return classInsightDisplay(input);
}
