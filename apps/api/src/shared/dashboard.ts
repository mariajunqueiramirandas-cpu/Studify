// Shared pieces of the web dashboard functions (account-*, admin-*; api.md §4.11): the Minha conta read model,
// the admin audit log, pilot invite codes and the protective age rule.
import type { Db } from '@studify/db';
import {
  ApiFailure,
  DEFAULT_TIME_ZONE,
  NOTIFICATION_CHANNEL,
  addDays,
  localDateOf,
  type AccountOverview,
  type AdminAuditEntry,
  type AdminSettings,
  type AdminUserDetail,
  type LocalDate,
  type NotificationChannel,
} from '@studify/shared';
import type { AuthUser } from './auth.ts';
import type { Deps } from './deps.ts';

/** Deletions finish within 15 days (security-privacy §10), as account-delete promises. */
const DELETION_DAYS = 15;
const DEFAULT_QUIET = { start: '22:00', end: '07:00' } as const;

/** Last day of `month` (1–12) in `year`. */
function lastDayOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Under 18 on `today` by the rule of spec 00 §8.1: the birthday counts as the last day of the birth month, so a
 * student is a minor for the whole month they turn 18. Same result as private.is_minor_birth.
 */
export function isMinorBirth(birthYear: number, birthMonth: number, today: LocalDate): boolean {
  const day = Math.min(lastDayOf(birthYear, birthMonth), lastDayOf(birthYear + 18, birthMonth));
  const adult = `${birthYear + 18}-${String(birthMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return today < adult;
}

/** Length of the quiet window in minutes, across midnight (22:00–07:00 is 540). */
export function quietMinutes(start: string, end: string): number {
  const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return (toMin(end) - toMin(start) + 1440) % 1440;
}

/** True for an IANA zone the runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Appends one entry to private.admin_audit. A failed write is logged; the action it records has already happened. */
export async function audit(
  db: Db,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.schema('private').from('admin_audit').insert({
    actor_id: actorId,
    action,
    target_type: targetType,
    target_id: targetId,
    details,
  });
  if (error) console.error('admin_audit insert failed', action, error.message);
}

/** Same alphabet and rejection sampling as private.new_invite_code (31 symbols; 248 = 8 × 31). */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newInviteCode(randomBytes: (n: number) => Uint8Array): string {
  let out = '';
  while (out.length < 8) {
    for (const byte of randomBytes(16)) {
      if (byte < 248 && out.length < 8) out += INVITE_ALPHABET[byte % 31];
    }
  }
  return out;
}

/** Pilot invite link: the /i/{code} page of the link site, or the app route without a public host. */
export function inviteLink(baseUrl: string | null, code: string): string {
  return baseUrl ? `https://${baseUrl}/i/${code}` : `studify://auth/invite?code=${code}`;
}

interface ProfileRow {
  id: string;
  display_name: string;
  display_name_status: AccountOverview['profile']['display_name_status'];
  avatar_preset: string | null;
  school_year: AccountOverview['profile']['school_year'];
  timezone: string | null;
  foreign_language: 'en' | 'es' | null;
  app_role: 'user' | 'app_admin';
  birth_year: number;
  birth_month: number;
  privacy_notice_version: string;
  privacy_accepted_at: string;
  settings: Record<string, unknown> | null;
  created_at: string;
  deleted_at: string | null;
}

/** The profile of the caller; a signed-in account without one has not finished sign-up in the app. */
export async function requireProfile(db: Db, userId: string): Promise<ProfileRow> {
  const { data, error } = await db
    .from('profiles')
    .select('id, display_name, display_name_status, avatar_preset, school_year, timezone, foreign_language, app_role, birth_year, birth_month, privacy_notice_version, privacy_accepted_at, settings, created_at, deleted_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data || (data as ProfileRow).deleted_at) {
    throw new ApiFailure('not_found', { message: 'Essa conta ainda não tem perfil. Termine o cadastro no app do Studify.' });
  }
  return data as ProfileRow;
}

function readSettings(raw: Record<string, unknown> | null): AccountOverview['settings'] {
  const theme = raw?.theme === 'light' || raw?.theme === 'dark' ? raw.theme : 'system';
  const stored = (raw?.notifications ?? {}) as Partial<Record<NotificationChannel, unknown>>;
  const notifications = Object.fromEntries(NOTIFICATION_CHANNEL.map((c) => [c, stored[c] !== false])) as Record<NotificationChannel, boolean>;
  return { theme, notifications };
}

const hhmm = (value: unknown, fallback: string): string => (typeof value === 'string' && /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : fallback);
const pct = (spent: number, limit: number): number => (limit > 0 ? Math.min(100, Math.max(0, Math.round((spent * 100) / limit))) : 100);

/** Everything the Minha conta pages show, read with the service role for the caller only. */
export async function loadAccountOverview(deps: Deps, user: AuthUser, now: Date): Promise<AccountOverview> {
  const { db } = deps;
  const profile = await requireProfile(db, user.userId);
  const timeZone = profile.timezone ?? DEFAULT_TIME_ZONE;
  const today = localDateOf(now, timeZone);
  const from = addDays(today, -13);
  const exempt = profile.app_role === 'app_admin';

  const [prefs, usageToday, budgets, streak, activity, memberships, devices, exports, deletion] = await Promise.all([
    db.from('study_preferences').select('quiet_start, quiet_end').eq('user_id', user.userId).maybeSingle(),
    // The same function the app's meter reads, run as the student (it reads auth.uid()).
    deps.asUser(user).rpc('my_ai_usage_today'),
    db.schema('private').from('ai_budgets').select('period_start, limit_micro_usd, spent_micro_usd')
      .eq('scope_type', 'user').eq('scope_id', user.userId).eq('period_type', 'day')
      .order('period_start', { ascending: false }).limit(14),
    db.from('streaks').select('current_length, longest_length').eq('user_id', user.userId).maybeSingle(),
    db.from('daily_activity').select('local_date, active_minutes, reviews').eq('user_id', user.userId).gte('local_date', from).is('deleted_at', null),
    db.from('class_group_members').select('class_group_id, role, status, nickname, joined_at, league_opt_in, accepts_duels, contribute_insights')
      .eq('user_id', user.userId).in('status', ['active', 'pending']),
    db.from('push_tokens').select('device_id, platform, app_version, last_seen_at, created_at')
      .eq('user_id', user.userId).is('invalidated_at', null).order('last_seen_at', { ascending: false }),
    db.from('data_exports').select('id, status, created_at, completed_at, expires_at')
      .eq('user_id', user.userId).order('created_at', { ascending: false }).limit(5),
    db.from('account_deletions').select('id, status, requested_at')
      .eq('user_id', user.userId).in('status', ['pending', 'running', 'failed']).order('requested_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  for (const res of [prefs, budgets, streak, activity, memberships, devices, exports, deletion]) if (res.error) throw res.error;

  const usage = (usageToday.error ? null : usageToday.data) as { pct?: number; byFeature?: Array<{ feature: string; pct: number }> } | null;
  const byDay = new Map<string, number>();
  for (const row of (budgets.data as Array<{ period_start: string; limit_micro_usd: number; spent_micro_usd: number }> | null) ?? []) {
    byDay.set(String(row.period_start).slice(0, 10), pct(Number(row.spent_micro_usd), Number(row.limit_micro_usd)));
  }
  const days: LocalDate[] = Array.from({ length: 14 }, (_, i) => addDays(from, i));
  const activityRows = new Map<string, { active_minutes: number; reviews: number }>();
  for (const row of (activity.data as Array<{ local_date: string; active_minutes: number; reviews: number }> | null) ?? []) {
    activityRows.set(String(row.local_date).slice(0, 10), row);
  }
  const weekStart = addDays(today, -6);
  const week = days.filter((d) => d >= weekStart).map((d) => activityRows.get(d));

  const memberRows = (memberships.data as Array<{
    class_group_id: string; role: AccountOverview['class_groups'][number]['role']; status: 'active' | 'pending'; nickname: string | null;
    joined_at: string | null; league_opt_in: boolean; accepts_duels: boolean; contribute_insights: boolean;
  }> | null) ?? [];
  const groupIds = memberRows.map((m) => m.class_group_id);
  const groups = new Map<string, string>();
  const counts = new Map<string, number>();
  if (groupIds.length > 0) {
    const [named, members] = await Promise.all([
      db.from('class_groups').select('id, name').in('id', groupIds).is('deleted_at', null),
      db.from('class_group_members').select('class_group_id').in('class_group_id', groupIds).eq('status', 'active'),
    ]);
    if (named.error) throw named.error;
    if (members.error) throw members.error;
    for (const g of (named.data as Array<{ id: string; name: string }> | null) ?? []) groups.set(g.id, g.name);
    for (const m of (members.data as Array<{ class_group_id: string }> | null) ?? []) counts.set(m.class_group_id, (counts.get(m.class_group_id) ?? 0) + 1);
  }

  const del = deletion.data as { id: string; status: 'pending' | 'running' | 'failed'; requested_at: string } | null;
  return {
    profile: {
      id: profile.id,
      email: user.email,
      display_name: profile.display_name,
      display_name_status: profile.display_name_status,
      avatar_preset: profile.avatar_preset,
      school_year: profile.school_year,
      timezone: timeZone,
      foreign_language: profile.foreign_language,
      app_role: profile.app_role,
      is_minor: isMinorBirth(profile.birth_year, profile.birth_month, localDateOf(now, DEFAULT_TIME_ZONE)),
      privacy_notice_version: profile.privacy_notice_version,
      privacy_accepted_at: profile.privacy_accepted_at,
      created_at: profile.created_at,
    },
    settings: readSettings(profile.settings),
    quiet_hours: {
      start: hhmm((prefs.data as { quiet_start?: string } | null)?.quiet_start, DEFAULT_QUIET.start),
      end: hhmm((prefs.data as { quiet_end?: string } | null)?.quiet_end, DEFAULT_QUIET.end),
    },
    ai_usage: {
      today_pct: exempt ? 0 : Math.round(usage?.pct ?? 0),
      by_feature: usage?.byFeature ?? [],
      history: days.map((day) => ({ day, pct: exempt ? 0 : (byDay.get(day) ?? 0) })),
      exempt,
    },
    activity: {
      streak: (streak.data as { current_length?: number } | null)?.current_length ?? 0,
      longest_streak: (streak.data as { longest_length?: number } | null)?.longest_length ?? 0,
      minutes_7d: week.reduce((sum, row) => sum + (row?.active_minutes ?? 0), 0),
      reviews_7d: week.reduce((sum, row) => sum + (row?.reviews ?? 0), 0),
      days: days.map((day) => ({ day, minutes: activityRows.get(day)?.active_minutes ?? 0, reviews: activityRows.get(day)?.reviews ?? 0 })),
    },
    class_groups: memberRows
      .filter((m) => groups.has(m.class_group_id))
      .map((m) => ({
        id: m.class_group_id,
        name: groups.get(m.class_group_id) ?? '',
        role: m.role,
        status: m.status,
        nickname: m.nickname,
        joined_at: m.joined_at,
        members: counts.get(m.class_group_id) ?? 0,
        league_opt_in: m.league_opt_in,
        accepts_duels: m.accepts_duels,
        contribute_insights: m.contribute_insights,
      })),
    devices: (devices.data as AccountOverview['devices'] | null) ?? [],
    exports: (exports.data as AccountOverview['exports'] | null) ?? [],
    deletion: del
      ? { ...del, completes_by: new Date(Date.parse(del.requested_at) + DELETION_DAYS * 86_400_000).toISOString() }
      : null,
  };
}

/** One student for the Administração pages, with the audit entries about them. Null-safe: unknown → 404. */
export async function loadAdminUserDetail(db: Db, userId: string): Promise<AdminUserDetail> {
  const [detail, log] = await Promise.all([
    db.schema('private').rpc('admin_user_detail', { p_user: userId }),
    db.schema('private').rpc('admin_audit_list', { p_limit: 20, p_before: null, p_target: userId }),
  ]);
  if (detail.error) throw detail.error;
  if (log.error) throw log.error;
  if (!detail.data) throw new ApiFailure('not_found');
  return { ...(detail.data as Omit<AdminUserDetail, 'audit'>), audit: (log.data as AdminAuditEntry[] | null) ?? [] };
}

/** Limits, feature flags, app versions and pilot invites (Configurações and Convites pages). */
export async function loadAdminSettings(db: Db, baseUrl: string | null): Promise<AdminSettings> {
  const [limits, flags, versions, invites] = await Promise.all([
    db.schema('private').rpc('admin_limits'),
    db.from('feature_flags').select('key, description, enabled_all, percentage, user_ids, class_group_ids, updated_at').order('key'),
    db.from('app_versions').select('version_code, version_name, runtime_version, released_at, blocks_older, notes_ptbr')
      .order('version_code', { ascending: false }).limit(20),
    db.from('invites').select('id, code, email, uses_left, expires_at, revoked_at, created_at')
      .is('class_group_id', null).order('created_at', { ascending: false }).limit(50),
  ]);
  for (const res of [limits, flags, versions, invites]) if (res.error) throw res.error;
  return {
    limits: limits.data as AdminSettings['limits'],
    flags: (flags.data as AdminSettings['flags'] | null) ?? [],
    versions: (versions.data as AdminSettings['versions'] | null) ?? [],
    invites: ((invites.data as Array<Omit<AdminSettings['invites'][number], 'link'>> | null) ?? []).map((i) => ({ ...i, link: inviteLink(baseUrl, i.code) })),
  };
}
