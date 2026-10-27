import { describe, expect, it } from 'vitest';
import { assertRuntimeConfig, loadConfig } from '../../src/framework/env.ts';

describe('loadConfig', () => {
  it('applies defaults and treats blank values as unset', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgresql://x', SUPABASE_URL: '', ANTHROPIC_API_KEY: '   ' });
    expect(cfg.databaseUrl).toBe('postgresql://x');
    expect(cfg.supabaseUrl).toBeNull();
    expect(cfg.anthropicApiKey).toBeNull();
    expect(cfg.pgPoolMax).toBe(6);
    expect(cfg.pgBossSchema).toBe('pgboss');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.aiTimeoutMs).toBe(600_000);
  });

  it('rejects invalid values with the variable name', () => {
    expect(() => loadConfig({ SUPABASE_URL: 'not a url' })).toThrow(/SUPABASE_URL/);
    expect(() => loadConfig({ WORKER_LOG_LEVEL: 'verbose' })).toThrow(/WORKER_LOG_LEVEL/);
    expect(() => loadConfig({ PG_BOSS_SCHEMA: 'Drop Table' })).toThrow(/PG_BOSS_SCHEMA/);
  });

  it('lists every missing runtime variable at once', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgresql://x' });
    expect(() => assertRuntimeConfig(cfg)).toThrow(/SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY/);
  });

  it('accepts a complete runtime configuration', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgresql://x',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      ANTHROPIC_API_KEY: 'a',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010',
    });
    expect(() => assertRuntimeConfig(cfg)).not.toThrow();
    expect(cfg.anthropicBaseUrl).toBe('http://127.0.0.1:4010');
  });

  it('keeps files on Supabase Storage until R2_BUCKET is set, and names what a partial R2 setup lacks', () => {
    expect(loadConfig({}).storage).toEqual({ provider: 'supabase' });
    const r2 = { R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'studify' };
    expect(loadConfig(r2).storage).toEqual({ provider: 'r2', r2: { accountId: r2.R2_ACCOUNT_ID, accessKeyId: 'id', secretAccessKey: 's', bucket: 'studify' } });
    expect(() => loadConfig({ R2_BUCKET: 'studify', PG_BOSS_SCHEMA: 'Drop Table' })).toThrow(/PG_BOSS_SCHEMA.*R2_ACCOUNT_ID is missing/);
  });
});
