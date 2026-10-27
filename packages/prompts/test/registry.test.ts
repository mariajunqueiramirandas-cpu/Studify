import { describe, expect, it } from 'vitest';
import { TASKS, TASK_BY_ID, getTask, listTasks } from '../src/index.ts';

describe('task registry', () => {
  it('lists unique task ids', () => {
    const ids = TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TASK_BY_ID.size).toBe(ids.length);
  });

  it('covers the Phase 0–2 catalog (38 tasks)', () => {
    expect(TASKS.length).toBe(38);
  });

  it('gives every task a prompt_version of the form <task id>@v<n>', () => {
    for (const task of TASKS) {
      expect(task.promptVersion).toMatch(/^[A-Za-z][A-Za-z.]*@v\d+$/);
      expect(task.promptVersion.startsWith(`${task.id}@v`)).toBe(true);
    }
  });

  it('declares features, effort, class and budget for every task', () => {
    for (const task of TASKS) {
      expect(task.features.length, task.id).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(task.effort);
      expect(['XS', 'S', 'M', 'L', 'XL']).toContain(task.maxTokensClass);
      expect(['content', 'user', 'system']).toContain(task.budget);
    }
  });

  it('gives structured tasks a root-level strict JSON schema and others none', () => {
    for (const task of TASKS) {
      if (task.outputMode === 'structured') {
        expect(task.jsonSchema, task.id).toBeTruthy();
        expect((task.jsonSchema as Record<string, unknown>).additionalProperties, task.id).toBe(false);
      } else {
        expect(task.jsonSchema, task.id).toBeUndefined();
      }
    }
  });

  it('uses citations output only for prose with page citations', () => {
    const citations = TASKS.filter((t) => t.outputMode === 'citations').map((t) => t.id).sort();
    expect(citations).toEqual(['explain.restyle', 'notes.deep', 'notes.study', 'notes.tldr', 'tutor.turn']);
  });

  it('getTask throws on unknown ids and resolves known ones', () => {
    expect(getTask('cards.generate').id).toBe('cards.generate');
    expect(() => getTask('nope.unknown')).toThrow(/unknown task id/);
  });

  it('listTasks returns one row per task', () => {
    expect(listTasks()).toHaveLength(TASKS.length);
  });
});
