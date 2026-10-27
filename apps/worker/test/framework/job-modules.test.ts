// Job discovery (api §7): every module in src/jobs exports `jobs`, the registered names are unique, and every
// cron schedule is a valid 5-field expression. Loads the real modules, as src/index.ts does at startup.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverJobModules } from '../../src/index.ts';
import type { JobDefinition } from '../../src/framework/types.ts';

const JOBS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/jobs');

/** The job modules of api §7 that must be picked up (one file each). */
const EXPECTED_MODULES = [
  'account', 'batch', 'content', 'files', 'grading', 'ingest', 'learning', 'motivation', 'notify', 'planning', 'podcast', 'prova', 'rooms', 'social',
  'trust',
];

/** Field ranges of a standard 5-field cron (minute hour day-of-month month day-of-week; 0 and 7 are Sunday). */
const FIELD_RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** True for `*`, `n`, `a-b`, `*\/n`, `a-b/n` and comma lists of those, all inside the field range. */
export function isValidCronField(field: string, [min, max]: [number, number]): boolean {
  return field.split(',').every((part) => {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) return false;
    const [, range, step] = match;
    if (step !== undefined && (Number(step) < 1 || !Number.isInteger(Number(step)))) return false;
    if (range === '*') return true;
    const [lo, hi] = (range ?? '').split('-').map(Number);
    if (lo === undefined || lo < min || lo > max) return false;
    if (hi !== undefined && (hi < lo || hi > max)) return false;
    return true;
  });
}

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f, i) => isValidCronField(f, FIELD_RANGES[i]!));
}

describe('cron validator', () => {
  it('accepts the expressions the jobs use and rejects malformed ones', () => {
    for (const ok of ['0 6 * * *', '5 * * * *', '0 7 * * 1', '*/15 * * * *', '0 9-17/2 * * 1-5', '30 4 1,15 * *']) expect(isValidCron(ok), ok).toBe(true);
    for (const bad of ['', '0 6 * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '0 6 * * 9', 'daily', '0 6 * * * *', '5-2 * * * *']) {
      expect(isValidCron(bad), bad).toBe(false);
    }
  });
});

describe('job modules (api §7)', () => {
  it('every file in src/jobs is a job module and exports a non-empty jobs array', async () => {
    const files = (await readdir(JOBS_DIR)).filter((f) => /\.ts$/.test(f) && !f.endsWith('.test.ts')).map((f) => f.replace(/\.ts$/, '')).sort();
    expect(files).toEqual(EXPECTED_MODULES);
    for (const name of files) {
      const mod = (await import(path.join(JOBS_DIR, `${name}.ts`))) as { jobs?: JobDefinition<any>[] };
      expect(Array.isArray(mod.jobs), name).toBe(true);
      expect(mod.jobs!.length, name).toBeGreaterThan(0);
    }
  });

  it('discovers every job once: names are unique and each has a handler', async () => {
    const defs = await discoverJobModules();
    const names = defs.map((d) => d.name);
    expect(new Set(names).size, `duplicate names: ${names.filter((n, i) => names.indexOf(n) !== i).join(', ')}`).toBe(names.length);
    for (const def of defs) {
      expect(def.name).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(typeof def.handler, def.name).toBe('function');
    }
  });

  it('every recurring schedule is a valid cron expression', async () => {
    const defs = await discoverJobModules();
    const scheduled = defs.filter((d) => d.schedule !== undefined);
    expect(scheduled.length).toBeGreaterThan(0);
    for (const def of scheduled) {
      expect(isValidCron(def.schedule!), `${def.name}: ${def.schedule}`).toBe(true);
    }
  });

  it('the prefetch payload of notes.prefetch_deep is accepted by ingest.topic_content (LRN-01.4)', async () => {
    const { TopicContentPayload } = await import('../../src/jobs/content.ts');
    const { handleNotesPrefetch } = await import('../../src/jobs/learning.ts');
    const { fakeEnv, EXAM, SUBJECT, USER } = await import('../jobs/fakes.ts');
    const env = fakeEnv('2026-10-27T15:00:00.000Z');
    const topic = '0190f3a2-7b1c-7d3e-8f00-00000000abcd';
    env.db.seed('exams', [{ id: EXAM, user_id: USER, goal_id: 'g', subject_id: SUBJECT, title: 'P1', local_date: '2026-10-30', status: 'scheduled', deleted_at: null }]);
    env.db.seed('exam_scope_nodes', [{ exam_id: EXAM, node_id: topic, source: 'user', confirmed: true }]);
    env.db.seed('knowledge_nodes', [{ id: topic, subject_id: SUBJECT, kind: 'topic', deleted_at: null }]);
    await handleNotesPrefetch(env.ctx);
    const queued = env.enqueued.find((e) => e.name === 'ingest.topic_content');
    expect(queued).toBeDefined();
    expect(TopicContentPayload.safeParse({ ...queued!.data, subject_id: SUBJECT, node_ids: [topic] }).success).toBe(true);
    expect(TopicContentPayload.parse({ ...queued!.data, node_ids: [topic] }).kinds).toEqual(['deep']);
  });
});
