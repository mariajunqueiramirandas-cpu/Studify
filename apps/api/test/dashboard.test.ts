import { test } from 'bun:test';
// Web dashboard functions (api.md §4.11): Minha conta for every student, Administração for the owner only.
// The SQL read models (private.admin_*) are covered by packages/db/pgtap/admin_dashboard.test.sql; here they are stubs.
import { assert, assertEquals, assertMatch } from './assert.ts';
import { ALICE, BOB, NOW, json, makeHarness, request, withUsers, type Harness } from './fakes.ts';
import { v7 } from './world.ts';
import type { P2Deps } from '../src/shared-p2/deps.ts';
import { ROUTES } from '../src/routes.ts';
import { isMinorBirth, newInviteCode, quietMinutes } from '../src/shared/dashboard.ts';
import { handler as accountOverview } from '../src/functions/account-overview.ts';
import { handler as accountUpdate } from '../src/functions/account-update.ts';
import { handler as accountMembership } from '../src/functions/account-membership.ts';
import { handler as accountDeviceRemove } from '../src/functions/account-device-remove.ts';
import { handler as accountExportLink } from '../src/functions/account-export-link.ts';
import { handler as adminOverview } from '../src/functions/admin-overview.ts';
import { handler as adminUsers } from '../src/functions/admin-users.ts';
import { handler as adminUser } from '../src/functions/admin-user.ts';
import { handler as adminUserControl } from '../src/functions/admin-user-control.ts';
import { handler as adminClassGroupControl } from '../src/functions/admin-class-group-control.ts';
import { handler as adminModerationControl } from '../src/functions/admin-moderation-control.ts';
import { handler as adminSettingsControl } from '../src/functions/admin-settings-control.ts';
import { handler as adminAudit } from '../src/functions/admin-audit.ts';

const GROUP = '9a000000-0000-4000-8000-000000000001';
const OTHER_GROUP = '9a000000-0000-4000-8000-000000000002';

/** Harness with Alice as a student; `admin` makes Alice the owner (app_admin). */
function setup(opts: { admin?: boolean } = {}): Harness {
  const h = makeHarness();
  withUsers(h);
  for (const p of h.db.table('profiles')) Object.assign(p, { created_at: '2026-09-01T12:00:00Z', app_role: 'user', school_year: 'em2' });
  if (opts.admin) h.db.table('profiles').find((p) => p.id === ALICE.id)!.app_role = 'app_admin';
  h.db.rpcs.set('my_ai_usage_today', () => ({ data: { pct: 42, byFeature: [{ feature: 'TUT-01', pct: 40 }] } }));
  // Read models: echo what the SQL would answer, enough for the handlers to pass through.
  h.db.rpcs.set('admin_user_detail', (args) => ({ data: h.db.table('profiles').some((p) => p.id === args.p_user) ? { profile: { id: args.p_user } } : null }));
  h.db.rpcs.set('admin_audit_list', () => ({ data: [] }));
  h.db.rpcs.set('admin_moderation', () => ({ data: { reports: [], flags: [], pending_names: [], feedback: [] } }));
  h.db.rpcs.set('admin_limits', () => ({ data: { user_day: { effective: 1, configured: null, builtin: 1 }, class_group_month: { effective: 50_000_000, configured: null, builtin: 50_000_000 }, global_month: { effective: 1, configured: null, builtin: 1 }, user_overrides: 0 } }));
  h.db.rpcs.set('admin_class_groups', () => ({ data: [] }));
  h.db.rpcs.set('ai_budget_set_limit', (args) => ({ data: args.p_limit ?? 1_000_000 }));
  return h;
}

/** P2 members the settings functions read: the public host and random bytes. */
function p2(h: Harness, bytes?: () => Uint8Array): P2Deps {
  return {
    ...h.deps,
    userRpc: async () => ({ data: null, error: null }),
    broadcast: async () => undefined,
    baseUrl: 'studify.test',
    randomInt: () => 0,
    randomBytes: (n: number) => bytes?.() ?? crypto.getRandomValues(new Uint8Array(n)),
  };
}

const body = (h: Harness, name: string, b: unknown, idem = 1) => request(name, { body: b, idem: v7(idem) });

// ---------------------------------------------------------------- helpers

test('isMinorBirth: the birthday counts as the last day of the birth month (spec 00 §8.1)', () => {
  assertEquals(isMinorBirth(2008, 10, '2026-10-30'), true);
  assertEquals(isMinorBirth(2008, 10, '2026-10-31'), false);
  assertEquals(isMinorBirth(2008, 2, '2026-02-28'), false); // 2008-02-29 + 18 years is clamped to Feb 28
  assertEquals(isMinorBirth(1990, 1, '2026-10-27'), false);
});

test('quietMinutes spans midnight', () => {
  assertEquals(quietMinutes('22:00', '07:00'), 540);
  assertEquals(quietMinutes('23:30', '06:00'), 390);
  assertEquals(quietMinutes('08:00', '09:00'), 60);
});

test('newInviteCode uses the database alphabet (no 0, 1, I, L, O)', () => {
  for (let i = 0; i < 200; i++) assertMatch(newInviteCode((n) => crypto.getRandomValues(new Uint8Array(n))), /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  // Bytes >= 248 are rejected, so the distribution stays uniform.
  assertEquals(newInviteCode((n) => new Uint8Array(n).fill(255).map((v, i) => (i % 2 ? v : 0))), 'AAAAAAAA');
});

test('every dashboard function is routed', () => {
  for (const name of ['account-overview', 'account-update', 'account-membership', 'account-device-remove', 'account-export-link',
    'admin-overview', 'admin-ai-usage', 'admin-users', 'admin-user', 'admin-user-control', 'admin-class-groups',
    'admin-class-group-control', 'admin-moderation', 'admin-moderation-control', 'admin-settings', 'admin-settings-control', 'admin-audit']) {
    assert(ROUTES.has(name), name);
  }
});

// ---------------------------------------------------------------- account-overview

test('account-overview: 404 with a clear message before the profile exists', async () => {
  const h = setup();
  h.db.tables.set('profiles', []);
  const res = await accountOverview(request('account-overview'), h.deps);
  assertEquals(res.status, 404);
  assertMatch((await json(res)).error.message, /Termine o cadastro no app/);
});

test('account-overview: defaults, usage as percentages, the caller\'s own rows only', async () => {
  const h = setup();
  h.db.seed('push_tokens', [
    { id: v7(1), user_id: ALICE.id, device_id: 'pixel', platform: 'android', app_version: '1.2.0', last_seen_at: '2026-10-26T10:00:00Z', created_at: '2026-10-01T00:00:00Z', invalidated_at: null },
    { id: v7(2), user_id: ALICE.id, device_id: 'old', platform: 'android', app_version: '1.0.0', last_seen_at: '2026-09-01T10:00:00Z', created_at: '2026-09-01T00:00:00Z', invalidated_at: '2026-09-02T00:00:00Z' },
    { id: v7(3), user_id: BOB.id, device_id: 'bob-phone', platform: 'android', app_version: '1.2.0', last_seen_at: '2026-10-26T10:00:00Z', created_at: '2026-10-01T00:00:00Z', invalidated_at: null },
  ]);
  h.db.seed('ai_budgets', [
    { scope_type: 'user', scope_id: ALICE.id, period_type: 'day', period_start: '2026-10-26', limit_micro_usd: 1_000_000, spent_micro_usd: 250_000 },
    { scope_type: 'user', scope_id: BOB.id, period_type: 'day', period_start: '2026-10-26', limit_micro_usd: 1_000_000, spent_micro_usd: 900_000 },
  ]);
  h.db.seed('daily_activity', [
    { user_id: ALICE.id, local_date: '2026-10-25', active_minutes: 30, reviews: 12, deleted_at: null },
    { user_id: ALICE.id, local_date: '2026-10-10', active_minutes: 99, reviews: 99, deleted_at: null },
  ]);
  h.db.seed('streaks', { user_id: ALICE.id, current_length: 4, longest_length: 9 });
  h.db.seed('class_groups', [{ id: GROUP, name: '3º A', deleted_at: null }, { id: OTHER_GROUP, name: 'Apagada', deleted_at: '2026-10-01T00:00:00Z' }]);
  h.db.seed('class_group_members', [
    { class_group_id: GROUP, user_id: ALICE.id, role: 'member', status: 'active', nickname: null, joined_at: '2026-10-01T00:00:00Z', league_opt_in: false, accepts_duels: true, contribute_insights: true },
    { class_group_id: GROUP, user_id: BOB.id, role: 'owner', status: 'active', nickname: null, joined_at: '2026-09-01T00:00:00Z', league_opt_in: true, accepts_duels: true, contribute_insights: true },
    { class_group_id: OTHER_GROUP, user_id: ALICE.id, role: 'member', status: 'active', nickname: null, joined_at: null, league_opt_in: false, accepts_duels: true, contribute_insights: true },
  ]);
  h.db.seed('account_deletions', { id: v7(9), user_id: ALICE.id, requested_by: 'self', status: 'pending', requested_at: '2026-10-20T00:00:00Z' });

  const res = await accountOverview(request('account-overview'), h.deps);
  assertEquals(res.status, 200);
  const o = await json(res);
  assertEquals(o.profile.email, ALICE.email);
  assertEquals(o.profile.is_minor, true);
  assertEquals(o.settings, { theme: 'system', notifications: { reviews: true, plan: true, class: true, processing: true } });
  assertEquals(o.quiet_hours, { start: '22:00', end: '07:00' });
  assertEquals(o.ai_usage.today_pct, 42);
  assertEquals(o.ai_usage.history.length, 14);
  assertEquals(o.ai_usage.history.find((d: { day: string }) => d.day === '2026-10-26').pct, 25);
  assertEquals(o.activity.streak, 4);
  assertEquals(o.activity.minutes_7d, 30, 'only the last 7 days count');
  assertEquals(o.devices.map((d: { device_id: string }) => d.device_id), ['pixel']);
  assertEquals(o.class_groups.length, 1, 'deleted Turmas are hidden');
  assertEquals(o.class_groups[0].members, 2);
  assertEquals(o.deletion.completes_by, '2026-11-04T00:00:00.000Z');
  // No money anywhere in the student's view.
  assert(!JSON.stringify(o).includes('micro_usd'));
});

test('account-overview: an admin has no limit to use up', async () => {
  const h = setup({ admin: true });
  const o = await json(await accountOverview(request('account-overview'), h.deps));
  assertEquals(o.ai_usage.exempt, true);
  assertEquals(o.ai_usage.today_pct, 0);
});

// ---------------------------------------------------------------- account-update

test('account-update: a new name goes back to moderation, other settings keys are kept', async () => {
  const h = setup();
  h.db.table('profiles').find((p) => p.id === ALICE.id)!.settings = { theme: 'dark', memory: { desired_retention: 0.85 }, notifications: { plan: false } };
  const res = await accountUpdate(body(h, 'account-update', { display_name: 'Alice M.', notifications: { reviews: false }, timezone: 'America/Manaus' }), h.deps);
  assertEquals(res.status, 200);
  const row = h.db.rows('profiles').find((p) => p.id === ALICE.id)!;
  assertEquals(row.display_name, 'Alice M.');
  assertEquals(row.display_name_status, 'pending');
  assertEquals(row.timezone, 'America/Manaus');
  assertEquals(row.settings, { theme: 'dark', memory: { desired_retention: 0.85 }, notifications: { plan: false, reviews: false } });
  const o = await json(res);
  assertEquals(o.settings.notifications, { reviews: false, plan: false, class: true, processing: true });
});

test('account-update: the same name keeps its approval', async () => {
  const h = setup();
  await accountUpdate(body(h, 'account-update', { display_name: 'Alice', theme: 'light' }), h.deps);
  assertEquals(h.db.rows('profiles').find((p) => p.id === ALICE.id)!.display_name_status, 'approved');
});

test('account-update: blocked names, unknown timezones, empty and unknown fields are refused', async () => {
  const h = setup();
  assertEquals((await json(await accountUpdate(body(h, 'account-update', { display_name: 'Admin Studify' }, 1), h.deps))).error.code, 'display_name_rejected');
  assertEquals((await accountUpdate(body(h, 'account-update', { timezone: 'Mars/Olympus' }, 2), h.deps)).status, 400);
  assertEquals((await accountUpdate(body(h, 'account-update', {}, 3), h.deps)).status, 400);
  assertEquals((await accountUpdate(body(h, 'account-update', { app_role: 'app_admin' }, 4), h.deps)).status, 400);
  assertEquals(h.db.rows('profiles').find((p) => p.id === ALICE.id)!.app_role, 'user');
});

test('account-update: under 18, quiet hours keep at least 8 hours (PLT-05.3)', async () => {
  const h = setup();
  const res = await accountUpdate(body(h, 'account-update', { quiet_start: '23:30', quiet_end: '06:00' }, 1), h.deps);
  assertEquals(res.status, 400);
  assertMatch((await json(res)).error.message, /pelo menos 8 horas/);
  assertEquals(h.db.rows('study_preferences').length, 0);
  const ok = await accountUpdate(body(h, 'account-update', { quiet_start: '21:30' }, 2), h.deps);
  assertEquals(ok.status, 200);
  assertEquals(h.db.rows('study_preferences'), [{ user_id: ALICE.id, quiet_start: '21:30', quiet_end: '07:00', created_at: NOW.toISOString() }]);
  assertEquals((await json(ok)).quiet_hours, { start: '21:30', end: '07:00' });
});

test('account-update: adults may shorten quiet hours', async () => {
  const h = setup();
  h.db.table('profiles').find((p) => p.id === ALICE.id)!.birth_year = 1995;
  const res = await accountUpdate(body(h, 'account-update', { quiet_start: '23:30', quiet_end: '06:00' }), h.deps);
  assertEquals(res.status, 200);
});

// ---------------------------------------------------------------- account-membership

test('account-membership: leaving runs leave_class_group as the student', async () => {
  const h = setup();
  h.db.rpcs.set('leave_class_group', () => ({ data: null }));
  const res = await accountMembership(body(h, 'account-membership', { action: 'leave', class_group_id: GROUP }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.db.rpcCalls.find((c) => c.name === 'leave_class_group')?.args, { p_class_group_id: GROUP });
});

test('account-membership: the owner must hand the Turma over first', async () => {
  const h = setup();
  h.db.rpcs.set('leave_class_group', () => ({ error: { message: 'owner_must_transfer', code: 'P0001' } }));
  const res = await accountMembership(body(h, 'account-membership', { action: 'leave', class_group_id: GROUP }), h.deps);
  assertEquals(res.status, 403);
  assertMatch((await json(res)).error.message, /Passe a turma/);
});

test('account-membership: choices change only on the caller\'s active membership', async () => {
  const h = setup();
  h.db.seed('class_group_members', [
    { class_group_id: GROUP, user_id: ALICE.id, role: 'member', status: 'active', league_opt_in: false, accepts_duels: true, contribute_insights: true },
    { class_group_id: OTHER_GROUP, user_id: BOB.id, role: 'member', status: 'active', league_opt_in: false, accepts_duels: true, contribute_insights: true },
  ]);
  const ok = await accountMembership(body(h, 'account-membership', { action: 'update', class_group_id: GROUP, league_opt_in: true }, 1), h.deps);
  assertEquals(ok.status, 200);
  assertEquals(h.db.rows('class_group_members').find((m) => m.user_id === ALICE.id)!.league_opt_in, true);
  const other = await accountMembership(body(h, 'account-membership', { action: 'update', class_group_id: OTHER_GROUP, accepts_duels: false }, 2), h.deps);
  assertEquals(other.status, 404);
  assertEquals(h.db.rows('class_group_members').find((m) => m.user_id === BOB.id)!.accepts_duels, true);
});

// ---------------------------------------------------------------- devices and exports

test('account-device-remove: invalidates only the caller\'s token', async () => {
  const h = setup();
  h.db.seed('push_tokens', [
    { id: v7(1), user_id: ALICE.id, device_id: 'pixel', invalidated_at: null },
    { id: v7(2), user_id: BOB.id, device_id: 'bob-phone', invalidated_at: null },
  ]);
  assertEquals((await accountDeviceRemove(body(h, 'account-device-remove', { device_id: 'bob-phone' }, 1), h.deps)).status, 404);
  assertEquals((await accountDeviceRemove(body(h, 'account-device-remove', { device_id: 'pixel' }, 2), h.deps)).status, 200);
  const tokens = h.db.rows('push_tokens');
  assertEquals(tokens.find((t) => t.device_id === 'pixel')!.invalidated_at, NOW.toISOString());
  assertEquals(tokens.find((t) => t.device_id === 'bob-phone')!.invalidated_at, null);
});

test('account-export-link: signs only the caller\'s ready, unexpired export', async () => {
  const h = setup();
  h.db.seed('data_exports', [
    { id: v7(1), user_id: ALICE.id, status: 'ready', storage_path: `${ALICE.id}/a.zip`, expires_at: '2026-11-01T00:00:00Z' },
    { id: v7(2), user_id: ALICE.id, status: 'ready', storage_path: `${ALICE.id}/b.zip`, expires_at: '2026-10-20T00:00:00Z' },
    { id: v7(3), user_id: BOB.id, status: 'ready', storage_path: `${BOB.id}/c.zip`, expires_at: '2026-11-01T00:00:00Z' },
  ]);
  h.db.objects.set(`exports/${ALICE.id}/a.zip`, new Uint8Array([1]));
  h.db.objects.set(`exports/${BOB.id}/c.zip`, new Uint8Array([1]));
  const ok = await accountExportLink(request('account-export-link', { body: { export_id: v7(1) } }), h.deps);
  assertEquals(ok.status, 200);
  assertEquals(await json(ok), { url: `https://storage.test/exports/${ALICE.id}/a.zip?ttl=300`, expires_in: 300 });
  const expired = await accountExportLink(request('account-export-link', { body: { export_id: v7(2) } }), h.deps);
  assertEquals(expired.status, 404);
  assertMatch((await json(expired)).error.message, /expirou/);
  assertEquals((await accountExportLink(request('account-export-link', { body: { export_id: v7(3) } }), h.deps)).status, 404);
});

// ---------------------------------------------------------------- admin access

const ADMIN_FUNCTIONS: Array<[string, unknown]> = [
  ['admin-overview', {}],
  ['admin-ai-usage', { days: 7 }],
  ['admin-users', {}],
  ['admin-user', { user_id: BOB.id }],
  ['admin-user-control', { action: 'approve_name', user_id: BOB.id }],
  ['admin-class-groups', {}],
  ['admin-class-group-control', { action: 'set_budget', class_group_id: GROUP, limit_micro_usd: 1 }],
  ['admin-moderation', {}],
  ['admin-moderation-control', { action: 'report', report_id: v7(1), decision: 'dismissed' }],
  ['admin-settings', {}],
  ['admin-settings-control', { action: 'invite_revoke', invite_id: v7(1) }],
  ['admin-audit', {}],
];

for (const [name, payload] of ADMIN_FUNCTIONS) {
  test(`${name}: 403 for a student, and nothing is read or written`, async () => {
    const h = setup();
    const res = await ROUTES.get(name)!(body(h, name, payload), p2(h));
    assertEquals(res.status, 403);
    assertEquals((await json(res)).error.code, 'forbidden');
    assertEquals(h.db.rpcCalls.filter((c) => c.schema === 'private' && c.name.startsWith('admin')).length, 0);
    assertEquals(h.db.rows('admin_audit').length, 0);
  });
}

test('admin-overview: the read model plus the server version', async () => {
  const h = setup({ admin: true });
  h.db.rpcs.set('admin_overview', () => ({ data: { users: { total: 2 } } }));
  const o = await json(await adminOverview(request('admin-overview'), h.deps));
  assertEquals(o.users.total, 2);
  assertMatch(o.server.version, /^\d+\.\d+\.\d+$/);
});

test('admin-users: the search is trimmed and the filter defaults to all', async () => {
  const h = setup({ admin: true });
  h.db.rpcs.set('admin_users', () => ({ data: { total: 0, rows: [] } }));
  await adminUsers(request('admin-users', { body: { query: '  bob ' } }), h.deps);
  await adminUsers(request('admin-users', { body: { query: '   ', filter: 'suspended', limit: 10, offset: 20 } }), h.deps);
  const calls = h.db.rpcCalls.filter((c) => c.name === 'admin_users').map((c) => c.args);
  assertEquals(calls, [
    { p_query: 'bob', p_filter: 'all', p_limit: 25, p_offset: 0 },
    { p_query: null, p_filter: 'suspended', p_limit: 10, p_offset: 20 },
  ]);
});

test('admin-user: unknown students are not found', async () => {
  const h = setup({ admin: true });
  assertEquals((await adminUser(request('admin-user', { body: { user_id: v7(77) } }), h.deps)).status, 404);
  assertEquals((await adminUser(request('admin-user', { body: { user_id: BOB.id } }), h.deps)).status, 200);
});

// ---------------------------------------------------------------- admin-user-control

test('admin-user-control: nobody removes their own admin role', async () => {
  const h = setup({ admin: true });
  const res = await adminUserControl(body(h, 'admin-user-control', { action: 'set_role', user_id: ALICE.id, role: 'user' }), h.deps);
  assertEquals(res.status, 403);
  assertEquals(h.db.rows('profiles').find((p) => p.id === ALICE.id)!.app_role, 'app_admin');
});

test('admin-user-control: promoting a student is applied and audited', async () => {
  const h = setup({ admin: true });
  const res = await adminUserControl(body(h, 'admin-user-control', { action: 'set_role', user_id: BOB.id, role: 'app_admin' }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.db.rows('profiles').find((p) => p.id === BOB.id)!.app_role, 'app_admin');
  const [entry] = h.db.rows('admin_audit');
  assertEquals({ ...entry, created_at: undefined }, { actor_id: ALICE.id, action: 'user.set_role', target_type: 'profile', target_id: BOB.id, details: { from: 'user', to: 'app_admin' }, created_at: undefined });
});

test('admin-user-control: suspension bans the auth user, records the moderation action, and can be lifted', async () => {
  const h = setup({ admin: true });
  // Bob's token was verified a moment ago, so the API remembers it.
  assertEquals((await accountOverview(request('account-overview', { token: BOB.jwt }), h.deps)).status, 200);
  const res = await adminUserControl(body(h, 'admin-user-control', { action: 'suspend', user_id: BOB.id, days: 3, reason: 'Nome ofensivo repetido' }, 1), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.db.userUpdates, [{ id: BOB.id, attributes: { ban_duration: '72h' } }]);
  const [mod] = h.db.rows('moderation_actions');
  assertEquals([mod!.action, mod!.actor_kind, mod!.target_id, mod!.reason], ['ban', 'app_admin', BOB.id, 'Nome ofensivo repetido']);
  // The suspension reaches the token the API remembered: Bob's next call is refused at once.
  h.db.users.set(BOB.jwt, { id: BOB.id, email: BOB.email, banned_until: '2099-01-01T00:00:00Z' });
  assertEquals((await accountOverview(request('account-overview', { token: BOB.jwt }), h.deps)).status, 403);
  await adminUserControl(body(h, 'admin-user-control', { action: 'unsuspend', user_id: BOB.id }, 2), h.deps);
  assertEquals(h.db.userUpdates[1], { id: BOB.id, attributes: { ban_duration: 'none' } });
  assertEquals(h.db.rows('admin_audit').map((a) => a.action), ['user.suspend', 'user.unsuspend']);
});

test('admin-user-control: no suspending yourself or another admin', async () => {
  const h = setup({ admin: true });
  h.db.table('profiles').find((p) => p.id === BOB.id)!.app_role = 'app_admin';
  assertEquals((await adminUserControl(body(h, 'admin-user-control', { action: 'suspend', user_id: ALICE.id, days: null, reason: 'teste' }, 1), h.deps)).status, 403);
  assertEquals((await adminUserControl(body(h, 'admin-user-control', { action: 'suspend', user_id: BOB.id, days: null, reason: 'teste' }, 2), h.deps)).status, 403);
  assertEquals(h.db.userUpdates.length, 0);
});

test('admin-user-control: name review and the daily limit override', async () => {
  const h = setup({ admin: true });
  h.db.table('profiles').find((p) => p.id === BOB.id)!.display_name_status = 'pending';
  await adminUserControl(body(h, 'admin-user-control', { action: 'approve_name', user_id: BOB.id }, 1), h.deps);
  assertEquals(h.db.rows('profiles').find((p) => p.id === BOB.id)!.display_name_status, 'approved');
  await adminUserControl(body(h, 'admin-user-control', { action: 'set_daily_limit', user_id: BOB.id, limit_micro_usd: 2_500_000 }, 2), h.deps);
  assertEquals(h.db.rpcCalls.find((c) => c.name === 'ai_budget_set_limit')?.args, { p_scope_type: 'user', p_scope_id: BOB.id, p_limit: 2_500_000, p_actor: ALICE.id });
  assertEquals((await adminUserControl(body(h, 'admin-user-control', { action: 'approve_name', user_id: v7(55) }, 3), h.deps)).status, 404);
});

test('a suspended account is refused at once, before its token expires', async () => {
  const h = setup();
  h.db.users.set(ALICE.jwt, { id: ALICE.id, email: ALICE.email, banned_until: '2099-01-01T00:00:00Z' });
  const res = await accountOverview(request('account-overview'), h.deps);
  assertEquals(res.status, 403);
  assertEquals((await json(res)).error.code, 'banned');
  h.db.users.set(ALICE.jwt, { id: ALICE.id, email: ALICE.email, banned_until: '2020-01-01T00:00:00Z' });
  assertEquals((await accountOverview(request('account-overview'), h.deps)).status, 200, 'an expired ban no longer applies');
});

// ---------------------------------------------------------------- Turmas, moderation, settings, audit

test('admin-class-group-control: sets the Turma limit through the budget function and audits it', async () => {
  const h = setup({ admin: true });
  const res = await adminClassGroupControl(body(h, 'admin-class-group-control', { action: 'set_budget', class_group_id: GROUP, limit_micro_usd: null }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.db.rpcCalls.find((c) => c.name === 'ai_budget_set_limit')?.args, { p_scope_type: 'class_group', p_scope_id: GROUP, p_limit: null, p_actor: ALICE.id });
  assertEquals((await json(res)).default_limit, 50_000_000);
  assertEquals(h.db.rows('admin_audit')[0]!.action, 'class_group.set_budget');
});

test('admin-moderation-control: a report is closed once', async () => {
  const h = setup({ admin: true });
  h.db.seed('user_reports', { id: v7(1), reporter_id: BOB.id, reason: 'spam', status: 'open' });
  const res = await adminModerationControl(body(h, 'admin-moderation-control', { action: 'report', report_id: v7(1), decision: 'dismissed', note: 'Sem problema' }, 1), h.deps);
  assertEquals(res.status, 200);
  const report = h.db.rows('user_reports')[0]!;
  assertEquals([report.status, report.handled_by, report.handled_at], ['dismissed', ALICE.id, NOW.toISOString()]);
  assertEquals(h.db.rows('admin_audit')[0]!.details, { note: 'Sem problema' });
  const again = await adminModerationControl(body(h, 'admin-moderation-control', { action: 'report', report_id: v7(1), decision: 'actioned' }, 2), h.deps);
  assertEquals(again.status, 409);
  assertEquals((await json(again)).error.code, 'already_completed');
});

test('admin-moderation-control: a flag is resolved by resolve_flag as the admin', async () => {
  const h = setup({ admin: true });
  h.db.seed('content_flags', { id: v7(2), item_type: 'card', item_id: v7(3), status: 'open' });
  h.db.rpcs.set('resolve_flag', () => ({ data: null }));
  const res = await adminModerationControl(body(h, 'admin-moderation-control', { action: 'flag', flag_id: v7(2), decision: 'remove' }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.db.rpcCalls.find((c) => c.name === 'resolve_flag'), { name: 'resolve_flag', args: { p_flag_id: v7(2), p_decision: 'remove' }, schema: 'public' });
});

test('admin-settings-control: a pilot invite is single use for 14 days by default, with its link', async () => {
  const h = setup({ admin: true });
  const res = await adminSettingsControl(body(h, 'admin-settings-control', { action: 'invite_create' }), p2(h));
  assertEquals(res.status, 200);
  const { invite, settings } = await json(res);
  assertMatch(invite.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assertEquals(invite.uses_left, 1);
  assertEquals(invite.expires_at, '2026-11-10T15:00:00.000Z');
  assertEquals(invite.link, `https://studify.test/i/${invite.code}`);
  assertEquals(settings.invites[0].code, invite.code);
  const row = h.db.rows('invites')[0]!;
  assertEquals([row.class_group_id, row.created_by], [null, ALICE.id]);
  assertEquals(h.db.rows('admin_audit')[0]!.details, { uses: 1, expires_in_days: 14, bound_to_email: false });
});

test('admin-settings-control: a code collision draws a new code', async () => {
  const h = setup({ admin: true });
  h.db.seed('invites', { id: v7(90), code: 'AAAAAAAA', class_group_id: null, created_by: BOB.id, expires_at: '2026-12-01T00:00:00Z', revoked_at: null });
  let call = 0;
  const bytes = () => new Uint8Array(16).fill(call++ < 1 ? 0 : 1);
  const res = await adminSettingsControl(body(h, 'admin-settings-control', { action: 'invite_create', uses: 5, expires_in_days: 30, email: 'nova@escola.test' }), p2(h, bytes));
  assertEquals(res.status, 200);
  const { invite } = await json(res);
  assertEquals(invite.code, 'BBBBBBBB');
  assertEquals([invite.uses_left, invite.email], [5, 'nova@escola.test']);
});

test('admin-settings-control: revoking touches only live pilot invites', async () => {
  const h = setup({ admin: true });
  h.db.seed('invites', [
    { id: v7(1), code: 'CCCCCCCC', class_group_id: null, created_by: ALICE.id, revoked_at: null, created_at: '2026-10-01T00:00:00Z' },
    { id: v7(2), code: 'DDDDDDDD', class_group_id: GROUP, created_by: BOB.id, revoked_at: null, created_at: '2026-10-01T00:00:00Z' },
  ]);
  assertEquals((await adminSettingsControl(body(h, 'admin-settings-control', { action: 'invite_revoke', invite_id: v7(2) }, 1), p2(h))).status, 404);
  assertEquals((await adminSettingsControl(body(h, 'admin-settings-control', { action: 'invite_revoke', invite_id: v7(1) }, 2), p2(h))).status, 200);
  assertEquals(h.db.rows('invites').map((i) => i.revoked_at), [NOW.toISOString(), null]);
});

test('admin-settings-control: limits change only where given; null goes back to the placeholder', async () => {
  const h = setup({ admin: true });
  const res = await adminSettingsControl(body(h, 'admin-settings-control', { action: 'set_limits', global_month_micro_usd: 200_000_000, user_day_micro_usd: null }, 1), p2(h));
  assertEquals(res.status, 200);
  const calls = h.db.rpcCalls.filter((c) => c.name === 'ai_budget_set_limit').map((c) => [c.args.p_scope_type, c.args.p_limit]);
  assertEquals(calls, [['user', null], ['global', 200_000_000]]);
  assertEquals(h.db.rows('admin_audit')[0]!.details, { user_day_micro_usd: null, global_month_micro_usd: 200_000_000 });
  assertEquals((await adminSettingsControl(body(h, 'admin-settings-control', { action: 'set_limits' }, 2), p2(h))).status, 400);
});

test('admin-settings-control: feature flags are created and changed in place; unknown versions are not found', async () => {
  const h = setup({ admin: true });
  await adminSettingsControl(body(h, 'admin-settings-control', { action: 'flag_upsert', key: 'web_dashboard', description: 'Painel web', percentage: 20 }, 1), p2(h));
  await adminSettingsControl(body(h, 'admin-settings-control', { action: 'flag_upsert', key: 'web_dashboard', enabled_all: true }, 2), p2(h));
  const flags = h.db.rows('feature_flags');
  assertEquals(flags.length, 1);
  assertEquals([flags[0]!.description, flags[0]!.percentage, flags[0]!.enabled_all], ['Painel web', 20, true]);
  assertEquals((await adminSettingsControl(body(h, 'admin-settings-control', { action: 'flag_upsert', key: 'Bad Key' }, 3), p2(h))).status, 400);
  assertEquals((await adminSettingsControl(body(h, 'admin-settings-control', { action: 'version_block', version_code: 7, blocks_older: true }, 4), p2(h))).status, 404);
});

test('admin-audit: pages back with `before`', async () => {
  const h = setup({ admin: true });
  await adminAudit(request('admin-audit', { body: { limit: 10, before: '2026-10-20T00:00:00.000Z' } }), h.deps);
  assertEquals(h.db.rpcCalls.find((c) => c.name === 'admin_audit_list')?.args, { p_limit: 10, p_before: '2026-10-20T00:00:00.000Z', p_target: null });
});

test('admin-audit: the cursor accepts the timestamp exactly as Postgres writes it', async () => {
  const h = setup({ admin: true });
  const res = await adminAudit(request('admin-audit', { body: { before: '2026-10-29T16:00:13.123456+00:00' } }), h.deps);
  assertEquals(res.status, 200);
  assertEquals(h.db.rpcCalls.find((c) => c.name === 'admin_audit_list')?.args.p_before, '2026-10-29T16:00:13.123456+00:00');
});
