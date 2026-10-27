// Worker entry point. Starts pg-boss, discovers job modules in src/jobs (any file that exports
// `jobs: JobDefinition[]`), registers them, and shuts down gracefully on SIGTERM/SIGINT.
// Run: pnpm --filter @studify/worker start   (needs DATABASE_URL, SUPABASE_*, ANTHROPIC_API_KEY)
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { assertRuntimeConfig, loadConfig } from './framework/env.ts';
import { createRuntime } from './framework/runtime.ts';
import type { JobDefinition } from './framework/types.ts';

const JOBS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobs');

/** Imports every module in src/jobs that exports `jobs`. Files starting with "_" are skipped. */
export async function discoverJobModules(dir = JOBS_DIR): Promise<JobDefinition<any>[]> {
  const entries = await readdir(dir);
  const files = entries
    .filter((f) => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'))
    .sort();
  const defs: JobDefinition<any>[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as { jobs?: JobDefinition<any>[] };
    if (Array.isArray(mod.jobs)) defs.push(...mod.jobs);
  }
  return defs;
}

async function main(): Promise<void> {
  const config = loadConfig();
  assertRuntimeConfig(config);
  const runtime = await createRuntime(config);
  const definitions = await discoverJobModules();
  await runtime.registry.register(definitions);
  runtime.log.info({ jobs: definitions.map((d) => d.name) }, 'worker started');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    runtime.log.info({ signal }, 'stop requested');
    await runtime.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
