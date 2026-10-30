// UsageSink over public.ai_usage (ai-pipeline §9.2). The table has fewer columns than AiUsageRow:
// budget_class, mode, ttft, batch_id, custom_id, attempt and error_code are not stored. Batch
// reconciliation therefore relies on request ids and the job logs.
import type { AiUsageRow, UsageSink } from '@studify/ai';
import type { Sql } from './db.ts';
import type { Logger } from './logger.ts';

/** Column values for one ai_usage insert, in the order used by INSERT_SQL. */
export function usageParams(row: AiUsageRow): unknown[] {
  const fallback = row.model_served !== row.model_requested ? row.model_served : null;
  return [
    row.user_id,
    row.class_group_id,
    row.subject_id,
    row.job_id,
    row.document_id,
    row.node_id,
    row.feature,
    row.task_id,
    row.model_requested,
    fallback,
    row.request_id,
    row.mode === 'batch',
    row.effort,
    row.input_tokens,
    row.output_tokens,
    row.cache_creation_5m_tokens + row.cache_creation_1h_tokens,
    row.cache_read_tokens,
    row.server_tool_uses ? JSON.stringify(row.server_tool_uses) : null,
    row.cost_micro_usd,
    row.price_version,
    row.stop_reason,
    row.refusal_category,
    row.latency_ms,
    row.prompt_version,
    row.thinking_tokens,
  ];
}

const INSERT_SQL = `
insert into public.ai_usage (
  user_id, class_group_id, subject_id, job_id, document_id, node_id, feature, task, model,
  fallback_model, request_id, batch, effort, input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens, server_tool_uses, cost_micro_usd,
  price_version, stop_reason, refusal_category, latency_ms, prompt_version, thinking_tokens
) values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20,
  $21, $22, $23, $24, $25
)`;

/**
 * Writes one row per API request. A failed insert is logged and not rethrown: the response was
 * already paid for, and a retried job would call Claude again.
 */
export function createUsageSink(sql: Sql, log: Logger): UsageSink {
  return {
    async record(row: AiUsageRow): Promise<void> {
      try {
        await sql.query(INSERT_SQL, usageParams(row));
      } catch (err) {
        log.error({ err: errorName(err), task: row.task_id, feature: row.feature }, 'ai_usage insert failed');
      }
    },
  };
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}
