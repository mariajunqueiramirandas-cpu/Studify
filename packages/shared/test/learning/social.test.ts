import { describe, expect, it } from 'vitest';
import {
  SOCIAL,
  battleChoiceOf,
  battleDistributionOf,
  battlePodiumEvent,
  battlePoints,
  battlePublicQuestion,
  battleRevealEvent,
  battleStateEvent,
  battleTopic,
  classInsightDisplay,
  duelAnswerSeconds,
  duelPoints,
  isBattleAnswerRejected,
  isDuelTimeout,
  leaderboardTop,
  topicInsight,
} from '../../src/learning/index.ts';

describe('duel scoring (§18.1, SOC-02)', () => {
  it('correct: 100 + round(50·(1 − t/T)); wrong: 0', () => {
    expect(duelPoints(true, 0, 30)).toBe(150);
    expect(duelPoints(true, 15, 30)).toBe(125);
    expect(duelPoints(true, 30, 30)).toBe(100);
    expect(duelPoints(false, 0, 30)).toBe(0);
  });

  it('time is clamped to [0, T]', () => {
    expect(duelPoints(true, -5, 30)).toBe(150);
    expect(duelPoints(true, 90, 30)).toBe(100);
  });

  it('server-measured answer time subtracts 0.5 s and is clamped', () => {
    expect(duelAnswerSeconds(0, 5000)).toBeCloseTo(4.5, 10);
    expect(duelAnswerSeconds(5000, 1000)).toBe(0);
    expect(duelAnswerSeconds(0, 120_000)).toBe(30);
  });

  it('the deadline grace is 1.5 s (api §4.7, data-model §5.7): later receipts are timeouts', () => {
    expect(SOCIAL.duelDeadlineGraceMs).toBe(1500);
    expect(isDuelTimeout(2500, 1000)).toBe(false);
    expect(isDuelTimeout(2501, 1000)).toBe(true);
  });
});

describe('battle Realtime payloads (api §8.2, SOC-03.10)', () => {
  const players = [
    { user_id: 'u-b', nickname: 'Bia', score: 900 },
    { user_id: 'u-a', nickname: 'Ana', score: 1200 },
    { user_id: 'u-c', nickname: 'Caio', score: 900 },
    { user_id: 'u-d', nickname: 'Davi', score: 300 },
    { user_id: 'u-e', nickname: 'Eva', score: 100 },
    { user_id: 'u-f', nickname: 'Fabi', score: 50 },
  ];

  it('topic is the private channel battle:{id}', () => {
    expect(battleTopic('b-1')).toBe('battle:b-1');
  });

  it('leaderboard: best first, competition ranking, only the top N are sent', () => {
    const top = leaderboardTop(players, 5);
    expect(top.map((e) => [e.nickname, e.rank])).toEqual([
      ['Ana', 1],
      ['Bia', 2],
      ['Caio', 2],
      ['Davi', 4],
      ['Eva', 5],
    ]);
    expect(top.some((e) => e.nickname === 'Fabi')).toBe(false);
    expect(leaderboardTop(players, 3)).toHaveLength(3);
  });

  it('distribution is null below 5 answers and in whole percent from 5', () => {
    expect(battleDistributionOf(['A', 'B', null, 'A'], ['A', 'B', 'C'])).toBeNull();
    expect(battleDistributionOf(['A', 'A', 'B', 'C', 'A', null], ['A', 'B', 'C', 'D'])).toEqual({ A: 60, B: 20, C: 20, D: 0 });
    expect(battleDistributionOf(['A', 'A', 'A', 'B', 'B', 'C'], ['A', 'B', 'C'])).toEqual({ A: 50, B: 33, C: 17 });
  });

  it('choice of a practice response and public question strip the answer key', () => {
    expect(battleChoiceOf({ choice: 'B' })).toBe('B');
    expect(battleChoiceOf({ value: true })).toBeNull();
    const pub = battlePublicQuestion({
      id: 'q1',
      type: 'mcq_single',
      stem: 'Qual?',
      stimulus: null,
      payload: { options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }], correct: 'B', rationale: 'secret' },
    });
    expect(JSON.stringify(pub)).not.toContain('secret');
    expect(JSON.stringify(pub)).not.toContain('correct');
    expect(pub).toEqual({ id: 'q1', type: 'mcq_single', stem: 'Qual?', stimulus: null, payload: { options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }] } });
  });

  it('state event carries the window only when a question is open', () => {
    const opens = new Date('2026-10-27T15:00:01.500Z');
    const closes = new Date('2026-10-27T15:00:21.500Z');
    expect(battleStateEvent({ status: 'question_open', currentIndex: 2, total: 5, question: { id: 'q' }, opensAt: opens, closesAt: closes, players: 4 })).toEqual({
      event: 'state',
      payload: { status: 'question_open', current_index: 2, total: 5, question: { id: 'q' }, opens_at: opens.toISOString(), closes_at: closes.toISOString(), players: 4 },
    });
    expect(battleStateEvent({ status: 'reveal', currentIndex: 2, total: 5 })).toEqual({ event: 'state', payload: { status: 'reveal', current_index: 2, total: 5 } });
  });

  it('reveal event: correct response, explanation only when present, distribution may be null', () => {
    const board = leaderboardTop(players, 5);
    const withExplanation = battleRevealEvent({ index: 1, correctResponse: { choice: 'B' }, explanation: 'Porque sim.', distribution: null, leaderboard: board });
    expect(withExplanation).toEqual({
      event: 'reveal',
      payload: { index: 1, correct_response: { choice: 'B' }, explanation: 'Porque sim.', distribution: null, leaderboard: board },
    });
    const without = battleRevealEvent({ index: 0, correctResponse: { value: true }, explanation: null, distribution: { A: 100 }, leaderboard: [] });
    expect(without.payload).not.toHaveProperty('explanation');
    expect(without.payload.distribution).toEqual({ A: 100 });
  });

  it('podium event sends the given standings as leaderboard', () => {
    expect(battlePodiumEvent(leaderboardTop(players, 3))).toEqual({ event: 'podium', payload: { leaderboard: leaderboardTop(players, 3) } });
  });
});

describe('battle scoring (§18.2, SOC-03)', () => {
  it('base 500–1000 when correct, from fastest to slowest; zero when wrong', () => {
    expect(battlePoints(true, 0, 30, 1)).toBe(1000);
    expect(battlePoints(true, 30, 30, 1)).toBe(500);
    expect(battlePoints(true, 15, 30, 1)).toBe(750);
    expect(battlePoints(false, 0, 30, 4)).toBe(0);
  });

  it('streak bonus: 50 per answer beyond the first, capped at 200', () => {
    expect(battlePoints(true, 0, 30, 1)).toBe(1000);
    expect(battlePoints(true, 0, 30, 3)).toBe(1100);
    expect(battlePoints(true, 0, 30, 10)).toBe(1200);
  });

  it('answers after closes_at + 1 s are rejected', () => {
    expect(isBattleAnswerRejected(2001, 1000)).toBe(true);
    expect(isBattleAnswerRejected(2000, 1000)).toBe(false);
  });
});

describe('class insights: k-anonymity with k = 5 (§18.3, SOC-04)', () => {
  it('fewer than five answerers reveal nothing', () => {
    expect(classInsightDisplay({ answerers: 4, wrong: 4 }).display).toEqual({ kind: 'none' });
  });

  it('5–9 answerers, or fewer than two right or wrong, show only a band', () => {
    expect(classInsightDisplay({ answerers: 7, wrong: 5 }).display).toEqual({ kind: 'band', band: 'hard', label: 'Difícil para a turma' });
    expect(classInsightDisplay({ answerers: 7, wrong: 1 }).display).toEqual({ kind: 'band', band: 'easy', label: 'Tranquila para a turma' });
    expect(classInsightDisplay({ answerers: 7, wrong: 3 }).display).toEqual({ kind: 'none' });
    expect(classInsightDisplay({ answerers: 20, wrong: 0 }).display).toEqual({ kind: 'band', band: 'easy', label: 'Tranquila para a turma' });
  });

  it('10 or more with at least two right and two wrong: error rate rounded to 5% and clamped to [5%, 95%]', () => {
    expect(classInsightDisplay({ answerers: 20, wrong: 7 }).display).toEqual({ kind: 'error_rate', errorRate: 0.35 });
    expect(classInsightDisplay({ answerers: 50, wrong: 48 }).display).toEqual({ kind: 'error_rate', errorRate: 0.95 });
    expect(classInsightDisplay({ answerers: 100, wrong: 60 }).display).toEqual({ kind: 'error_rate', errorRate: 0.6 });
  });

  it('a pitfall (wrong option) needs three choosers and ten answerers', () => {
    expect(classInsightDisplay({ answerers: 20, wrong: 7, topWrongOptionCount: 3 }).pitfallRate).toBe(0.15);
    expect(classInsightDisplay({ answerers: 20, wrong: 7, topWrongOptionCount: 2 }).pitfallRate).toBeNull();
    expect(classInsightDisplay({ answerers: 8, wrong: 4, topWrongOptionCount: 3 }).pitfallRate).toBeNull();
  });

  it('topic aggregate: mean error over questions with n ≥ 5, only with at least three such questions', () => {
    const qs = [
      { answerers: 5, wrong: 1 },
      { answerers: 10, wrong: 4 },
      { answerers: 10, wrong: 6 },
      { answerers: 3, wrong: 3 },
    ];
    expect(topicInsight(qs)).toEqual({ kind: 'error_rate', errorRate: 0.4 });
    expect(topicInsight(qs.slice(0, 2))).toEqual({ kind: 'none' });
  });
});
