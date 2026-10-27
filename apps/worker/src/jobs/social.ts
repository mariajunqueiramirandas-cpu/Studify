// Social jobs (SOC-02, SOC-03, SOC-04; spec 10 §8.2–8.4): duel.expire, battle.tick, insights.recompute.
// Scoring and state rules are in lib/social.ts. Every transition is a conditional update, so a retried
// or duplicated job changes nothing twice (api.md §7 idempotency keys).
import { z } from 'zod';
import type { JobContext, JobDefinition } from '../framework/types.ts';
import { chunk, unwrap, unwrapRows, uniq, IN_CHUNK } from '../lib/db.ts';
import { aggregateInsights, battleStep, scoreBattleAnswer, type AnswerRow, type BattleAnswerFact } from '../lib/social.ts';

const DuelPayload = z.object({ duel_id: z.string().min(1) });
const BattlePayload = z.object({ battle_id: z.string().min(1), index: z.number().int().min(0) });
const InsightsPayload = z.object({ class_group_id: z.string().min(1).optional() });

/** Reveal length before the next question (spec 10 §8.3 "auto after 10 s"). */
export const REVEAL_MS = 10_000;
/** Podium length before the battle closes (spec 10 §8.3 "2 min"). */
export const PODIUM_MS = 120_000;
/** Timers may fire a little early on a busy queue. */
export const TOLERANCE_MS = 500;
/** Opening delay for the next question (SOC-03.5, opens_at 1.5 s in the future). */
export const OPEN_DELAY_MS = 1_500;
/** K-anonymity threshold for class insights (SOC-04.3). */
export const INSIGHT_K = 5;

export async function handleDuelExpire(ctx: JobContext, raw: Record<string, unknown>): Promise<{ status: string }> {
  const payload = DuelPayload.parse(raw);
  const duel = unwrap(
    await ctx.supabase.from('duels').select('id,status,expires_at').eq('id', payload.duel_id).maybeSingle(),
    'duels',
  ) as { id: string; status: string; expires_at: string } | null;
  if (!duel) return { status: 'not_found' };
  if (duel.status !== 'waiting_opponent') return { status: 'noop' };
  if (new Date(duel.expires_at).getTime() > ctx.now().getTime()) return { status: 'not_yet' };
  // Conditional update: only a duel still waiting expires. No penalty (SOC-02.10).
  const changed = unwrapRows<{ id: string }>(
    await ctx.supabase.from('duels').update({ status: 'expired' }).eq('id', duel.id).eq('status', 'waiting_opponent').select('id'),
    'duels',
  );
  return { status: changed.length > 0 ? 'expired' : 'noop' };
}

export interface BattleTickOutcome {
  status: 'noop' | 'closed' | 'advanced' | 'podium' | 'ended';
  scored?: number;
}

/**
 * battle.tick (SOC-03.4): drives the battle state machine for (battle_id, index). The status and
 * current_index in the WHERE clause make each transition happen once; a stale tick is a no-op.
 */
export async function handleBattleTick(ctx: JobContext, raw: Record<string, unknown>): Promise<BattleTickOutcome> {
  const payload = BattlePayload.parse(raw);
  const battle = unwrap(
    await ctx.supabase
      .from('battles')
      .select('id,class_group_id,quiz_id,status,current_index,question_opens_at,question_closes_at,seconds_per_question')
      .eq('id', payload.battle_id)
      .maybeSingle(),
    'battles',
  ) as {
    id: string;
    class_group_id: string;
    quiz_id: string;
    status: string;
    current_index: number;
    question_opens_at: string | null;
    question_closes_at: string | null;
    seconds_per_question: number;
  } | null;
  if (!battle) return { status: 'noop' };
  const quiz = unwrap(await ctx.supabase.from('quizzes').select('question_ids').eq('id', battle.quiz_id).maybeSingle(), 'quizzes') as
    | { question_ids: string[] }
    | null;
  const questionIds = quiz?.question_ids ?? [];
  const step = battleStep(battle, payload.index, questionIds.length);
  const now = ctx.now();

  if (step.kind === 'noop') return { status: 'noop' };
  // A duplicate tick must not skip the reveal or the podium: advance/podium wait for the reveal window,
  // end waits for the podium window (both measured from the question's scheduled close).
  const closesMs = battle.question_closes_at ? Date.parse(battle.question_closes_at) : NaN;
  const elapsed = now.getTime() - closesMs;
  if ((step.kind === 'advance' || step.kind === 'podium') && !(elapsed >= REVEAL_MS - TOLERANCE_MS)) return { status: 'noop' };
  if (step.kind === 'end' && !(elapsed >= REVEAL_MS + PODIUM_MS - TOLERANCE_MS)) return { status: 'noop' };
  if (step.kind === 'close') {
    const claimed = unwrapRows<{ id: string }>(
      await ctx.supabase.from('battles').update({ status: 'question_reveal' }).eq('id', battle.id).eq('status', 'question_open').eq('current_index', payload.index).select('id'),
      'battles',
    );
    if (claimed.length === 0) return { status: 'noop' };
    const scored = await scoreQuestion(ctx, battle, questionIds[payload.index] ?? '');
    await ctx.enqueue('battle.tick', { battle_id: battle.id, index: payload.index }, {
      singletonKey: `battle.tick:${battle.id}:${payload.index}:reveal`,
      startAfter: new Date(now.getTime() + REVEAL_MS),
    });
    return { status: 'closed', scored };
  }
  if (step.kind === 'advance') {
    const opens = new Date(now.getTime() + OPEN_DELAY_MS);
    const closes = new Date(opens.getTime() + battle.seconds_per_question * 1000);
    const moved = unwrapRows<{ id: string }>(
      await ctx.supabase
        .from('battles')
        .update({ status: 'question_open', current_index: step.nextIndex, question_opens_at: opens.toISOString(), question_closes_at: closes.toISOString() })
        .eq('id', battle.id)
        .eq('status', 'question_reveal')
        .eq('current_index', payload.index)
        .select('id'),
      'battles',
    );
    if (moved.length === 0) return { status: 'noop' };
    await ctx.enqueue('battle.tick', { battle_id: battle.id, index: step.nextIndex }, {
      singletonKey: `battle.tick:${battle.id}:${step.nextIndex}:close`,
      startAfter: closes,
    });
    return { status: 'advanced' };
  }
  if (step.kind === 'podium') {
    const moved = unwrapRows<{ id: string }>(
      await ctx.supabase.from('battles').update({ status: 'podium' }).eq('id', battle.id).eq('status', 'question_reveal').eq('current_index', payload.index).select('id'),
      'battles',
    );
    if (moved.length === 0) return { status: 'noop' };
    await ctx.enqueue('battle.tick', { battle_id: battle.id, index: payload.index }, {
      singletonKey: `battle.tick:${battle.id}:${payload.index}:podium`,
      startAfter: new Date(now.getTime() + PODIUM_MS),
    });
    return { status: 'podium' };
  }
  // end
  const ended = unwrapRows<{ id: string }>(
    await ctx.supabase.from('battles').update({ status: 'ended', ended_at: now.toISOString() }).eq('id', battle.id).eq('status', 'podium').eq('current_index', payload.index).select('id'),
    'battles',
  );
  if (ended.length === 0) return { status: 'noop' };
  await ctx.enqueue('insights.recompute', { class_group_id: battle.class_group_id }, { singletonKey: `insights:${battle.class_group_id}` });
  return { status: 'ended' };
}

/** Scores every player's answer to the question (SOC-03.6) and writes the new totals and streaks. */
async function scoreQuestion(
  ctx: JobContext,
  battle: { id: string; question_opens_at: string | null; question_closes_at: string | null; seconds_per_question: number },
  questionId: string,
): Promise<number> {
  const players = unwrapRows<{ user_id: string; score: number; answer_streak: number; quiz_attempt_id: string | null }>(
    await ctx.supabase.from('battle_players').select('user_id,score,answer_streak,quiz_attempt_id').eq('battle_id', battle.id),
    'battle_players',
  );
  if (!battle.question_opens_at || !battle.question_closes_at || !questionId) return 0;
  const attemptIds = players.map((p) => p.quiz_attempt_id).filter((id): id is string => id !== null);
  const answers = new Map<string, BattleAnswerFact>();
  for (const part of chunk(attemptIds, IN_CHUNK)) {
    for (const a of unwrapRows<{ attempt_id: string; correct: boolean | null; answered_at: string }>(
      await ctx.supabase.from('attempt_answers').select('attempt_id,correct,answered_at').eq('question_id', questionId).in('attempt_id', part),
      'attempt_answers',
    )) {
      answers.set(a.attempt_id, { correct: a.correct === true, receivedAtMs: Date.parse(a.answered_at) });
    }
  }
  const opensMs = Date.parse(battle.question_opens_at);
  const closesMs = Date.parse(battle.question_closes_at);
  for (const p of players) {
    const answer = p.quiz_attempt_id ? (answers.get(p.quiz_attempt_id) ?? null) : null;
    const result = scoreBattleAnswer(answer, p.answer_streak, opensMs, closesMs, battle.seconds_per_question);
    unwrap(
      await ctx.supabase.from('battle_players').update({ score: p.score + result.points, answer_streak: result.nextStreak }).eq('battle_id', battle.id).eq('user_id', p.user_id),
      'battle_players',
    );
  }
  return players.length;
}

/**
 * insights.recompute (SOC-04): first answers of contributing members, grouped per question, written to
 * private.class_insights. Questions with fewer than 5 answerers get no row (k-anonymity, §18.3).
 */
export async function handleInsightsRecompute(ctx: JobContext, raw: Record<string, unknown>): Promise<{ classes: number; questions: number }> {
  const payload = InsightsPayload.parse(raw);
  if (!payload.class_group_id) {
    const groups = unwrapRows<{ id: string }>(await ctx.supabase.from('class_groups').select('id').is('deleted_at', null), 'class_groups');
    for (const g of groups) await ctx.enqueue('insights.recompute', { class_group_id: g.id }, { singletonKey: `insights:${g.id}` });
    return { classes: groups.length, questions: 0 };
  }
  const classId = payload.class_group_id;
  const members = unwrapRows<{ user_id: string; contribute_insights: boolean }>(
    await ctx.supabase.from('class_group_members').select('user_id,contribute_insights').eq('class_group_id', classId).eq('status', 'active'),
    'class_group_members',
  );
  const optedOut = new Set(members.filter((m) => !m.contribute_insights).map((m) => m.user_id));
  const memberIds = members.map((m) => m.user_id);
  const subjects = unwrapRows<{ id: string }>(await ctx.supabase.from('subjects').select('id').eq('owner_class_group_id', classId).is('deleted_at', null), 'subjects');
  const questions: Array<{ id: string; node_id: string }> = [];
  for (const part of chunk(subjects.map((s) => s.id), IN_CHUNK)) {
    questions.push(...unwrapRows(await ctx.supabase.from('questions').select('id,node_id').in('subject_id', part).is('deleted_at', null), 'questions'));
  }
  const nodeOf = new Map(questions.map((q) => [q.id, q.node_id] as const));
  const rows: AnswerRow[] = [];
  for (const part of chunk(uniq(questions.map((q) => q.id)), IN_CHUNK)) {
    for (const memberChunk of chunk(memberIds, IN_CHUNK)) {
      rows.push(
        ...unwrapRows<AnswerRow>(
          await ctx.supabase.from('attempt_answers').select('user_id,question_id,correct,response,answered_at').in('question_id', part).in('user_id', memberChunk).not('correct', 'is', null),
          'attempt_answers',
        ),
      );
    }
  }
  const aggregates = aggregateInsights(rows, optedOut, INSIGHT_K);
  await ctx.db.query('delete from private.class_insights where class_group_id = $1', [classId]);
  for (const agg of aggregates) {
    await ctx.db.query(
      'insert into private.class_insights (class_group_id, question_id, node_id, n_answered, n_wrong, option_counts, computed_at) values ($1, $2, $3, $4, $5, $6, $7)',
      [classId, agg.questionId, nodeOf.get(agg.questionId) ?? null, agg.answerers, agg.wrong, JSON.stringify(agg.optionCounts), ctx.now().toISOString()],
    );
  }
  return { classes: 1, questions: aggregates.length };
}

export const jobs: JobDefinition[] = [
  { name: 'duel.expire', retryLimit: 3, handler: async (ctx, data) => void (await handleDuelExpire(ctx, data)) },
  { name: 'battle.tick', retryLimit: 3, handler: async (ctx, data) => void (await handleBattleTick(ctx, data)) },
  { name: 'insights.recompute', retryLimit: 2, schedule: '0 6 * * *', handler: async (ctx, data) => void (await handleInsightsRecompute(ctx, data)) },
];
