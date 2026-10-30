import { describe, expect, it } from 'vitest';
import { TASKS, type AnyTaskDef } from '../src/index.ts';
import { TASK_INPUTS } from './task-inputs.ts';

function countBreakpoints(task: AnyTaskDef, built: ReturnType<AnyTaskDef['build']>): number {
  const system = built.system.filter((b) => b.cache_control).length;
  const messages = built.messages.reduce((sum, m) => {
    if (typeof m.content === 'string') return sum;
    return sum + m.content.filter((b) => 'cache_control' in b && b.cache_control).length;
  }, 0);
  void task;
  return system + messages;
}

describe('builders', () => {
  it('has a fixture for every registered task', () => {
    for (const task of TASKS) {
      expect(TASK_INPUTS[task.id], task.id).toBeDefined();
    }
  });

  for (const task of TASKS) {
    describe(task.id, () => {
      const input = TASK_INPUTS[task.id];

      it('renders identically on repeated builds (deterministic)', () => {
        const first = JSON.stringify(task.build(input));
        const second = JSON.stringify(task.build(input));
        expect(first).toBe(second);
      });

      it('places at most 4 cache breakpoints and caches the system prefix unless the task opts out', () => {
        const built = task.build(input);
        expect(countBreakpoints(task, built)).toBeLessThanOrEqual(4);
        if (task.cache === null) expect(countBreakpoints(task, built)).toBe(0);
        else expect(built.system.at(-1)?.cache_control?.ttl).toBe(task.cache);
      });

      it('marks document blocks with citations only in citations mode (all-or-none)', () => {
        const built = task.build(input);
        for (const message of built.messages) {
          if (typeof message.content === 'string') continue;
          for (const block of message.content) {
            if (block.type !== 'document') continue;
            if (task.outputMode === 'citations') expect(block.citations).toEqual({ enabled: true });
            else expect(block.citations).toBeUndefined();
          }
        }
      });

      it('exposes a document map with one label per document block', () => {
        const built = task.build(input);
        const blocks = built.messages.flatMap((m) =>
          typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'document'),
        );
        expect(Object.keys(built.documents?.labels ?? {})).toHaveLength(blocks.length);
        expect(Object.keys(built.documents?.allowedPages ?? {})).toHaveLength(blocks.length);
      });

      it('puts document and image blocks before any text block in each user turn (ai-pipeline §2.2)', () => {
        const built = task.build(input);
        for (const message of built.messages) {
          if (typeof message.content === 'string' || message.role !== 'user') continue;
          const firstText = message.content.findIndex((b) => b.type === 'text');
          if (firstText === -1) continue;
          const lastMedia = message.content.reduce((acc, b, i) => (b.type === 'document' || b.type === 'image' ? i : acc), -1);
          expect(lastMedia, `${task.id}: media after text`).toBeLessThan(firstText);
        }
      });

      it('attaches the task JSON schema as output_config.format for structured tasks', () => {
        const built = task.build(input);
        expect(built.outputFormat?.schema ?? null).toEqual(task.jsonSchema ?? null);
      });

      it('matches the stored snapshot (schema excluded: it is covered above and by registry tests)', () => {
        const { outputFormat: _schema, ...rest } = task.build(input);
        expect(rest).toMatchSnapshot();
      });
    });
  }
});
