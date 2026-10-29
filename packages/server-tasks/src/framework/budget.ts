// BudgetStore over private.ai_budget_reserve / private.ai_budget_settle (security-privacy §7, PLT-04).
// Reservation and settlement are atomic in Postgres; this file only maps errors and results.
import type { BudgetReserveInput, BudgetReserveResult, BudgetScope, BudgetStore } from '@studify/ai';
import type { Sql } from './db.ts';

interface PgErrorLike {
  message?: unknown;
  detail?: unknown;
  hint?: unknown;
}

const SCOPE_BY_DETAIL: Readonly<Record<string, BudgetScope>> = {
  user: 'user_day',
  class_group: 'class_group_month',
  global: 'global_month',
};

/** Parses `resets_at=YYYY-MM-DD` from the HINT of the budget_exhausted exception. */
export function resetsAtFromHint(hint: unknown): string | undefined {
  if (typeof hint !== 'string') return undefined;
  const match = /resets_at=(\d{4}-\d{2}-\d{2})/.exec(hint);
  return match?.[1];
}

/** Returns the budget scope when `err` is the budget_exhausted exception, otherwise null. */
export function budgetExhaustedScope(err: unknown): { scope: BudgetScope; resetsAt?: string } | null {
  const e = err as PgErrorLike | null;
  if (!e || typeof e !== 'object' || e.message !== 'budget_exhausted') return null;
  const detail = typeof e.detail === 'string' ? e.detail : 'user';
  const scope = SCOPE_BY_DETAIL[detail] ?? 'user_day';
  const resetsAt = resetsAtFromHint(e.hint);
  return resetsAt ? { scope, resetsAt } : { scope };
}

export function createBudgetStore(sql: Sql): BudgetStore {
  return {
    async reserve(input: BudgetReserveInput): Promise<BudgetReserveResult> {
      const { ctx } = input;
      try {
        const { rows } = await sql.query<{ id: string }>(
          `select private.ai_budget_reserve($1::uuid, $2::uuid, $3::text, $4::text, $5::bigint) as id`,
          [ctx.userId, ctx.classGroupId, ctx.feature, ctx.budgetClass, Math.max(0, Math.ceil(input.estimateMicroUsd))],
        );
        const id = rows[0]?.id;
        if (!id) throw new Error('ai_budget_reserve returned no reservation id');
        return { ok: true, reservationId: id };
      } catch (err) {
        const exhausted = budgetExhaustedScope(err);
        if (exhausted) return { ok: false, scope: exhausted.scope, ...(exhausted.resetsAt ? { resetsAt: exhausted.resetsAt } : {}) };
        throw err;
      }
    },
    async settle(reservationId: string, actualMicroUsd: number): Promise<void> {
      await sql.query(`select private.ai_budget_settle($1::uuid, $2::bigint)`, [
        reservationId,
        Math.max(0, Math.round(actualMicroUsd)),
      ]);
    },
  };
}
