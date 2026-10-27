// HTTP surface: health, dispatch to the function handlers, the JSON envelopes for unknown routes, the static
// link site and environment validation. Handlers themselves are covered by the suites next to this file.
import { test, expect } from 'bun:test';
import path from 'node:path';
import { ConfigError, DEFAULT_SITE_DIR, loadConfig } from '../src/config.ts';
import { VERSION, createApp } from '../src/app.ts';
import type { P2Deps } from '../src/shared-p2/deps.ts';
import { makeHarness } from './fakes.ts';
import { assertEquals, assertInstanceOf, assertStringIncludes } from './assert.ts';

const VALID_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  SUPABASE_ANON_KEY: 'anon',
  ANTHROPIC_API_KEY: 'sk-test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/studify',
};

function app() {
  const h = makeHarness();
  return createApp(h.deps as unknown as P2Deps, DEFAULT_SITE_DIR);
}

test('config: every missing required variable is listed at once', () => {
  try {
    loadConfig({});
    throw new Error('expected a ConfigError');
  } catch (err) {
    assertInstanceOf(err, ConfigError);
    for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL']) {
      assertStringIncludes((err as ConfigError).problems.join('\n'), `${key} is missing`);
    }
  }
});

test('config: defaults for port, pg-boss schema, base URL and site directory', () => {
  const cfg = loadConfig(VALID_ENV);
  assertEquals(cfg.port, 3000);
  assertEquals(cfg.pgBossSchema, 'pgboss');
  assertEquals(cfg.baseUrl, undefined);
  assertEquals(cfg.siteDir, path.resolve(import.meta.dir, '../../site/public'));
});

test('config: an empty BASE_URL is kept (custom-scheme links); empty optional values count as unset', () => {
  const cfg = loadConfig({ ...VALID_ENV, BASE_URL: '', ANTHROPIC_BASE_URL: '', PORT: '8080' });
  assertEquals(cfg.baseUrl, '');
  assertEquals(cfg.anthropicBaseUrl, undefined);
  assertEquals(cfg.port, 8080);
});

test('config: a malformed DATABASE_URL and an unsafe schema name are rejected', () => {
  try {
    loadConfig({ ...VALID_ENV, DATABASE_URL: 'mysql://x', PG_BOSS_SCHEMA: 'pg;drop' });
    throw new Error('expected a ConfigError');
  } catch (err) {
    assertInstanceOf(err, ConfigError);
    assertStringIncludes((err as ConfigError).problems.join('\n'), 'DATABASE_URL: must start with postgres');
    assertStringIncludes((err as ConfigError).problems.join('\n'), 'PG_BOSS_SCHEMA');
  }
});

test('health: 200 with the package version', async () => {
  const res = await app().request('/api/health');
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true, version: VERSION });
});

test('dispatch: a function without a JWT answers its own 401 envelope', async () => {
  const res = await app().request('/api/quiz-create', { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': '0190a000-0000-7000-8000-0000000000aa' }, body: '{}' });
  assertEquals(res.status, 401);
  const body = (await res.json()) as { error: { code: string; message: string } };
  assertEquals(typeof body.error.code, 'string');
  assertEquals(typeof body.error.message, 'string');
});

test('dispatch: GET reaches the function, which answers 405 with the CORS headers', async () => {
  const res = await app().request('/api/quiz-create');
  assertEquals(res.status, 405);
  assertEquals(res.headers.get('access-control-allow-origin'), '*');
});

test('dispatch: OPTIONS answers the CORS preflight without auth', async () => {
  const res = await app().request('/api/quiz-create', { method: 'OPTIONS' });
  assertEquals(res.status, 204);
  assertStringIncludes(res.headers.get('access-control-allow-headers') ?? '', 'idempotency-key');
});

test('unknown function: 404 with the error envelope, including names that only look like keys', async () => {
  for (const name of ['no-such-function', 'constructor', 'health']) {
    const res = await app().request(`/api/${name}`, { method: 'POST' });
    assertEquals(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assertEquals(body.error.code, 'not_found');
  }
});

test('site: the landing page, the link route and the App Links file are served with their types', async () => {
  const a = app();
  const home = await a.request('/');
  assertEquals(home.status, 200);
  assertStringIncludes(home.headers.get('content-type') ?? '', 'text/html');

  const link = await a.request('/c/ABCDEFGH');
  assertEquals(link.status, 200);
  const linkHtml = await Bun.file(path.join(DEFAULT_SITE_DIR, 'link.html')).text();
  assertEquals(await link.text(), linkHtml);

  const assetlinks = await a.request('/.well-known/assetlinks.json');
  assertEquals(assetlinks.status, 200);
  assertEquals(assetlinks.headers.get('content-type'), 'application/json');
  assertEquals(typeof (await assetlinks.json()), 'object');
});

test('site: files outside the allow-list and unknown paths are 404, not read from disk', async () => {
  const a = app();
  assertEquals((await a.request('/_redirects')).status, 404);
  assertEquals((await a.request('/vercel.json')).status, 404);
  assertEquals((await a.request('/../../package.json')).status, 404);
  assertEquals((await a.request('/nope')).status, 404);
});
