// deno-lint-ignore-file require-await no-this-alias
// Test doubles for the Edge Function handlers. No network, no real clients: the in-memory database
// implements the supabase-js query shapes the handlers use (filters, upsert with ON CONFLICT, counts,
// RPC errors, storage objects, auth), the fake Claude client implements the SDK surface callClaude
// uses (create, stream with text and citation events, final message), and the budget gate is injectable.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AiUsageRow, AnthropicLike, BudgetReserveInput, BudgetReserveResult, BudgetScope, BudgetStore, UsageSink } from '@studify/ai';
import { uuidV7 } from '@studify/shared';
import type { Deps, Enqueue } from '../src/shared/deps.ts';

export type Row = Record<string, unknown>;

/** Unique constraints the real schema enforces (conflict targets for insert and upsert). */
const UNIQUE: Record<string, string[][]> = {
  review_logs: [['id']],
  attempt_answers: [['id'], ['attempt_id', 'question_id']],
  card_states: [['user_id', 'card_id']],
  card_overrides: [['user_id', 'card_id']],
  xp_events: [['id'], ['user_id', 'ref_type', 'ref_id', 'source_feature']],
  node_user_settings: [['user_id', 'node_id']],
  subject_user_settings: [['user_id', 'subject_id']],
  quiz_attempts: [['id']],
  documents: [['id']],
  document_slices: [['document_id', 'purpose', 'page_start', 'page_end']],
  idempotency_keys: [['user_id', 'function_name', 'key']],
  mastery_evidence: [['ref_type', 'ref_id', 'node_id']],
  exam_scope_nodes: [['exam_id', 'node_id']],
  invites: [['id']],
  profiles: [['id']],
  study_preferences: [['user_id']],
};

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const da = typeof a === 'string' ? Date.parse(a) : NaN;
  const db = typeof b === 'string' ? Date.parse(b) : NaN;
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

interface PgError {
  message: string;
  code?: string;
  hint?: string | null;
  details?: string | null;
}

type RpcFn = (args: Record<string, unknown>) => { data?: unknown; error?: PgError | null };

export class FakeDb {
  readonly tables = new Map<string, Row[]>();
  readonly rpcs = new Map<string, RpcFn>();
  readonly objects = new Map<string, Uint8Array>();
  readonly users = new Map<string, { id: string; email: string | null }>();
  readonly deletedUsers: string[] = [];
  readonly signedOut: string[] = [];
  otpCode: string | null = null;
  readonly rpcCalls: Array<{ name: string; args: Record<string, unknown>; schema: string }> = [];

  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  seed(name: string, rows: Row | Row[]): void {
    this.table(name).push(...(Array.isArray(rows) ? rows : [rows]));
  }

  /** Rows of a table (copies), for assertions. */
  rows(name: string): Row[] {
    return this.table(name).map((r) => ({ ...r }));
  }

  from(name: string): Query {
    return new Query(this, name);
  }

  schema(name: string) {
    return {
      from: (table: string) => new Query(this, table),
      rpc: (fn: string, args: Record<string, unknown> = {}) => this.callRpc(name, fn, args),
    };
  }

  rpc(fn: string, args: Record<string, unknown> = {}) {
    return this.callRpc('public', fn, args);
  }

  callRpc(schema: string, fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ name: fn, args, schema });
    const impl = this.rpcs.get(fn);
    if (!impl) return Promise.resolve({ data: null, error: { message: `no rpc ${fn}`, code: '42883' } as PgError });
    const out = impl(args);
    return Promise.resolve({ data: out.data ?? null, error: out.error ?? null });
  }

  get auth() {
    const db = this;
    return {
      getUser: async (jwt: string) => {
        const user = db.users.get(jwt);
        if (!user) return { data: { user: null }, error: { message: 'invalid jwt' } };
        return { data: { user: { id: user.id, email: user.email } }, error: null };
      },
      verifyOtp: async (params: { email: string; token: string }) => {
        if (db.otpCode !== null && params.token === db.otpCode) return { data: { user: {} }, error: null };
        return { data: { user: null }, error: { message: 'Token has expired or is invalid' } };
      },
      admin: {
        signOut: async (jwt: string, scope: string) => {
          db.signedOut.push(`${jwt}:${scope}`);
          return { error: null };
        },
        deleteUser: async (id: string) => {
          db.deletedUsers.push(id);
          return { data: null, error: null };
        },
      },
    };
  }

  /** supabase-js storage surface, backed by `objects` (keys are `bucket/object`). */
  get storage() {
    const db = this;
    return {
      from: (bucket: string) => ({
        info: async (object: string) => {
          const key = `${bucket}/${object}`;
          return db.objects.has(key) ? { data: { name: object }, error: null } : { data: null, error: { message: 'Object not found' } };
        },
        download: async (object: string) => {
          const bytes = db.objects.get(`${bucket}/${object}`);
          if (!bytes) return { data: null, error: { message: 'Object not found' } };
          return { data: new Blob([bytes as BlobPart]), error: null };
        },
        upload: async (object: string, bytes: Uint8Array) => {
          db.objects.set(`${bucket}/${object}`, bytes);
          return { data: { path: object }, error: null };
        },
      }),
    };
  }

  /** Cast to the supabase-js type the handlers accept. */
  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

export class Query implements PromiseLike<{ data: unknown; error: PgError | null; count?: number | null }> {
  #db: FakeDb;
  #table: string;
  #filters: Array<(r: Row) => boolean> = [];
  #op: 'select' | 'insert' | 'upsert' | 'update' | 'delete' = 'select';
  #payload: Row | Row[] | null = null;
  #onConflict: string[] | null = null;
  #ignoreDuplicates = false;
  #head = false;
  #countExact = false;
  #orderBy: Array<{ col: string; asc: boolean }> = [];
  #limit: number | null = null;
  #single: 'maybe' | 'one' | null = null;

  constructor(db: FakeDb, table: string) {
    this.#db = db;
    this.#table = table;
  }

  select(_cols?: string, options: { count?: string; head?: boolean } = {}) {
    if (this.#op === 'select') this.#op = 'select';
    this.#head = options.head === true;
    this.#countExact = options.count === 'exact';
    return this;
  }
  insert(rows: Row | Row[]) {
    this.#op = 'insert';
    this.#payload = rows;
    return this;
  }
  upsert(rows: Row | Row[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.#op = 'upsert';
    this.#payload = rows;
    this.#onConflict = options.onConflict ? options.onConflict.split(',') : null;
    this.#ignoreDuplicates = options.ignoreDuplicates === true;
    return this;
  }
  update(patch: Row) {
    this.#op = 'update';
    this.#payload = patch;
    return this;
  }
  delete() {
    this.#op = 'delete';
    return this;
  }
  eq(col: string, value: unknown) {
    this.#filters.push((r) => r[col] === value || (value === null && r[col] == null));
    return this;
  }
  neq(col: string, value: unknown) {
    this.#filters.push((r) => r[col] !== value);
    return this;
  }
  in(col: string, values: readonly unknown[]) {
    this.#filters.push((r) => values.includes(r[col]));
    return this;
  }
  is(col: string, value: null) {
    this.#filters.push((r) => r[col] === null || r[col] === undefined);
    void value;
    return this;
  }
  gt(col: string, value: unknown) {
    this.#filters.push((r) => r[col] != null && compare(r[col], value) > 0);
    return this;
  }
  gte(col: string, value: unknown) {
    this.#filters.push((r) => r[col] != null && compare(r[col], value) >= 0);
    return this;
  }
  lt(col: string, value: unknown) {
    this.#filters.push((r) => r[col] != null && compare(r[col], value) < 0);
    return this;
  }
  lte(col: string, value: unknown) {
    this.#filters.push((r) => r[col] != null && compare(r[col], value) <= 0);
    return this;
  }
  textSearch(col: string, query: string) {
    const words = normalize(query).split(/\s+/).filter((w) => w.length > 0);
    this.#filters.push((r) => {
      const text = normalize(String(r[col] ?? ''));
      return words.some((w) => text.includes(w));
    });
    return this;
  }
  order(col: string, options: { ascending?: boolean } = {}) {
    this.#orderBy.push({ col, asc: options.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.#limit = n;
    return this;
  }
  maybeSingle() {
    this.#single = 'maybe';
    return this;
  }
  single() {
    this.#single = 'one';
    return this;
  }

  #matching(): Row[] {
    return this.#db.table(this.#table).filter((r) => this.#filters.every((f) => f(r)));
  }

  #conflictKeys(): string[][] {
    if (this.#onConflict) return [this.#onConflict];
    return UNIQUE[this.#table] ?? [['id']];
  }

  #findConflict(row: Row): Row | undefined {
    const table = this.#db.table(this.#table);
    for (const keys of this.#conflictKeys()) {
      if (keys.some((k) => row[k] === undefined)) continue;
      const hit = table.find((r) => keys.every((k) => r[k] === row[k]));
      if (hit) return hit;
    }
    return undefined;
  }

  #run(): { data: unknown; error: PgError | null; count?: number | null } {
    const table = this.#db.table(this.#table);
    if (this.#op === 'select') {
      let rows = this.#matching();
      if (this.#orderBy.length) {
        rows = [...rows].sort((a, b) => {
          for (const o of this.#orderBy) {
            const c = compare(a[o.col], b[o.col]);
            if (c !== 0) return o.asc ? c : -c;
          }
          return 0;
        });
      }
      const count = this.#countExact ? rows.length : null;
      if (this.#limit !== null) rows = rows.slice(0, this.#limit);
      if (this.#head) return { data: null, error: null, count };
      const copies = rows.map((r) => ({ ...r }));
      if (this.#single === 'maybe') return { data: copies[0] ?? null, error: null };
      if (this.#single === 'one') return copies[0] ? { data: copies[0], error: null } : { data: null, error: { message: 'no rows', code: 'PGRST116' } };
      return { data: copies, error: null, count };
    }

    if (this.#op === 'insert' || this.#op === 'upsert') {
      const list = Array.isArray(this.#payload) ? this.#payload : [this.#payload as Row];
      const out: Row[] = [];
      for (const raw of list) {
        const row: Row = { ...raw };
        // Column defaults the database would fill in: receipt time for created_at.
        if (row.created_at === undefined) row.created_at = new Date(NOW_MS).toISOString();
        const hit = this.#findConflict(row);
        if (hit) {
          if (this.#op === 'upsert' && this.#ignoreDuplicates) continue;
          if (this.#op === 'upsert') {
            Object.assign(hit, row);
            continue;
          }
          return { data: null, error: { message: 'duplicate key value violates unique constraint', code: '23505' } };
        }
        table.push(row);
        out.push(row);
      }
      return { data: out, error: null };
    }

    if (this.#op === 'update') {
      const hits = this.#matching();
      for (const r of hits) Object.assign(r, this.#payload as Row);
      const copies = hits.map((r) => ({ ...r }));
      if (this.#single === 'maybe') return { data: copies[0] ?? null, error: null };
      return { data: copies, error: null };
    }

    // delete
    const hits = new Set(this.#matching());
    this.#db.tables.set(
      this.#table,
      table.filter((r) => !hits.has(r)),
    );
    return { data: null, error: null };
  }

  then<R1 = { data: unknown; error: PgError | null; count?: number | null }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: PgError | null; count?: number | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return Promise.resolve().then(() => this.#run()).then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------- Claude

export interface FakeCall {
  params: Record<string, unknown>;
  stream: boolean;
}

export type ReplyFn = (params: Record<string, unknown>) => FakeReply;

export interface FakeBlock {
  type: 'text';
  text: string;
  citations?: Array<Record<string, unknown>>;
}

export interface FakeReply {
  content: Array<Record<string, unknown>>;
  stop_reason?: 'end_turn' | 'max_tokens' | 'refusal' | 'pause_turn';
  stop_details?: { category: string } | null;
}

/** Turns a reply into the BetaMessage the wrapper reads. */
function toMessage(reply: FakeReply, id: string): Record<string, unknown> {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: reply.content,
    stop_reason: reply.stop_reason ?? 'end_turn',
    stop_details: reply.stop_details ?? null,
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  };
}

export class FakeClaude implements AnthropicLike {
  readonly calls: FakeCall[] = [];
  #reply: ReplyFn;
  #seq = 0;

  constructor(reply: ReplyFn | FakeReply) {
    this.#reply = typeof reply === 'function' ? reply : () => reply;
  }

  // deno-lint-ignore no-explicit-any
  beta: any = {
    messages: {
      create: async (params: Record<string, unknown>) => {
        this.calls.push({ params, stream: false });
        return toMessage(this.#reply(params), `msg_${++this.#seq}`);
      },
      stream: (params: Record<string, unknown>) => {
        this.calls.push({ params, stream: true });
        const message = toMessage(this.#reply(params), `msg_${++this.#seq}`);
        const listeners: { text: Array<(t: string) => void>; citation: Array<(c: unknown) => void> } = { text: [], citation: [] };
        return {
          on(event: 'text' | 'citation', listener: (value: never) => void) {
            listeners[event].push(listener as (v: unknown) => void);
            return this;
          },
          finalMessage: async () => {
            // Events fire in order during the stream, as the SDK does: text deltas, then citations of the block.
            for (const block of message.content as Array<Record<string, unknown>>) {
              if (block.type !== 'text') continue;
              const text = block.text as string;
              for (const chunk of text.match(/.{1,12}/gs) ?? []) for (const l of listeners.text) l(chunk);
              for (const c of (block.citations as Array<Record<string, unknown>> | undefined) ?? []) {
                for (const l of listeners.citation) l(c);
              }
            }
            return message;
          },
        };
      },
      batches: {},
    },
  };

  files = { upload: async () => ({ id: 'file_1' }), delete: async () => ({}) };
}

/** A page-location citation as the API sends it (1-based page index within the cited document block). */
export function pageCitation(documentIndex: number, page: number, citedText: string) {
  return {
    type: 'page_location',
    document_index: documentIndex,
    document_title: null,
    start_page_number: page,
    end_page_number: page + 1,
    cited_text: citedText,
  };
}

// ---------------------------------------------------------------- budget and usage

export class FakeBudget implements BudgetStore {
  refuse: BudgetScope | null = null;
  reserved: BudgetReserveInput[] = [];
  settled: Array<{ id: string; actual: number }> = [];
  #seq = 0;

  async reserve(input: BudgetReserveInput): Promise<BudgetReserveResult> {
    this.reserved.push(input);
    if (this.refuse) return { ok: false, scope: this.refuse, resetsAt: '2026-10-28T00:00:00-03:00' };
    return { ok: true, reservationId: uuidV7(NOW_MS + ++this.#seq) };
  }

  async settle(reservationId: string, actualMicroUsd: number): Promise<void> {
    this.settled.push({ id: reservationId, actual: actualMicroUsd });
  }
}

export class FakeUsage implements UsageSink {
  rows: AiUsageRow[] = [];
  async record(row: AiUsageRow): Promise<void> {
    this.rows.push(row);
  }
}

// ---------------------------------------------------------------- deps and requests

export const NOW_MS = Date.parse('2026-10-27T15:00:00Z');
export const NOW = new Date(NOW_MS);

export interface Harness {
  db: FakeDb;
  claude: FakeClaude;
  budget: FakeBudget;
  usage: FakeUsage;
  enqueued: Array<{ queue: string; data: Record<string, unknown>; options: Record<string, unknown> | undefined }>;
  deps: Deps;
}

export function makeHarness(reply: ReplyFn | FakeReply = { content: [{ type: 'text', text: '{}' }] }): Harness {
  const db = new FakeDb();
  const claude = new FakeClaude(reply);
  const budget = new FakeBudget();
  const usage = new FakeUsage();
  const enqueued: Harness['enqueued'] = [];
  const seenSingletons = new Set<string>();
  let seq = 0;
  const enqueue: Enqueue = async (queue, data, options) => {
    if (options?.singletonKey) {
      const key = `${queue}:${options.singletonKey}`;
      if (seenSingletons.has(key)) return null;
      seenSingletons.add(key);
    }
    enqueued.push({ queue, data, options: options as Record<string, unknown> | undefined });
    return `job-${++seq}`;
  };
  const deps: Deps = {
    db: db.asClient(),
    supabaseUrl: 'http://supabase.test',
    anonKey: 'anon-key',
    asUser: () => db.asClient(),
    ai: { client: claude, budget, usage, maxRetries: 0 },
    enqueue,
    now: () => new Date(NOW),
    newId: () => uuidV7(NOW_MS + ++seq),
    heartbeatMs: 0,
  };
  return { db, claude, budget, usage, enqueued, deps };
}

export const ALICE = { id: '0190a000-0000-7000-8000-00000000a11c', email: 'alice@example.com', jwt: 'jwt-alice' };
export const BOB = { id: '0190a000-0000-7000-8000-00000000b0b0', email: 'bob@example.com', jwt: 'jwt-bob' };
export const IDEM_KEY = '0190a000-0000-7000-8000-0000000000aa';

/** Logs in both test students and creates their profiles. */
export function withUsers(h: Harness): void {
  h.db.users.set(ALICE.jwt, { id: ALICE.id, email: ALICE.email });
  h.db.users.set(BOB.jwt, { id: BOB.id, email: BOB.email });
  for (const u of [ALICE, BOB]) {
    h.db.seed('profiles', {
      id: u.id,
      display_name: u.id === ALICE.id ? 'Alice' : 'Bob',
      display_name_status: 'approved',
      birth_year: 2010,
      birth_month: 5,
      timezone: 'America/Sao_Paulo',
      settings: {},
      privacy_notice_version: 'v1',
      privacy_accepted_at: NOW.toISOString(),
    });
  }
}

export function request(path: string, opts: { token?: string | null; body?: unknown; raw?: string; idem?: string | null; method?: string; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-studify-version': '100', 'x-studify-schema': '1', 'x-device-id': 'device-1', ...(opts.headers ?? {}) };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? ALICE.jwt}`;
  if (opts.idem !== null) headers['idempotency-key'] = opts.idem ?? IDEM_KEY;
  const body = opts.raw ?? (opts.body === undefined ? '{}' : JSON.stringify(opts.body));
  const noBody = opts.method === 'OPTIONS' || opts.method === 'GET';
  return new Request(`http://functions.test/${path}`, { method: opts.method ?? 'POST', headers, body: noBody ? undefined : body });
}

/** Reads an SSE body into frames. */
export function parseSse(text: string): Array<{ event: string; data: unknown }> {
  const frames: Array<{ event: string; data: unknown }> = [];
  for (const block of text.split('\n\n')) {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (event && data) frames.push({ event, data: JSON.parse(data) });
  }
  return frames;
}

export async function json(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

/** A small valid PDF with one text line per page, built with pdf-lib (the same library the functions use). */
export async function makePdf(pages: number, linePrefix = 'Pagina'): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    const page = doc.addPage([300, 300]);
    page.drawText(`${linePrefix} ${i} fotossintese clorofila`, { x: 20, y: 150, size: 12, font });
  }
  return doc.save();
}
