// A push-based async iterable for stream events. Runtime-neutral.

export interface EventQueue<T> {
  push(item: T): void;
  close(): void;
  fail(error: unknown): void;
  iterable: AsyncIterable<T>;
}

export function createEventQueue<T>(): EventQueue<T> {
  const buffered: T[] = [];
  const waiting: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  let closed = false;
  let failure: { error: unknown } | null = null;

  const push = (item: T): void => {
    if (closed || failure) return;
    const waiter = waiting.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else buffered.push(item);
  };

  const close = (): void => {
    if (closed || failure) return;
    closed = true;
    for (const waiter of waiting.splice(0)) waiter.resolve({ value: undefined, done: true });
  };

  const fail = (error: unknown): void => {
    if (closed || failure) return;
    failure = { error };
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  };

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift() as T, done: false });
          }
          if (failure) return Promise.reject(failure.error);
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
        },
      };
    },
  };

  return { push, close, fail, iterable };
}
