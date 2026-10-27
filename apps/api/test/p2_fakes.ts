// In-memory fakes for the Phase 2 handler tests. The query builder implements the supabase-js subset the
// functions use: select/insert/upsert/update/delete, eq/neq/in/is/gt/gte/lt/lte, order, limit, maybeSingle,
// and awaiting the builder. Unique constraints are declared per table (23505), as in Postgres.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiDeps } from '../src/shared/deps.ts';
import type { BroadcastMessage, P2Deps, UserRpc } from '../src/shared-p2/deps.ts';
import { uuidV7 } from '@studify/shared';

export type Row = Record<string, unknown>;
type Err = { code?: string; message: string; hint?: string | null; details?: string | null } | null;
type Result = { data: unknown; error: Err };

export interface FakeConfig {
  tables?: Record<string, Row[]>;
  uniques?: Record<string, string[][]>;
  users?: Record<string, { id: string; email: string | null }>;
  rpcs?: Record<string, (args: Row) => { data: unknown; error: Err }>;
}

export interface FakeDb {
  tables: Record<string, Row[]>;
  /** Clock for created_at on inserted rows (kept in step with the deps clock). */
  clock: () => string;
  rpcCalls: { name: string; args: Row }[];
  auth: { getUser(jwt: string): Promise<{ data: { user: { id: string; email: string | null } | null }; error: Err }> };
  from(table: string): Builder;
  rpc(name: string, args: Row): Promise<Result>;
  schema(name: string): { from(table: string): Builder; rpc(name: string, args: Row): Promise<Result> };
}

type Pred = (r: Row) => boolean;

function val(r: Row, c: string): unknown {
  return r[c] ?? null;
}

function cmp(a: unknown, b: unknown): number {
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

export class Builder implements PromiseLike<Result> {
  #op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  #payload: Row | Row[] | null = null;
  #conflict: string[] | null = null;
  #ignore = false;
  #returning = false;
  #preds: Pred[] = [];
  #order: { col: string; asc: boolean } | null = null;
  #limit: number | null = null;
  #single = false;

  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
    private readonly uniques: Record<string, string[][]>,
  ) {}

  select(_cols?: string): this {
    if (this.#op === 'select') return this;
    this.#returning = true;
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.#op = 'insert';
    this.#payload = payload;
    return this;
  }
  upsert(payload: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.#op = 'upsert';
    this.#payload = payload;
    this.#conflict = opts.onConflict ? opts.onConflict.split(',') : null;
    this.#ignore = opts.ignoreDuplicates === true;
    return this;
  }
  update(patch: Row): this {
    this.#op = 'update';
    this.#payload = patch;
    return this;
  }
  delete(): this {
    this.#op = 'delete';
    return this;
  }
  eq(c: string, v: unknown): this {
    this.#preds.push((r) => val(r, c) === v);
    return this;
  }
  neq(c: string, v: unknown): this {
    this.#preds.push((r) => val(r, c) !== v);
    return this;
  }
  in(c: string, values: unknown[]): this {
    this.#preds.push((r) => values.includes(val(r, c)));
    return this;
  }
  is(c: string, v: null): this {
    this.#preds.push((r) => val(r, c) === v);
    return this;
  }
  gt(c: string, v: unknown): this {
    this.#preds.push((r) => cmp(val(r, c), v) > 0);
    return this;
  }
  gte(c: string, v: unknown): this {
    this.#preds.push((r) => cmp(val(r, c), v) >= 0);
    return this;
  }
  lt(c: string, v: unknown): this {
    this.#preds.push((r) => cmp(val(r, c), v) < 0);
    return this;
  }
  lte(c: string, v: unknown): this {
    this.#preds.push((r) => cmp(val(r, c), v) <= 0);
    return this;
  }
  order(c: string, opts: { ascending?: boolean } = {}): this {
    this.#order = { col: c, asc: opts.ascending !== false };
    return this;
  }
  limit(n: number): this {
    this.#limit = n;
    return this;
  }
  maybeSingle(): this {
    this.#single = true;
    return this;
  }

  #matches(r: Row): boolean {
    return this.#preds.every((p) => p(r));
  }

  #conflictWith(row: Row, cols: string[]): Row | undefined {
    return this.db.tables[this.table]?.find((r) => cols.every((c) => r[c] === row[c]));
  }

  #checkUnique(row: Row): Err {
    const rows = this.db.tables[this.table] ?? [];
    if (row.id !== undefined && rows.some((r) => r.id === row.id)) {
      return { code: '23505', message: 'duplicate key value (id)' };
    }
    for (const cols of this.uniques[this.table] ?? []) {
      if (cols.every((c) => row[c] !== undefined) && rows.some((r) => cols.every((c) => r[c] === row[c]))) {
        return { code: '23505', message: `duplicate key value (${cols.join(',')})` };
      }
    }
    return null;
  }

  #run(): Result {
    const rows = (this.db.tables[this.table] ??= []);
    const payloadRows =
      (): Row[] => (Array.isArray(this.#payload) ? this.#payload : this.#payload ? [this.#payload] : []);
    const withDefaults = (r: Row): Row => ({ created_at: this.db.clock(), ...r });

    if (this.#op === 'insert') {
      const inserted: Row[] = [];
      for (const raw of payloadRows()) {
        const err = this.#checkUnique(raw);
        if (err) return { data: null, error: err };
        const row = withDefaults(raw);
        rows.push(row);
        inserted.push(row);
      }
      return { data: this.#returning ? inserted.map((r) => ({ ...r })) : null, error: null };
    }

    if (this.#op === 'upsert') {
      const out: Row[] = [];
      for (const raw of payloadRows()) {
        const cols = this.#conflict ?? [];
        const existing = cols.length ? this.#conflictWith(raw, cols) : undefined;
        if (existing) {
          if (this.#ignore) continue;
          Object.assign(existing, raw);
          out.push({ ...existing });
          continue;
        }
        const err = this.#checkUnique(raw);
        if (err) return { data: null, error: err };
        const row = withDefaults(raw);
        rows.push(row);
        out.push(row);
      }
      return { data: this.#returning ? out : null, error: null };
    }

    if (this.#op === 'update') {
      const matched = rows.filter((r) => this.#matches(r));
      for (const r of matched) Object.assign(r, this.#payload as Row);
      return { data: this.#returning ? matched.map((r) => ({ ...r })) : null, error: null };
    }

    if (this.#op === 'delete') {
      const keep = rows.filter((r) => !this.#matches(r));
      const removed = rows.length - keep.length;
      rows.splice(0, rows.length, ...keep);
      return { data: removed, error: null };
    }

    let out = rows.filter((r) => this.#matches(r)).map((r) => ({ ...r }));
    if (this.#order) {
      const { col, asc } = this.#order;
      out = out.sort((a, b) => (asc ? cmp(a[col], b[col]) : cmp(b[col], a[col])));
    }
    if (this.#limit !== null) out = out.slice(0, this.#limit);
    if (this.#single) return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }

  then<A, B>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.#run()).then(onfulfilled, onrejected);
  }
}

/** Builds the fake client. The same tables back both the public and private schemas. */
export function createFakeDb(config: FakeConfig = {}): FakeDb & SupabaseClient {
  const uniques: Record<string, string[][]> = {
    idempotency_keys: [['user_id', 'function_name', 'key']],
    question_served: [['quiz_attempt_id', 'question_id']],
    attempt_answers: [['attempt_id', 'question_id']],
    mastery_evidence: [['ref_type', 'ref_id', 'node_id']],
    battle_players: [['battle_id', 'user_id']],
    ...config.uniques,
  };
  const db: FakeDb = {
    clock: () => '2026-10-27T12:00:00.000Z',
    tables: Object.fromEntries(Object.entries(config.tables ?? {}).map(([k, v]) => [k, v.map((r) => ({ ...r }))])),
    rpcCalls: [],
    auth: {
      getUser(jwt: string) {
        const user = config.users?.[jwt];
        return Promise.resolve(
          user ? { data: { user }, error: null } : { data: { user: null }, error: { message: 'invalid jwt' } },
        );
      },
    },
    from(table: string) {
      return new Builder(db, table, uniques);
    },
    rpc(name: string, args: Row): Promise<Result> {
      db.rpcCalls.push({ name, args });
      const handler = config.rpcs?.[name];
      return Promise.resolve(handler ? handler(args) : { data: null, error: { message: `no rpc ${name}` } });
    },
    schema(_name: string) {
      return {
        from: (table: string) => new Builder(db, table, uniques),
        rpc: (name: string, args: Row) => db.rpc(name, args),
      };
    },
  };
  return db as unknown as FakeDb & SupabaseClient;
}

export interface Sent {
  queue: string;
  data: Record<string, unknown>;
  options?: { singletonKey?: string; startAfterSeconds?: number };
}

export interface FakeDepsOptions {
  db: FakeDb & SupabaseClient;
  now?: Date;
  baseUrl?: string | null;
  userRpc?: UserRpc;
  randomInts?: number[];
  guardianMail?: P2Deps['guardianMail'];
}

export interface FakeEnv {
  deps: P2Deps;
  sent: Sent[];
  broadcasts: BroadcastMessage[];
  setNow(d: Date): void;
  db: FakeDb & SupabaseClient;
}

/** Deterministic deps: fixed clock, sequential v7-shaped ids, recorded enqueues and broadcasts. */
export function createFakeDeps(opts: FakeDepsOptions): FakeEnv {
  let now = opts.now ?? new Date('2026-10-27T12:00:00Z');
  let counter = 0;
  opts.db.clock = () => now.toISOString();
  const sent: Sent[] = [];
  const broadcasts: BroadcastMessage[] = [];
  const ints = [...(opts.randomInts ?? [])];
  const aiStub = {
    client: {},
    budget: {
      reserve: () => Promise.resolve({ ok: true as const, reservationId: 'r' }),
      settle: () => Promise.resolve(undefined),
    },
    usage: { record: () => Promise.resolve(undefined) },
  } as unknown as AiDeps;
  const deps: P2Deps = {
    db: opts.db,
    supabaseUrl: 'https://example.supabase.test',
    anonKey: 'anon',
    asUser: () => opts.db,
    verifyEmailCode: () => Promise.resolve(false),
    ai: aiStub,
    enqueue: (queue, data, options) => {
      sent.push({ queue, data, options });
      return Promise.resolve(`job-${sent.length}`);
    },
    now: () => now,
    newId: () => {
      counter += 1;
      return `00000000-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;
    },
    heartbeatMs: 0,
    userRpc: opts.userRpc ?? (() => Promise.resolve({ data: null, error: { message: 'no userRpc' } })),
    broadcast: (messages) => {
      broadcasts.push(...messages);
      return Promise.resolve();
    },
    baseUrl: opts.baseUrl === undefined ? 'studify.test' : opts.baseUrl,
    randomInt: (maxExclusive) => (ints.length > 0 ? (ints.shift() as number) % maxExclusive : 0),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    guardianMail: opts.guardianMail,
  };
  return {
    deps,
    sent,
    broadcasts,
    setNow(d) {
      now = d;
      opts.db.clock = () => now.toISOString();
    },
    db: opts.db,
  };
}

/** A POST with a fresh UUID v7 Idempotency-Key (the key is required on mutating functions). */
export function post(
  body: unknown,
  opts: { jwt?: string | null; key?: string | null; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`;
  if (opts.key !== null) headers['idempotency-key'] = opts.key ?? uuidV7();
  return new Request('https://functions.test/fn', { method: 'POST', headers, body: JSON.stringify(body) });
}

export async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

export const ALICE = '00000000-0000-4000-8000-00000000a11c';
export const BOB = '00000000-0000-4000-8000-0000000000b0';
export const CAROL = '00000000-0000-4000-8000-0000000000c0';
export const GROUP = '00000000-0000-4000-8000-0000000000e0';
export const SUBJECT = '00000000-0000-4000-8000-000000005b00';
export const NODE = '00000000-0000-4000-8000-000000000e00';

export const USERS = {
  'jwt-alice': { id: ALICE, email: 'alice@example.test' },
  'jwt-bob': { id: BOB, email: 'bob@example.test' },
  'jwt-carol': { id: CAROL, email: 'carol@example.test' },
};

/** Question with a 4-option mcq (correct 'b') for duel and battle tests. */
export function mcq(id: string, correct = 'b'): Row {
  return {
    id,
    subject_id: SUBJECT,
    node_id: NODE,
    type: 'mcq_single',
    stem: `Pergunta ${id}`,
    stimulus: null,
    payload: {
      options: ['a', 'b', 'c', 'd'].map((o) => ({ id: o, text: `Opção ${o}`, rationale: `Por que ${o}` })),
      correct,
    },
    explanation: `Explicação de ${id}`,
    difficulty: 3,
    source_pages: [{ document_id: 'doc', page_start: 1, page_end: 1 }],
    version: 1,
    status: 'active',
    review_status: 'approved',
    hidden_reason: null,
    personal_for_user_id: null,
    deleted_at: null,
  };
}

/** Standard fixture: Alice (owner) and Bob (member) in GROUP, Carol outside, one subject with 10 questions. */
export function baseTables(): Record<string, Row[]> {
  const qids = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(i + 10)}`);
  return {
    profiles: [
      { id: ALICE, display_name: 'Ana' },
      { id: BOB, display_name: 'Bob' },
      { id: CAROL, display_name: 'Carol' },
    ],
    class_groups: [{ id: GROUP, name: 'Turma', settings: {}, deleted_at: null }],
    class_group_members: [
      { class_group_id: GROUP, user_id: ALICE, role: 'owner', status: 'active', nickname: 'Ana', accepts_duels: true },
      { class_group_id: GROUP, user_id: BOB, role: 'member', status: 'active', nickname: 'Léo', accepts_duels: true },
    ],
    subjects: [{
      id: SUBJECT,
      name: 'Biologia',
      owner_profile_id: null,
      owner_class_group_id: GROUP,
      created_by: ALICE,
      content_language: 'pt',
      is_language_subject: false,
      enem_area: null,
      deleted_at: null,
    }],
    knowledge_nodes: [{ id: NODE, subject_id: SUBJECT, deleted_at: null }],
    questions: qids.map((id) => mcq(id)),
    mastery: [],
    quizzes: [],
    quiz_attempts: [],
    attempt_answers: [],
    mistakes: [],
    mastery_evidence: [],
    duels: [],
    battles: [],
    battle_players: [],
    user_blocks: [],
    documents: [],
    exams: [],
    guardian_links: [],
    quiz_shares: [],
    schedule_imports: [],
  };
}

export const QIDS = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-0000000000${String(i + 10)}`);
