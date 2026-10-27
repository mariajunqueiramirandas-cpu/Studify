/// <reference types="jest" />
jest.mock('expo-sqlite', () => require('../testing/expo-sqlite.mock'));

import { createEmptyCard, fsrs, Rating, State } from 'ts-fsrs';
import { createTestDb } from '../testing/test-db';
import { seedCards, seedProfile, seedSubject } from '../testing/seed';
import { recordReview, ReviewError, refreshQueueCache, schedulerFor, currentUserId } from '../hooks/review';
import { cardStates, queueCache, reviewLogs, outbox } from '../schema';

describe('recordReview', () => {
  it('replays a rating sequence exactly like ts-fsrs (golden schedule)', async () => {
    const { db } = await createTestDb();
    seedProfile(db);
    seedSubject(db);
    const [id] = seedCards(db, 1);
    const sequence = [Rating.Good, Rating.Good, Rating.Again, Rating.Good] as const;
    const f = fsrs({ request_retention: 0.9 });
    let expected = createEmptyCard(new Date('2026-10-27T12:00:00.000Z'));
    let at = new Date('2026-10-27T12:00:00.000Z');
    for (const rating of sequence) {
      at = new Date(at.getTime() + 3 * 24 * 3600 * 1000);
      expected = f.next(expected, at, rating as never).card;
      await recordReview(db as never, { cardId: id!, rating: rating as never, now: at });
    }
    const local = db.select().from(cardStates).all()[0]!;
    expect(local.due.getTime()).toBe(expected.due.getTime());
    expect(local.stability).toBeCloseTo(expected.stability, 10);
    expect(local.difficulty).toBeCloseTo(expected.difficulty, 10);
    expect(local.state).toBe(expected.state);
    expect(local.reps).toBe(4);
    expect(local.lapses).toBe(1);
  });

  it('keeps a local review log and a review_log outbox row with the same client id', async () => {
    const { db } = await createTestDb();
    seedProfile(db);
    seedSubject(db);
    const [id] = seedCards(db, 1);
    const result = await recordReview(db as never, { cardId: id!, rating: Rating.Good as never, source: 'widget', durationMs: 1200 });
    const log = db.select().from(reviewLogs).all()[0]!;
    expect(log.id).toBe(result.logId);
    expect(log.source).toBe('widget');
    expect(log.durationMs).toBe(1200);
    const row = db.select().from(outbox).all()[0]!;
    expect(row.id).toBe(result.logId);
    expect(row.kind).toBe('review_log');
    expect((row.payload as { source: string }).source).toBe('widget');
  });

  it('refreshes queue_cache with only the due cards, earliest first', async () => {
    const { db } = await createTestDb();
    seedProfile(db);
    seedSubject(db);
    const ids = seedCards(db, 3);
    const now = new Date('2026-10-27T12:00:00.000Z');
    // ids[1] is due an hour ago, ids[2] is due in a week, ids[0] is reviewed now (due days later).
    const base = (cardId: string, due: Date) =>
      db.insert(cardStates).values({
        userId: 'user-1', cardId, subjectId: 'subject-1', due, stability: 1, difficulty: 5, elapsedDays: 0,
        scheduledDays: 1, reps: 1, lapses: 0, state: 2, learningSteps: 0, lastReview: now, suspended: false,
        hidden: false, isLeech: false, introducedAt: now, lastLogId: null, updatedAt: now, pulledAt: null,
      }).run();
    base(ids[1]!, new Date(now.getTime() - 3_600_000));
    base(ids[2]!, new Date(now.getTime() + 7 * 24 * 3_600_000));
    await recordReview(db as never, { cardId: ids[0]!, rating: Rating.Good as never, now });
    refreshQueueCache(db as never, currentUserId(db as never), now);
    const queued = db.select().from(queueCache).all().map((r) => r.cardId);
    expect(queued).toEqual([ids[1]]);
  });

  it('rejects an unknown card and a device without a profile', async () => {
    const { db } = await createTestDb();
    await expect(recordReview(db as never, { cardId: 'x', rating: 3 })).rejects.toBeInstanceOf(ReviewError);
    seedProfile(db);
    await expect(recordReview(db as never, { cardId: 'missing', rating: 3 })).rejects.toMatchObject({ code: 'card_not_found' });
  });

  it('uses the profile settings for retention and drops the cache per settings key', () => {
    const a = schedulerFor({ memory: { desired_retention: 0.85 } });
    const b = schedulerFor({ memory: { desired_retention: 0.85 } });
    expect(a).toBe(b);
    expect(schedulerFor(undefined)).not.toBe(a);
    expect(State.New).toBe(0);
  });
});
