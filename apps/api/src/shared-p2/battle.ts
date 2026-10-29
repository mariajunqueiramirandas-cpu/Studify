// Battle state, PIN, and Realtime payloads (SOC-03, spec 10 §8.3). Status values and event shapes follow
// the battle screen contract: broadcast on `battle:{id}` with events `state`, `reveal` and `podium`.
import type { Db } from '@studify/db';
import { SOCIAL } from '@studify/shared';
import { padDigits } from './util.ts';

export const BATTLE_STATUSES = [
  'lobby',
  'question_open',
  'question_closed',
  'reveal',
  'podium',
  'ended',
  'cancelled',
] as const;
export type BattleStatus = (typeof BATTLE_STATUSES)[number];
export const LIVE_BATTLE_STATUSES: readonly BattleStatus[] = [
  'lobby',
  'question_open',
  'question_closed',
  'reveal',
  'podium',
];

/** Players may join until question 3 opens (SOC-03.7): current_index 0 and 1 are joinable. */
export const LATE_JOIN_MAX_INDEX = 2;
export const MAX_BATTLE_PLAYERS = 60;
/** opens_at is set this far in the future so clients render together (spec 10 §8.3). */
export const OPEN_LEAD_MS = 1_500;
/** Answers after closes_at + grace are rejected (SOC-03.5, SOCIAL.battleClosesGraceMs). */
export const BATTLE_GRACE_MS = SOCIAL.battleClosesGraceMs;
/** Distribution is shown only with at least this many answers (SOC-03.10). */
export const DISTRIBUTION_MIN_ANSWERS = 5;
export const LEADERBOARD_SIZE = 5;

export interface BattleRow {
  id: string;
  class_group_id: string;
  host_id: string;
  quiz_id: string;
  pin: string;
  status: BattleStatus;
  current_index: number;
  question_opens_at: string | null;
  question_closes_at: string | null;
  seconds_per_question: number;
}

const BATTLE_COLUMNS =
  'id, class_group_id, host_id, quiz_id, pin, status, current_index, question_opens_at, question_closes_at, seconds_per_question';

export async function loadBattle(db: Db, battleId: string): Promise<BattleRow | null> {
  const { data, error } = await db.from('battles').select(BATTLE_COLUMNS).eq('id', battleId).maybeSingle();
  if (error) throw error;
  return (data as BattleRow | null) ?? null;
}

// ---------- PIN (SOC-03.2) ----------

/** A 4-digit PIN "0000".."9999". `randomInt` is injected so tests can force collisions. */
export function generatePin(randomInt: (maxExclusive: number) => number): string {
  return padDigits(randomInt(10_000), 4);
}

/** Draws PINs until `isTaken` is false. Gives up after `attempts` (the caller maps that to a server error). */
export async function pickFreePin(
  randomInt: (maxExclusive: number) => number,
  isTaken: (pin: string) => Promise<boolean>,
  attempts = 50,
): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const pin = generatePin(randomInt);
    if (!(await isTaken(pin))) return pin;
  }
  return null;
}

/** True when a PIN is held by a battle that is still live (the uniqueness rule of data-model §5.7). */
export async function pinIsLive(db: Db, pin: string): Promise<boolean> {
  const { data, error } = await db.from('battles').select('id').eq('pin', pin).in('status', [...LIVE_BATTLE_STATUSES])
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

// ---------- Timing (SOC-03.4, §8.3) ----------

export function questionWindow(now: Date, secondsPerQuestion: number): { opensAt: Date; closesAt: Date } {
  const opensAt = new Date(now.getTime() + OPEN_LEAD_MS);
  return { opensAt, closesAt: new Date(opensAt.getTime() + secondsPerQuestion * 1000) };
}

/** Server-only acceptance: open window, same question index, and no later than closes_at + grace. */
export function isAnswerAccepted(args: {
  status: BattleStatus;
  currentIndex: number;
  questionIndex: number;
  opensAtMs: number | null;
  closesAtMs: number | null;
  receivedMs: number;
}): boolean {
  if (args.status !== 'question_open') return false;
  if (args.currentIndex !== args.questionIndex) return false;
  if (args.opensAtMs === null || args.closesAtMs === null) return false;
  if (args.receivedMs < args.opensAtMs) return false;
  return args.receivedMs <= args.closesAtMs + BATTLE_GRACE_MS;
}

/** Joining is allowed in the lobby, or while question index 0 or 1 is current (SOC-03.7). */
export function canJoinNow(battle: Pick<BattleRow, 'status' | 'current_index'>): boolean {
  if (battle.status === 'lobby') return true;
  return battle.status !== 'podium' && battle.status !== 'ended' && battle.status !== 'cancelled' &&
    battle.current_index < LATE_JOIN_MAX_INDEX;
}

// ---------- Realtime payloads (coordinator contract) ----------

export interface LeaderboardEntry {
  user_id: string;
  nickname: string;
  score: number;
  rank: number;
}

export interface PlayerScore {
  user_id: string;
  nickname: string;
  score: number;
}

/** Top `size` players with competition ranking (equal scores share a rank). Lower positions are never sent (SOC-03.10). */
export function leaderboardTop(players: readonly PlayerScore[], size = LEADERBOARD_SIZE): LeaderboardEntry[] {
  const sorted = [...players].sort((a, b) =>
    b.score - a.score || a.nickname.localeCompare(b.nickname) || a.user_id.localeCompare(b.user_id)
  );
  const out: LeaderboardEntry[] = [];
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
 * Answer distribution per option, as percentages (SOC-03.10). `null` when fewer than
 * DISTRIBUTION_MIN_ANSWERS players answered: the client then shows no distribution at all.
 */
export function distributionOf(
  choices: readonly (string | null)[],
  optionIds: readonly string[],
): Record<string, number> | null {
  const answered = choices.filter((c): c is string => c !== null);
  if (answered.length < DISTRIBUTION_MIN_ANSWERS) return null;
  const out: Record<string, number> = {};
  for (const id of optionIds) out[id] = 0;
  for (const c of answered) if (c in out) out[c] = (out[c] ?? 0) + 1;
  for (const id of optionIds) out[id] = Math.round(((out[id] ?? 0) / answered.length) * 100);
  return out;
}

export function stateEvent(args: {
  status: BattleStatus;
  currentIndex: number;
  total: number;
  question?: Record<string, unknown> | null;
  opensAt?: Date | null;
  closesAt?: Date | null;
  players?: number;
}): { event: 'state'; payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = { status: args.status, current_index: args.currentIndex, total: args.total };
  if (args.question) payload.question = args.question;
  if (args.opensAt) payload.opens_at = args.opensAt.toISOString();
  if (args.closesAt) payload.closes_at = args.closesAt.toISOString();
  if (args.players !== undefined) payload.players = args.players;
  return { event: 'state', payload };
}

export function revealEvent(args: {
  index: number;
  correctResponse: unknown;
  explanation?: string | null;
  distribution: Record<string, number> | null;
  leaderboard: LeaderboardEntry[];
}): { event: 'reveal'; payload: Record<string, unknown> } {
  const payload: Record<string, unknown> = {
    index: args.index,
    correct_response: args.correctResponse,
    distribution: args.distribution,
    leaderboard: args.leaderboard,
  };
  if (args.explanation) payload.explanation = args.explanation;
  return { event: 'reveal', payload };
}

export function podiumEvent(leaderboard: LeaderboardEntry[]): { event: 'podium'; payload: Record<string, unknown> } {
  return { event: 'podium', payload: { leaderboard } };
}

/** Choice id of a response in the practice shape `{choice}` (mcq_single). Null for anything else. */
export function choiceOf(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const choice = (response as { choice?: unknown }).choice;
  return typeof choice === 'string' ? choice : null;
}

export function battleTopic(battleId: string): string {
  return `battle:${battleId}`;
}
