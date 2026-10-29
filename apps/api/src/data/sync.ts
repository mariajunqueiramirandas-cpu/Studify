// The offline mirror's pull (mobile-app.md §4.3, apps/mobile/src/db/sync): one page of a mirrored table after the
// keyset cursor (updated_at, ...pk), as the student may read it. Pushes go through sync-push.
import { z } from 'zod';
import { dataRoute, rows, type DataRoute } from './define.ts';

/** The tables the app mirrors (apps/mobile/src/db/sync/registry.ts PULL_TABLES). Anything else is refused. */
export const SYNC_TABLES = new Set([
  'profiles', 'study_preferences', 'subjects', 'subject_user_settings', 'knowledge_nodes', 'node_sources', 'node_user_settings',
  'glossary_terms', 'notes', 'note_highlights', 'cards', 'card_overrides', 'card_states', 'goals', 'exams', 'exam_scope_nodes',
  'plan_items', 'mistakes', 'questions', 'quizzes', 'quiz_attempts', 'attempt_answers', 'feed_items', 'mastery',
  'daily_activity', 'streaks', 'achievements', 'memory_palaces', 'mnemonics',
]);

const Column = z.string().regex(/^[a-z_][a-z0-9_]*$/);
const Scalar = z.union([z.string().max(200), z.number()]);
const Filter = z.discriminatedUnion('op', [
  z.object({ column: Column, op: z.literal('in'), value: z.array(z.string().max(200)).max(1000) }),
  z.object({ column: Column, op: z.enum(['eq', 'gte', 'lte']), value: Scalar }),
  z.object({ column: Column, op: z.literal('is_null') }),
]);

const PullInput = z.object({
  table: z.string().refine((t) => SYNC_TABLES.has(t), 'not a mirrored table'),
  select: z.array(Column).min(1).max(100),
  pk: z.array(Column).min(1).max(4),
  cursor: z.object({ updatedAt: z.string().max(64).nullable(), key: z.array(Scalar).max(4).nullable() }),
  filters: z.array(Filter).max(8),
  limit: z.number().int().min(1).max(1000),
});

/** (updated_at, ...pk) > cursor, lexicographically, in or() syntax (the same condition the app built before). */
export function cursorCondition(pk: string[], updatedAt: string, key: (string | number)[]): string {
  const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const ts = quote(updatedAt);
  const clauses = [`updated_at.gt.${ts}`];
  pk.forEach((column, i) => {
    const equalities = pk.slice(0, i).map((c, j) => `,${c}.eq.${quote(String(key[j]))}`).join('');
    clauses.push(`and(updated_at.eq.${ts}${equalities},${column}.gt.${quote(String(key[i]))})`);
  });
  return clauses.join(',');
}

export const routes: DataRoute[] = [
  dataRoute({
    name: 'sync-pull',
    write: false,
    input: PullInput,
    example: (seed) => ({
      table: 'subjects',
      select: ['id', 'name', 'updated_at', 'deleted_at'],
      pk: ['id'],
      cursor: { updatedAt: '2026-01-01T00:00:00.000000+00:00', key: [seed.missingId] },
      filters: [{ column: 'system_kind', op: 'is_null' as const }],
      limit: 100,
    }),
    run: async ({ db, input }) => {
      let query = db.from(input.table).select(input.select.join(','));
      for (const f of input.filters) {
        if (f.op === 'in') query = query.in(f.column, f.value);
        else if (f.op === 'eq') query = query.eq(f.column, f.value);
        else if (f.op === 'gte') query = query.gte(f.column, f.value);
        else if (f.op === 'lte') query = query.lte(f.column, f.value);
        else query = query.is(f.column, null);
      }
      if (input.cursor.updatedAt !== null && input.cursor.key !== null) {
        query = query.or(cursorCondition(input.pk, input.cursor.updatedAt, input.cursor.key));
      }
      query = query.order('updated_at', { ascending: true });
      for (const column of input.pk) query = query.order(column, { ascending: true });
      return { rows: await rows(query.limit(input.limit), `sync-pull ${input.table}`) };
    },
  }),
];
