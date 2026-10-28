// Every registered Claude task builds a request that the SDK-side rules accept, in both sync and Batch form.
// Mock-only: no network. Live acceptance by the API still needs a real key (see the run notes).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TASKS, type AnyTaskDef } from '@studify/prompts';
import { assertRequestShape, buildParams, choicesFromPages, type SystemBlock, type TaskCall } from '@studify/ai';
import { TASK_INPUTS } from '../../../packages/prompts/test/task-inputs.ts';

// Numeric bounds the API rejects in tool input schemas (see packages/ai sanitizeTools).
const TOOL_BOUND_KEYWORDS = /"(minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf)"/;

// Structured tasks: the call-site Zod schema is not reachable from the registry, so a placeholder stands in for it
// here. The real output schemas are covered by the registry tests (complexity limits, object unions).
function outputFor(task: AnyTaskDef) {
  if (task.outputMode === 'structured') return { mode: 'structured' as const, schema: z.any() };
  return { mode: task.outputMode === 'citations' ? ('citations' as const) : ('plain' as const) };
}

function callFor(task: AnyTaskDef) {
  const input = TASK_INPUTS[task.id];
  const built = task.build(input as never);
  const system: SystemBlock[] = built.system.map((block) =>
    block.cache_control ? { text: block.text, cacheTtl: block.cache_control.ttl } : { text: block.text },
  );
  const call = {
    task: {
      id: built.taskId,
      version: task.version,
      features: task.features,
      effort: built.effort,
      maxTokensClass: built.maxTokensClass,
      output: outputFor(task),
    },
    ctx: { feature: 'test', budgetClass: task.budget, userId: 'u', classGroupId: null, subjectId: null, documentId: null, nodeId: null, jobId: null },
    system,
    messages: built.messages as unknown as TaskCall<unknown>['messages'],
    ...(built.tools ? { tools: built.tools as unknown as TaskCall<unknown>['tools'] } : {}),
    choices: choicesFromPages(built.documents?.allowedPages),
  } as unknown as TaskCall<unknown>;
  return { call, built };
}

describe('every Claude request is built, routed and shaped', () => {
  it('registers a fixture for every task', () => {
    expect(TASKS.filter((t) => !TASK_INPUTS[t.id]).map((t) => t.id)).toEqual([]);
  });

  for (const task of TASKS) {
    describe(task.id, () => {
      it('builds sync and batch params that pass the shape checks', () => {
        const { call, built } = callFor(task);
        for (const batch of [false, true]) {
          const params: ReturnType<typeof buildParams> = buildParams(call, { batch, maxTokensClass: built.maxTokensClass, messages: call.messages });
          expect(() => assertRequestShape(params, { batch })).not.toThrow();
          expect(params.model).toBeTruthy();
        }
      });

      it('sends no numeric bounds in any custom tool schema', () => {
        const { call } = callFor(task);
        const params = buildParams(call, { batch: false, maxTokensClass: call.task.maxTokensClass, messages: call.messages });
        const custom = (params.tools ?? []).filter((t) => 'input_schema' in t);
        expect(JSON.stringify(custom)).not.toMatch(TOOL_BOUND_KEYWORDS);
      });

      it('attaches output_config.format exactly for structured tasks', () => {
        const { call } = callFor(task);
        const params = buildParams(call, { batch: false, maxTokensClass: call.task.maxTokensClass, messages: call.messages });
        const structured = task.outputMode === 'structured';
        expect(Boolean(task.jsonSchema)).toBe(structured);
        expect(Boolean(params.output_config?.format)).toBe(structured);
      });
    });
  }
});
