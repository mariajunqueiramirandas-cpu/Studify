// Bounded parallelism for slice calls (ai-pipeline §7.5: ≤ 4 outline slices in parallel) and fan-out writes.

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Runs at most `size` tasks at once. A waiting task with a lower `priority` starts first; equal priorities start in
 * the order they were asked for.
 */
export function priorityLimiter(size: number): <T>(priority: number, fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<{ priority: number; start: () => void }> = [];
  const next = () => {
    if (active >= size || waiting.length === 0) return;
    let best = 0;
    for (let i = 1; i < waiting.length; i += 1) if ((waiting[i] as { priority: number }).priority < (waiting[best] as { priority: number }).priority) best = i;
    const [entry] = waiting.splice(best, 1);
    active += 1;
    entry?.start();
  };
  return <T>(priority: number, fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      waiting.push({
        priority,
        start: () => {
          Promise.resolve()
            .then(fn)
            .then(resolve, reject)
            .finally(() => {
              active -= 1;
              next();
            });
        },
      });
      next();
    });
}
