/// <reference types="jest" />
// streamFunction (ADR 0009): a dropped stream reconnects with the same key, follows `202 running`, and a replayed
// transcript does not deliver an event twice. An `error` event ends the stream with that ApiError.
// jest.mock calls are hoisted above these imports.
import { ApiError } from '../errors';
import { streamFunction, type SseEvent } from '../functions';
jest.mock('../supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }), refreshSession: async () => ({}) } },
}));
jest.mock('../env', () => ({ getApiUrl: () => 'https://api.test/api', getEnv: () => ({ anonKey: 'anon' }) }));
jest.mock('../../lib/device', () => ({ getDeviceId: () => 'device-1' }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { android: { versionCode: 1 } } } }));

interface Scripted {
  status: number;
  headers?: Record<string, string>;
  chunks: string[];
  /** How the attempt ends: the body completes, or the connection drops. */
  end: 'load' | 'error';
}

const sent: { key: string | undefined }[] = [];
let script: Scripted[] = [];

class FakeXhr {
  status = 0;
  readyState = 0;
  responseText = '';
  onreadystatechange: (() => void) | null = null;
  onprogress: (() => void) | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  #headers: Record<string, string> = {};
  #request: Record<string, string> = {};
  #aborted = false;

  open() {}
  setRequestHeader(name: string, value: string) {
    this.#request[name.toLowerCase()] = value;
  }
  getResponseHeader(name: string) {
    return this.#headers[name.toLowerCase()] ?? null;
  }
  abort() {
    this.#aborted = true;
    this.onabort?.();
  }
  send() {
    sent.push({ key: this.#request['idempotency-key'] });
    const next = script.shift();
    if (!next) throw new Error('no scripted response left');
    void (async () => {
      await Promise.resolve();
      this.status = next.status;
      this.#headers = Object.fromEntries(Object.entries(next.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      this.readyState = 2;
      this.onreadystatechange?.();
      for (const chunk of next.chunks) {
        if (this.#aborted) return;
        this.responseText += chunk;
        this.onprogress?.();
        await Promise.resolve();
      }
      if (this.#aborted) return;
      this.readyState = 4;
      if (next.end === 'error') this.onerror?.();
      else this.onload?.();
    })();
  }
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const META = frame('meta', { request_id: 'r1' });
const PART1 = frame('delta', { text: 'Olá, ' });
const PART2 = frame('delta', { text: 'tudo bem?' });
const DONE = frame('done', { stop_reason: 'end_turn', usage_pct_today: 3 });
const SSE = { 'Content-Type': 'text/event-stream' };

beforeEach(() => {
  sent.length = 0;
  script = [];
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
});

function collect() {
  const events: SseEvent[] = [];
  return { events, onEvent: (e: SseEvent) => void events.push(e) };
}

describe('streamFunction (ADR 0009)', () => {
  it('delivers a complete stream once', async () => {
    script = [{ status: 200, headers: SSE, chunks: [META, PART1, PART2, DONE], end: 'load' }];
    const { events, onEvent } = collect();
    await streamFunction('tutor-chat', {}, onEvent, { idempotencyKey: 'key-1' }).done;
    expect(events.map((e) => e.event)).toEqual(['meta', 'delta', 'delta', 'done']);
    expect(sent).toEqual([{ key: 'key-1' }]);
  });

  it('resumes a dropped stream with the same key and never repeats an event', async () => {
    script = [
      // The connection drops after the first delta; the server keeps writing into the transcript.
      { status: 200, headers: SSE, chunks: [META, PART1], end: 'error' },
      // Still running on the server: ask again shortly.
      { status: 202, headers: { 'x-operation-status': 'running', 'Retry-After': '0.01' }, chunks: ['{"status":"running","operation_key":"key-1"}'], end: 'load' },
      // Finished: the stored stream is replayed from the start.
      { status: 200, headers: SSE, chunks: [META, PART1, PART2, DONE], end: 'load' },
    ];
    const { events, onEvent } = collect();
    await streamFunction('tutor-chat', {}, onEvent, { idempotencyKey: 'key-1' }).done;
    expect(events.map((e) => (e.event === 'delta' ? `delta:${(e.data as { text: string }).text}` : e.event))).toEqual([
      'meta',
      'delta:Olá, ',
      'delta:tudo bem?',
      'done',
    ]);
    expect(sent.map((s) => s.key)).toEqual(['key-1', 'key-1', 'key-1']);
  }, 10_000);

  it('ends with the ApiError of an error event and does not retry it', async () => {
    script = [
      {
        status: 200,
        headers: SSE,
        chunks: [META, frame('error', { code: 'budget_exhausted', message: 'Você atingiu o limite de IA de hoje.' })],
        end: 'load',
      },
    ];
    const { onEvent } = collect();
    const error = await streamFunction('teaching-turn', {}, onEvent, { idempotencyKey: 'key-2' }).done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('budget_exhausted');
    expect(sent).toHaveLength(1);
  });

  it('maps an HTTP error status before the stream opens', async () => {
    script = [{ status: 404, headers: { 'Content-Type': 'application/json' }, chunks: ['{"error":{"code":"not_found","message":"Não achei."}}'], end: 'load' }];
    const { onEvent } = collect();
    const error = await streamFunction('teaching-turn', {}, onEvent, { idempotencyKey: 'key-3' }).done.catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('not_found');
  });
});
