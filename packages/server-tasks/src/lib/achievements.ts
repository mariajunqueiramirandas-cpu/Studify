// Achievements (MOT-01.8, spec 13 §8.5). The catalog and the unlock rules are pure and live in @studify/shared;
// this file measures the metrics from the tables and writes achievements rows. Called from the motivation
// jobs (xp.award and streaks.rollover), so it runs after every event that can change a metric.
import { achievementProgress, bestWeekGoalDays, calibration, type AchievementMetrics, type Confidence, type RatedAnswer } from '@studify/shared';
import type { OperationContext } from '../framework/types.ts';
import { IN_CHUNK, chunk, unwrap, unwrapRows, uniq } from './db.ts';
import { addDays, localDateOf, safeTimeZone } from './time.ts';

/** Caps keep each count query small: the catalog only needs to know whether a threshold is reached. */
const CAP = { reviews: 1000, questions: 500, mistakes: 20, documents: 1, mocks: 1, duels: 10, rematches: 1, reports: 3 } as const;

/** Reads every computable metric for one user (table names in the catalog comments of @studify/shared). */
export async function loadAchievementMetrics(ctx: OperationContext, userId: string): Promise<AchievementMetrics> {
  const sb = ctx.supabase;
  const tz = safeTimeZone(
    (unwrap(await sb.from('profiles').select('timezone').eq('id', userId).maybeSingle(), 'profiles') as { timezone: string | null } | null)?.timezone,
  );

  const documents = unwrapRows(await sb.from('documents').select('id').eq('uploaded_by', userId).is('deleted_at', null).limit(CAP.documents), 'documents').length;
  const reviews = unwrapRows(await sb.from('review_logs').select('id').eq('user_id', userId).limit(CAP.reviews), 'review_logs').length;
  const questions = unwrapRows(await sb.from('attempt_answers').select('id').eq('user_id', userId).is('deleted_at', null).limit(CAP.questions), 'attempt_answers').length;
  const streak = unwrap(await sb.from('streaks').select('longest_length').eq('user_id', userId).maybeSingle(), 'streaks') as { longest_length: number } | null;
  const mistakesResolved = unwrapRows(
    await sb.from('mistakes').select('id').eq('user_id', userId).not('resolved_at', 'is', null).is('deleted_at', null).limit(CAP.mistakes),
    'mistakes',
  ).length;
  const errorReportsAccepted = unwrapRows(await sb.from('content_flags').select('id').eq('reporter_id', userId).eq('status', 'accepted').limit(CAP.reports), 'content_flags').length;

  // Mock exams: submitted attempts of quizzes of kind mock_exam or enem_simulado owned by the user.
  const mockQuizIds = unwrapRows<{ id: string }>(
    await sb.from('quizzes').select('id').eq('owner_id', userId).in('kind', ['mock_exam', 'enem_simulado']).is('deleted_at', null),
    'quizzes',
  ).map((q) => q.id);
  let mockExams = 0;
  for (const part of chunk(mockQuizIds, IN_CHUNK)) {
    mockExams += unwrapRows(
      await sb.from('quiz_attempts').select('id').eq('user_id', userId).eq('status', 'submitted').in('quiz_id', part).limit(CAP.mocks),
      'quiz_attempts',
    ).length;
    if (mockExams >= CAP.mocks) break;
  }

  // Duels finished in either seat (challenger or opponent). Ids are unioned because a duel is listed once per seat.
  const duelIds = new Set<string>();
  for (const column of ['challenger_id', 'opponent_id'] as const) {
    for (const row of unwrapRows<{ id: string }>(
      await sb.from('duels').select('id').eq(column, userId).eq('status', 'finished').limit(CAP.duels),
      'duels',
    )) duelIds.add(row.id);
  }
  const rematchWins = unwrapRows(await sb.from('duels').select('id').eq('winner_id', userId).not('rematch_of', 'is', null).limit(CAP.rematches), 'duels').length;

  // Calibration (PRA-05): the last 50 rated answers, read with the question shape the score needs.
  const rated = unwrapRows<{ question_id: string; confidence: number; correct: boolean; answered_at: string }>(
    await sb
      .from('attempt_answers')
      .select('question_id,confidence,correct,answered_at')
      .eq('user_id', userId)
      .not('confidence', 'is', null)
      .not('correct', 'is', null)
      .order('answered_at', { ascending: false })
      .limit(50),
    'attempt_answers',
  );
  const shapes = new Map<string, { type: string; payload: Record<string, unknown> }>();
  for (const part of chunk(uniq(rated.map((r) => r.question_id)), IN_CHUNK)) {
    for (const q of unwrapRows<{ id: string; type: string; payload: Record<string, unknown> }>(
      await sb.from('questions').select('id,type,payload').in('id', part),
      'questions',
    )) shapes.set(q.id, { type: q.type, payload: q.payload });
  }
  const ratedAnswers: RatedAnswer[] = rated.flatMap((r) => {
    const shape = shapes.get(r.question_id);
    if (!shape) return [];
    const options = Array.isArray(shape.payload.options) ? shape.payload.options.length : 4;
    return [
      {
        bucketId: 'all',
        confidence: r.confidence as Confidence,
        score: r.correct ? 1 : 0,
        numOptions: options,
        trueFalse: shape.type === 'true_false',
        answeredAt: new Date(r.answered_at),
      },
    ];
  });
  const calibrated = ratedAnswers.length >= 50 && calibration(ratedAnswers, tz).calibrated;

  // Consistent week (MOT-01): days with the goal met, in the last five weeks, grouped by study week.
  const since = addDays(localDateOf(ctx.now(), tz), -35);
  const goalDays = unwrapRows<{ local_date: string; goal_met: boolean }>(
    await sb.from('daily_activity').select('local_date,goal_met').eq('user_id', userId).eq('goal_met', true).gte('local_date', since).limit(400),
    'daily_activity',
  ).map((d) => ({ day: d.local_date, goalMet: d.goal_met }));

  // Phase 5 achievements (spec 13 §8.5 "Later").
  const bosses = unwrapRows<{ unit_node_id: string }>(
    await sb.from('boss_attempts').select('unit_node_id').eq('user_id', userId).eq('passed', true).limit(50),
    'boss_attempts',
  );
  const lucas = unwrapRows<{ score: number | null }>(
    await sb.from('teaching_sessions').select('score').eq('user_id', userId).not('score', 'is', null).order('score', { ascending: false }).limit(1),
    'teaching_sessions',
  );
  const debates = unwrapRows(await sb.from('argument_sessions').select('id').eq('user_id', userId).eq('status', 'finished').limit(5), 'argument_sessions').length;
  const contributions = unwrapRows(await sb.from('contributions').select('id').eq('author_id', userId).eq('status', 'approved').limit(10), 'contributions').length;
  const peerQuestions = unwrapRows(
    await sb.from('questions').select('id').eq('author_id', userId).eq('origin', 'peer').eq('review_status', 'approved').is('deleted_at', null).limit(10),
    'questions',
  ).length;
  const focus = unwrapRows<{ cycles_done: number | null }>(
    await sb.from('study_sessions').select('cycles_done').eq('user_id', userId).eq('kind', 'focus').limit(200),
    'study_sessions',
  );

  return {
    documents,
    reviews,
    longestStreak: Number(streak?.longest_length ?? 0),
    questions,
    mockExams,
    mistakesResolved,
    calibrated,
    duelsFinished: duelIds.size,
    rematchWins,
    errorReportsAccepted,
    bestWeekGoalDays: bestWeekGoalDays(goalDays),
    bossesDefeated: new Set(bosses.map((b) => b.unit_node_id)).size,
    bestLucasScore: Number(lucas[0]?.score ?? 0),
    debatesFinished: debates,
    turmaContributions: contributions + peerQuestions,
    focusCycles: focus.reduce((s, f) => s + Number(f.cycles_done ?? 0), 0),
  };
}

/**
 * Writes the progress of every computable achievement and unlocks the ones whose threshold is reached.
 * An unlocked row is never rewritten (its unlocked_at stays), so the unlock time is the first time it was met.
 * Returns the codes unlocked by this call.
 */
export async function syncAchievements(ctx: OperationContext, userId: string): Promise<{ unlocked: string[] }> {
  const metrics = await loadAchievementMetrics(ctx, userId);
  const progress = achievementProgress(metrics).filter((p) => p.computable);
  const existing = unwrapRows<{ code: string; unlocked_at: string | null }>(
    await ctx.supabase.from('achievements').select('code,unlocked_at').eq('user_id', userId),
    'achievements',
  );
  const done = new Set(existing.filter((r) => r.unlocked_at !== null).map((r) => r.code));
  const now = ctx.now().toISOString();
  const rows = progress
    .filter((p) => !done.has(p.code))
    .map((p) => ({ user_id: userId, code: p.code, progress: p.progress, unlocked_at: p.unlocked ? now : null, updated_at: now }));
  if (rows.length > 0) {
    unwrap(await ctx.supabase.from('achievements').upsert(rows, { onConflict: 'user_id,code' }), 'achievements');
  }
  const unlocked = progress.filter((p) => p.unlocked && !done.has(p.code)).map((p) => p.code);
  if (unlocked.length > 0) ctx.log.info({ unlocked }, 'achievements unlocked');
  return { unlocked };
}
