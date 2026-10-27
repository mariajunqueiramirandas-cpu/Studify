import { describe, expect, it } from 'vitest';
import { bossHealth, bossPassed, bossQuestionCount, selectBossQuestions, skillNodeState, skillTreeLayout } from '../../src/learning/index.ts';

describe('skill tree node states (spec 13 §8.6)', () => {
  const masteries = new Map<string, number | null>([['p1', 0.3], ['p2', 0.9], ['p3', null]]);
  const of = (id: string) => masteries.get(id) ?? null;

  it('untouched node with a weak prerequisite is "recomendado depois" and names the weakest one', () => {
    const v = skillNodeState({ id: 'n', mastery: null, retrievability: null, prerequisiteIds: ['p2', 'p1', 'p3'] }, of);
    expect(v).toEqual({ id: 'n', state: 'recommended_later', recommendedAfter: 'p3' });
  });

  it('available when every prerequisite is ≥ 50% (or there is none)', () => {
    expect(skillNodeState({ id: 'n', mastery: 0, retrievability: null, prerequisiteIds: ['p2'] }, of).state).toBe('available');
    expect(skillNodeState({ id: 'n', mastery: null, retrievability: null, prerequisiteIds: [] }, of).state).toBe('available');
  });

  it('progress, mastered and cooling ignore prerequisites (never a lock)', () => {
    expect(skillNodeState({ id: 'n', mastery: 0.4, retrievability: 0.9, prerequisiteIds: ['p1'] }, of).state).toBe('in_progress');
    expect(skillNodeState({ id: 'n', mastery: 0.85, retrievability: 0.8, prerequisiteIds: ['p1'] }, of).state).toBe('mastered');
    expect(skillNodeState({ id: 'n', mastery: 0.85, retrievability: 0.6, prerequisiteIds: [] }, of).state).toBe('cooling');
    expect(skillNodeState({ id: 'n', mastery: 0.8, retrievability: null, prerequisiteIds: [] }, of).state).toBe('mastered');
  });
});

describe('skill tree layout (MOT-02.1)', () => {
  const units = [
    { id: 'u2', title: 'Unidade 2', order: 2 },
    { id: 'u1', title: 'Unidade 1', order: 1 },
  ];
  const topics = [
    { id: 'a', unitId: 'u1', title: 'A', order: 1 },
    { id: 'b', unitId: 'u1', title: 'B', order: 2 },
    { id: 'c', unitId: 'u1', title: 'C', order: 3 },
    { id: 'd', unitId: 'u2', title: 'D', order: 1 },
  ];
  const prereqs = [
    { nodeId: 'b', prerequisiteId: 'a' },
    { nodeId: 'c', prerequisiteId: 'b' },
    { nodeId: 'd', prerequisiteId: 'c' },
  ];

  it('units are bands in outline order; columns follow prerequisite depth inside a unit', () => {
    const l = skillTreeLayout(units, topics, prereqs);
    expect(l.regions.map((r) => r.unitId)).toEqual(['u1', 'u2']);
    const pos = Object.fromEntries(l.nodes.map((n) => [n.id, [n.col, n.row]]));
    expect(pos).toEqual({ a: [0, 0], b: [1, 0], c: [2, 0], d: [0, 2] });
    expect(l.regions[0]!.boss).toEqual({ col: 3, row: 0 });
    expect(l.edges).toContainEqual({ from: 'c', to: 'd' });
  });

  it('is deterministic and survives a prerequisite cycle', () => {
    const cyclic = [...prereqs, { nodeId: 'a', prerequisiteId: 'c' }];
    expect(skillTreeLayout(units, topics, cyclic)).toEqual(skillTreeLayout([...units].reverse(), [...topics].reverse(), cyclic));
  });
});

describe('Chefão (MOT-02.4)', () => {
  it('10 questions up to 4 topics, 15 above', () => {
    expect(bossQuestionCount(4)).toBe(10);
    expect(bossQuestionCount(5)).toBe(15);
  });

  const candidates = Array.from({ length: 40 }, (_, i) => ({ id: `q${String(i).padStart(2, '0')}`, nodeId: `t${i % 4}` }));
  const mastery = (t: string) => ({ t0: 0.9, t1: 0.1, t2: 0.5, t3: null })[t] ?? null;

  it('covers every topic, leans toward weak topics and is deterministic per seed', () => {
    const picked = selectBossQuestions(candidates, mastery, 10, 'attempt-1');
    expect(picked).toHaveLength(10);
    expect(new Set(picked).size).toBe(10);
    const topicsOf = picked.map((id) => candidates.find((c) => c.id === id)!.nodeId);
    expect(new Set(topicsOf)).toEqual(new Set(['t0', 't1', 't2', 't3']));
    expect(selectBossQuestions(candidates, mastery, 10, 'attempt-1')).toEqual(picked);
    let weak = 0;
    let strong = 0;
    for (let s = 0; s < 50; s++) {
      for (const id of selectBossQuestions(candidates, mastery, 10, `s${s}`)) {
        const t = candidates.find((c) => c.id === id)!.nodeId;
        if (t === 't1') weak++;
        if (t === 't0') strong++;
      }
    }
    expect(weak).toBeGreaterThan(strong);
  });

  it('retries get different questions while unseen ones remain', () => {
    const first = selectBossQuestions(candidates, mastery, 10, 'a');
    const second = selectBossQuestions(candidates, mastery, 10, 'b', new Set(first));
    expect(second.filter((id) => first.includes(id))).toEqual([]);
  });

  it('health empties at the 70% pass mark; pass at ≥ 70%', () => {
    expect(bossHealth(0, 10)).toBe(1);
    expect(bossHealth(7, 10)).toBe(0);
    expect(bossHealth(3, 10)).toBeCloseTo(1 - 3 / 7);
    expect(bossPassed(0.7)).toBe(true);
    expect(bossPassed(0.69)).toBe(false);
  });
});
