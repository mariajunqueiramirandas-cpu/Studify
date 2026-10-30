// AI budget gate and usage log (security-privacy §7, ai-pipeline §9). The BudgetStore wraps the
// service-only private.ai_budget_reserve / ai_budget_settle functions. The private schema is not exposed
// through PostgREST; in production db.schema('private') runs over direct SQL (private-schema.ts).
import type { Db } from '@studify/db';
import type { AiUsageRow, BudgetReserveInput, BudgetReserveResult, BudgetScope, BudgetStore, UsageSink } from '@studify/ai';
import { DEFAULT_TIME_ZONE, localDateOf } from '@studify/shared';
import { failureFromPg, type PgErrorLike } from './errors.ts';

/** The DETAIL of budget_exhausted names the scope: global | user | class_group (core_rpc.sql). */
export function scopeFromDetail(detail: string | null | undefined): BudgetScope {
  if (detail === 'user') return 'user_day';
  if (detail === 'class_group') return 'class_group_month';
  return 'global_month';
}

/** HINT is `resets_at=<date>`. */
export function resetsAtFromHint(hint: string | null | undefined): string | undefined {
  const match = /resets_at=(\d{4}-\d{2}-\d{2})/.exec(hint ?? '');
  return match ? `${match[1]}T00:00:00-03:00` : undefined;
}

export function makeBudgetStore(db: Db): BudgetStore {
  return {
    async reserve(input: BudgetReserveInput): Promise<BudgetReserveResult> {
      const { data, error } = await db.schema('private').rpc('ai_budget_reserve', {
        p_user: input.ctx.userId,
        p_class_group: input.ctx.classGroupId ?? null,
        p_feature: input.ctx.feature,
        p_budget_class: input.ctx.budgetClass,
        p_estimate_micro_usd: input.estimateMicroUsd,
      });
      if (error) {
        const pg = error as PgErrorLike;
        if (pg.message === 'budget_exhausted') {
          return { ok: false, scope: scopeFromDetail(pg.details), resetsAt: resetsAtFromHint(pg.hint) };
        }
        throw failureFromPg(pg);
      }
      return { ok: true, reservationId: String(data) };
    },
    async settle(reservationId: string, actualMicroUsd: number): Promise<void> {
      const { error } = await db.schema('private').rpc('ai_budget_settle', {
        p_reservation_id: reservationId,
        p_actual_micro_usd: Math.max(0, Math.round(actualMicroUsd)),
      });
      // A failed settle leaves the hold to expire after 10 minutes (ai_budget_release_expired); log only.
      if (error) console.error('ai_budget_settle failed', (error as PgErrorLike).message);
    },
  };
}

/** Maps one AiUsageRow onto public.ai_usage (data-model §5.11). Columns with no home are dropped, see the report. */
export function usageRecord(row: AiUsageRow): Record<string, unknown> {
  const fellBack = row.model_served !== row.model_requested;
  return {
    user_id: row.user_id,
    class_group_id: row.class_group_id,
    subject_id: row.subject_id,
    job_id: row.job_id,
    document_id: row.document_id,
    node_id: row.node_id,
    feature: row.feature,
    task: row.task_id,
    model: row.model_requested,
    fallback_model: fellBack || row.fallback_used ? row.model_served : null,
    request_id: row.request_id,
    batch: row.mode === 'batch',
    effort: row.effort,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_creation_input_tokens: row.cache_creation_5m_tokens + row.cache_creation_1h_tokens,
    cache_read_input_tokens: row.cache_read_tokens,
    server_tool_uses: row.server_tool_uses,
    cost_micro_usd: row.cost_micro_usd,
    price_version: row.price_version,
    stop_reason: row.stop_reason,
    refusal_category: row.refusal_category,
    latency_ms: row.latency_ms,
    prompt_version: row.prompt_version,
    thinking_tokens: row.thinking_tokens,
  };
}

export function makeUsageSink(db: Db): UsageSink {
  return {
    async record(row: AiUsageRow): Promise<void> {
      const { error } = await db.from('ai_usage').insert(usageRecord(row));
      // Usage logging must not fail a student's request after the money is spent: log and continue.
      if (error) console.error('ai_usage insert failed', error.message);
    },
  };
}

/** Share of the user's daily AI budget used, 0–100 (PLT-04.2). Reads the private budget row only. */
export async function usagePctToday(db: Db, userId: string, now: Date): Promise<number> {
  const { data: profile } = await db.from('profiles').select('timezone').eq('id', userId).maybeSingle();
  const timeZone = (profile?.timezone as string | undefined) ?? DEFAULT_TIME_ZONE;
  const day = localDateOf(now, timeZone);
  const { data } = await db
    .schema('private')
    .from('ai_budgets')
    .select('limit_micro_usd, reserved_micro_usd, spent_micro_usd')
    .eq('scope_type', 'user')
    .eq('scope_id', userId)
    .eq('period_type', 'day')
    .eq('period_start', day)
    .maybeSingle();
  if (!data) return 0;
  const limit = Number(data.limit_micro_usd);
  if (limit <= 0) return 100;
  const used = Number(data.spent_micro_usd) + Number(data.reserved_micro_usd);
  return Math.min(100, Math.max(0, Math.round((used / limit) * 100)));
}

