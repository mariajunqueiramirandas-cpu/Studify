// Battle transitions executed by Edge Functions (spec 10 §8.3): open a question, broadcast state, read the
// roster. Each transition is a conditional update, so a host action and a battle.tick cannot both apply.
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiFailure } from '@studify/shared';
import type { P2Deps } from './deps.ts';
import { scheduleAt } from './jobs.ts';
import { loadQuestion, publicQuestion, type QuestionRow } from './questions.ts';
import { loadQuiz } from './duel.ts';
import {
  type BattleRow,
  type BattleStatus,
  battleTopic,
  leaderboardTop,
  type PlayerScore,
  podiumEvent,
  questionWindow,
  stateEvent,
} from './battle.ts';

export async function rosterOf(db: SupabaseClient, battleId: string): Promise<PlayerScore[]> {
  const { data, error } = await db.from('battle_players').select('user_id, nickname, score').eq('battle_id', battleId);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    user_id: r.user_id as string,
    nickname: r.nickname as string,
    score: Number(r.score ?? 0),
  }));
}

export async function broadcastState(
  deps: P2Deps,
  battleId: string,
  event: { event: string; payload: Record<string, unknown> },
): Promise<void> {
  await deps.broadcast([{ topic: battleTopic(battleId), event: event.event, payload: event.payload, private: true }]);
}

/**
 * Opens question `index`: sets the window, schedules battle.tick at closes_at and broadcasts `state`.
 * `from` is the status and index the transition expects; anything else is a lost race (409-style).
 */
export async function openQuestion(args: {
  deps: P2Deps;
  battle: BattleRow;
  index: number;
  total: number;
  from: { status: BattleStatus; index: number };
  now: Date;
}): Promise<{ opensAt: Date; closesAt: Date; question: QuestionRow }> {
  const { deps, battle, index, from } = args;
  const db = deps.db;
  const quiz = await loadQuiz(db, battle.quiz_id);
  const questionId = quiz?.question_ids[index];
  const question = questionId ? await loadQuestion(db, questionId) : null;
  if (!question) throw new ApiFailure('internal_error');
  const { opensAt, closesAt } = questionWindow(args.now, battle.seconds_per_question);
  const updated = await db
    .from('battles')
    .update({
      status: 'question_open',
      current_index: index,
      question_opens_at: opensAt.toISOString(),
      question_closes_at: closesAt.toISOString(),
    })
    .eq('id', battle.id)
    .eq('status', from.status)
    .eq('current_index', from.index)
    .select('id');
  if (updated.error) throw updated.error;
  if (!updated.data || updated.data.length === 0) {
    throw new ApiFailure('invalid_request', { message: 'A batalha mudou. Atualiza a tela.' });
  }

  await scheduleAt(deps, 'battle.tick', { battle_id: battle.id, index }, closesAt, `battle-tick:${battle.id}:${index}`);
  const players = (await rosterOf(db, battle.id)).length;
  await broadcastState(
    deps,
    battle.id,
    stateEvent({
      status: 'question_open',
      currentIndex: index,
      total: args.total,
      question: publicQuestion(question),
      opensAt,
      closesAt,
      players,
    }),
  );
  return { opensAt, closesAt, question };
}

/** Podium: the top 3 standings are sent as `podium` (spec 10 §8.3). Used when the last reveal is done or the host ends. */
export async function broadcastPodium(
  deps: P2Deps,
  battleId: string,
  status: BattleStatus,
  index: number,
  total: number,
): Promise<void> {
  const board = leaderboardTop(await rosterOf(deps.db, battleId), 3);
  await broadcastState(deps, battleId, stateEvent({ status, currentIndex: index, total }));
  await broadcastState(deps, battleId, podiumEvent(board));
}
