import { describe, expect, it } from 'vitest';
import {
  activeMinutesByStudyDay,
  autoRestDays,
  evaluateStreak,
  initialStreakState,
  levelFor,
  levelThreshold,
  xpFor,
  type DailyActivity,
} from '../../src/learning/index.ts';
import { studyDay } from '../../src/learning/time.ts';

const ctx = { dailyGoalXpAwarded: false, noteXpToday: 0, podcastsToday: 0 };

describe('XP table (§17.1, spec 13 §8.1)', () => {
  it('reviews: 1 XP for any rating, none inside the 10-minute cooldown', () => {
    expect(xpFor({ kind: 'card_reviewed' }, ctx)).toBe(1);
    expect(xpFor({ kind: 'card_reviewed', sameCardWithinCooldown: true }, ctx)).toBe(0);
  });

  it('questions: 2 for the first attempt of the day, +1 when correct; later attempts earn nothing', () => {
    expect(xpFor({ kind: 'question_answered', firstAttemptToday: true, correct: true }, ctx)).toBe(3);
    expect(xpFor({ kind: 'question_answered', firstAttemptToday: true, correct: false }, ctx)).toBe(2);
    expect(xpFor({ kind: 'question_answered', firstAttemptToday: false, correct: true }, ctx)).toBe(0);
  });

  it('quizzes need five questions; simulados give 20 plus one per question', () => {
    expect(xpFor({ kind: 'quiz_completed', questionCount: 4 }, ctx)).toBe(0);
    expect(xpFor({ kind: 'quiz_completed', questionCount: 5 }, ctx)).toBe(5);
    expect(xpFor({ kind: 'simulado_completed', questionCount: 10 }, ctx)).toBe(30);
  });

  it('bosses: 50 the first time, 10 on retries', () => {
    expect(xpFor({ kind: 'boss_defeated', retry: false }, ctx)).toBe(50);
    expect(xpFor({ kind: 'boss_defeated', retry: true }, ctx)).toBe(10);
  });

  it('daily goal once per day; note reading capped at 20 XP per day; podcasts at 3 per day', () => {
    expect(xpFor({ kind: 'daily_goal_met' }, ctx)).toBe(10);
    expect(xpFor({ kind: 'daily_goal_met' }, { ...ctx, dailyGoalXpAwarded: true })).toBe(0);
    expect(xpFor({ kind: 'note_section_read' }, { ...ctx, noteXpToday: 19 })).toBe(1);
    expect(xpFor({ kind: 'note_section_read' }, { ...ctx, noteXpToday: 20 })).toBe(0);
    expect(xpFor({ kind: 'podcast_completed' }, { ...ctx, podcastsToday: 3 })).toBe(0);
  });

  it('Lucas, duels and battles', () => {
    expect(xpFor({ kind: 'lucas_finished', score: 85 }, ctx)).toBe(18);
    expect(xpFor({ kind: 'duel_finished', won: true }, ctx)).toBe(10);
    expect(xpFor({ kind: 'duel_finished', won: false }, ctx)).toBe(5);
    expect(xpFor({ kind: 'battle_played', rank: 1 }, ctx)).toBe(15);
    expect(xpFor({ kind: 'battle_played', rank: 2 }, ctx)).toBe(11);
    expect(xpFor({ kind: 'battle_played', rank: 3 }, ctx)).toBe(8);
    expect(xpFor({ kind: 'battle_played', rank: 9 }, ctx)).toBe(5);
  });
});

describe('levels (§17.2)', () => {
  it('threshold(L) = 50·L·(L+1)', () => {
    expect([1, 2, 3, 5, 10, 20].map(levelThreshold)).toEqual([100, 300, 600, 1500, 5500, 21000]);
  });

  it('levelFor returns the highest level whose threshold is reached', () => {
    expect(levelFor(0)).toBe(0);
    expect(levelFor(99)).toBe(0);
    expect(levelFor(100)).toBe(1);
    expect(levelFor(299)).toBe(1);
    expect(levelFor(300)).toBe(2);
    expect(levelFor(1500)).toBe(5);
    expect(levelFor(20999)).toBe(19);
    expect(levelFor(21000)).toBe(20);
  });
});

function day(d: string, extra: Partial<DailyActivity> = {}): DailyActivity {
  return { day: d, activeMinutes: 0, cardReviews: 0, completedSessions: 0, examOfActiveGoal: false, restDay: false, autoRest: false, ...extra };
}
const counted = (d: string): DailyActivity => day(d, { cardReviews: 10 });

describe('streaks with shields (§17.3)', () => {
  it('counted days: 5 active minutes, 10 reviews, a completed session, or an exam of an active goal', () => {
    const start = initialStreakState();
    expect(evaluateStreak([day('2026-10-27', { activeMinutes: 4, cardReviews: 9 })], start).length).toBe(0);
    expect(evaluateStreak([day('2026-10-27', { activeMinutes: 5 })], start).length).toBe(1);
    expect(evaluateStreak([day('2026-10-27', { completedSessions: 1 })], start).length).toBe(1);
    expect(evaluateStreak([day('2026-10-27', { examOfActiveGoal: true })], start).length).toBe(1);
  });

  it('seven counted days in a row add one shield; a missed day spends it and keeps the length', () => {
    const days = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'].map(counted);
    const after = evaluateStreak(days, initialStreakState());
    expect(after).toMatchObject({ length: 7, shields: 1, longest: 7 });

    const spent = evaluateStreak([...days, day('2026-10-27')], after);
    expect(spent).toMatchObject({ length: 7, shields: 0, shieldUsedOn: ['2026-10-27'] });

    const broken = evaluateStreak([...days, day('2026-10-27'), day('2026-10-28')], after);
    expect(broken).toMatchObject({ length: 0, longest: 7 });
  });

  it('rest days and auto-rest days neither count nor break the streak', () => {
    const days = [counted('2026-10-20'), day('2026-10-21', { restDay: true }), counted('2026-10-22')];
    expect(evaluateStreak(days, initialStreakState()).length).toBe(2);
    const exams = autoRestDays([{ examDays: ['2026-10-30'], lastExamDay: '2026-10-21' }]);
    expect([...exams].sort()).toEqual(['2026-10-22', '2026-10-30']);
    const withAuto = [counted('2026-10-20'), day('2026-10-21', { restDay: true }), day('2026-10-22', { autoRest: true }), counted('2026-10-23')];
    expect(evaluateStreak(withAuto, initialStreakState()).length).toBe(2);
  });

  it('a day missing from the input counts as empty', () => {
    const days = [counted('2026-10-20'), counted('2026-10-22')];
    expect(evaluateStreak(days, initialStreakState())).toMatchObject({ length: 1, longest: 1 });
  });

  it('evaluation is idempotent for days already processed', () => {
    const days = [counted('2026-10-20'), counted('2026-10-21')];
    const once = evaluateStreak(days, initialStreakState());
    expect(evaluateStreak(days, once)).toEqual(once);
  });

  it('04:00 boundary: activity before 04:00 local belongs to the previous study day', () => {
    // Local 03:59 on 28 Oct is 06:59Z; local 04:00 is 07:00Z; local 23:30 on 27 Oct is 02:30Z on 28 Oct.
    expect(studyDay(new Date('2026-10-28T06:59:00Z'))).toBe('2026-10-27');
    expect(studyDay(new Date('2026-10-28T07:00:00Z'))).toBe('2026-10-28');
    expect(studyDay(new Date('2026-10-28T02:30:00Z'))).toBe('2026-10-27');

    // Ten reviews at 23:30 on the 27th and ten more at 03:59 on the 28th: one counted study day (the 27th).
    const reviewTimes = [
      ...Array.from({ length: 10 }, () => '2026-10-28T02:30:00Z'),
      ...Array.from({ length: 10 }, () => '2026-10-28T06:59:00Z'),
    ].map((iso) => new Date(iso));
    const byDay = new Map<string, number>();
    for (const t of reviewTimes) byDay.set(studyDay(t), (byDay.get(studyDay(t)) ?? 0) + 1);
    expect(Object.fromEntries(byDay)).toEqual({ '2026-10-27': 20 });
    const after = evaluateStreak([day('2026-10-27', { cardReviews: 20 })], initialStreakState());
    expect(after).toMatchObject({ length: 1, lastEvaluated: '2026-10-27' });
  });
});

describe('active minutes (§17.4)', () => {
  const at = (iso: string): number => new Date(iso).getTime();

  it('counts minutes between interactions less than 90 s apart', () => {
    // 10:00:00, 10:00:50, 10:02:00 → minutes 10:00, 10:01, 10:02 are covered by 50 s and 70 s gaps.
    const minutes = activeMinutesByStudyDay([at('2026-10-27T13:00:00Z'), at('2026-10-27T13:00:50Z'), at('2026-10-27T13:02:00Z')], 'America/Sao_Paulo');
    expect(minutes).toEqual({ '2026-10-27': 3 });
  });

  it('a gap over 90 s is idle: only the minutes that hold an interaction count', () => {
    const minutes = activeMinutesByStudyDay([at('2026-10-27T13:00:00Z'), at('2026-10-27T13:02:00Z')], 'America/Sao_Paulo');
    expect(minutes).toEqual({ '2026-10-27': 2 });
  });
});
