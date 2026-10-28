// Postgres RPC functions used in Phases 0–2 (api.md §5). Each entry is the args and result schema of
// one `supabase.rpc(name, args)` call. Functions returning `void` resolve to `null` through PostgREST.
// Invariant failures raise P0001 with a HINT naming the error code (see errorCodeFromHint).
import { z } from 'zod';
import { NODE_KIND } from '../enums.ts';
import { InviteCodeSchema, IsoInstantSchema, UuidSchema } from './common.ts';
import { SYNC_MIRROR_TABLES } from './sync.ts';
import { TopicGroupSchema, TopicGroupsSchema } from './jsonb.ts';

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'expected #RRGGBB');
const nullResult = z.null();
const unitPercent = z.number().min(0).max(100);

// ---------------------------------------------------------------- platform and Turma (SOC-01, PLT-02/04)

export const MEMBER_MODERATION_ACTION = z.enum(['approve', 'reject', 'remove', 'ban', 'unban', 'promote', 'demote']);

/** Outline operations for `edit_outline` (ING-04). Each op is validated on its own. */
export const OutlineOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('rename'), node_id: UuidSchema, title: z.string().min(1).max(200) }),
  z.object({
    op: z.literal('move'),
    node_id: UuidSchema,
    parent_id: UuidSchema,
    position: z.int().min(0).optional(),
  }),
  z.object({ op: z.literal('reorder'), node_id: UuidSchema, position: z.int().min(0) }),
  z.object({
    op: z.literal('merge'),
    node_ids: z.array(UuidSchema).min(2),
    title: z.string().min(1).max(200),
  }),
  z.object({ op: z.literal('split'), node_id: UuidSchema, titles: z.array(z.string().min(1)).min(2) }),
  z.object({ op: z.literal('delete'), node_id: UuidSchema }),
  z.object({ op: z.literal('restore'), node_id: UuidSchema }),
  z.object({
    op: z.literal('create'),
    kind: z.enum(NODE_KIND),
    parent_id: UuidSchema.optional(),
    title: z.string().min(1).max(200),
  }),
]);
export type OutlineOp = z.infer<typeof OutlineOpSchema>;

// ---------------------------------------------------------------- registry

export const RPC_SCHEMAS = {
  my_feature_flags: {
    args: z.object({}),
    result: z.array(z.string()),
  },
  create_class_group: {
    args: z.object({
      name: z.string().min(2).max(60),
      school: z.string().optional(),
      school_year: z.string().optional(),
    }),
    result: z.object({ class_group_id: UuidSchema, invite_code: InviteCodeSchema }),
  },
  join_class_group: {
    args: z.object({ code: InviteCodeSchema }),
    result: z.object({ class_group_id: UuidSchema, status: z.enum(['active', 'pending']) }),
  },
  rotate_invite: {
    args: z.object({
      class_group_id: UuidSchema,
      expires_in_days: z.int().min(1).max(30).optional(),
      uses_left: z.int().min(1).nullable().optional(),
    }),
    result: z.object({ invite_code: InviteCodeSchema, expires_at: IsoInstantSchema }),
  },
  moderate_member: {
    args: z.object({
      class_group_id: UuidSchema,
      user_id: UuidSchema,
      action: MEMBER_MODERATION_ACTION,
    }),
    result: nullResult,
  },
  leave_class_group: {
    args: z.object({ class_group_id: UuidSchema }),
    result: nullResult,
  },
  delete_class_group: {
    args: z.object({ class_group_id: UuidSchema }),
    result: nullResult,
  },
  create_shared_subject: {
    args: z.object({
      class_group_id: UuidSchema,
      name: z.string().min(1).max(60),
      color: hexColor,
      icon: z.string().min(1),
    }),
    result: UuidSchema,
  },
  share_subject: {
    args: z.object({
      subject_id: UuidSchema,
      class_group_id: UuidSchema,
      copyright_ack: z.boolean(), // security §11 upload confirmation
    }),
    result: nullResult,
  },

  // ------------------------------------------------------------ knowledge map and goals

  edit_outline: {
    args: z.object({ subject_id: UuidSchema, ops: z.array(OutlineOpSchema).min(1) }),
    result: z.object({ event_ids: z.array(UuidSchema), regenerate_node_ids: z.array(UuidSchema) }),
  },
  undo_outline_event: {
    args: z.object({ event_id: UuidSchema }),
    result: nullResult,
  },
  confirm_exam_scope: {
    args: z.object({
      exam_id: UuidSchema,
      node_ids: z.array(UuidSchema),
      default_all: z.boolean(),
    }),
    result: nullResult,
  },
  start_desperate_mode: {
    args: z.object({
      goal_id: UuidSchema,
      exam_ids: z.array(UuidSchema).min(1),
      minutes_per_day: z.int().min(60).max(240), // GOL-12
    }),
    result: z.object({ desperate_mode_id: UuidSchema, diagnostic_quiz_id: UuidSchema.optional() }),
  },
  set_desperate_groups: {
    args: z.object({
      desperate_mode_id: UuidSchema,
      moves: z.array(z.object({ node_id: UuidSchema, group: TopicGroupSchema })),
    }),
    result: z.object({
      topic_groups: TopicGroupsSchema,
      coverage: z.array(z.object({ exam_id: UuidSchema, pct: unitPercent })),
    }),
  },
  end_desperate_mode: {
    args: z.object({ desperate_mode_id: UuidSchema }),
    result: z.object({ ok: z.literal(true) }),
  },
  log_exam_grade: {
    args: z.object({
      exam_id: UuidSchema,
      grade: z.number().min(0),
      grade_max: z.number().positive(),
    }),
    result: z.object({
      required: z.array(
        z.object({
          exam_id: UuidSchema,
          needed: z.number(),
          status: z.enum(['secured', 'needed', 'impossible']),
        }),
      ),
    }),
  },
  apply_schedule_import: {
    args: z.object({ schedule_import_id: UuidSchema, goal_id: UuidSchema.optional() }),
    result: z.object({ goal_id: UuidSchema, exam_ids: z.array(UuidSchema) }),
  },

  // ------------------------------------------------------------ insights, budgets, moderation

  class_insights_for: {
    args: z.object({
      class_group_id: UuidSchema,
      subject_id: UuidSchema.optional(),
      node_id: UuidSchema.optional(),
    }),
    result: z.array(
      z.object({
        question_id: UuidSchema.optional(),
        node_id: UuidSchema.optional(),
        pct_wrong: unitPercent,
        n_bucket: z.string().min(1), // anonymity buckets, never raw counts (SOC-04)
        option_pcts: z.record(z.string(), unitPercent).optional(),
      }),
    ),
  },
  class_group_ai_usage: {
    args: z.object({
      class_group_id: UuidSchema,
      month: z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM'),
    }),
    result: z.object({
      spent_pct: unitPercent,
      by_feature: z.record(z.string(), z.number().min(0)),
    }),
  },
  resolve_flag: {
    args: z.object({
      flag_id: UuidSchema,
      decision: z.enum(['accept', 'reject', 'remove']),
      fix: z.unknown().optional(),
    }),
    result: nullResult,
  },
  handle_report: {
    args: z.object({
      report_id: UuidSchema,
      action: z.enum(['dismiss', 'warn', 'remove_content', 'remove_member', 'escalate']),
    }),
    result: nullResult,
  },
  block_user: {
    args: z.object({ user_id: UuidSchema }),
    result: nullResult,
  },
  unblock_user: {
    args: z.object({ user_id: UuidSchema }),
    result: nullResult,
  },
  sync_snapshot: {
    args: z.object({
      table: z.enum(SYNC_MIRROR_TABLES),
      subject_ids: z.array(UuidSchema),
    }),
    result: z.object({ url: z.url() }),
  },
} as const;

export type RpcName = keyof typeof RPC_SCHEMAS;

/** Args schema for an RPC by name. */
export function rpcArgsSchema<N extends RpcName>(name: N): (typeof RPC_SCHEMAS)[N]['args'] {
  return RPC_SCHEMAS[name].args;
}

/** Result schema for an RPC by name. */
export function rpcResultSchema<N extends RpcName>(name: N): (typeof RPC_SCHEMAS)[N]['result'] {
  return RPC_SCHEMAS[name].result;
}
