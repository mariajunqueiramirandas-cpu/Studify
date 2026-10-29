// Realtime over SSE (ADR 0012, api.md §8). Each signed-in app holds one stream (POST /api/realtime-stream) and
// joins channels on it with realtime-join; the stream then carries:
//   * broadcast — events the server sends on a private channel (battle:{id}, duel:{id}, room:{id}, turma:{id},
//     turma:{id}:mods, user:{id});
//   * presence  — who is on a channel, the whole state after each change (rooms and battles are small);
//   * change    — a row that changed, for row channels `rows:<table>:<column>=<value>` (ai_jobs by id or user,
//     notification_inbox by user, podcast_episodes by id). The row is re-read as the subscriber, so row level
//     security still decides who sees it.
// Joining a private channel and sending presence are decided by the realtime policies (realtime.messages), the
// same rules Supabase Realtime applied. The hub lives in the one API process (ADR 0010: one replica), so it needs
// no broker. A stream ends when its token expires (`reauth`): the app refreshes the session, reopens and re-joins.
import type { Db } from '@studify/db';
import type { AuthUser } from '../shared/auth.ts';
import { log } from '../log.ts';

export interface PresenceEntry {
  key: string;
  payload: Record<string, unknown>;
}

export interface RowChange {
  table: string;
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  id: unknown;
  user_id?: unknown;
  subject_id?: unknown;
  class_group_id?: unknown;
}

interface Connection {
  id: string;
  user: AuthUser;
  topics: Map<string, { presence: PresenceEntry | null }>;
  send(event: string, data: unknown): void;
  close(event?: string): void;
}

/** Tables whose row changes the app may follow, and the columns it may filter them by. */
export const ROW_CHANNELS: Readonly<Record<string, readonly string[]>> = {
  ai_jobs: ['id', 'user_id', 'document_id'],
  notification_inbox: ['user_id'],
  podcast_episodes: ['id'],
  documents: ['id', 'subject_id'],
  notes: ['id'],
  essays: ['id'],
  duels: ['id'],
  camera_captures: ['id'],
  class_group_members: ['class_group_id'],
};

const PRIVATE_TOPIC = /^(battle|duel|room|turma|user):[0-9a-f-]{36}(:mods)?$/;
const ROW_TOPIC = /^rows:([a-z_]+):([a-z_]+)=([0-9a-f-]{36})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseRowTopic(topic: string): { table: string; column: string; value: string } | null {
  const m = ROW_TOPIC.exec(topic);
  if (!m) return null;
  const [, table, column, value] = m as unknown as [string, string, string, string];
  if (!ROW_CHANNELS[table]?.includes(column) || !UUID.test(value)) return null;
  return { table, column, value };
}

class Rollback extends Error {}

function claimsOf(user: AuthUser): { sub: string; role: string; email: string | null } {
  return { sub: user.userId, role: 'authenticated', email: user.email };
}

const encoder = new TextEncoder();
const SSE_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' };
const MAX_PENDING_BYTES = 256 * 1024;
const MAX_TOPICS_PER_CONNECTION = 64;
const MAX_CONNECTIONS_PER_USER = 4;

export class RealtimeHub {
  readonly #connections = new Map<string, Connection>();
  /** topic -> connection ids */
  readonly #topics = new Map<string, Set<string>>();

  constructor(
    private readonly db: Db,
    private readonly options: { heartbeatMs: number; newId: () => string },
  ) {}

  get size(): number {
    return this.#connections.size;
  }

  /** Opens a stream for a verified user. `expiresAt` (ms) is the token's expiry: the stream ends then. */
  open(user: AuthUser, expiresAt: number | null, headers: Record<string, string> = {}, signal?: AbortSignal): Response {
    const mine = [...this.#connections.values()].filter((c) => c.user.userId === user.userId);
    // An app that reconnects without closing (a dropped network) leaves its old stream; the oldest goes first.
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_CONNECTIONS_PER_USER + 1))) old.close('replaced');
    const id = this.options.newId();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let timers: Array<ReturnType<typeof setTimeout>> = [];
    let closed = false;
    const write = (text: string) => {
      if (closed) return;
      const bytes = encoder.encode(text);
      try {
        if ((controller.desiredSize ?? 0) < bytes.byteLength) {
          conn.close();
          return;
        }
        controller.enqueue(bytes);
      } catch {
        conn.close();
      }
    };
    const conn: Connection = {
      id,
      user,
      topics: new Map(),
      send: (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
      close: (event) => {
        if (closed) return;
        if (event) write(`event: ${event}\ndata: {}\n\n`);
        closed = true;
        for (const t of timers) clearTimeout(t);
        timers = [];
        this.#drop(conn);
        try {
          controller.close();
        } catch {}
      },
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          controller = c;
          this.#connections.set(id, conn);
          conn.send('ready', { connection_id: id });
          if (this.options.heartbeatMs > 0) {
            const beat = setInterval(() => write(': ping\n\n'), this.options.heartbeatMs);
            beat.unref?.();
            timers.push(beat as unknown as ReturnType<typeof setTimeout>);
          }
          if (expiresAt !== null) {
            const left = Math.max(0, expiresAt - Date.now());
            const expiry = setTimeout(() => conn.close('reauth'), left);
            expiry.unref?.();
            timers.push(expiry);
          }
          signal?.addEventListener('abort', () => conn.close(), { once: true });
        },
        cancel: () => conn.close(),
      },
      { highWaterMark: MAX_PENDING_BYTES, size: (chunk) => chunk?.byteLength ?? 0 },
    );
    return new Response(stream, { status: 200, headers: { ...SSE_HEADERS, ...headers } });
  }

  #connection(connectionId: string, user: AuthUser): Connection | null {
    const conn = this.#connections.get(connectionId);
    return conn && conn.user.userId === user.userId ? conn : null;
  }

  /**
   * Joins a channel. Returns the presence state for presence channels, or an error code: `not_found` (no such
   * stream for this user), `forbidden` (the policies refuse) or `invalid_request` (not a known channel).
   */
  async join(connectionId: string, user: AuthUser, topic: string, presence: PresenceEntry | null): Promise<{ ok: true; presence: Record<string, unknown[]> } | { ok: false; code: string }> {
    const conn = this.#connection(connectionId, user);
    if (!conn) return { ok: false, code: 'not_found' };
    if (!conn.topics.has(topic) && conn.topics.size >= MAX_TOPICS_PER_CONNECTION) return { ok: false, code: 'rate_limited' };
    const row = parseRowTopic(topic);
    if (row) {
      // A row channel filtered by a student id is only for that student; every delivered row is re-read as them.
      if (row.column === 'user_id' && row.value !== user.userId) return { ok: false, code: 'forbidden' };
      if (presence) return { ok: false, code: 'invalid_request' };
    } else if (PRIVATE_TOPIC.test(topic)) {
      if (!(await this.canReceive(user, topic))) return { ok: false, code: 'forbidden' };
      if (presence && !(await this.canSendPresence(user, topic))) return { ok: false, code: 'forbidden' };
    } else {
      return { ok: false, code: 'invalid_request' };
    }
    conn.topics.set(topic, { presence });
    let members = this.#topics.get(topic);
    if (!members) this.#topics.set(topic, (members = new Set()));
    members.add(conn.id);
    if (presence) this.#presenceChanged(topic);
    return { ok: true, presence: this.presenceState(topic) };
  }

  leave(connectionId: string, user: AuthUser, topic: string): boolean {
    const conn = this.#connection(connectionId, user);
    if (!conn || !conn.topics.has(topic)) return false;
    const had = conn.topics.get(topic)?.presence;
    conn.topics.delete(topic);
    this.#topics.get(topic)?.delete(conn.id);
    if (this.#topics.get(topic)?.size === 0) this.#topics.delete(topic);
    if (had) this.#presenceChanged(topic);
    return true;
  }

  /** Updates this connection's presence on a channel it joined with presence. */
  track(connectionId: string, user: AuthUser, topic: string, payload: Record<string, unknown>): boolean {
    const conn = this.#connection(connectionId, user);
    const entry = conn?.topics.get(topic);
    if (!conn || !entry?.presence) return false;
    entry.presence = { key: entry.presence.key, payload };
    this.#presenceChanged(topic);
    return true;
  }

  /** `{ key: [payload, ...] }`, the shape supabase-js presenceState() had. */
  presenceState(topic: string): Record<string, unknown[]> {
    const state: Record<string, unknown[]> = {};
    for (const id of this.#topics.get(topic) ?? []) {
      const p = this.#connections.get(id)?.topics.get(topic)?.presence;
      if (p) (state[p.key] ??= []).push({ ...p.payload, presence_ref: id });
    }
    return state;
  }

  broadcast(topic: string, event: string, payload: Record<string, unknown>): number {
    let sent = 0;
    for (const id of this.#topics.get(topic) ?? []) {
      this.#connections.get(id)?.send('broadcast', { topic, event, payload });
      sent += 1;
    }
    return sent;
  }

  /** A row changed (studify_row_changes). Each subscriber gets it as they may read it. */
  async rowChanged(change: RowChange): Promise<void> {
    const keys = ROW_CHANNELS[change.table];
    if (!keys) return;
    for (const column of keys) {
      const value = (change as unknown as Record<string, unknown>)[column];
      if (typeof value !== 'string') continue;
      const topic = `rows:${change.table}:${column}=${value}`;
      const members = this.#topics.get(topic);
      if (!members || members.size === 0) continue;
      for (const id of [...members]) {
        const conn = this.#connections.get(id);
        if (!conn) continue;
        if (change.op === 'DELETE') {
          conn.send('change', { topic, table: change.table, op: 'DELETE', new: null, old: { id: change.id } });
          continue;
        }
        try {
          const res = await this.db.asUser(claimsOf(conn.user)).from(change.table).select('*').eq('id', change.id).maybeSingle();
          if (res.data) conn.send('change', { topic, table: change.table, op: change.op, new: res.data, old: null });
        } catch (err) {
          log('warn', 'realtime row re-read failed', { table: change.table, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  /** The realtime select policy: may this user receive on the channel? */
  async canReceive(user: AuthUser, topic: string): Promise<boolean> {
    let allowed = false;
    try {
      await this.db.transaction(async (tx) => {
        // A message row exists only inside this transaction, so the select policy has a row to judge.
        const inserted = await tx.schema('realtime').from('messages').insert({ topic, extension: 'broadcast', private: true }).select('id').single();
        if (inserted.error) throw new Error(inserted.error.message);
        const row = inserted.data as { id: number };
        await tx.select(`select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)`, [JSON.stringify(claimsOf(user)), topic]);
        const [seen] = await tx.select<{ ok: boolean }>('select exists (select 1 from realtime.messages where id = $1) as ok', [row?.id ?? -1]);
        allowed = seen?.ok === true;
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return allowed;
  }

  /** The realtime insert policy for presence: may this user announce themselves on the channel? */
  async canSendPresence(user: AuthUser, topic: string): Promise<boolean> {
    let allowed = false;
    try {
      await this.db.transaction(async (tx) => {
        await tx.select(`select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)`, [JSON.stringify(claimsOf(user)), topic]);
        const res = await tx.schema('realtime').from('messages').insert({ topic, extension: 'presence', private: true });
        allowed = res.error === null;
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    return allowed;
  }

  #presenceChanged(topic: string): void {
    const state = this.presenceState(topic);
    for (const id of this.#topics.get(topic) ?? []) this.#connections.get(id)?.send('presence', { topic, state });
  }

  #drop(conn: Connection): void {
    if (!this.#connections.delete(conn.id)) return;
    for (const [topic, entry] of conn.topics) {
      this.#topics.get(topic)?.delete(conn.id);
      if (this.#topics.get(topic)?.size === 0) this.#topics.delete(topic);
      if (entry.presence) this.#presenceChanged(topic);
    }
    conn.topics.clear();
  }

  /** Ends every stream (shutdown). The apps reconnect to the next process. */
  closeAll(): void {
    for (const conn of [...this.#connections.values()]) conn.close('reconnect');
  }
}
