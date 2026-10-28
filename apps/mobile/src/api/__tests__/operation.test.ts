/// <reference types="jest" />
import { ApiError } from '../errors';
import { NETWORK_ATTEMPTS, OPERATION_DEADLINE_MS, REQUEST_DEADLINE_MS, RUNNING_HEADER, retryAfterMs, untilSettled, type Reply } from '../operation';

function reply(status: number, text = '', headers: Record<string, string> = {}): Reply {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, text, header: (name) => lower[name.toLowerCase()] ?? null };
}

const running = (key: string, retryAfter = '1') =>
  reply(202, JSON.stringify({ status: 'running', operation_key: key }), { [RUNNING_HEADER]: 'running', 'Retry-After': retryAfter });

/** Records every send with its key and answers from a script. No real waiting. */
function scripted(answers: (Reply | Error | 'hang')[]) {
  const keys: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const deps = {
    send: (key: string, signal: AbortSignal) => {
      keys.push(key);
      const next = answers.shift() ?? reply(500);
      if (next === 'hang') {
        return new Promise<Reply>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
  return { deps, keys, sleeps };
}

describe('untilSettled (ADR 0009)', () => {
  it('returns a final answer at once', async () => {
    const { deps, keys } = scripted([reply(200, '{"ok":true}')]);
    const out = await untilSettled(deps, 'k1');
    expect(out.status).toBe(200);
    expect(keys).toEqual(['k1']);
  });

  it('asks again with the same key while the server says the call is running', async () => {
    const { deps, keys, sleeps } = scripted([running('k1', '2'), running('k1'), reply(201, '{"id":"x"}')]);
    const out = await untilSettled(deps, 'k1');
    expect(out.status).toBe(201);
    expect(keys).toEqual(['k1', 'k1', 'k1']);
    expect(sleeps).toEqual([2000, 1000]);
  });

  it('follows the running call it joined instead of starting another', async () => {
    const { deps, keys } = scripted([running('k-original'), reply(200, '{}')]);
    await untilSettled(deps, 'k-mine');
    expect(keys).toEqual(['k-mine', 'k-original']);
  });

  it('treats a 202 without the running header as a final answer', async () => {
    const { deps } = scripted([reply(202, '{"status":"preparing","job_id":"j"}')]);
    const out = await untilSettled(deps, 'k1');
    expect(out.status).toBe(202);
  });

  it('resends with the same key after a network failure', async () => {
    const { deps, keys } = scripted([new TypeError('Network request failed'), reply(200, '{}')]);
    const out = await untilSettled(deps, 'k1');
    expect(out.status).toBe(200);
    expect(keys).toEqual(['k1', 'k1']);
  });

  it('gives up as offline after NETWORK_ATTEMPTS failures in a row', async () => {
    const { deps, keys } = scripted(Array.from({ length: NETWORK_ATTEMPTS }, () => new TypeError('Network request failed')));
    await expect(untilSettled(deps, 'k1')).rejects.toMatchObject({ code: 'offline' });
    expect(keys).toHaveLength(NETWORK_ATTEMPTS);
  });

  it('gives up as timeout when attempts go silent past their deadline', async () => {
    jest.useFakeTimers();
    try {
      const { deps } = scripted(Array.from({ length: NETWORK_ATTEMPTS }, () => 'hang' as const));
      const settled = untilSettled(deps, 'k1').catch((e: unknown) => e);
      for (let i = 0; i < NETWORK_ATTEMPTS; i++) await jest.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS);
      const error = await settled;
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('timeout');
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops following a call that runs past the operation deadline', async () => {
    const answers = Array.from({ length: 1000 }, () => running('k1', '5'));
    const { deps } = scripted(answers);
    await expect(untilSettled(deps, 'k1')).rejects.toMatchObject({ code: 'timeout' });
    expect(deps.now()).toBeGreaterThanOrEqual(OPERATION_DEADLINE_MS);
  });

  it('returns error statuses for the caller to map', async () => {
    const { deps } = scripted([reply(402, '{"error":{"code":"budget_exhausted","message":"x"}}')]);
    const out = await untilSettled(deps, 'k1');
    expect(out.status).toBe(402);
  });

  it('rethrows an abort from the caller without retrying', async () => {
    const controller = new AbortController();
    controller.abort();
    const { deps, keys } = scripted([reply(200)]);
    await expect(untilSettled(deps, 'k1', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(keys).toEqual([]);
  });
});

describe('retryAfterMs', () => {
  it('reads seconds, defaults to one second and caps long waits', () => {
    expect(retryAfterMs(() => '2')).toBe(2000);
    expect(retryAfterMs(() => null)).toBe(1000);
    expect(retryAfterMs(() => 'soon')).toBe(1000);
    expect(retryAfterMs(() => '60')).toBe(5000);
  });
});
