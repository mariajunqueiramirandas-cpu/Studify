import { describe, expect, it } from 'vitest';
import { assertRuntimeConfig, loadConfig } from '../../src/framework/env.ts';

describe('loadConfig', () => {
  it('applies defaults and treats blank values as unset', () => {
    const cfg = loadConfig({ DATABASE_URL: 'postgresql://x', ANTHROPIC_BASE_URL: '', ANTHROPIC_API_KEY: '   ' });
    expect(cfg.databaseUrl).toBe('postgresql://x');
    expect(cfg.anthropicBaseUrl).toBeNull();
    expect(cfg.anthropicApiKey).toBeNull();
    expect(cfg.pgPoolMax).toBe(6);
    expect(cfg.logLevel).toBe('info');
    expect(cfg.aiTimeoutMs).toBe(600_000);
  });

  it('rejects invalid values with the variable name', () => {
    expect(() => loadConfig({ ANTHROPIC_BASE_URL: 'not a url' })).toThrow(/ANTHROPIC_BASE_URL/);
    expect(() => loadConfig({ TASK_LOG_LEVEL: 'verbose' })).toThrow(/TASK_LOG_LEVEL/);
  });

  it('lists every missing runtime variable at once', () => {
    const cfg = loadConfig({});
    expect(() => assertRuntimeConfig(cfg)).toThrow(/DATABASE_URL, ANTHROPIC_API_KEY/);
  });

  it('accepts a complete runtime configuration', () => {
    const cfg = loadConfig({
      DATABASE_URL: 'postgresql://x',
      ANTHROPIC_API_KEY: 'a',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:4010',
    });
    expect(() => assertRuntimeConfig(cfg)).not.toThrow();
    expect(cfg.anthropicBaseUrl).toBe('http://127.0.0.1:4010');
  });
});
