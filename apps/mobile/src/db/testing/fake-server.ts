// In-memory stand-in for the Supabase side of the sync protocol (api.md §4.1, §3.2, ADR 0007).
// Test-only. It replays review logs with ts-fsrs to derive card_states (like the server does),
// implements PostgREST-style pulls (filters + (updated_at, ...pk) cursor), and can inject faults:
// lost acks, offline errors, 426, per-row rejections and server errors.
import { createEmptyCard, fsrs, type Grade } from 'ts-fsrs';
import { SyncTransportError, type SyncErrorKind } from '../sync/errors';
import type {
  PullFilter,
  PullRequest,
  PullResponse,
  PushItem,
  PushRequest,
  PushResponse,
  PushRejection,
  SyncTransport,
} from '../sync/transport';

type Row = Record<string, unknown>;

/** Server-side primary keys (snake_case) per table. */
export const SERVER_PK: Record<string, string[]> = {
  profiles: ['id'],
  study_preferences: ['user_id'],
  subjects: ['id'],
  subject_user_settings: ['user_id', 'subject_id'],
  knowledge_nodes: ['id'],
  node_sources: ['id'],
  node_user_settings: ['user_id', 'node_id'],
  glossary_terms: ['id'],
  notes: ['id'],
  note_highlights: ['id'],
  cards: ['id'],
  card_overrides: ['user_id', 'card_id'],
  card_states: ['user_id', 'card_id'],
  goals: ['id'],
  exams: ['id'],
  exam_scope_nodes: ['exam_id', 'node_id'],
  plan_items: ['id'],
  mistakes: ['id'],
  questions: ['id'],
  quizzes: ['id'],
  quiz_attempts: ['id'],
  attempt_answers: ['id'],
  feed_items: ['id'],
  mastery: ['user_id', 'node_id'],
  daily_activity: ['user_id', 'local_date'],
  streaks: ['user_id'],
  achievements: ['user_id', 'code'],
};

export type Fault =
  | { type: 'error'; kind: SyncErrorKind; message?: string; code?: string }
  /** Process the batch, then lose the response (the classic lost ack). */
  | { type: 'lose-ack' }
  /** Answer the batch but refuse these ids (drop=false keeps them in the outbox). */
  | { type: 'reject'; ids: string[]; code: string; drop?: boolean };

/** Monotonic server timestamp with microsecond precision, like Postgres `timestamptz`. */
export function stampOf(seq: number): string {
  return `2026-10-27T10:00:00.${String(seq).padStart(6, '0')}+00:00`;
}

function seqOf(stamp: string): number {
  const frac = stamp.slice(stamp.indexOf('.') + 1, stamp.indexOf('.') + 7);
  return Number(frac);
}

function keyOf(row: Row, pk: string[]): string {
  return pk.map((c) => String(row[c])).join('|');
}

export interface FakeServer {
  transport: SyncTransport;
  /** Inserts or replaces a row. `updated_at` is assigned from the server sequence. */
  put(table: string, row: Row): void;
  tombstone(table: string, id: string): void;
  rows(table: string): Row[];
  logs(): Row[];
  logsFor(cardId: string): Row[];
  cardState(cardId: string, userId?: string): Row | undefined;
  /** Faults consumed by the next push calls, in order. */
  faults: Fault[];
  stats: { pushes: number; itemsReceived: number; maxBatch: number; duplicateReceipts: number; itemKinds: Record<string, number>; pulls: number };
  /** Receipt-side server clock (epoch ms). */
  serverNow: () => number;
  setServerNow(ms: number): void;
  rejectionFor: Map<string, PushRejection>;
}

export function createFakeServer(options: { serverNow?: () => number; userId?: string } = {}): FakeServer {
  const tables = new Map<string, Map<string, Row>>();
  const reviewLogs = new Map<string, Row>();
  const seenItemIds = new Set<string>();
  let seq = 0;
  let serverClock = options.serverNow ?? (() => Date.parse('2026-10-27T12:00:00.000Z'));
  const rejectionFor = new Map<string, PushRejection>();
  const f = fsrs();

  const table = (name: string) => {
    let t = tables.get(name);
    if (!t) {
      t = new Map();
      tables.set(name, t);
    }
    return t;
  };

  const put = (name: string, row: Row) => {
    seq += 1;
    const stored = { deleted_at: null, ...row, updated_at: stampOf(seq) };
    table(name).set(keyOf(stored, SERVER_PK[name] ?? ['id']), stored);
  };

  const replayCard = (cardId: string, userId: string): Row | null => {
    const logs = [...reviewLogs.values()]
      .filter((l) => l['card_id'] === cardId && l['undoes_log_id'] === null)
      .sort((a, b) => String(a['reviewed_at']).localeCompare(String(b['reviewed_at'])) || String(a['id']).localeCompare(String(b['id'])));
    if (logs.length === 0) return null;
    // Undo rows cancel their target: drop both.
    const undone = new Set([...reviewLogs.values()].filter((l) => l['undoes_log_id']).map((l) => l['undoes_log_id'] as string));
    const effective = logs.filter((l) => !undone.has(String(l['id'])));
    if (effective.length === 0) return null;
    let card = createEmptyCard(new Date(String(effective[0]!['reviewed_at'])));
    let last: Row | null = null;
    for (const log of effective) {
      const at = new Date(String(log['reviewed_at']));
      const result = f.next(card, at, log['rating'] as Grade);
      card = result.card;
      last = log;
    }
    return {
      user_id: userId,
      card_id: cardId,
      subject_id: cardSubject(cardId),
      due: card.due.toISOString(),
      stability: card.stability,
      difficulty: card.difficulty,
      elapsed_days: card.elapsed_days,
      scheduled_days: card.scheduled_days,
      reps: card.reps,
      lapses: card.lapses,
      state: card.state,
      learning_steps: card.learning_steps,
      last_review: card.last_review ? card.last_review.toISOString() : null,
      suspended: false,
      hidden: false,
      is_leech: false,
      introduced_at: null,
      last_log_id: last ? last['id'] : null,
      updated_at: stampOf(++seq),
    };
  };

  const cardSubject = (cardId: string): string => {
    const card = table('cards').get(cardId);
    return String(card?.['subject_id'] ?? 'unknown-subject');
  };

  const processItem = (item: PushItem, receivedAtMs: number, touched: Set<string>, userId: string) => {
    if (item.kind !== 'review_log') {
      // Other kinds are accepted and ignored by the fake (the engine tests check the outbox side).
      return;
    }
    const payload = item.payload as Row;
    const cardId = String(payload['card_id']);
    const clientReviewed = Date.parse(String(payload['reviewed_at']));
    let reviewedAt = clientReviewed;
    let clockSkew = false;
    const tolerance = 5 * 60_000;
    if (clientReviewed > receivedAtMs + tolerance) {
      clockSkew = true;
      reviewedAt = receivedAtMs; // replayed at receipt time
    }
    reviewLogs.set(item.id, {
      id: item.id,
      user_id: userId,
      card_id: cardId,
      rating: payload['rating'],
      reviewed_at: new Date(reviewedAt).toISOString(),
      client_reviewed_at: payload['reviewed_at'],
      elapsed_days: payload['elapsed_days'] ?? null,
      scheduled_days: payload['scheduled_days'] ?? null,
      undoes_log_id: payload['undoes_log_id'] ?? null,
      clock_skew: clockSkew,
    });
    touched.add(cardId);
  };

  const transport: SyncTransport = {
    async push(req: PushRequest): Promise<PushResponse> {
      const fault = faults.shift();
      if (fault?.type === 'error') {
        throw new SyncTransportError(fault.kind, fault.message ?? `fault ${fault.kind}`, fault.code);
      }
      stats.pushes += 1;
      stats.maxBatch = Math.max(stats.maxBatch, req.items.length);
      stats.itemsReceived += req.items.length;
      const receivedAt = serverClock();
      const touched = new Set<string>();
      const acked: string[] = [];
      const rejected: PushRejection[] = [];
      for (const item of req.items) {
        stats.itemKinds[item.kind] = (stats.itemKinds[item.kind] ?? 0) + 1;
        if (seenItemIds.has(item.id)) {
          stats.duplicateReceipts += 1;
        }
        seenItemIds.add(item.id);
        const forced = rejectionFor.get(item.id) ?? (fault?.type === 'reject' && fault.ids.includes(item.id) ? { id: item.id, code: fault.code, drop: fault.drop ?? false } : undefined);
        if (forced) {
          rejected.push(forced);
          continue;
        }
        if (reviewLogs.has(item.id)) {
          // Idempotent replay: already stored, acknowledged again.
          acked.push(item.id);
          continue;
        }
        processItem(item, receivedAt, touched, options.userId ?? 'user-1');
        acked.push(item.id);
      }
      const cardStates: Row[] = [];
      for (const cardId of touched) {
        const state = replayCard(cardId, options.userId ?? 'user-1');
        if (state) {
          table('card_states').set(keyOf(state, SERVER_PK.card_states!), state);
          cardStates.push(state);
        }
      }
      if (fault?.type === 'lose-ack') {
        throw new SyncTransportError('offline', 'connection lost after the server processed the batch');
      }
      return {
        acked,
        rejected,
        card_states: cardStates,
        server_time: new Date(receivedAt).toISOString(),
      };
    },

    async pull(req: PullRequest): Promise<PullResponse> {
      const fault = faults.shift();
      if (fault?.type === 'error') {
        throw new SyncTransportError(fault.kind, fault.message ?? `fault ${fault.kind}`, fault.code);
      }
      stats.pulls += 1;
      const rows = [...(tables.get(req.table)?.values() ?? [])].filter((row) => req.filters.every((f) => matches(row, f)));
      const cursorSeq = req.cursor.updatedAt !== null ? seqOf(req.cursor.updatedAt) : null;
      const after = (row: Row): boolean => {
        if (cursorSeq === null) return true;
        const s = seqOf(String(row['updated_at']));
        if (s !== cursorSeq) return s > cursorSeq;
        const key = req.pk.map((c) => String(row[c]));
        const cur = req.cursor.key ?? [];
        for (let i = 0; i < req.pk.length; i++) {
          if (key[i] !== String(cur[i])) return key[i]! > String(cur[i]);
        }
        return false;
      };
      const ordered = rows
        .filter(after)
        .sort((a, b) => seqOf(String(a['updated_at'])) - seqOf(String(b['updated_at'])) || keyOf(a, req.pk).localeCompare(keyOf(b, req.pk)));
      return { rows: ordered.slice(0, req.limit).map((r) => pick(r, req.select)) };
    },
  };

  const faults: Fault[] = [];
  const stats: FakeServer['stats'] = { pushes: 0, itemsReceived: 0, maxBatch: 0, duplicateReceipts: 0, itemKinds: {}, pulls: 0 };

  return {
    transport,
    put(name, row) {
      put(name, row);
    },
    tombstone(name, id) {
      const existing = table(name).get(id);
      if (!existing) return;
      seq += 1;
      table(name).set(id, { ...existing, deleted_at: new Date(serverClock()).toISOString(), updated_at: stampOf(seq) });
    },
    rows: (name) => [...(tables.get(name)?.values() ?? [])],
    logs: () => [...reviewLogs.values()],
    logsFor: (cardId) => [...reviewLogs.values()].filter((l) => l['card_id'] === cardId),
    cardState: (cardId, userId = options.userId ?? 'user-1') => table('card_states').get(`${userId}|${cardId}`),
    faults,
    stats,
    serverNow: () => serverClock(),
    setServerNow(ms) {
      serverClock = () => ms;
    },
    rejectionFor,
  };
}

function matches(row: Row, filter: PullFilter): boolean {
  const value = row[filter.column];
  switch (filter.op) {
    case 'in':
      return (filter.value as string[]).includes(String(value));
    case 'eq':
      return String(value) === String(filter.value);
    case 'gte':
      return String(value) >= String(filter.value);
    case 'lte':
      return String(value) <= String(filter.value);
  }
}

function pick(row: Row, select: string[]): Row {
  const out: Row = {};
  for (const c of select) out[c] = row[c] ?? null;
  return out;
}

