// HTTP surface: health, dispatch to the function handlers, the JSON envelopes for unknown routes, the static
// link site and environment validation. Handlers themselves are covered by the suites next to this file.
import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConfigError, DEFAULT_SITE_DIR, loadConfig } from '../src/config.ts';
import { VERSION, createApp } from '../src/app.ts';
import { DEFAULT_APK_URL } from '../src/site.ts';
import type { P2Deps } from '../src/shared-p2/deps.ts';
import { makeHarness } from './fakes.ts';
import { assertEquals, assertInstanceOf, assertStringIncludes } from './assert.ts';

const VALID_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  SUPABASE_ANON_KEY: 'anon',
  ANTHROPIC_API_KEY: 'sk-test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/studify',
  STORAGE_SIGNING_KEY: 'x'.repeat(32),
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

test('config: defaults for port, base URL and site directory', () => {
  const cfg = loadConfig(VALID_ENV);
  assertEquals(cfg.port, 3000);
  assertEquals(cfg.baseUrl, undefined);
  assertEquals(cfg.siteDir, path.resolve(import.meta.dir, '../../site/dist'));
});

test('config: an empty BASE_URL is kept (custom-scheme links); empty optional values count as unset', () => {
  const cfg = loadConfig({ ...VALID_ENV, BASE_URL: '', ANTHROPIC_BASE_URL: '', PORT: '8080' });
  assertEquals(cfg.baseUrl, '');
  assertEquals(cfg.anthropicBaseUrl, undefined);
  assertEquals(cfg.port, 8080);
});

test('config: a malformed DATABASE_URL  are rejected', () => {
  try {
    loadConfig({ ...VALID_ENV, DATABASE_URL: 'mysql://x' });
    throw new Error('expected a ConfigError');
  } catch (err) {
    assertInstanceOf(err, ConfigError);
    assertStringIncludes((err as ConfigError).problems.join('\n'), 'DATABASE_URL: must start with postgres');
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

/** A built site as Vite lays it out (apps/site/dist is not built in the API job). */
function siteFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'studify-site-'));
  mkdirSync(path.join(dir, 'assets'));
  mkdirSync(path.join(dir, '.well-known'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
  writeFileSync(path.join(dir, '_redirects'), '/c/* /index.html 200');
  writeFileSync(path.join(dir, '.well-known', 'assetlinks.json'), '[]');
  return dir;
}

function siteApp(apkUrl?: string) {
  return createApp(makeHarness().deps as unknown as P2Deps, siteFixture(), apkUrl);
}

test('site: the landing page, the link routes, the bundle and the App Links file are served with their types', async () => {
  const a = siteApp();
  const home = await a.request('/');
  assertEquals(home.status, 200);
  assertStringIncludes(home.headers.get('content-type') ?? '', 'text/html');
  assertEquals(home.headers.get('cache-control'), 'no-cache');

  const link = await a.request('/c/ABCDEFGH');
  assertEquals(link.status, 200);
  assertEquals(await link.text(), '<!doctype html><div id="root"></div>');
  assertEquals(link.headers.get('x-robots-tag'), 'noindex');

  const bundle = await a.request('/assets/index-abc123.js');
  assertEquals(bundle.status, 200);
  assertStringIncludes(bundle.headers.get('content-type') ?? '', 'text/javascript');
  assertStringIncludes(bundle.headers.get('cache-control') ?? '', 'immutable');

  const assetlinks = await a.request('/.well-known/assetlinks.json');
  assertEquals(assetlinks.status, 200);
  assertEquals(assetlinks.headers.get('content-type'), 'application/json');
  assertEquals(typeof (await assetlinks.json()), 'object');
});

test('site: /download redirects to the newest release APK, or to APK_URL when set', async () => {
  const res = await siteApp().request('/download');
  assertEquals(res.status, 302);
  assertEquals(res.headers.get('location'), DEFAULT_APK_URL);
  assertEquals(res.headers.get('cache-control'), 'no-store');

  const custom = await siteApp('https://example.com/s.apk').request('/download');
  assertEquals(custom.headers.get('location'), 'https://example.com/s.apk');
  assertEquals(loadConfig({ ...VALID_ENV, APK_URL: 'https://example.com/s.apk' }).apkUrl, 'https://example.com/s.apk');
  assertEquals(loadConfig(VALID_ENV).apkUrl, DEFAULT_APK_URL);
});

test('site: files outside the allow-list and unknown paths are 404, not read from disk', async () => {
  const a = siteApp();
  assertEquals((await a.request('/_redirects')).status, 404);
  assertEquals((await a.request('/vercel.json')).status, 404);
  assertEquals((await a.request('/../../package.json')).status, 404);
  assertEquals((await a.request('/assets/..%2Findex.html')).status, 404);
  assertEquals((await a.request('/assets/%2e%2e%2f..%2fpackage.json')).status, 404);
  assertEquals((await a.request('/assets/missing.js')).status, 404);
  assertEquals((await a.request('/assets/index-abc123.exe')).status, 404);
  assertEquals((await a.request('/nope')).status, 404);
});

/** A built dashboard as Vite lays it out with base /painel/ (apps/dashboard/dist is not built in the API job). */
function dashboardApp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'studify-dashboard-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><meta name="studify-config" content="%STUDIFY_CONFIG%"><div id="root"></div>');
  writeFileSync(path.join(dir, 'assets', 'index-d4sh.js'), 'console.log(1)');
  writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
  return createApp(makeHarness().deps as unknown as P2Deps, siteFixture(), undefined, {
    dir,
    supabaseUrl: 'https://abc.supabase.co',
    anonKey: 'sb_publishable_"<x>',
  });
}

test('dashboard: every /painel route serves the app with the runtime settings and strict headers', async () => {
  const a = dashboardApp();
  for (const route of ['/painel', '/painel/', '/painel/admin/usuarios/0190a000-0000-7000-8000-00000000b0b0', '/painel/privacidade']) {
    const res = await a.request(route);
    assertEquals(res.status, 200, route);
    const html = await res.text();
    // The settings are attribute-escaped JSON: a quote or bracket in a value cannot break out of the tag.
    assertStringIncludes(html, 'content="{&quot;supabaseUrl&quot;:&quot;https://abc.supabase.co&quot;,&quot;supabaseAnonKey&quot;:&quot;sb_publishable_\\&quot;&lt;x&gt;&quot;}"');
    const csp = res.headers.get('content-security-policy') ?? '';
    assertStringIncludes(csp, "script-src 'self'");
    assertStringIncludes(csp, "connect-src 'self' https://abc.supabase.co");
    assertStringIncludes(csp, "frame-ancestors 'none'");
    assertEquals(res.headers.get('x-frame-options'), 'DENY');
    assertEquals(res.headers.get('referrer-policy'), 'no-referrer');
    assertEquals(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    assertEquals(res.headers.get('cache-control'), 'no-cache');
  }
});

test('dashboard: hashed assets are immutable; unknown files are 404, not the app page', async () => {
  const a = dashboardApp();
  const bundle = await a.request('/painel/assets/index-d4sh.js');
  assertEquals(bundle.status, 200);
  assertStringIncludes(bundle.headers.get('cache-control') ?? '', 'immutable');
  assertEquals((await a.request('/painel/favicon.svg')).status, 200);
  assertEquals((await a.request('/painel/assets/missing.js')).status, 404);
  assertEquals((await a.request('/painel/assets/..%2Findex.html')).status, 404);
  assertEquals((await a.request('/painel/assets/x.exe')).status, 404);
  // The landing page and the API are untouched.
  assertEquals((await a.request('/')).status, 200);
  assertEquals((await a.request('/api/health')).status, 200);
});

test('dashboard: DASHBOARD_DIR overrides the default build directory', () => {
  assertEquals(loadConfig({ ...VALID_ENV, DASHBOARD_DIR: '/app/dashboard' }).dashboardDir, '/app/dashboard');
  assertStringIncludes(loadConfig(VALID_ENV).dashboardDir, path.join('apps', 'dashboard', 'dist'));
});
