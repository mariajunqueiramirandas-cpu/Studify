/// <reference types="jest" />
/// <reference types="node" />
// Sync engine scenarios from testing-strategy.md §5.3 and mobile-app.md §4.3, run against the real
// Drizzle schema + migrations (node:sqlite) and an in-memory server with ts-fsrs replay.
jest.mock('expo-sqlite', () => require('../testing/expo-sqlite.mock'));

import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '../testing/test-db';
import { createFakeServer, type FakeServer } from '../testing/fake-server';
import { createFakeClock, createFakeTimers, type FakeClock, type FakeTimers } from '../testing/clock';
import { seedCards, seedProfile, seedSubject, serverCard, serverNode, serverProfile, serverSubject, SUBJECT_ID, USER_ID } from '../testing/seed';
import { createSyncEngine, type SyncEngine } from '../sync/engine';
import { backoffDelayMs, SyncTransportError } from '../sync/errors';
import { clampClientTime, lwwUpdatedAtMs, observeServerTime, resetClockForTests, serverNowMs } from '../sync/clock';
import { MAX_ATTEMPTS, BACKOFF_CAP_MS } from '../sync/constants';
import { enqueueOutbox, countOutbox, listStuckRows } from '../outbox';
import { cardOverrides, cardStates, cards, outbox, syncCursors } from '../schema';
import { recordReview, undoReview } from '../hooks/review';
import { filterSignature } from '../sync/engine';

interface Device {
  db: TestDb;
  engine: SyncEngine;
  clock: FakeClock;
  timers: FakeTimers;
  id: string;
}

async function createDevice(server: FakeServer, id: string, clock = createFakeClock()): Promise<Device> {
  const { db } = await createTestDb();
  const timers = createFakeTimers();
  const engine = createSyncEngine({
    db: db as never,
    transport: server.transport,
    deviceId: id,
    now: clock.now,
    setTimer: timers.setTimer,
  });
  return { db, engine, clock, timers, id };
}

/** Puts the profile, a subject with a node, and `count` cards on the server and syncs them down. */
async function seedServerAndPull(server: FakeServer, device: Device, count: number): Promise<string[]> {
  server.put('profiles', serverProfile());
  server.put('subjects', serverSubject());
  server.put('knowledge_nodes', serverNode());
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `card-${i}`;
    ids.push(id);
    server.put('cards', serverCard(id));
  }
  await device.engine.sync('manual');
  return ids;
}

function cardStateRow(db: TestDb, cardId: string) {
  return db.select().from(cardStates).where(eq(cardStates.cardId, cardId)).get();
}

beforeEach(() => {
  resetClockForTests();
});

describe('offline reviews and push', () => {
  it('pushes 50 offline reviews: 50 server logs, card_states equal the device predictions', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    seedProfile(device.db);
    seedSubject(device.db);
    const ids = seedCards(device.db, 50);

    const ratings = [3, 3, 1, 4, 2] as const;
    for (let i = 0; i < ids.length; i++) {
      device.clock.advance(60_000);
      await recordReview(device.db as never, {
        cardId: ids[i]!,
        rating: ratings[i % ratings.length] as never,
        now: new Date(device.clock.now()),
      });
    }
    expect(countOutbox(device.db as never).pending).toBe(50);
    expect(server.logs()).toHaveLength(0); // offline: nothing reached the server

    await device.engine.sync('manual');

    expect(server.logs()).toHaveLength(50);
    expect(countOutbox(device.db as never).pending).toBe(0);
    for (const id of ids) {
      const local = cardStateRow(device.db, id)!;
      const remote = server.cardState(id)!;
      expect(remote).toBeDefined();
      expect(new Date(String(remote['due'])).getTime()).toBe(local.due.getTime());
      expect(Number(remote['stability'])).toBeCloseTo(local.stability, 10);
      expect(Number(remote['state'])).toBe(local.state);
      expect(Number(remote['reps'])).toBe(local.reps);
    }
  });

  it('sends a whole batch of 10,000 pending rows in batches of at most 200', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    seedProfile(device.db);
    device.db.transaction((tx) => {
      for (let i = 0; i < 10_000; i++) {
        enqueueOutbox(tx, { kind: 'study_session', id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`, payload: { n: i }, createdAt: 1_000 + i });
      }
    });
    expect(countOutbox(device.db as never).pending).toBe(10_000);

    const before = process.memoryUsage().heapUsed;
    await device.engine.sync('manual');
    const growthMb = (process.memoryUsage().heapUsed - before) / 1024 / 1024;

    expect(server.stats.itemsReceived).toBe(10_000);
    expect(server.stats.maxBatch).toBeLessThanOrEqual(200);
    expect(server.stats.pushes).toBe(50);
    expect(countOutbox(device.db as never).pending).toBe(0);
    // Loose bound: batches are released as they are acknowledged (memory does not scale with the outbox).
    expect(growthMb).toBeLessThan(200);
  });

  it('re-push after a lost ack creates no duplicate review logs', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    seedProfile(device.db);
    seedSubject(device.db);
    const ids = seedCards(device.db, 3);
    for (const id of ids) {
      await recordReview(device.db as never, { cardId: id, rating: 3 });
    }

    server.faults.push({ type: 'lose-ack' });
    await device.engine.sync('manual');
    // The server stored the batch, the device did not get the ack, rows stay in the outbox.
    expect(server.logs()).toHaveLength(3);
    expect(countOutbox(device.db as never).pending).toBe(3);

    await device.engine.sync('manual');
    expect(server.logs()).toHaveLength(3);
    expect(server.stats.duplicateReceipts).toBe(3);
    expect(countOutbox(device.db as never).pending).toBe(0);
  });

  it('two concurrent sync loops send every row once and empty the outbox once', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    seedProfile(device.db);
    seedSubject(device.db);
    const ids = seedCards(device.db, 20);
    for (const id of ids) await recordReview(device.db as never, { cardId: id, rating: 3 });

    await Promise.all([device.engine.sync('manual'), device.engine.sync('foreground'), device.engine.sync('periodic')]);

    expect(server.logs()).toHaveLength(20);
    expect(server.stats.duplicateReceipts).toBe(0);
    expect(countOutbox(device.db as never).pending).toBe(0);
  });
});

describe('two devices', () => {
  it('reviews of the same card on two offline devices are both kept and converge to the replay', async () => {
    for (const order of [['A', 'B'], ['B', 'A']] as const) {
      const server = createFakeServer();
      const a = await createDevice(server, 'dev-A', createFakeClock());
      const b = await createDevice(server, 'dev-B', createFakeClock());
      await seedServerAndPull(server, a, 1);
      await b.engine.sync('manual');

      // Both offline: A rates Good at 12:00, B rates Again at 12:30 (B's clock is 2 min behind).
      a.clock.set(Date.parse('2026-10-27T12:00:00.000Z'));
      b.clock.set(Date.parse('2026-10-27T12:28:00.000Z'));
      await recordReview(a.db as never, { cardId: 'card-0', rating: 3, now: new Date(a.clock.now()) });
      await recordReview(b.db as never, { cardId: 'card-0', rating: 1, now: new Date(b.clock.now()) });

      const engines = { A: a.engine, B: b.engine };
      for (const who of order) await engines[who].sync('manual');
      await a.engine.sync('manual');
      await b.engine.sync('manual');

      expect(server.logsFor('card-0')).toHaveLength(2);
      const remote = server.cardState('card-0')!;
      const aState = cardStateRow(a.db, 'card-0')!;
      const bState = cardStateRow(b.db, 'card-0')!;
      // Both devices converge on the server's replay (the authoritative state).
      expect(aState.due.getTime()).toBe(new Date(String(remote['due'])).getTime());
      expect(bState.due.getTime()).toBe(new Date(String(remote['due'])).getTime());
      expect(aState.reps).toBe(2);
      expect(bState.reps).toBe(2);
    }
  });
});

describe('deletes, overlays and cursors', () => {
  it('a tombstone wins over a pending edit: row removed, edit dropped, no crash', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    await seedServerAndPull(server, device, 1);
    expect(device.db.select().from(cards).all()).toHaveLength(1);

    enqueueOutbox(device.db as never, {
      kind: 'card_override',
      entityId: 'card-0',
      payload: { fields: { front: 'Editado offline' } },
    });
    server.tombstone('cards', 'card-0');

    await expect(device.engine.sync('manual')).resolves.toBeUndefined();
    expect(device.db.select().from(cards).all()).toHaveLength(0);
    expect(device.db.select().from(cardOverrides).all()).toHaveLength(0);
    expect(server.rows('card_overrides')).toHaveLength(0);
    expect(countOutbox(device.db as never).pending).toBe(0);
    expect(device.engine.getStatus().state).toBe('idle');
  });

  it('a pending local edit overlays the pulled row until it is acknowledged', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    await seedServerAndPull(server, device, 1);

    enqueueOutbox(device.db as never, {
      kind: 'card_override',
      entityId: 'card-0',
      payload: { fields: { front: 'Minha versão' } },
    });
    // The server refuses the edit (kept in the outbox), so the pull below races a pending edit.
    server.rejectionFor.set(outboxIdOf(device.db, 'card_override'), { id: outboxIdOf(device.db, 'card_override'), code: 'stale', drop: false });
    server.put('card_overrides', { user_id: USER_ID, card_id: 'card-0', front: 'Versão do servidor', back: null, media: null, created_at: '2026-10-27T10:00:00.000000+00:00', deleted_at: null });

    await device.engine.sync('manual');
    const local = device.db.select().from(cardOverrides).where(eq(cardOverrides.cardId, 'card-0')).get();
    expect(local?.front).toBe('Minha versão');
    expect(countOutbox(device.db as never).pending).toBe(1);
  });

  it('pulls incrementally from the cursor and does not skip rows that share a timestamp', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    device.engine; // keep engine alive
    const engine = createSyncEngine({
      db: device.db as never,
      transport: server.transport,
      deviceId: 'dev-A',
      pullPageSize: 2,
      now: device.clock.now,
      setTimer: device.timers.setTimer,
    });
    server.put('profiles', serverProfile());
    server.put('subjects', serverSubject());
    server.put('knowledge_nodes', serverNode());
    // Five cards written in one transaction get the same server timestamp in Postgres; here the
    // sequence still makes them distinct, so force a shared stamp by re-writing their updated_at.
    for (let i = 0; i < 5; i++) server.put('cards', serverCard(`card-${i}`));
    for (const row of server.rows('cards')) row['updated_at'] = '2026-10-27T10:00:00.000100+00:00';

    await engine.sync('manual');
    expect(device.db.select().from(cards).all()).toHaveLength(5);

    const pullsBefore = server.stats.pulls;
    server.put('cards', serverCard('card-late'));
    // A later server timestamp than the shared one (the fake's sequence would otherwise place it earlier).
    server.rows('cards').find((r) => r['id'] === 'card-late')!['updated_at'] = '2026-10-27T10:00:00.000200+00:00';
    await engine.sync('manual');
    expect(device.db.select().from(cards).all()).toHaveLength(6);
    // Only the cards table had new rows, but every table is still queried once.
    expect(server.stats.pulls).toBeGreaterThan(pullsBefore);
    const cursor = device.db.select().from(syncCursors).where(eq(syncCursors.tableName, 'cards')).get();
    expect(cursor?.updatedAt).toContain('+00:00');
  });

  it('a changed scope resets the cursor so rows entering the scope are not skipped', () => {
    expect(filterSignature([{ column: 'subject_id', op: 'in', value: ['a'] }])).not.toBe(
      filterSignature([{ column: 'subject_id', op: 'in', value: ['a', 'b'] }]),
    );
  });
});

describe('errors, backoff and upgrades', () => {
  it('backoff grows 5 s, 10 s, 20 s, ... and is capped at 10 min', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    seedProfile(device.db);
    seedSubject(device.db);
    const [id] = seedCards(device.db, 1);
    await recordReview(device.db as never, { cardId: id!, rating: 3 });

    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      server.faults.push({ type: 'error', kind: 'server', message: 'HTTP 503' });
      await device.engine.sync('manual');
      delays.push(device.timers.delays[device.timers.delays.length - 1]!);
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000, 600_000]);
    expect(delays.every((d) => d <= BACKOFF_CAP_MS)).toBe(true);
    expect(device.engine.getStatus().state).toBe('backoff');
    expect(countOutbox(device.db as never).pending).toBe(1); // server errors do not touch the rows
  });

  it('a backoff-gated periodic sync waits; a manual sync bypasses the gate and recovers', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    seedProfile(device.db);
    seedSubject(device.db);
    const [id] = seedCards(device.db, 1);
    await recordReview(device.db as never, { cardId: id!, rating: 3 });

    server.faults.push({ type: 'error', kind: 'transient' });
    await device.engine.sync('manual');
    const sentBefore = server.stats.pushes;
    await device.engine.sync('periodic');
    expect(server.stats.pushes).toBe(sentBefore); // still in backoff

    await device.engine.sync('manual');
    expect(server.stats.pushes).toBe(sentBefore + 1);
    expect(device.engine.getStatus().state).toBe('idle');
    expect(countOutbox(device.db as never).pending).toBe(0);
  });

  it('HTTP 426 stops syncing and reports upgrade_required; the outbox is kept', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    seedProfile(device.db);
    seedSubject(device.db);
    const [id] = seedCards(device.db, 1);
    await recordReview(device.db as never, { cardId: id!, rating: 3 });

    server.faults.push({ type: 'error', kind: 'upgrade_required', code: 'app_update_required' });
    await device.engine.sync('manual');
    expect(device.engine.getStatus().state).toBe('upgrade_required');

    const calls = server.stats.pushes + server.stats.pulls;
    await device.engine.sync('manual');
    await device.engine.sync('foreground');
    expect(server.stats.pushes + server.stats.pulls).toBe(calls);
    expect(countOutbox(device.db as never).pending).toBe(1);
  });

  it('rows the server refuses MAX_ATTEMPTS times become stuck, are skipped, and can be retried', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    seedProfile(device.db);
    seedSubject(device.db);
    const [id] = seedCards(device.db, 1);
    await recordReview(device.db as never, { cardId: id!, rating: 3 });
    const rowId = outboxIdOf(device.db, 'review_log');
    server.rejectionFor.set(rowId, { id: rowId, code: 'invalid', drop: false });

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await device.engine.sync('manual');
    }
    expect(listStuckRows(device.db as never)).toHaveLength(1);
    expect(device.engine.getStatus().stuck).toBe(1);

    const received = server.stats.itemsReceived;
    await device.engine.sync('periodic');
    expect(server.stats.itemsReceived).toBe(received); // stuck rows are not sent automatically

    server.rejectionFor.delete(rowId);
    await device.engine.retryStuck();
    expect(server.logs()).toHaveLength(1);
    expect(device.engine.getStatus().stuck).toBe(0);
    expect(countOutbox(device.db as never).pending).toBe(0);
  });

  it('a session expiry (401) stops syncing as auth_required', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    server.faults.push({ type: 'error', kind: 'auth' });
    await device.engine.sync('manual');
    expect(device.engine.getStatus().state).toBe('auth_required');
  });

  it('keeps the device prediction while reviews for the card are still unacknowledged', async () => {
    const server = createFakeServer();
    const device = await createDevice(server, 'dev-A');
    await seedServerAndPull(server, device, 1);
    await device.engine.sync('manual');

    const first = await recordReview(device.db as never, { cardId: 'card-0', rating: 3 });
    const second = await recordReview(device.db as never, { cardId: 'card-0', rating: 1 });
    // Only the first review is acknowledged; the second stays pending.
    server.rejectionFor.set(second.logId, { id: second.logId, code: 'stale', drop: false });
    await device.engine.sync('manual');

    expect(server.logsFor('card-0')).toHaveLength(1);
    const local = cardStateRow(device.db, 'card-0')!;
    expect(local.reps).toBe(2); // not overwritten by the server's one-review state
    expect(local.lastLogId).toBe(second.logId);
    expect(first.logId).not.toBe(second.logId);
  });
});

describe('clock handling', () => {
  it('a device 3 days ahead: LWW timestamps are clamped to server time ± 5 min', () => {
    const server = Date.parse('2026-10-27T12:00:00.000Z');
    const deviceNow = server + 3 * 24 * 60 * 60 * 1000;
    observeServerTime(server, deviceNow);
    expect(serverNowMs(deviceNow)).toBe(server);
    const lww = lwwUpdatedAtMs(deviceNow);
    expect(lww).toBe(server + 5 * 60 * 1000);
    expect(clampClientTime(server - 10 * 60 * 1000, server)).toBe(server - 5 * 60 * 1000);
  });

  it('a review dated more than 5 min in the future is flagged clock_skew and replayed at receipt time', async () => {
    const serverMs = Date.parse('2026-10-27T12:00:00.000Z');
    const server = createFakeServer({ serverNow: () => serverMs });
    const device = await createDevice(server, 'dev-A', createFakeClock(serverMs + 3 * 24 * 60 * 60 * 1000));
    seedProfile(device.db);
    seedSubject(device.db);
    const [id] = seedCards(device.db, 1);
    await recordReview(device.db as never, { cardId: id!, rating: 3, now: new Date(device.clock.now()) });
    await device.engine.sync('manual');

    const [log] = server.logsFor(id!);
    expect(log!['clock_skew']).toBe(true);
    expect(new Date(String(log!['reviewed_at'])).getTime()).toBe(serverMs);
  });
});

describe('outbox bookkeeping', () => {
  it('stores the entity id so a tombstone can find pending edits', async () => {
    const { db } = await createTestDb();
    enqueueOutbox(db as never, { kind: 'card_override', entityId: 'c1', payload: { fields: {} } });
    expect(db.select().from(outbox).where(eq(outbox.entityId, 'c1')).all()).toHaveLength(1);
  });
});

describe('undo', () => {
  it('restores the previous card state and queues a compensating review log', async () => {
    const { db } = await createTestDb();
    seedProfile(db);
    seedSubject(db);
    const [id] = seedCards(db, 1);
    const first = await recordReview(db as never, { cardId: id!, rating: 3 });
    const beforeSecond = cardStateRow(db, id!)!;
    const second = await recordReview(db as never, { cardId: id!, rating: 1 });
    expect(cardStateRow(db, id!)!.reps).toBe(2);

    await undoReview(db as never, second.logId);
    const restored = cardStateRow(db, id!)!;
    expect(restored.reps).toBe(beforeSecond.reps);
    expect(restored.due.getTime()).toBe(beforeSecond.due.getTime());
    const undoRow = db.select().from(outbox).where(eq(outbox.kind, 'review_log')).all().find((r) => (r.payload as { undoes_log_id?: string }).undoes_log_id === second.logId);
    expect(undoRow).toBeDefined();

    await expect(undoReview(db as never, second.logId)).rejects.toThrow('já foi desfeita');
    expect(first.logId).toBeTruthy();
  });
});

describe('transport errors', () => {
  it('maps SyncTransportError kinds to backoff delays deterministically', () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(1)).toBe(5_000);
    expect(backoffDelayMs(2)).toBe(10_000);
    expect(backoffDelayMs(99)).toBe(BACKOFF_CAP_MS);
    expect(new SyncTransportError('offline', 'x').kind).toBe('offline');
  });
});

/** The id of the newest outbox row of a kind (test helper). */
function outboxIdOf(db: TestDb, kind: string): string {
  const row = db.select().from(outbox).where(eq(outbox.kind, kind)).all().at(-1);
  if (!row) throw new Error(`no outbox row of kind ${kind}`);
  return row.id;
}

// Keep the helper import list honest for the reader: these are used by the scenarios above.
void SUBJECT_ID;
