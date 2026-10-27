// Copies every file from the Supabase project's Storage to R2 (docs/engineering/deployment.md §9).
// Run from the repository root with the backend's environment (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, R2_*):
//   pnpm storage:copy-to-r2 --dry-run    lists what would be copied
//   pnpm storage:copy-to-r2              copies; files already in R2 are skipped, so it can run again
import { createClient } from '@supabase/supabase-js';
import { copyAllObjects, r2Storage, storageConfigFromEnv, supabaseStorage } from '../src/index.ts';

const dryRun = process.argv.includes('--dry-run');
const url = process.env.SUPABASE_URL?.trim();
const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
const config = storageConfigFromEnv({ ...process.env, STORAGE_PROVIDER: 'r2' });
if (config.provider !== 'r2') throw new Error('R2 is not configured');

const source = supabaseStorage(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
const target = r2Storage(config.r2);
console.log(`${dryRun ? 'Dry run: ' : ''}copying Supabase Storage → R2 bucket ${config.r2.bucket}`);
const report = await copyAllObjects(source, target, {
  dryRun,
  onFile: (path, outcome) => {
    if (outcome !== 'skipped') console.log(`${outcome.padEnd(10)} ${path}`);
  },
});
console.log(`copied ${report.copied} (${(report.bytes / 1024 / 1024).toFixed(1)} MB), already in R2 ${report.skipped}, failed ${report.failed.length}`);
for (const f of report.failed) console.error(`failed ${f.path}: ${f.error}`);
if (report.failed.length > 0) process.exit(1);
