// Data endpoints (ADR 0012, api.md §3): the reads and writes the app used to send straight to Supabase's table API,
// each as a named API call. Every endpoint runs its queries as the signed-in student (`ctx.db` is db.asUser), so
// the row level security policies that guarded the app's direct queries still decide what it may read and write;
// an endpoint never widens that. Answers go over SSE like every call (meta, then done.result): reads are read-only
// streams without an idempotency record, writes are idempotent by their Idempotency-Key.
//
// `example` is an input the route accepts for a freshly seeded student; data-routes.integration.test.ts runs every
// route with it against the migrated schema, so a misspelled table or column fails CI, not the app.
import type { ZodType } from 'zod';
import { ApiFailure } from '@studify/shared';
import type { Db, DbError, DbResult } from '@studify/db';
import type { AuthUser } from '../shared/auth.ts';
import type { Deps } from '../shared/deps.ts';
import { failureFromPg } from '../shared/errors.ts';
import { defineFunction } from '../shared/http.ts';

export interface DataContext<I> {
  input: I;
  user: AuthUser;
  /** The student's client: every statement runs as `authenticated` with their claims. */
  db: Db;
  now: Date;
  deps: Deps;
}

/** Ids a seeded student owns, for route examples (data-routes.integration.test.ts). */
export interface DataSeed {
  userId: string;
  subjectId: string;
  documentId: string;
  nodeId: string;
  classGroupId: string;
  goalId: string;
  examId: string;
  /** Any id that matches no row. */
  missingId: string;
}

export interface DataRoute<I = any> {
  /** The route under /api/<name>; kebab case, feature first: `subjects-list`. */
  name: string;
  /** Writes are idempotent by Idempotency-Key and never replayed as reads. */
  write: boolean;
  input: ZodType<I>;
  example: (seed: DataSeed) => I;
  run(ctx: DataContext<I>): Promise<unknown>;
}

export function dataRoute<I>(route: DataRoute<I>): DataRoute<I> {
  return route;
}

export function handlerOf<I>(route: DataRoute<I>): (req: Request, deps: Deps) => Promise<Response> {
  return defineFunction<I>({
    name: route.name,
    mutating: route.write,
    readOnly: !route.write,
    input: route.input,
    run: async (ctx) => {
      const result = await route.run({ input: ctx.input, user: ctx.user, db: ctx.deps.asUser(ctx.user), now: ctx.now, deps: ctx.deps });
      return ctx.json(result ?? null);
    },
  });
}

/** A database error as the error the app sees. Unknown ones are internal errors, logged with their SQLSTATE. */
export function dbFailure(error: DbError, what: string): Error {
  const mapped = failureFromPg(error);
  if (mapped.code !== 'internal_error') return mapped;
  switch (error.code) {
    case 'PGRST116':
      return new ApiFailure('not_found');
    case '23503':
    case '23514':
    case '23502':
    case '22P02':
    case '22007':
    case '22008':
      return new ApiFailure('invalid_request');
    default:
      return new Error(`${what}: ${error.code} ${error.message}`);
  }
}

/** The rows of a read; throws the mapped error. */
export async function rows<T = any>(query: PromiseLike<DbResult<any>>, what = 'query'): Promise<T[]> {
  const res = await query;
  if (res.error) throw dbFailure(res.error, what);
  return (res.data ?? []) as T[];
}

/** One row or null (maybeSingle). */
export async function maybe<T = any>(query: PromiseLike<DbResult<any>>, what = 'query'): Promise<T | null> {
  const res = await query;
  if (res.error) throw dbFailure(res.error, what);
  return (res.data ?? null) as T | null;
}

/** A write or rpc whose data is not needed; throws the mapped error. Returns `data` for writes with .select(). */
export async function done<T = unknown>(query: PromiseLike<DbResult<any>>, what = 'write'): Promise<T> {
  const res = await query;
  if (res.error) throw dbFailure(res.error, what);
  return res.data as T;
}

/** A count from `select(..., { count: 'exact', head: true })`. */
export async function count(query: PromiseLike<DbResult<any>>, what = 'count'): Promise<number> {
  const res = await query;
  if (res.error) throw dbFailure(res.error, what);
  return res.count ?? 0;
}
