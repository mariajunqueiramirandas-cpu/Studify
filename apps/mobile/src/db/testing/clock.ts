// Controllable device clock and backoff timers for engine tests. Test-only.
export interface FakeClock {
  now: () => number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function createFakeClock(start = Date.parse('2026-10-27T12:00:00.000Z')): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    set(ms) {
      t = ms;
    },
  };
}

export interface FakeTimers {
  setTimer: (fn: () => void, ms: number) => () => void;
  /** Delays requested so far, in order. */
  delays: number[];
  /** Runs the pending timer (if any). */
  fire(): void;
  pending(): number;
}

export function createFakeTimers(): FakeTimers {
  let pendingFn: (() => void) | null = null;
  const delays: number[] = [];
  return {
    delays,
    setTimer(fn, ms) {
      delays.push(ms);
      pendingFn = fn;
      return () => {
        if (pendingFn === fn) pendingFn = null;
      };
    },
    fire() {
      const fn = pendingFn;
      pendingFn = null;
      fn?.();
    },
    pending: () => (pendingFn ? 1 : 0),
  };
}
