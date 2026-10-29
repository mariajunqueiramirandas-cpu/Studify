// Server-side domain library loaded by the API. No executable worker or queue consumer.
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
export { createRuntime } from './framework/runtime.ts';
export { loadConfig } from './framework/env.ts';
import type { OperationDefinition } from './framework/types.ts';

const JOBS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobs');

/** Imports every module in src/jobs that exports `jobs`. Files starting with "_" are skipped. */
export async function discoverOperations(dir = JOBS_DIR): Promise<OperationDefinition<any>[]> {
  const entries = await readdir(dir);
  const files = entries
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'))
    .sort();
  const defs: OperationDefinition<any>[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as { jobs?: OperationDefinition<any>[] };
    if (Array.isArray(mod.jobs)) defs.push(...mod.jobs);
  }
  return defs;
}
