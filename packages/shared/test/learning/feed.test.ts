import { describe, expect, it } from 'vitest';
import { feedPriority, rankFeed, type FeedContext, type FeedItem, type FeedPoolKey } from '../../src/learning/index.ts';

const NOW = new Date('2026-10-27T12:00:00Z');
const ctx = (over: Partial<FeedContext> = {}): FeedContext => ({
  userId: 'u1',
  studyDay: '2026-10-27',
  now: NOW,
  newQuotaRemaining: 5,
  subjectCount: 2,
  rounds: 1,
  ...over,
});

function item(id: string, pool: FeedPoolKey, over: Partial<FeedItem> = {}): FeedItem {
  return {
    id,
    pool,
    subjectId: 'bio',
    conceptId: 'c-' + id,
    examUrgency: 0,
    mastery: 0.5,
    seenBefore: true,
    shownWithin24h: false,
    ...over,
  };
}

describe('priority (§10)', () => {
  it('combines urgency, mastery gap, due pressure and novelty', () => {
    // 0.4·0.5 + 0.3·0.6 + 0.2·1 (a day overdue on a 1-day stability) + 0.1·1 = 0.58 plus jitter ±0.05.
    const it1 = item('p1', 'D', {
      examUrgency: 0.5,
      mastery: 0.4,
      effectiveDue: new Date(NOW.getTime() - 86_400_000),
      stabilityDays: 1,
      seenBefore: false,
    });
    const priority = feedPriority(it1, ctx(), []);
    expect(Math.abs(priority - (0.2 + 0.18 + 0.2 + 0.1))).toBeLessThanOrEqual(0.05);
  });

  it('recency penalty: 1 when shown in the last 24 h unless re-shown; 0.5 for a recent concept', () => {
    const base = item('r1', 'Q', { mastery: 0.5 });
    const fresh = feedPriority(base, ctx(), []);
    const shown = feedPriority({ ...base, shownWithin24h: true }, ctx(), []);
    const reShown = feedPriority({ ...base, shownWithin24h: true, reShow: true }, ctx(), []);
    const recentConcept = feedPriority(base, ctx(), [base.conceptId]);
    expect(fresh - shown).toBeCloseTo(1, 10);
    expect(fresh - reShown).toBeCloseTo(0, 10);
    expect(fresh - recentConcept).toBeCloseTo(0.5, 10);
  });

  it('jitter is deterministic for (user, study day, item)', () => {
    const it1 = item('j1', 'Q');
    expect(feedPriority(it1, ctx(), [])).toBe(feedPriority(it1, ctx(), []));
  });
});

describe('round template (§10)', () => {
  it('a full round has five slots, with at least three retrieval items', () => {
    const pools = {
      D: [item('d1', 'D', { effectiveDue: NOW }), item('d2', 'D', { effectiveDue: NOW })],
      M: [item('m1', 'M')],
      Q: [item('q1', 'Q'), item('q2', 'Q')],
      G: [item('g1', 'G')],
      L: [item('l1', 'L')],
      K: [item('k1', 'K')],
    };
    const [round] = rankFeed(pools, ctx());
    expect(round?.slots).toHaveLength(5);
    expect(round?.retrievalCount).toBeGreaterThanOrEqual(3);
    expect(round?.slots[0]?.item.pool).toMatch(/^[LGK]$/);
    expect(round?.slots[1]?.item.pool).toMatch(/^[DMQ]$/);
  });

  it('empty pools give no rounds', () => {
    const empty = { D: [], M: [], Q: [], G: [], L: [], K: [] };
    expect(rankFeed(empty, ctx({ rounds: 3 }))).toEqual([]);
  });

  it('with only "você sabia" items, rounds still fill from K and report no retrieval items', () => {
    const pools = { D: [], M: [], Q: [], G: [], L: [], K: [item('k1', 'K'), item('k2', 'K')] };
    const rounds = rankFeed(pools, ctx());
    expect(rounds[0]?.retrievalCount).toBe(0);
    expect(rounds[0]?.slots.map((s) => s.item.id).sort()).toEqual(['k1', 'k2']);
  });

  it('micro-lessons are skipped when the new-card quota is used up (FED-01.10)', () => {
    const pools = { D: [item('d1', 'D')], M: [], Q: [item('q1', 'Q')], G: [], L: [item('l1', 'L')], K: [] };
    const [round] = rankFeed(pools, ctx({ newQuotaRemaining: 0 }));
    expect(round?.slots.map((s) => s.item.pool)).not.toContain('L');
  });

  it('never runs three consecutive items of one subject when two subjects are in scope', () => {
    const d = Array.from({ length: 6 }, (_, i) => item(`a${i}`, 'D', { subjectId: 'bio', effectiveDue: NOW }));
    const q = Array.from({ length: 6 }, (_, i) => item(`b${i}`, 'Q', { subjectId: 'hist' }));
    const rounds = rankFeed({ D: d, M: [], Q: q, G: [], L: [], K: [] }, ctx({ rounds: 2 }));
    const subjects = rounds.flatMap((r) => r.slots.map((s) => s.item.subjectId));
    for (let i = 2; i < subjects.length; i++) {
      const three = subjects[i] === subjects[i - 1] && subjects[i - 1] === subjects[i - 2];
      expect(three).toBe(false);
    }
  });

  it('is deterministic for the same context and pools', () => {
    const pools = { D: [item('d1', 'D', { effectiveDue: NOW }), item('d2', 'D')], M: [], Q: [item('q1', 'Q')], G: [], L: [], K: [] };
    expect(rankFeed(pools, ctx())).toEqual(rankFeed(pools, ctx()));
  });
});
