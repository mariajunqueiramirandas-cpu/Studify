// Small helpers around supabase-js results. Every job reads through these so an error becomes a
// JobDataError (retried by pg-boss) instead of a silent empty result.

export interface DbResult<T> {
  data: T | null;
  error: { message: string } | null;
}

export class JobDataError extends Error {
  constructor(
    message: string,
    readonly code: string = 'db_error',
  ) {
    super(message);
    this.name = 'JobDataError';
  }
}

export function unwrap<T>(res: DbResult<T>, what: string): T | null {
  if (res.error) throw new JobDataError(`${what}: ${res.error.message}`);
  return res.data;
}

export function unwrapRows<T>(res: DbResult<T[]>, what: string): T[] {
  return unwrap(res, what) ?? [];
}

/** Pages through a PostgREST table in windows of `pageSize` rows (the default API limit is 1000). */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<DbResult<T[]>>,
  what: string,
  pageSize = 1000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const rows = unwrapRows(await page(from, from + pageSize - 1), what);
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Keeps `in (...)` filters under PostgREST's URL length limit. */
export const IN_CHUNK = 150;

export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}
