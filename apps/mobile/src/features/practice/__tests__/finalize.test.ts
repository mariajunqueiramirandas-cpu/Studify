/// <reference types="jest" />
// Durable quiz finalization: the pending queue in MMKV and the quiz-submit flush.
jest.mock('../../../api/functions', () => ({ callFunction: jest.fn() }));
jest.mock('../../../lib/kv', () => {
  const store = new Map<string, string>();
  const kv = {
    getString: (key: string) => store.get(key),
    set: (key: string, value: string) => {
      store.set(key, value);
    },
    remove: (key: string) => {
      store.delete(key);
    },
  };
  return { getKv: () => kv };
});

import { callFunction } from '../../../api/functions';
import { ApiError } from '../../../api/errors';
import { getKv } from '../../../lib/kv';
import {
  MAX_FLUSH_FAILURES,
  MAX_PENDING_AGE_MS,
  PENDING_SUBMITS_KEY,
  flushPendingQuizSubmits,
  pendingSubmitCount,
  queuePendingQuizSubmit,
} from '../finalize';

const mockCall = callFunction as jest.MockedFunction<typeof callFunction>;

const ATTEMPT_A = '0190f6a0-0000-7000-8000-00000000000a';
const ATTEMPT_B = '0190f6a0-0000-7000-8000-00000000000b';
const T0 = 1_800_000_000_000;

function queue(attemptId: string, now = T0) {
  queuePendingQuizSubmit({
    attemptId,
    finishedAt: new Date(now).toISOString(),
    answers: [
      {
        id: '0190f6a0-0000-7000-8000-0000000000a1',
        question_id: '4f2c0000-0000-4000-8000-000000000001',
        response: { alt: 'B' },
        confidence: 3,
        time_spent_ms: 4200,
        hints_used: 0,
      },
    ],
    now,
  });
}

function storedRecords(): Array<{ attempt_id: string; failures: number }> {
  const raw = getKv().getString(PENDING_SUBMITS_KEY);
  return raw ? JSON.parse(raw) : [];
}

beforeEach(() => {
  getKv().remove(PENDING_SUBMITS_KEY);
  mockCall.mockReset();
  jest.spyOn(Date, 'now').mockReturnValue(T0);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('queuePendingQuizSubmit', () => {
  it('stores the record and counts it', () => {
    queue(ATTEMPT_A);
    expect(pendingSubmitCount()).toBe(1);
    expect(storedRecords()[0]).toMatchObject({ attempt_id: ATTEMPT_A, failures: 0 });
  });

  it('replaces a record with the same attempt_id instead of duplicating it', () => {
    queue(ATTEMPT_A);
    queue(ATTEMPT_A);
    queue(ATTEMPT_B);
    expect(pendingSubmitCount()).toBe(2);
  });
});

describe('flushPendingQuizSubmits', () => {
  it('calls quiz-submit with the record body and a stable Idempotency-Key, then removes it on success', async () => {
    queue(ATTEMPT_A);
    mockCall.mockResolvedValueOnce({});

    await flushPendingQuizSubmits();

    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(mockCall).toHaveBeenCalledWith(
      'quiz-submit',
      {
        attempt_id: ATTEMPT_A,
        finished_at: new Date(T0).toISOString(),
        answers: [
          expect.objectContaining({ question_id: '4f2c0000-0000-4000-8000-000000000001', response: { alt: 'B' }, confidence: 3 }),
        ],
      },
      { idempotencyKey: `quiz-submit:${ATTEMPT_A}` },
    );
    expect(pendingSubmitCount()).toBe(0);
    expect(getKv().getString(PENDING_SUBMITS_KEY)).toBeUndefined();
  });

  it('keeps the record on not_found (the attempt row is not synced yet) and counts the failure', async () => {
    queue(ATTEMPT_A);
    mockCall.mockRejectedValueOnce(new ApiError('not_found', 404, 'nf'));

    await flushPendingQuizSubmits();

    expect(pendingSubmitCount()).toBe(1);
    expect(storedRecords()[0]?.failures).toBe(1);
  });

  it('removes the record on already_exists', async () => {
    queue(ATTEMPT_A);
    mockCall.mockRejectedValueOnce(new ApiError('already_exists', 409, 'já entregue'));

    await flushPendingQuizSubmits();

    expect(pendingSubmitCount()).toBe(0);
  });

  it('keeps the record on network errors and 5xx responses', async () => {
    queue(ATTEMPT_A);
    mockCall.mockRejectedValueOnce(new ApiError('offline', 0, 'offline'));
    await flushPendingQuizSubmits();
    expect(pendingSubmitCount()).toBe(1);

    mockCall.mockRejectedValueOnce(new ApiError('unknown', 503, 'down'));
    await flushPendingQuizSubmits();
    expect(pendingSubmitCount()).toBe(1);
    expect(storedRecords()[0]?.failures).toBe(2);
  });

  it('keeps a record whose call throws a non-API error', async () => {
    queue(ATTEMPT_A);
    mockCall.mockRejectedValueOnce(new TypeError('boom'));

    await expect(flushPendingQuizSubmits()).resolves.toBeUndefined();
    expect(pendingSubmitCount()).toBe(1);
  });

  it('drops a record after MAX_FLUSH_FAILURES failed flushes', async () => {
    queue(ATTEMPT_A);
    mockCall.mockRejectedValue(new ApiError('not_found', 404, 'nf'));

    for (let i = 1; i < MAX_FLUSH_FAILURES; i++) await flushPendingQuizSubmits();
    expect(pendingSubmitCount()).toBe(1);

    await flushPendingQuizSubmits();
    expect(pendingSubmitCount()).toBe(0);
  });

  it('drops a record older than 14 days without calling the server', async () => {
    queue(ATTEMPT_A, T0);
    jest.spyOn(Date, 'now').mockReturnValue(T0 + MAX_PENDING_AGE_MS + 1);

    await flushPendingQuizSubmits();

    expect(mockCall).not.toHaveBeenCalled();
    expect(pendingSubmitCount()).toBe(0);
  });

  it('keeps going past a failing record and sends the others', async () => {
    queue(ATTEMPT_A);
    queue(ATTEMPT_B);
    mockCall.mockRejectedValueOnce(new ApiError('not_found', 404, 'nf')).mockResolvedValueOnce({});

    await flushPendingQuizSubmits();

    expect(mockCall).toHaveBeenCalledTimes(2);
    expect(storedRecords().map((r) => r.attempt_id)).toEqual([ATTEMPT_A]);
  });

  it('does nothing when the queue is empty', async () => {
    await flushPendingQuizSubmits();
    expect(mockCall).not.toHaveBeenCalled();
  });

  describe('concurrency guard', () => {
    it('folds a second call made during a flush into it: the record is sent once', async () => {
      queue(ATTEMPT_A);
      let resolveCall!: () => void;
      mockCall.mockImplementationOnce(() => new Promise<unknown>((resolve) => (resolveCall = () => resolve({}))));

      const first = flushPendingQuizSubmits();
      const second = flushPendingQuizSubmits();
      resolveCall();
      await Promise.all([first, second]);

      expect(mockCall).toHaveBeenCalledTimes(1);
      expect(pendingSubmitCount()).toBe(0);
    });

    it('sends a record queued while a flush is running, without a second concurrent flush', async () => {
      queue(ATTEMPT_A);
      let resolveA!: () => void;
      mockCall
        .mockImplementationOnce(() => new Promise<unknown>((resolve) => (resolveA = () => resolve({}))))
        .mockResolvedValueOnce({});

      const first = flushPendingQuizSubmits();
      queue(ATTEMPT_B);
      const second = flushPendingQuizSubmits();
      resolveA();
      await Promise.all([first, second]);

      expect(mockCall.mock.calls.map((c) => (c[1] as { attempt_id: string }).attempt_id)).toEqual([ATTEMPT_A, ATTEMPT_B]);
      expect(pendingSubmitCount()).toBe(0);
    });

    it('allows a new flush once the previous one has finished', async () => {
      queue(ATTEMPT_A);
      mockCall.mockRejectedValueOnce(new ApiError('not_found', 404, 'nf'));
      await flushPendingQuizSubmits();

      mockCall.mockResolvedValueOnce({});
      await flushPendingQuizSubmits();

      expect(mockCall).toHaveBeenCalledTimes(2);
      expect(pendingSubmitCount()).toBe(0);
    });
  });
});
