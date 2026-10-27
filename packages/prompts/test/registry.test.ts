import { describe, expect, it } from 'vitest';
import { TASKS, TASK_BY_ID, getTask, listTasks } from '../src/index.ts';

describe('task registry', () => {
  it('lists unique task ids', () => {
    const ids = TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(TASK_BY_ID.size).toBe(ids.length);
  });

  it('covers the Phase 0–5 catalog (77 tasks)', () => {
    expect(TASKS.length).toBe(77);
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

  // Structured outputs reject a request whose schemas have more than 16 fields with anyOf or type arrays,
  // or more than 24 optional fields ("Schema is too complex for compilation", a 400 on every call).
  it('keeps every output schema within the structured-output complexity limits', () => {
    for (const task of TASKS) {
      if (!task.jsonSchema) continue;
      let unions = 0;
      let optional = 0;
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk);
        if (!node || typeof node !== 'object') return;
        const obj = node as Record<string, unknown>;
        if (obj.anyOf || Array.isArray(obj.type)) unions++;
        if (obj.properties && typeof obj.properties === 'object') {
          const required = new Set((obj.required as string[] | undefined) ?? []);
          optional += Object.keys(obj.properties).filter((key) => !required.has(key)).length;
        }
        Object.values(obj).forEach(walk);
      };
      walk(task.jsonSchema);
      expect(unions, `${task.id} union-typed fields`).toBeLessThanOrEqual(16);
      expect(optional, `${task.id} optional fields`).toBeLessThanOrEqual(24);
    }
  });

  it('uses citations output only for prose with page citations', () => {
    const citations = TASKS.filter((t) => t.outputMode === 'citations').map((t) => t.id).sort();
    expect(citations).toEqual([
      'argument.reply',
      'camera.explain',
      'camera.solveFull',
      'divide.merge',
      'explain.restyle',
      'notes.deep',
      'notes.study',
      'notes.tldr',
      'podcast.handAnswer',
      'tutor.turn',
    ]);
  });

  it('getTask throws on unknown ids and resolves known ones', () => {
    expect(getTask('cards.generate').id).toBe('cards.generate');
    expect(() => getTask('nope.unknown')).toThrow(/unknown task id/);
  });

  it('listTasks returns one row per task', () => {
    expect(listTasks()).toHaveLength(TASKS.length);
  });
});
