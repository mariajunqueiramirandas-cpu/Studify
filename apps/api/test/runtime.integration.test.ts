import { expect, test } from 'bun:test';
import { loadConfig } from '../src/config.ts';
import { buildProdRuntime } from '../src/shared/prod.ts';

// Separate from private-schema.test.ts's destructive temporary-schema harness.
const url = process.env.RUNTIME_TEST_DATABASE_URL;
(url ? test : test.skip)('production runtime loads direct operations, enforces one owner, and releases ownership on stop', async () => {
  const config = loadConfig({ DATABASE_URL: url, SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'test', SUPABASE_ANON_KEY: 'test', ANTHROPIC_API_KEY: 'test' });
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
