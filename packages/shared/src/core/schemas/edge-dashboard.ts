// Web dashboard payloads (apps/dashboard, served at /painel; api.md §4.11). "Minha conta" calls work for every
// student with a profile; "Administração" calls answer 403 unless the caller is the owner (app_admin).
// Requests are validated by the functions. Responses are plain interfaces: the dashboard imports them as types only.
import { z } from 'zod';
import { FOREIGN_LANGUAGE, SCHOOL_YEAR, type NotificationChannel, type SchoolYear } from '../enums.ts';
import { TimeOfDaySchema, UuidSchema } from './common.ts';

/** Largest limit the dashboard accepts: $10,000 in micro-USD. Bigger numbers are typos. */
const MicroUsdLimitSchema = z.int().min(0).max(10_000_000_000);

// ================================================================ Minha conta

/** account-update: any subset of the editable profile, preferences and quiet hours. */
export const AccountUpdateReqSchema = z
  .object({
    display_name: z.string().trim().min(2).max(30),
    school_year: z.enum(SCHOOL_YEAR).nullable(),
    timezone: z.string().min(1).max(64),
    foreign_language: z.enum(FOREIGN_LANGUAGE).nullable(),
    theme: z.enum(['system', 'light', 'dark']),
    notifications: z.object({ reviews: z.boolean(), plan: z.boolean(), class: z.boolean(), processing: z.boolean() }).partial(),
    quiet_start: TimeOfDaySchema,
    quiet_end: TimeOfDaySchema,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type AccountUpdateReq = z.infer<typeof AccountUpdateReqSchema>;

/** account-membership: leave a Turma, or change the member's own choices in it. */
export const AccountMembershipReqSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('leave'), class_group_id: UuidSchema }),
  z.object({
    action: z.literal('update'),
    class_group_id: UuidSchema,
    league_opt_in: z.boolean().optional(),
    accepts_duels: z.boolean().optional(),
    contribute_insights: z.boolean().optional(),
  }),
]);
export type AccountMembershipReq = z.infer<typeof AccountMembershipReqSchema>;

/** account-device-remove: stop notifications to one device (its push token is invalidated). */
export const AccountDeviceRemoveReqSchema = z.object({ device_id: z.string().min(1).max(200) });

/** account-export-link: a short-lived download link for a ready export. */
export const AccountExportLinkReqSchema = z.object({ export_id: UuidSchema });

export interface AccountOverview {
  profile: {
    id: string;
    email: string | null;
    display_name: string;
    display_name_status: 'pending' | 'approved' | 'rejected';
    avatar_preset: string | null;
    school_year: SchoolYear | null;
    timezone: string;
    foreign_language: 'en' | 'es' | null;
    app_role: 'user' | 'app_admin';
    is_minor: boolean;
    privacy_notice_version: string;
    privacy_accepted_at: string;
    created_at: string;
  };
  settings: { theme: 'system' | 'light' | 'dark'; notifications: Record<NotificationChannel, boolean> };
  /** HH:mm, in the student's timezone. */
  quiet_hours: { start: string; end: string };
  /** Percentages of the daily limit only: money is never shown to students (PLT-04.2). */
  ai_usage: { today_pct: number; by_feature: Array<{ feature: string; pct: number }>; history: Array<{ day: string; pct: number }>; exempt: boolean };
  activity: { streak: number; longest_streak: number; minutes_7d: number; reviews_7d: number; days: Array<{ day: string; minutes: number; reviews: number }> };
  class_groups: Array<{
    id: string;
    name: string;
    role: 'owner' | 'moderator' | 'member';
    status: 'pending' | 'active';
    nickname: string | null;
    joined_at: string | null;
    members: number;
    league_opt_in: boolean;
    accepts_duels: boolean;
    contribute_insights: boolean;
  }>;
  devices: Array<{ device_id: string; platform: string; app_version: string | null; last_seen_at: string; created_at: string }>;
  exports: Array<{ id: string; status: 'queued' | 'running' | 'ready' | 'failed' | 'expired'; created_at: string; completed_at: string | null; expires_at: string | null }>;
  deletion: { id: string; status: 'pending' | 'running' | 'failed'; requested_at: string; completes_by: string } | null;
}

// ================================================================ Administração

export const ADMIN_USER_FILTERS = ['all', 'admins', 'pending_names', 'suspended', 'minors', 'deleting'] as const;
export type AdminUserFilter = (typeof ADMIN_USER_FILTERS)[number];

export const AdminAiUsageReqSchema = z.object({ days: z.int().min(1).max(366).default(30) });

export const AdminUsersReqSchema = z.object({
  query: z.string().max(120).optional(),
  filter: z.enum(ADMIN_USER_FILTERS).default('all'),
  limit: z.int().min(1).max(100).default(25),
  offset: z.int().min(0).max(100_000).default(0),
});
export type AdminUsersReq = z.infer<typeof AdminUsersReqSchema>;

export const AdminUserReqSchema = z.object({ user_id: UuidSchema });

export const AdminUserControlReqSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_role'), user_id: UuidSchema, role: z.enum(['user', 'app_admin']) }),
  z.object({ action: z.literal('approve_name'), user_id: UuidSchema }),
  z.object({ action: z.literal('reject_name'), user_id: UuidSchema }),
  /** days null: until lifted. */
  z.object({ action: z.literal('suspend'), user_id: UuidSchema, days: z.int().min(1).max(3650).nullable(), reason: z.string().trim().min(3).max(500) }),
  z.object({ action: z.literal('unsuspend'), user_id: UuidSchema }),
  /** limit null: back to the default. */
  z.object({ action: z.literal('set_daily_limit'), user_id: UuidSchema, limit_micro_usd: MicroUsdLimitSchema.nullable() }),
]);
export type AdminUserControlReq = z.infer<typeof AdminUserControlReqSchema>;

export const AdminClassGroupControlReqSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_budget'), class_group_id: UuidSchema, limit_micro_usd: MicroUsdLimitSchema.nullable() }),
]);
export type AdminClassGroupControlReq = z.infer<typeof AdminClassGroupControlReqSchema>;

export const AdminModerationControlReqSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('report'), report_id: UuidSchema, decision: z.enum(['actioned', 'dismissed', 'escalated']), note: z.string().trim().max(500).optional() }),
  z.object({ action: z.literal('flag'), flag_id: UuidSchema, decision: z.enum(['accept', 'reject', 'remove']) }),
]);
export type AdminModerationControlReq = z.infer<typeof AdminModerationControlReqSchema>;

export const AdminSettingsControlReqSchema = z.discriminatedUnion('action', [
  /** Each limit: omitted = unchanged, null = back to the built-in placeholder. */
  z.object({
    action: z.literal('set_limits'),
    user_day_micro_usd: MicroUsdLimitSchema.nullable().optional(),
    class_group_month_micro_usd: MicroUsdLimitSchema.nullable().optional(),
    global_month_micro_usd: MicroUsdLimitSchema.nullable().optional(),
  }),
  z.object({
    action: z.literal('flag_upsert'),
    key: z.string().regex(/^[a-z][a-z0-9_]*$/).max(60),
    description: z.string().max(200).optional(),
    enabled_all: z.boolean().optional(),
    percentage: z.int().min(0).max(100).optional(),
  }),
  z.object({ action: z.literal('version_block'), version_code: z.int().positive(), blocks_older: z.boolean() }),
  z.object({
    action: z.literal('invite_create'),
    email: z.email().max(254).nullable().optional(),
    uses: z.int().min(1).max(100).default(1),
    expires_in_days: z.int().min(1).max(60).default(14),
  }),
  z.object({ action: z.literal('invite_revoke'), invite_id: UuidSchema }),
]);
export type AdminSettingsControlReq = z.infer<typeof AdminSettingsControlReqSchema>;

export const AdminAuditReqSchema = z.object({
  limit: z.int().min(1).max(200).default(50),
  /** The created_at of the last entry shown, as the API sent it (Postgres writes "+00:00", not "Z"). */
  before: z.iso.datetime({ offset: true }).optional(),
});

// ---------------------------------------------------------------- admin responses (micro-USD throughout)

export interface DayCost { day: string; cost: number; calls: number }

export interface AdminOverview {
  users: { total: number; new_7d: number; active_7d: number; admins: number; pending_names: number; suspended: number };
  series: Array<DayCost & { signups: number; active: number }>;
  spend: {
    today: number;
    month: number;
    cap_used: number | null;
    cap: number;
    month_start: string;
    today_date: string;
    top_features: Array<{ feature: string; cost: number; calls: number }>;
    top_class_groups: Array<{ id: string; name: string; cost: number; calls: number }>;
    outliers_today: Array<{ id: string; display_name: string; cost: number; median: number }>;
  };
  moderation: { open_reports: number; escalated_reports: number; open_flags: number; pending_names: number; feedback_7d: number };
  ops: {
    failed_jobs_24h: number;
    running_jobs: number;
    waiting_budget_jobs: number;
    pending_deletions: number;
    failed_deletions: number;
    open_exports: number;
    recent_failures: Array<{ id: string; type: string; stage: string | null; error_code: string | null; user_id: string | null; display_name: string | null; updated_at: string }>;
  };
  generated_at: string;
  server: { version: string; started_at: string };
}

export interface AdminAiReport {
  days: number;
  from: string;
  to: string;
  totals: {
    cost: number;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    refusals: number;
    fallbacks: number;
    batch_calls: number;
    users: number;
    p50_ms: number | null;
    p95_ms: number | null;
  };
  by_day: DayCost[];
  by_feature: Array<{ feature: string; cost: number; calls: number; refusals: number; p50_ms: number | null; p95_ms: number | null; cache_ratio: number | null }>;
  by_task: Array<{ task: string; feature: string; cost: number; calls: number; p50_ms: number | null; p95_ms: number | null }>;
  by_model: Array<{ model: string; cost: number; calls: number }>;
  by_class_group: Array<{ id: string; name: string; cost: number; calls: number }>;
  personal_cost: number;
  top_users: Array<{ id: string; display_name: string | null; app_role: string | null; cost: number; calls: number }>;
  refusals_by_category: Array<{ category: string; calls: number }>;
}

export interface AdminUserRow {
  id: string;
  display_name: string;
  display_name_status: 'pending' | 'approved' | 'rejected';
  app_role: 'user' | 'app_admin';
  school_year: SchoolYear | null;
  created_at: string;
  deleted_at: string | null;
  email: string | null;
  last_sign_in_at: string | null;
  banned_until: string | null;
  is_minor: boolean;
  last_active_date: string | null;
  cost_30d: number;
  class_groups: number;
  deletion_pending: boolean;
}

export interface AdminUserList { total: number; limit: number; offset: number; rows: AdminUserRow[] }

export interface AdminAuditEntry {
  id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
  actor_id: string | null;
  actor_name: string | null;
}

export interface AdminUserDetail {
  profile: {
    id: string;
    display_name: string;
    display_name_status: 'pending' | 'approved' | 'rejected';
    avatar_preset: string | null;
    school_year: SchoolYear | null;
    timezone: string;
    app_role: 'user' | 'app_admin';
    birth_year: number;
    birth_month: number;
    is_minor: boolean;
    privacy_notice_version: string;
    privacy_accepted_at: string;
    onboarding_completed_at: string | null;
    created_at: string;
    updated_at: string;
    deleted_at: string | null;
  };
  auth: { email: string | null; created_at: string; last_sign_in_at: string | null; banned_until: string | null } | null;
  class_groups: Array<{ id: string; name: string; role: string; status: string; joined_at: string | null }>;
  devices: Array<{ device_id: string; platform: string; app_version: string | null; last_seen_at: string; invalidated_at: string | null }>;
  spend: { today: number; d30: number; by_day: Array<{ day: string; cost: number }>; by_feature: Array<{ feature: string; cost: number; calls: number }> };
  limit: { effective: number; override: number | null; exempt: boolean };
  activity: { streak: number | null; longest_streak: number | null; last_active_date: string | null; minutes_7d: number; reviews_7d: number; subjects: number; documents: number };
  jobs: Array<{ id: string; type: string; stage: string | null; status: string; error_code: string | null; created_at: string; finished_at: string | null }>;
  reports: { made: number; received: number; open_received: number };
  exports: Array<{ id: string; status: string; created_at: string; completed_at: string | null; expires_at: string | null }>;
  deletion: { id: string; status: string; requested_by: string; requested_at: string; completed_at: string | null } | null;
  audit: AdminAuditEntry[];
}

export interface AdminClassGroupRow {
  id: string;
  name: string;
  school: string | null;
  school_year: string | null;
  join_policy: 'approval' | 'open';
  member_cap: number;
  allow_member_uploads: boolean;
  created_at: string;
  owner_id: string;
  owner_name: string | null;
  members: number;
  pending: number;
  subjects: number;
  budget_override: number | null;
  budget_limit: number;
  cost_month: number;
  open_reports: number;
}

export interface AdminClassGroups { class_groups: AdminClassGroupRow[]; default_limit: number }

export interface AdminModerationQueue {
  reports: Array<{
    id: string;
    reason: string;
    context_type: string | null;
    context_id: string | null;
    comment: string | null;
    status: 'open' | 'escalated';
    created_at: string;
    class_group_id: string | null;
    class_group_name: string | null;
    reporter_id: string;
    reporter_name: string | null;
    reported_id: string | null;
    reported_name: string | null;
    reported_name_status: string | null;
  }>;
  flags: Array<{
    id: string;
    item_type: string;
    item_id: string;
    reason: string;
    comment: string | null;
    status: string;
    created_at: string;
    ai_verdict: 'confirmed' | 'rejected' | 'unsure' | null;
    ai_confidence: 'low' | 'medium' | 'high' | null;
    ai_explanation: string | null;
    class_group_id: string | null;
    class_group_name: string | null;
    reporter_id: string;
    reporter_name: string | null;
  }>;
  pending_names: Array<{ id: string; display_name: string; created_at: string; updated_at: string }>;
  feedback: Array<{ id: string; text: string; app_version: string | null; device_model: string | null; created_at: string; user_id: string; display_name: string | null }>;
}

export interface AdminLimit { effective: number; configured: number | null; builtin: number }

export interface AdminSettings {
  limits: { user_day: AdminLimit; class_group_month: AdminLimit; global_month: AdminLimit; user_overrides: number };
  flags: Array<{ key: string; description: string; enabled_all: boolean; percentage: number; user_ids: string[]; class_group_ids: string[]; updated_at: string }>;
  versions: Array<{ version_code: number; version_name: string; runtime_version: string; released_at: string; blocks_older: boolean; notes_ptbr: string }>;
  invites: Array<{ id: string; code: string; email: string | null; uses_left: number | null; expires_at: string; revoked_at: string | null; created_at: string; link: string }>;
}
