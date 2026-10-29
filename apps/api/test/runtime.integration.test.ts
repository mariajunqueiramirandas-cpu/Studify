import { expect, test } from 'bun:test';
import { loadConfig } from '../src/config.ts';
import { buildProdRuntime } from '../src/shared/prod.ts';

// Separate from private-schema.test.ts's destructive temporary-schema harness.
const url = process.env.RUNTIME_TEST_DATABASE_URL;
(url ? test : test.skip)('production runtime loads direct operations, enforces one owner, and releases ownership on stop', async () => {
  const config = loadConfig({ DATABASE_URL: url, SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'test', SUPABASE_ANON_KEY: 'test', ANTHROPIC_API_KEY: 'test', STORAGE_SIGNING_KEY: 'x'.repeat(32), STORAGE_DIR: '/tmp/studify-runtime-test' });
  const first = buildProdRuntime(config);
  const second = buildProdRuntime(config);
  try {
    await first.start();
    await expect(second.start()).rejects.toThrow('Another Studify API instance');
  } finally { await second.stop(); await first.stop(); }
  const restarted = buildProdRuntime(config);
  try { await restarted.start(); }
  finally { await restarted.stop(); }
});

// ADR 0011: a material the restart cut off is resumed where it stopped, not failed.
(url ? test : test.skip)('production runtime resumes a material that a restart cut off instead of failing it', async () => {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const user = '0190b000-0000-7000-8000-00000000aa01';
  const subject = '0190b000-0000-7000-8000-00000000aa02';
  const doc = '0190b000-0000-7000-8000-00000000aa03';
  const job = '0190b000-0000-7000-8000-00000000aa04';
  const cleanup = async () => {
    await pool.query(`delete from private.scheduled_actions where data->>'document_id' = $1`, [doc]);
    await pool.query('delete from public.ai_jobs where id = $1', [job]);
    await pool.query('delete from public.subjects where id = $1', [subject]);
    await pool.query('delete from public.profiles where id = $1', [user]);
    await pool.query('delete from auth.users where id = $1', [user]);
  };
  await cleanup();
  await pool.query(`insert into auth.users (id, email) values ($1, 'resume@studify.test')`, [user]);
  await pool.query(`insert into public.profiles (id, display_name, display_name_status, birth_year, birth_month, privacy_notice_version, privacy_accepted_at) values ($1, 'Resume', 'approved', 2009, 1, 'v1', now())`, [user]);
  await pool.query(`insert into public.subjects (id, owner_profile_id, created_by, name, color, icon) values ($1, $2, $2, 'Física', '#0000aa', 'atom')`, [subject, user]);
  await pool.query(`insert into public.documents (id, subject_id, uploaded_by, title, kind, storage_path, size_bytes, checksum_sha256, status) values ($1, $2, $3, 'Apostila', 'textbook', 'documents/x.pdf', 10, $4, 'processing')`, [doc, subject, user, 'c'.repeat(64)]);
  await pool.query(`insert into public.ai_jobs (id, type, user_id, subject_id, document_id, status, stage) values ($1, 'ingest.document', $2, $3, $4, 'running', 'S4')`, [job, user, subject, doc]);
  const config = loadConfig({ DATABASE_URL: url, SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'test', SUPABASE_ANON_KEY: 'test', ANTHROPIC_API_KEY: 'test', STORAGE_SIGNING_KEY: 'x'.repeat(32), STORAGE_DIR: '/tmp/studify-runtime-test' });
  const runtime = buildProdRuntime(config);
  try {
    await runtime.start();
    const resume = await pool.query(`select name, data from private.scheduled_actions where data->>'document_id' = $1`, [doc]);
    expect(resume.rows).toEqual([{ name: 'ingest.document', data: { document_id: doc, mode: 'resume', user_id: user, ai_job_id: job } }]);
    const state = await pool.query(`select d.status as doc, j.status as job from public.documents d join public.ai_jobs j on j.document_id = d.id where d.id = $1`, [doc]);
    expect(state.rows[0]).toEqual({ doc: 'processing', job: 'running' });
  } finally {
    await runtime.stop();
    await cleanup();
    await pool.end();
  }
});
