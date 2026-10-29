// In-memory stand-ins for the OperationContext dependencies: a supabase-like query builder (the subset the
// jobs use), storage and auth, a pg stub for the private.* writes, and a fake Anthropic client that
// runs behind the real callClaude() pipeline (budget reserve → request → validate → usage row).
import pino from 'pino';
import type { AnthropicLike, BudgetStore, ClaudeDeps, UsageSink, AiUsageRow } from '@studify/ai';
import type { OperationContext } from '../../src/framework/types.ts';

export type Row = Record<string, any>;
type Result = { data: any; error: { message: string } | null };

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  return a === b;
}

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export class FakeDatabase {
  readonly tables = new Map<string, Row[]>();
  /** Every operation on these tables fails with the given message (for failure-path tests). */
  readonly failures = new Map<string, string>();

  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  seed(name: string, rows: Row[]): void {
    this.tables.set(name, rows.map((r) => ({ id: newId(), ...r })));
  }

  rows(name: string): Row[] {
    return this.table(name);
  }

  from(name: string): unknown {
    return new Query(this, name);
  }
}

class Query implements PromiseLike<Result> {
  private filters: Array<(r: Row) => boolean> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private window: { from: number; to: number } | null = null;
  private limitN: number | null = null;
  private mode: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  private payload: Row | Row[] | null = null;
  private opts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
  private returning = false;
  private singleMode: 'none' | 'single' | 'maybe' = 'none';
  private projection: string | null = null;

  constructor(
    private readonly db: FakeDatabase,
    private readonly table: string,
  ) {}

  select(columns?: string): this {
    if (this.mode === 'select') this.projection = columns ?? null;
    else this.returning = true;
    return this;
  }
  eq(col: string, value: unknown): this {
    this.filters.push((r) => same(r[col], value));
    return this;
  }
  neq(col: string, value: unknown): this {
    this.filters.push((r) => !same(r[col], value));
    return this;
  }
  in(col: string, values: readonly unknown[]): this {
    this.filters.push((r) => values.some((v) => same(r[col], v)));
    return this;
  }
  is(col: string, value: unknown): this {
    this.filters.push((r) => (value === null ? r[col] === null || r[col] === undefined : same(r[col], value)));
    return this;
  }
  not(col: string, op: string, value: unknown): this {
    if (op === 'is' && value === null) this.filters.push((r) => r[col] !== null && r[col] !== undefined);
    else this.filters.push((r) => !same(r[col], value));
    return this;
  }
  gt(col: string, value: unknown): this {
    this.filters.push((r) => (compare(r[col], value) ?? -1) > 0);
    return this;
  }
  gte(col: string, value: unknown): this {
    this.filters.push((r) => (compare(r[col], value) ?? -1) >= 0);
    return this;
  }
  lt(col: string, value: unknown): this {
    this.filters.push((r) => {
      const c = compare(r[col], value);
      return c !== null && c < 0;
    });
    return this;
  }
  lte(col: string, value: unknown): this {
    this.filters.push((r) => {
      const c = compare(r[col], value);
      return c !== null && c <= 0;
    });
    return this;
  }
  order(col: string, opts: { ascending?: boolean } = {}): this {
    this.orders.push({ col, asc: opts.ascending !== false });
    return this;
  }
  range(from: number, to: number): this {
    this.window = { from, to };
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }
  insert(payload: Row | Row[]): this {
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }
  upsert(payload: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.mode = 'upsert';
    this.payload = payload;
    this.opts = opts;
    return this;
  }
  update(patch: Row): this {
    this.mode = 'update';
    this.payload = patch;
    return this;
  }
  delete(): this {
    this.mode = 'delete';
    return this;
  }
  maybeSingle(): this {
    this.singleMode = 'maybe';
    return this;
  }
  single(): this {
    this.singleMode = 'single';
    return this;
  }
  then<A, B>(onFulfilled?: ((v: Result) => A | PromiseLike<A>) | null, onRejected?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve(this.exec()).then(onFulfilled, onRejected);
  }

  private project(rows: Row[]): Row[] {
    if (!this.projection || this.projection.trim() === '*') return rows.map((r) => ({ ...r }));
    const cols = this.projection.split(',').map((c) => c.trim());
    return rows.map((r) => {
      const out: Row = {};
      for (const c of cols) {
        const [alias, source] = c.includes(':') ? c.split(':') : [c, c];
        if (alias && source) out[alias] = r[source];
      }
      return out;
    });
  }

  private exec(): Result {
    const failure = this.db.failures.get(this.table);
    if (failure) return { data: null, error: { message: failure } };
    const rows = this.db.table(this.table);
    let data: Row[] | Row | null = null;
    if (this.mode === 'select') {
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const o of [...this.orders].reverse()) {
        out = out.slice().sort((a, b) => {
          const c = compare(a[o.col], b[o.col]) ?? 0;
          return o.asc ? c : -c;
        });
      }
      if (this.window) out = out.slice(this.window.from, this.window.to + 1);
      if (this.limitN !== null) out = out.slice(0, this.limitN);
      data = this.project(out);
    } else if (this.mode === 'insert') {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter((p): p is Row => !!p);
      const inserted = list.map((p) => ({ id: newId(), ...p }));
      rows.push(...inserted);
      data = this.returning ? this.project(inserted) : null;
    } else if (this.mode === 'upsert') {
      const keys = (this.opts.onConflict ?? 'id').split(',');
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]).filter((p): p is Row => !!p);
      const touched: Row[] = [];
      for (const p of list) {
        const existing = rows.find((r) => keys.every((k) => same(r[k] ?? null, p[k] ?? null)));
        if (existing) {
          if (this.opts.ignoreDuplicates) continue;
          Object.assign(existing, p);
          touched.push(existing);
        } else {
          const row = { id: newId(), ...p };
          rows.push(row);
          touched.push(row);
        }
      }
      data = this.returning ? this.project(touched) : null;
    } else if (this.mode === 'update') {
      const matched = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, this.payload ?? {});
      data = this.returning ? this.project(matched) : null;
    } else {
      const removed = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const r of removed) rows.splice(rows.indexOf(r), 1);
      data = this.returning ? this.project(removed) : null;
    }
    if (this.singleMode !== 'none') {
      const list = Array.isArray(data) ? data : data ? [data] : [];
      if (this.singleMode === 'single' && list.length !== 1) return { data: null, error: { message: 'no rows' } };
      return { data: list[0] ?? null, error: null };
    }
    return { data, error: null };
  }
}

export class FakeStorage {
  readonly objects = new Map<string, Uint8Array>();
  failUpload: string | null = null;
  failDownload = new Set<string>();
  removed: string[] = [];

  from(bucket: string) {
    return {
      download: async (path: string) => {
        const key = `${bucket}/${path}`;
        const bytes = this.objects.get(key);
        if (!bytes || this.failDownload.has(key)) return { data: null, error: { message: 'not found' } };
        return { data: new Blob([new Uint8Array(bytes)]), error: null };
      },
      upload: async (path: string, body: Uint8Array | string) => {
        if (this.failUpload) return { data: null, error: { message: this.failUpload } };
        const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
        this.objects.set(`${bucket}/${path}`, bytes);
        return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => {
        for (const p of paths) {
          this.removed.push(`${bucket}/${p}`);
          this.objects.delete(`${bucket}/${p}`);
        }
        return { data: paths, error: null };
      },
      createSignedUrl: async (path: string, ttl: number) => ({ data: { signedUrl: `https://storage.test/${bucket}/${path}?ttl=${ttl}` }, error: null }),
      /** Like Supabase Storage: the direct children of a folder; files carry an id, sub-folders have id null. */
      list: async (prefix: string) => {
        const base = `${bucket}/${prefix}/`;
        const entries = new Map<string, { name: string; id: string | null }>();
        for (const key of this.objects.keys()) {
          if (!key.startsWith(base)) continue;
          const rest = key.slice(base.length);
          const slash = rest.indexOf('/');
          const name = slash === -1 ? rest : rest.slice(0, slash);
          entries.set(name, { name, id: slash === -1 ? `id-${name}` : null });
        }
        return { data: [...entries.values()], error: null };
      },
    };
  }
}

/** A minimal Anthropic Message as the SDK returns it (what callClaude's usage and content code reads). */
function messageFor(value: unknown, n: number): Record<string, unknown> {
  const refusal = typeof value === 'object' && value !== null && (value as { refusal?: boolean }).refusal === true;
  const truncated = typeof value === 'object' && value !== null && (value as { stop?: string }).stop === 'max_tokens';
  const text = refusal
    ? ''
    : typeof value === 'object' && value !== null && 'raw' in value
      ? String((value as { raw: string }).raw)
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  // {content: [...]} replies with raw content blocks (web search results and citations).
  const raw = typeof value === 'object' && value !== null && Array.isArray((value as { content?: unknown }).content) ? (value as { content: unknown[] }).content : null;
  return {
    id: `msg_fake_${n}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: raw ?? [{ type: 'text', text, citations: [] }],
    stop_reason: refusal ? 'refusal' : truncated ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    stop_details: refusal ? { category: 'test' } : null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, server_tool_use: null },
  };
}

export interface FakeClaude {
  /** Replies for requests whose system + messages JSON contains `match`. Use {refusal: true} or {stop: 'max_tokens'}. */
  reply(match: string, value: unknown): void;
  calls: Array<Record<string, unknown>>;
  deps: ClaudeDeps;
  usage: AiUsageRow[];
  budgetOk: boolean;
}

export function fakeClaude(): FakeClaude {
  const rules: Array<{ match: string; value: unknown }> = [];
  const calls: Array<Record<string, unknown>> = [];
  const usage: AiUsageRow[] = [];
  let n = 0;
  const state = { budgetOk: true };
  const client = {
    beta: {
      messages: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          n += 1;
          const haystack = JSON.stringify({ system: params.system, messages: params.messages });
          const rule = rules.find((r) => haystack.includes(r.match));
          if (!rule) throw new Error(`fake claude: no reply for request containing ${haystack.slice(0, 160)}`);
          return messageFor(rule.value, n);
        },
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          n += 1;
          const haystack = JSON.stringify({ system: params.system, messages: params.messages });
          const rule = rules.find((r) => haystack.includes(r.match));
          if (!rule) throw new Error(`fake claude: no reply for streamed request containing ${haystack.slice(0, 160)}`);
          const message = messageFor(rule.value, n);
          const listeners = new Map<string, Array<(v: unknown) => void>>();
          const handle = {
            on(event: string, listener: (v: unknown) => void) {
              listeners.set(event, [...(listeners.get(event) ?? []), listener]);
              return handle;
            },
            finalMessage: async () => {
              const text = (message.content as Array<{ text: string }>)[0]?.text ?? '';
              for (const l of listeners.get('text') ?? []) l(text);
              return message;
            },
          };
          return handle;
        },
        batches: {
          create: () => {
            throw new Error('not expected');
          },
          retrieve: () => {
            throw new Error('not expected');
          },
          cancel: () => {
            throw new Error('not expected');
          },
          results: () => {
            throw new Error('not expected');
          },
        },
      },
    },
    files: {
      upload: () => {
        throw new Error('not expected');
      },
      delete: () => {
        throw new Error('not expected');
      },
    },
  } as unknown as AnthropicLike;
  const budget: BudgetStore = {
    reserve: async () => (state.budgetOk ? { ok: true, reservationId: 'res-1' } : { ok: false, scope: 'user_day' }),
    settle: async () => undefined,
  };
  const sink: UsageSink = {
    record: async (row) => {
      usage.push(row);
    },
  };
  const deps: ClaudeDeps = { client, budget, usage: sink, clock: () => Date.now(), sleep: async () => undefined, timeoutMs: 5_000, maxRetries: 0 };
  return {
    reply: (match, value) => rules.push({ match, value }),
    calls,
    deps,
    usage,
    get budgetOk() {
      return state.budgetOk;
    },
    set budgetOk(v: boolean) {
      state.budgetOk = v;
    },
  } as FakeClaude;
}

/** One Realtime broadcast sent through ctx.broadcast (api §8.2). Every Studify channel is private. */
export interface FakeBroadcast {
  topic: string;
  private: boolean;
  event: string;
  payload: Record<string, unknown>;
}

export interface FakeEnv {
  ctx: OperationContext;
  /** Broadcasts sent through ctx.broadcast, in order. */
  broadcasts: FakeBroadcast[];
  /** Every broadcast fails with this message (failure path: the transition still commits). */
  failBroadcast: string | null;
  db: FakeDatabase;
  storage: FakeStorage;
  claude: FakeClaude;
  enqueued: Array<{ name: string; data: Record<string, unknown>; opts?: { singletonKey?: string; startAfter?: Date | number } }>;
  pushed: Array<{ userId: string; message: Record<string, unknown> }>;
  progress: Array<Record<string, unknown>>;
  pgQueries: Array<{ text: string; values?: unknown[] }>;
  /** Rows returned by ctx.sql.query for SQL containing `match` (first match wins; default: no rows). */
  pgRows: Array<{ match: string; rows: Row[] }>;
  auth: { deleted: string[]; failDelete: string | null };
  setNow(iso: string): void;
}

export const NOW = '2026-10-27T15:00:00.000Z'; // 12:00 in America/Sao_Paulo

export function fakeEnv(startIso: string = NOW): FakeEnv {
  const db = new FakeDatabase();
  const storage = new FakeStorage();
  const claude = fakeClaude();
  const enqueued: FakeEnv['enqueued'] = [];
  const pushed: FakeEnv['pushed'] = [];
  const progress: FakeEnv['progress'] = [];
  const pgQueries: FakeEnv['pgQueries'] = [];
  const auth: FakeEnv['auth'] = { deleted: [], failDelete: null };
  let nowIso = startIso;
  const pgRows: FakeEnv['pgRows'] = [];
  const pg = {
    query: async (text: string, values?: unknown[]) => {
      pgQueries.push({ text, values });
      const hit = pgRows.find((r) => text.includes(r.match));
      return { rows: hit?.rows ?? [], rowCount: hit?.rows.length ?? 1 };
    },
  };
  const broadcasts: FakeBroadcast[] = [];
  const realtime = {
    failBroadcast: null as string | null,
  };
  const broadcast = async (topic: string, events: ReadonlyArray<{ event: string; payload: Record<string, unknown> }>) => {
    for (const e of events) {
      if (realtime.failBroadcast) throw new Error(realtime.failBroadcast);
      broadcasts.push({ topic, private: true, event: e.event, payload: e.payload });
    }
  };
  const client = {
    from: (table: string) => db.from(table),
    storage,
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          if (auth.failDelete) return { data: null, error: { message: auth.failDelete } };
          auth.deleted.push(id);
          return { data: { user: null }, error: null };
        },
      },
    },
  };
  const ctx = {
    db: client as unknown as OperationContext['db'],
    sql: pg as unknown as OperationContext['sql'],
    broadcast,
    ai: claude.deps,
    log: pino({ enabled: false }),
    execute: async (name: string, data: Record<string, unknown>, opts?: FakeEnv['enqueued'][number]['opts']) => {
      enqueued.push({ name, data, ...(opts ? { opts } : {}) });
      return `job-${enqueued.length}`;
    },
    progress: async (patch: Record<string, unknown>) => {
      progress.push(patch);
    },
    now: () => new Date(nowIso),
    push: async (userId: string, message: Record<string, unknown>) => {
      pushed.push({ userId, message });
    },
  } as unknown as OperationContext;
  return {
    ctx,
    broadcasts,
    get failBroadcast() {
      return realtime.failBroadcast;
    },
    set failBroadcast(v: string | null) {
      realtime.failBroadcast = v;
    },
    db,
    storage,
    claude,
    enqueued,
    pushed,
    progress,
    pgQueries,
    pgRows,
    auth,
    setNow: (iso: string) => {
      nowIso = iso;
    },
  };
}

export const USER = '11111111-1111-4111-8111-111111111111';
export const USER_B = '22222222-2222-4222-8222-222222222222';
export const SUBJECT = '33333333-3333-4333-8333-333333333333';
export const UNIT = '44444444-4444-4444-8444-444444444444';
export const TOPIC = '55555555-5555-4555-8555-555555555555';
export const TOPIC_B = '66666666-6666-4666-8666-666666666666';
export const GOAL = '77777777-7777-4777-8777-777777777777';
export const EXAM = '88888888-8888-4888-8888-888888888888';
export const DOC = '99999999-9999-4999-8999-999999999999';
export const QUESTION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const ANSWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const CARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const FLAG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const GROUP_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
