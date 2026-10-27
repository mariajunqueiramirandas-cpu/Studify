import { describe, expect, it } from 'vitest';
import {
  CAPI_ACCESSORIES,
  capiMood,
  capiStage,
  equippedAccessories,
  leagueBadges,
  leagueWeekXp,
  rankLeague,
  retroCards,
  retroFallbackTitle,
  retroPeriodsDue,
  visibleBoard,
  type RetroStats,
} from '../../src/learning/index.ts';

describe('Capi (MOT-03)', () => {
  it('grows with the level', () => {
    expect([0, 4, 5, 14, 15, 29, 30].map(capiStage)).toEqual(['filhote', 'filhote', 'jovem', 'jovem', 'adulta', 'adulta', 'sabia']);
  });

  const base = { focusActive: false, goalMetToday: false, daysAway: 0, minuteOfDay: 15 * 60 };
  it('moods by priority, and never anything sad', () => {
    expect(capiMood(base)).toBe('curious');
    expect(capiMood({ ...base, goalMetToday: true })).toBe('celebrating');
    expect(capiMood({ ...base, focusActive: true, goalMetToday: true })).toBe('focused');
    expect(capiMood({ ...base, minuteOfDay: 23 * 60 + 30, goalMetToday: true })).toBe('sleepy');
    expect(capiMood({ ...base, minuteOfDay: 2 * 60 })).toBe('sleepy');
  });

  it('rests (never sad) after 3+ days without activity (spec 13 §11)', () => {
    expect(capiMood({ ...base, daysAway: 2 })).toBe('curious');
    expect(capiMood({ ...base, daysAway: 3 })).toBe('resting');
    expect(capiMood({ ...base, daysAway: 30 })).toBe('resting');
  });

  it('wears only unlocked accessories, one per slot', () => {
    const worn = equippedAccessories(['bone', 'chapeu_formatura', 'oculos', 'nao_existe', 'cachecol_verde'], 6, new Set(['first_review']));
    expect(worn.map((a) => a.id)).toEqual(['bone', 'oculos', 'cachecol_verde']);
    expect(equippedAccessories(['bone'], 1, new Set())).toEqual([]);
    expect(new Set(CAPI_ACCESSORIES.map((a) => a.id)).size).toBe(CAPI_ACCESSORIES.length);
  });
});

describe('league (SOC-08, spec 10 §8.5)', () => {
  it('caps each day at 500 and skips quiet-hours XP', () => {
    const r = leagueWeekXp([
      { localDate: '2026-10-26', amount: 400, inQuietHours: false, occurredAt: '2026-10-26T15:00:00Z' },
      { localDate: '2026-10-26', amount: 300, inQuietHours: false, occurredAt: '2026-10-26T16:00:00Z' },
      { localDate: '2026-10-27', amount: 100, inQuietHours: true, occurredAt: '2026-10-28T02:00:00Z' },
      { localDate: '2026-10-27', amount: 50, inQuietHours: false, occurredAt: '2026-10-27T14:00:00Z' },
    ]);
    expect(r).toEqual({ xp: 550, reachedAt: '2026-10-27T14:00:00Z' });
  });

  it('ranks by XP, then by who reached it first', () => {
    const ranked = rankLeague([
      { userId: 'b', xp: 100, reachedAt: '2026-10-27T10:00:00Z' },
      { userId: 'a', xp: 100, reachedAt: '2026-10-27T09:00:00Z' },
      { userId: 'c', xp: 300, reachedAt: '2026-10-27T11:00:00Z' },
      { userId: 'd', xp: 0, reachedAt: null },
    ]);
    expect(ranked.map((r) => [r.userId, r.rank])).toEqual([['c', 1], ['a', 2], ['b', 3], ['d', 4]]);
  });

  it('badges: podium with XP and Semana consistente for ≥ 4 goal days', () => {
    expect(leagueBadges(1, 300, 4)).toEqual(['podium_1', 'consistent_week']);
    expect(leagueBadges(2, 0, 1)).toEqual([]);
    expect(leagueBadges(7, 50, 5)).toEqual(['consistent_week']);
  });

  it('shows the top 10 and the viewer only', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ userId: `u${i}`, rank: i + 1 }));
    expect(visibleBoard(rows, 'u12').map((r) => r.userId)).toEqual([...Array.from({ length: 10 }, (_, i) => `u${i}`), 'u12']);
  });
});

describe('Retrospectiva (MOT-04)', () => {
  it('goal recap the day after the last exam', () => {
    const due = retroPeriodsDue('2026-11-21', [{ id: 'g1', startDate: '2026-11-01', lastExamDay: '2026-11-20' }, { id: 'g2', startDate: '2026-11-01', lastExamDay: '2026-11-25' }]);
    expect(due).toEqual([{ type: 'goal', goalId: 'g1', start: '2026-11-01', end: '2026-11-20' }]);
  });

  it('semesters end in June and November by default; the year comes on December 20', () => {
    expect(retroPeriodsDue('2026-07-01', [])).toEqual([{ type: 'semester', goalId: null, start: '2025-12-01', end: '2026-06-30' }]);
    expect(retroPeriodsDue('2026-12-01', [])).toEqual([{ type: 'semester', goalId: null, start: '2026-07-01', end: '2026-11-30' }]);
    expect(retroPeriodsDue('2026-12-20', [])).toEqual([{ type: 'year', goalId: null, start: '2026-01-01', end: '2026-12-19' }]);
    expect(retroPeriodsDue('2026-08-10', [], ['08-09'])).toEqual([{ type: 'semester', goalId: null, start: '2025-08-10', end: '2026-08-09' }]);
    expect(retroPeriodsDue('2026-10-27', [])).toEqual([]);
  });

  const stats: RetroStats = {
    period: 'semester',
    active_minutes: 1234,
    days_studied: 40,
    cards_reviewed: 900,
    questions_answered: 300,
    accuracy: 0.72,
    best_subject: { name: 'Biologia', accuracy: 0.85 },
    most_improved_topic: { title: 'Mitose', from: 0.3, to: 0.8 },
    longest_streak: 12,
    best_lucas_score: 88,
    duels_won: 3,
    calibration_gain: 0.1,
    grades: [{ subject: 'Biologia', grade: '8,5' }],
  };

  it('6–8 cards, intro first and closing last, grades only with "Mostrar notas"', () => {
    const cards = retroCards(stats, 'T', null, { showGrades: false });
    expect(cards.length).toBeGreaterThanOrEqual(6);
    expect(cards.length).toBeLessThanOrEqual(8);
    expect(cards[0]!.kind).toBe('intro');
    expect(cards.at(-1)!.kind).toBe('closing');
    expect(cards.some((c) => c.kind === 'grades')).toBe(false);
    const minimal = retroCards({ ...stats, best_subject: null, most_improved_topic: null, best_lucas_score: null, duels_won: 0, calibration_gain: null, grades: [] }, 'T', null, { showGrades: true });
    expect(minimal.length).toBe(6);
    const withGrades = retroCards({ ...stats, best_subject: null, most_improved_topic: null, best_lucas_score: null }, 'T', null, { showGrades: true });
    expect(withGrades.some((c) => c.kind === 'grades')).toBe(true);
    expect(JSON.stringify(cards)).not.toMatch(/turma|colega/i);
  });

  it('has a fixed fallback title per period', () => {
    expect(retroFallbackTitle('semester').title).toBe('Que semestre, hein! ✨');
  });
});
