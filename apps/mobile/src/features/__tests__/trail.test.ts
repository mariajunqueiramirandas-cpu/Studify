/// <reference types="jest" />
jest.mock('expo-sqlite', () => require('../../db/testing/expo-sqlite.mock'));
jest.mock('../../api/supabase', () => ({ supabase: {} }));
jest.mock('../../lib/kv', () => {
  const store = new Map<string, unknown>();
  const kv = {
    getString: (k: string) => store.get(k) as string | undefined,
    set: (k: string, v: unknown) => void store.set(k, v),
    remove: (k: string) => void store.delete(k),
  };
  return { getKv: () => kv };
});

import { cards } from '../../db/schema';
import { seedCards, seedProfile, seedSubject, NODE_ID, SUBJECT_ID } from '../../db/testing/seed';
import { createTestDb } from '../../db/testing/test-db';
import { buildLocalQueue } from '../memory/local';
import { learnedConcepts, rememberLearned } from '../trail/learned';

describe('Trilha → flashcards (TRL-01.15)', () => {
  it('puts the cards of concepts cleared in the Trilha first among the new cards, even outside the usual window', async () => {
    const { db } = await createTestDb();
    seedProfile(db);
    seedSubject(db);
    seedCards(db, 70);
    const later = new Date('2026-10-28T12:00:00.000Z');
    db.insert(cards)
      .values({ id: 'trail-card', subjectId: SUBJECT_ID, nodeId: NODE_ID, conceptId: 'concept-x', type: 'basic', front: 'Clorofila?', back: 'Pigmento verde.', media: null, hasMath: false, siblingGroupId: null, clozeIndex: null, sourcePages: [], origin: 'generated', createdBy: null, personalForUserId: null, status: 'active', hiddenReason: null, version: 1, createdAt: later, updatedAt: later, deletedAt: null, pulledAt: later })
      .run();

    const before = buildLocalQueue(db as never, { now: later });
    expect(before.some((c) => c.id === 'trail-card')).toBe(false);

    expect(rememberLearned(['concept-x', 'concept-y'])).toEqual(['concept-x', 'concept-y']);
    expect(rememberLearned(['concept-x'])).toEqual([]);
    expect(learnedConcepts().has('concept-y')).toBe(true);

    const after = buildLocalQueue(db as never, { now: later });
    const firstNew = after.find((c) => c.isNew);
    expect(firstNew?.id).toBe('trail-card');
    expect(after.filter((c) => c.isNew)).toHaveLength(20);
  });
});
