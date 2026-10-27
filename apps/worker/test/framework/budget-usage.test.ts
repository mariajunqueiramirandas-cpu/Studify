import { describe, expect, it } from 'vitest';
import type { AiUsageRow } from '@studify/ai';
import { budgetExhaustedScope, createBudgetStore, resetsAtFromHint } from '../../src/framework/budget.ts';
import { usageParams } from '../../src/framework/usage.ts';
import type { Sql } from '../../src/framework/db.ts';

function fakeSql(respond: (text: string, values: unknown[]) => { rows: unknown[] } | Error) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql: Sql = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      const out = respond(text, values);
      if (out instanceof Error) throw out;
      return { rows: out.rows, rowCount: out.rows.length, command: '', oid: 0, fields: [] } as never;
    },
  };
  return { sql, calls };
}

describe('budget error mapping', () => {
  it('reads the scope from DETAIL and the reset date from HINT', () => {
    const err = Object.assign(new Error('budget_exhausted'), { detail: 'class_group', hint: 'resets_at=2026-11-01' });
    expect(budgetExhaustedScope(err)).toEqual({ scope: 'class_group_month', resetsAt: '2026-11-01' });
    expect(resetsAtFromHint('resets_at=2026-12-01')).toBe('2026-12-01');
  });

  it('ignores other errors', () => {
    expect(budgetExhaustedScope(new Error('connection reset'))).toBeNull();
  });
});

describe('createBudgetStore', () => {
  it('returns a reservation id from private.ai_budget_reserve', async () => {
    const { sql, calls } = fakeSql(() => ({ rows: [{ id: 'res-1' }] }));
    const store = createBudgetStore(sql);
    const result = await store.reserve({
      ctx: { userId: 'u', classGroupId: null, feature: 'ING-03', budgetClass: 'content' } as never,
      taskId: 'ingest.outline',
      promptVersion: 'ingest.outline@v1',
      estimateMicroUsd: 1234.2,
      mode: 'stream',
    });
    expect(result).toEqual({ ok: true, reservationId: 'res-1' });
    expect(calls[0]?.values).toEqual(['u', null, 'ING-03', 'content', 1235]);
  });

  it('maps an exhausted budget to a refusal with the scope', async () => {
    const err = Object.assign(new Error('budget_exhausted'), { detail: 'user', hint: 'resets_at=2026-10-28' });
    const { sql } = fakeSql(() => err);
    const result = await createBudgetStore(sql).reserve({
      ctx: { userId: 'u', classGroupId: null, feature: 'X', budgetClass: 'user' } as never,
      taskId: 't',
      promptVersion: 't@v1',
      estimateMicroUsd: 1,
      mode: 'sync',
    });
    expect(result).toEqual({ ok: false, scope: 'user_day', resetsAt: '2026-10-28' });
  });

  it('settles with a rounded non-negative amount', async () => {
    const { sql, calls } = fakeSql(() => ({ rows: [] }));
    await createBudgetStore(sql).settle('res-9', -4.4);
    expect(calls[0]?.values).toEqual(['res-9', 0]);
  });
});

describe('usageParams', () => {
  const row: AiUsageRow = {
    user_id: 'u1',
    class_group_id: null,
    subject_id: 's1',
    document_id: 'd1',
    node_id: null,
    job_id: 'j1',
    feature: 'LRN-01',
    task_id: 'notes.tldr',
    prompt_version: 'notes.tldr@v1',
    budget_class: 'content',
    mode: 'batch',
    model_requested: 'claude-haiku-5-5',
    model_served: 'claude-haiku-5-5',
    fallback_used: false,
    effort: 'low',
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_5m_tokens: 3,
    cache_creation_1h_tokens: 4,
    cache_read_tokens: 5,
    server_tool_uses: null,
    stop_reason: 'end_turn',
    refusal_category: null,
    cost_micro_usd: 99,
    price_version: 'v1',
    latency_ms: 1,
    ttft_ms: null,
    request_id: 'msg_1',
    batch_id: 'batch_1',
    custom_id: 'c',
    attempt: 1,
    error_code: null,
  };

  it('maps the row to ai_usage columns (batch flag, summed cache writes, no fallback)', () => {
    const params = usageParams(row);
    expect(params[0]).toBe('u1');
    expect(params[6]).toBe('LRN-01');
    expect(params[7]).toBe('notes.tldr');
    expect(params[9]).toBeNull(); // fallback_model
    expect(params[11]).toBe(true); // batch
    expect(params[15]).toBe(7); // cache creation 5m + 1h
    expect(params[16]).toBe(5); // cache read
    expect(params[18]).toBe(99); // cost
  });

  it('records the served model when it differs from the requested one', () => {
    // Haiku 5.5 has no server-side fallback; the column still records any served model that differs.
    const params = usageParams({ ...row, model_served: 'claude-opus-5-5' });
    expect(params[9]).toBe('claude-opus-5-5');
    expect(usageParams(row)[9]).toBeNull();
  });
});
