// Sync engine (mobile-app.md §4.3, ADR 0007). Pure TypeScript over an injected transport and the
// Drizzle database, so the same code runs on device and in Jest with a fake server.
//
// Rules implemented here:
// 1. Push before pull.
// 2. Idempotency: outbox ids are client UUIDs; acked rows are deleted; the server dedupes replays.
// 3. Reviews are append-only; card_states are overwritten by the server's authoritative value on
//    ack, unless the device still has unacknowledged reviews for that card (its prediction is newer).
// 4. Editable fields are LWW; pending local edits overlay pulled rows until acknowledged.
// 5. Tombstones delete the local row, its cascade children and any pending outbox edits for it.
// 6. Pull is incremental by (updated_at, ...pk) per table, within the current scope.
// 7. Failed pushes back off exponentially (5 s -> 10 min). A row the server rejects MAX_ATTEMPTS
//    times is stuck: kept, surfaced, skipped by automatic pushes until the user retries it.
// 8. HTTP 426 stops syncing and reports `upgrade_required`.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { AppDb, Db } from '../client';
import { countOutbox, dropOutboxForEntity, listPushableRows, retryStuckRows, type OutboxRow } from '../outbox';
import { cardStates, outbox, subjects, subjectUserSettings, syncCursors } from '../schema';
import { PULL_PAGE_SIZE, PUSH_BATCH_SIZE, SYNC_SCHEMA_VERSION } from './constants';
import { observeServerTime, parseInstantMs } from './clock';
import { SyncTransportError, backoffDelayMs } from './errors';
import { dbColumnName, isInstantColumn, keyValues, selectColumnsFor, serverRowToValues } from './mapping';
import { OVERLAY_TABLE_BY_KIND, PULL_TABLES, planWindowAround, type PullContext, type PullTableDef } from './registry';
import type { PullCursor, PullFilter, PushItem, PushResponse, SyncTransport } from './transport';
import { localDateOf } from '../../lib/dates';

export type SyncReason =
  | 'start'
  | 'foreground'
  | 'reconnect'
  | 'session_end'
  | 'periodic'
  | 'local_write'
  | 'widget'
  | 'manual'
  | 'backoff';

export type SyncState =
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'backoff'
  | 'upgrade_required'
  | 'auth_required'
  | 'stopped';

export interface SyncStatus {
  state: SyncState;
  /** Rows waiting to be sent. */
  pending: number;
  /** Rows the server rejected too many times (surface in Configurações → Sincronização). */
  stuck: number;
  /** Consecutive failed attempts (drives the backoff). */
  failures: number;
  lastSyncedAt: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
}

export interface SyncEngineOptions {
  db: AppDb;
  transport: SyncTransport;
  /** Stable per-install id (sent as `device_id`). */
  deviceId: string;
  /** Epoch ms. Injected for tests. */
  now?: () => number;
  /** Schedules a backoff retry; returns a cancel function. Injected for tests. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Overrides for tests (defaults: PUSH_BATCH_SIZE / PULL_PAGE_SIZE). */
  pushBatchSize?: number;
  pullPageSize?: number;
}

export interface SyncEngine {
  /** Runs one sync (push, then pull). Concurrent calls are coalesced into one run. Never rejects. */
  sync(reason?: SyncReason): Promise<void>;
  /** Clears the failure count of stuck rows and syncs now. */
  retryStuck(): Promise<void>;
  getStatus(): SyncStatus;
  subscribe(listener: (status: SyncStatus) => void): () => void;
  /** Cancels timers and stops every future run. */
  stop(): void;
}

/** Reasons that bypass an active backoff (the user or the connectivity changed). */
const BACKOFF_BYPASS: ReadonlySet<SyncReason> = new Set(['manual', 'foreground', 'reconnect', 'start']);
const TERMINAL: ReadonlySet<SyncState> = new Set(['upgrade_required', 'auth_required', 'stopped']);

const defaultTimer = (fn: () => void, ms: number) => {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
};

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { db, transport, deviceId } = options;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? defaultTimer;
  const pushBatchSize = options.pushBatchSize ?? PUSH_BATCH_SIZE;
  const pullPageSize = options.pullPageSize ?? PULL_PAGE_SIZE;

  let state: SyncState = 'idle';
  let failures = 0;
  let lastSyncedAt: number | null = null;
  let lastError: string | null = null;
  let nextRetryAt: number | null = null;
  let cancelRetry: (() => void) | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;
  let rerunRequested = false;
  const listeners = new Set<(status: SyncStatus) => void>();

  function getStatus(): SyncStatus {
    const counts = countOutbox(db);
    return {
      state,
      pending: counts.pending,
      stuck: counts.stuck,
      failures,
      lastSyncedAt,
      lastError,
      nextRetryAt,
    };
  }

  function setState(next: SyncState): void {
    state = next;
    if (listeners.size === 0) return;
    const status = getStatus();
    for (const listener of listeners) listener(status);
  }

  function cancelScheduledRetry(): void {
    cancelRetry?.();
    cancelRetry = null;
    nextRetryAt = null;
  }

  function scheduleRetry(delayMs: number): void {
    cancelScheduledRetry();
    nextRetryAt = now() + delayMs;
    cancelRetry = setTimer(() => {
      cancelRetry = null;
      nextRetryAt = null;
      void sync('backoff');
    }, delayMs);
  }

  function handleFailure(error: unknown): void {
    const err =
      error instanceof SyncTransportError ? error : new SyncTransportError('transient', errorMessage(error));
    lastError = err.message;
    switch (err.kind) {
      case 'upgrade_required':
        cancelScheduledRetry();
        setState('upgrade_required');
        return;
      case 'auth':
        cancelScheduledRetry();
        setState('auth_required');
        return;
      case 'offline':
        // Nothing to retry on a timer: the connectivity listener (reconnect) is the trigger.
        setState('offline');
        return;
      case 'transient':
      case 'server':
        failures += 1;
        scheduleRetry(backoffDelayMs(failures));
        setState('backoff');
        return;
    }
  }

  async function pushAll(): Promise<void> {
    let after: { createdAt: number; id: string } | null = null;
    for (;;) {
      const rows = listPushableRows(db, after, pushBatchSize);
      if (rows.length === 0) return;
      const last = rows[rows.length - 1]!;
      after = { createdAt: last.createdAt, id: last.id };

      const response = await transport.push({
        schema_version: SYNC_SCHEMA_VERSION,
        device_id: deviceId,
        items: rows.map(toPushItem),
      });
      observeServerTime(response.server_time, now());
      applyPushResponse(rows, response);
    }
  }

  function applyPushResponse(rows: OutboxRow[], response: PushResponse): void {
    const acked = new Set(response.acked);
    const rejected = new Map(response.rejected.map((r) => [r.id, r]));

    db.transaction((tx) => {
      for (const row of rows) {
        if (acked.has(row.id)) {
          tx.delete(outbox).where(eq(outbox.id, row.id)).run();
          continue;
        }
        const rejection = rejected.get(row.id);
        if (rejection?.drop) {
          tx.delete(outbox).where(eq(outbox.id, row.id)).run();
          continue;
        }
        // Per-row refusal (or silently missing from the ack): counts toward MAX_ATTEMPTS.
        tx.update(outbox)
          .set({ attempts: row.attempts + 1, lastError: rejection?.code ?? 'no_ack' })
          .where(eq(outbox.id, row.id))
          .run();
      }

      const touched = response.card_states
        .map((cs) => cs['card_id'])
        .filter((id): id is string => typeof id === 'string');
      if (touched.length === 0) return;

      // Cards that still have unacknowledged reviews keep the device prediction (it is newer).
      const pendingCards = new Set(
        tx
          .select({ entityId: outbox.entityId })
          .from(outbox)
          .where(and(eq(outbox.kind, 'review_log'), inArray(outbox.entityId, touched)))
          .all()
          .map((r) => r.entityId),
      );
      const stamp = new Date(now());
      for (const cs of response.card_states) {
        const values = serverRowToValues(cardStates, cs, stamp);
        if (pendingCards.has(String(values['cardId']))) continue;
        tx.insert(cardStates)
          .values(values as never)
          .onConflictDoUpdate({ target: [cardStates.userId, cardStates.cardId], set: values as never })
          .run();
      }
    });
  }

  async function pullAll(): Promise<void> {
    const planWindow = planWindowAround(localDateOf(now()));
    const ctx: PullContext = {
      activeSubjectIds: () => readActiveSubjectIds(db),
      planWindow,
    };

    for (const def of PULL_TABLES) {
      const filters: PullFilter[] | null = def.filters ? def.filters(ctx) : [];
      if (filters === null) continue;
      const signature = filterSignature(filters);
      const serverPk = def.pk.map((key) => dbColumnName(def.table, key));
      const select = selectColumnsFor(def.table);
      let cursor = readCursor(db, def.name, signature);

      for (;;) {
        const response = await transport.pull({
          table: def.name,
          select,
          pk: serverPk,
          cursor,
          filters,
          limit: pullPageSize,
        });
        observeServerTime(response.serverTime ?? null, now());
        if (response.rows.length === 0) break;

        cursor = applyPullPage(def, response.rows, signature, now());
        if (response.rows.length < pullPageSize) break;
      }
    }
  }

  function applyPullPage(def: PullTableDef, rows: Record<string, unknown>[], signature: string, nowMs: number): PullCursor {
    const pulledAt = new Date(nowMs);
    let last: PullCursor = { updatedAt: null, key: null };

    db.transaction((tx) => {
      for (const raw of rows) {
        const values = serverRowToValues(def.table, raw, pulledAt);
        const key = keyValues(values, def.pk);
        const entityId = String(values[def.pk[def.pk.length - 1]!]);

        const pendingReviews =
          def.name === 'card_states' &&
          tx
            .select({ id: outbox.id })
            .from(outbox)
            .where(and(eq(outbox.kind, 'review_log'), eq(outbox.entityId, entityId)))
            .limit(1)
            .get() !== undefined;

        if (raw['deleted_at'] !== null && raw['deleted_at'] !== undefined) {
          // Tombstone: delete wins over pending edits.
          tx.delete(def.table)
            .where(and(...def.pk.map((k) => eq(column(def.table, k), values[k] as never))))
            .run();
          for (const cascade of def.cascade ?? []) {
            tx.delete(cascade.child).where(eq(column(cascade.child, cascade.column), entityId)).run();
          }
          dropOutboxForEntity(tx, entityId);
        } else if (pendingReviews) {
          // Unacknowledged reviews make the device prediction newer than the server's state:
          // keep it until the ack arrives (the ack path follows the same rule).
        } else {
          const merged = applyOverlays(tx, def, entityId, values);
          const setValues = omit(merged, def.pk);
          tx.insert(def.table)
            .values(merged as never)
            .onConflictDoUpdate({ target: def.pk.map((k) => column(def.table, k)), set: setValues as never })
            .run();
        }

        last = { updatedAt: String(raw['updated_at']), key };
      }

      tx.insert(syncCursors)
        .values({
          tableName: def.name,
          updatedAt: last.updatedAt,
          lastId: JSON.stringify(last.key),
          filterSig: signature,
        })
        .onConflictDoUpdate({
          target: syncCursors.tableName,
          set: { updatedAt: last.updatedAt, lastId: JSON.stringify(last.key), filterSig: signature },
        })
        .run();
    });

    return last;
  }

  async function runOnce(reason: SyncReason): Promise<boolean> {
    const bypass = BACKOFF_BYPASS.has(reason);
    if (!bypass && nextRetryAt !== null && now() < nextRetryAt) {
      return false;
    }
    if (bypass) cancelScheduledRetry();

    setState('syncing');
    try {
      await pushAll();
      await pullAll();
      failures = 0;
      lastError = null;
      lastSyncedAt = now();
      setState('idle');
      return true;
    } catch (error) {
      handleFailure(error);
      return false;
    }
  }

  function sync(reason: SyncReason = 'manual'): Promise<void> {
    if (stopped || TERMINAL.has(state)) return Promise.resolve();
    if (running) {
      rerunRequested = true;
      return running;
    }
    running = (async () => {
      try {
        let again = true;
        while (again && !stopped) {
          rerunRequested = false;
          const ok = await runOnce(reason);
          // Trigger that arrived mid-run: run once more, but never spin while failing.
          again = ok && rerunRequested && !TERMINAL.has(state);
          reason = 'local_write';
        }
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    sync,
    async retryStuck() {
      retryStuckRows(db);
      await sync('manual');
    },
    getStatus,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      stopped = true;
      cancelScheduledRetry();
      setState('stopped');
    },
  };
}

// ---------- helpers ----------

function toPushItem(row: OutboxRow): PushItem {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    created_at: new Date(row.createdAt).toISOString(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function column(table: SQLiteTable, key: string): AnySQLiteColumn {
  const col = getTableColumns(table)[key];
  if (!col) throw new Error(`Unknown column "${key}"`);
  return col as AnySQLiteColumn;
}

function omit(values: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const key of keys) delete out[key];
  return out;
}

export function filterSignature(filters: PullFilter[]): string {
  return JSON.stringify(
    filters.map((f) => ({
      column: f.column,
      op: f.op,
      value: Array.isArray(f.value) ? [...f.value].sort() : f.value,
    })),
  );
}

function readCursor(db: Db, table: string, signature: string): PullCursor {
  const row = db.select().from(syncCursors).where(eq(syncCursors.tableName, table)).get();
  if (!row || !row.updatedAt || row.filterSig !== signature) {
    return { updatedAt: null, key: null };
  }
  return { updatedAt: row.updatedAt, key: JSON.parse(row.lastId ?? '[]') as (string | number)[] };
}

function readActiveSubjectIds(db: Db): string[] {
  return db
    .select({ id: subjects.id })
    .from(subjects)
    .leftJoin(subjectUserSettings, eq(subjectUserSettings.subjectId, subjects.id))
    .where(and(isNull(subjects.deletedAt), isNull(subjectUserSettings.archivedAt)))
    .all()
    .map((r) => r.id);
}

/**
 * Applies pending local edits (outbox rows of overlay kinds for this entity) on top of a pulled row.
 * Field values come from the outbox payload `fields` (Drizzle keys); instants are re-hydrated.
 */
function applyOverlays(
  tx: Db,
  def: PullTableDef,
  entityId: string,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const pending = tx
    .select()
    .from(outbox)
    .where(eq(outbox.entityId, entityId))
    .orderBy(asc(outbox.createdAt), asc(outbox.id))
    .all();

  let merged = values;
  for (const row of pending) {
    if (OVERLAY_TABLE_BY_KIND[row.kind as keyof typeof OVERLAY_TABLE_BY_KIND] !== def.name) continue;
    const fields = (row.payload as { fields?: Record<string, unknown> } | null)?.fields;
    if (!fields) continue;
    const coerced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      const col = getTableColumns(def.table)[key];
      if (!col || col.name === '_pulled_at') continue;
      coerced[key] = isInstantColumn(col) && typeof value === 'string' ? new Date(parseInstantMs(value)) : value;
    }
    merged = { ...merged, ...coerced };
  }
  return merged;
}
