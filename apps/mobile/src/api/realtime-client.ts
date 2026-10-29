// Realtime over the API's SSE stream (api.md §8, ADR 0012), with the channel shape the screens already used from
// supabase-js: `realtime.channel(topic).on(...).subscribe()`, `presenceState()`, `track()`, `removeChannel()`.
// One stream (realtime-stream) carries every channel of the app; joining, leaving and presence are separate calls,
// answered over SSE like every call. After a drop the client reopens the stream and joins its channels again, and
// re-sends its presence; a `reauth` event (the token expired) refreshes the session first.
// Pure (no Expo imports), so the reconnect logic is tested in Node with a fake transport.
import { createSseParser } from './sse';

export type ChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

export interface BroadcastMessage {
  event: string;
  payload: unknown;
}

/** A row channel's change: the row as the student may read it (null on DELETE). */
export interface RowChange<T = Record<string, unknown>> {
  op: 'INSERT' | 'UPDATE' | 'DELETE';
  new: T | null;
  old: { id: unknown } | null;
}

export interface RealtimeTransport {
  /** POST realtime-stream; the response body is the SSE stream. */
  open(signal: AbortSignal): Promise<Response>;
  /** realtime-join / realtime-leave / realtime-track; resolves with done.result, rejects with the API error. */
  call(name: 'realtime-join' | 'realtime-leave' | 'realtime-track', body: Record<string, unknown>): Promise<unknown>;
  /** Refreshes the session (401 or `reauth`). */
  refresh(): Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  /** No byte for this long (the server pings every 15 s) means a dead stream. Default 45 s. */
  stallMs?: number;
}

type Handler =
  | { type: 'broadcast'; event: string; fn: (message: BroadcastMessage) => void }
  | { type: 'presence'; fn: () => void }
  | { type: 'change'; fn: (change: RowChange) => void };

/** Row channel topic: `rows:<table>:<column>=<value>`, e.g. rowTopic('ai_jobs', 'user_id', id). */
export function rowTopic(table: string, column: string, value: string): string {
  return `rows:${table}:${column}=${value}`;
}

export class RealtimeChannel {
  readonly handlers: Handler[] = [];
  state: Record<string, unknown[]> = {};
  joined = false;
  presencePayload: Record<string, unknown> | null = null;
  statusCallback: ((status: ChannelStatus) => void) | null = null;
  removed = false;

  constructor(
    readonly topic: string,
    readonly presenceKey: string | null,
    private readonly client: RealtimeClient,
  ) {}

  on(type: 'broadcast', filter: { event: string }, fn: (message: BroadcastMessage) => void): this;
  on(type: 'presence', filter: { event: 'sync' }, fn: () => void): this;
  on(type: 'change', fn: (change: RowChange<any>) => void): this;
  on(type: string, a: unknown, b?: unknown): this {
    if (type === 'broadcast') this.handlers.push({ type, event: (a as { event: string }).event, fn: b as (m: BroadcastMessage) => void });
    else if (type === 'presence') this.handlers.push({ type, fn: b as () => void });
    else if (type === 'change') this.handlers.push({ type, fn: a as (c: RowChange) => void });
    return this;
  }

  subscribe(callback?: (status: ChannelStatus) => void): this {
    this.statusCallback = callback ?? null;
    this.client.add(this);
    return this;
  }

  /** `{ key: [payload, ...] }`, the last presence state the server sent. */
  presenceState(): Record<string, unknown[]> {
    return this.state;
  }

  /** Announces (or updates) this app's presence; re-sent after a reconnect. */
  async track(payload: Record<string, unknown>): Promise<'ok' | 'error'> {
    this.presencePayload = payload;
    return this.client.track(this);
  }

  status(status: ChannelStatus): void {
    try {
      this.statusCallback?.(status);
    } catch {
      /* a screen's callback never breaks the stream */
    }
  }
}

const RETRY_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

export class RealtimeClient {
  readonly #channels = new Set<RealtimeChannel>();
  #connectionId: string | null = null;
  #running = false;
  #abort: AbortController | null = null;

  constructor(private readonly transport: RealtimeTransport) {}

  /** The stream's id while it is open (tests). */
  get connectionId(): string | null {
    return this.#connectionId;
  }

  channel(topic: string, options: { presence?: { key: string } } = {}): RealtimeChannel {
    return new RealtimeChannel(topic, options.presence?.key ?? null, this);
  }

  add(channel: RealtimeChannel): void {
    this.#channels.add(channel);
    if (this.#connectionId) void this.#join(channel);
    if (!this.#running) void this.#run();
  }

  async removeChannel(channel: RealtimeChannel): Promise<void> {
    if (!this.#channels.delete(channel)) return;
    channel.removed = true;
    channel.status('CLOSED');
    const stillUsed = [...this.#channels].some((c) => c.topic === channel.topic);
    if (this.#connectionId && channel.joined && !stillUsed) {
      await this.transport.call('realtime-leave', { connection_id: this.#connectionId, topic: channel.topic }).catch(() => undefined);
    }
    channel.joined = false;
    if (this.#channels.size === 0) this.#abort?.abort();
  }

  /** Removes every channel and ends the stream (sign-out). */
  async close(): Promise<void> {
    for (const channel of [...this.#channels]) await this.removeChannel(channel);
    this.#abort?.abort();
  }

  async track(channel: RealtimeChannel): Promise<'ok' | 'error'> {
    if (!this.#connectionId || !channel.joined || !channel.presenceKey || !channel.presencePayload) return 'error';
    try {
      await this.transport.call('realtime-track', { connection_id: this.#connectionId, topic: channel.topic, key: channel.presenceKey, payload: channel.presencePayload });
      return 'ok';
    } catch {
      return 'error';
    }
  }

  async #join(channel: RealtimeChannel): Promise<void> {
    const connectionId = this.#connectionId;
    if (!connectionId || channel.removed) return;
    try {
      const result = (await this.transport.call('realtime-join', { connection_id: connectionId, topic: channel.topic })) as { presence?: Record<string, unknown[]> };
      if (channel.removed || this.#connectionId !== connectionId) return;
      channel.joined = true;
      channel.state = result?.presence ?? {};
      channel.status('SUBSCRIBED');
      if (channel.presencePayload) await this.track(channel);
    } catch {
      if (!channel.removed) channel.status('CHANNEL_ERROR');
    }
  }

  #dispatch(event: string, data: Record<string, unknown>): void {
    if (event === 'ready') {
      this.#connectionId = String(data.connection_id);
      for (const channel of this.#channels) void this.#join(channel);
      return;
    }
    const topic = data.topic;
    for (const channel of this.#channels) {
      if (channel.topic !== topic) continue;
      for (const h of channel.handlers) {
        try {
          if (event === 'broadcast' && h.type === 'broadcast' && (h.event === data.event || h.event === '*')) h.fn({ event: String(data.event), payload: data.payload });
          else if (event === 'presence' && h.type === 'presence') {
            channel.state = (data.state as Record<string, unknown[]>) ?? {};
            h.fn();
          } else if (event === 'change' && h.type === 'change') h.fn({ op: data.op as RowChange['op'], new: (data.new as Record<string, unknown>) ?? null, old: (data.old as { id: unknown }) ?? null });
        } catch {
          /* a screen's handler never breaks the stream */
        }
      }
      if (event === 'presence' && !channel.handlers.some((h) => h.type === 'presence')) channel.state = (data.state as Record<string, unknown[]>) ?? {};
    }
  }

  async #run(): Promise<void> {
    this.#running = true;
    let failures = 0;
    const sleep = this.transport.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    while (this.#channels.size > 0) {
      const controller = new AbortController();
      this.#abort = controller;
      let reauth = false;
      let stall: ReturnType<typeof setTimeout> | undefined;
      const arm = () => {
        if (stall !== undefined) clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), this.transport.stallMs ?? 45_000);
      };
      try {
        let response = await this.transport.open(controller.signal);
        if (response.status === 401) {
          await response.body?.cancel().catch(() => undefined);
          await this.transport.refresh();
          response = await this.transport.open(controller.signal);
        }
        if (!response.ok || !response.body) throw new Error(`realtime stream answered ${response.status}`);
        const reader = response.body.getReader();
        // Leaving, a stall or close() aborts: the pending read must end too, not only the request.
        controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => undefined), { once: true });
        const decoder = new TextDecoder();
        const parser = createSseParser((message) => {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(message.data) as Record<string, unknown>;
          } catch {
            return;
          }
          if (message.event === 'ready') failures = 0;
          if (message.event === 'reauth') reauth = true;
          this.#dispatch(message.event, data);
        });
        arm();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          arm();
          parser.feed(decoder.decode(chunk.value, { stream: true }));
        }
      } catch {
        /* dropped or refused: reconnect below */
      } finally {
        if (stall !== undefined) clearTimeout(stall);
        controller.abort();
      }
      this.#connectionId = null;
      for (const channel of this.#channels) {
        channel.joined = false;
        channel.status(reauth ? 'TIMED_OUT' : 'CHANNEL_ERROR');
      }
      if (this.#channels.size === 0) break;
      if (reauth) {
        await this.transport.refresh().catch(() => undefined);
        continue;
      }
      await sleep(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)] as number);
      failures += 1;
    }
    this.#running = false;
    // A channel added while the loop was ending would otherwise wait forever.
    if (this.#channels.size > 0) void this.#run();
  }
}
