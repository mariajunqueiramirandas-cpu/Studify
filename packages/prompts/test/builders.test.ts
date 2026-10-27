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

      it('places at most 4 cache breakpoints and always caches the system prefix', () => {
        const built = task.build(input);
        expect(countBreakpoints(task, built)).toBeLessThanOrEqual(4);
        expect(built.system.at(-1)?.cache_control?.ttl).toBeTruthy();
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

      it('matches the stored snapshot', () => {
        expect(task.build(input)).toMatchSnapshot();
      });
    });
  }
});
