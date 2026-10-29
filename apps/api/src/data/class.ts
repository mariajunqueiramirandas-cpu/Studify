// Data endpoints of apps/mobile/src/features/class (define.ts explains the contract): Turmas, members, invites,
// moderation, shared subjects, insights, duels and battles lists, the review queue (api.ts), and the phase 5 Turma
// features — Dividir e conquistar, Perguntas da turma and Ligas semanais (turma5.ts).
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import type { DbResult } from '@studify/db';
import { dataRoute, count, dbFailure, done, maybe, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();

const MembershipPatch = z
  .object({
    nickname: z.string().trim().max(30).nullable().optional(),
    contribute_insights: z.boolean().optional(),
    accepts_duels: z.boolean().optional(),
    league_opt_in: z.boolean().optional(),
  })
  .strict();

const GroupPatch = z
  .object({
    name: z.string().trim().min(2).max(60).optional(),
    join_policy: z.enum(['approval', 'open']).optional(),
    allow_member_uploads: z.boolean().optional(),
    settings: z
      .object({ battles_host: z.enum(['anyone', 'owner_mods']).optional(), duels_enabled: z.boolean().optional() })
      .passthrough()
      .optional(),
  })
  .strict();

/**
 * An RPC's result, like `done`, for the Turma functions that raise plain SQLSTATEs or bare words the shared mapping
 * does not know: no_data_found (P0002, "divisão not found") is not_found; a refused state change (P0001 words such as
 * invalid_state or owner_must_transfer, 55000 "not open", 54000 "claim limit reached") is invalid_request.
 */
async function rpc<T = unknown>(query: PromiseLike<DbResult<any>>, fn: string): Promise<T> {
  const res = await query;
  if (!res.error) return res.data as T;
  const failure = dbFailure(res.error, fn);
  if (failure instanceof ApiFailure) throw failure;
  if (res.error.code === 'P0002') throw new ApiFailure('not_found');
  if (res.error.code === 'P0001' || res.error.code === '55000' || res.error.code === '54000') throw new ApiFailure('invalid_request');
  throw failure;
}

/** Drops the keys the app left out, so an update touches only the columns it named. */
function defined(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
}

const classRoutes: DataRoute[] = [
  dataRoute({
    name: 'class-groups',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: async ({ db, user }) => {
      const mine = await rows<{ class_group_id: string }>(
        db.from('class_group_members').select('*').eq('user_id', user.userId).in('status', ['active', 'pending']),
      );
      if (!mine.length) return [];
      const groups = await rows<{ id: string }>(
        db.from('class_groups').select('*').in('id', mine.map((m) => m.class_group_id)).is('deleted_at', null),
      );
      return groups.map((g) => ({ ...g, membership: mine.find((m) => m.class_group_id === g.id)! }));
    },
  }),

  dataRoute({
    name: 'class-get',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: async ({ db, user, input }) => {
      const [group, me] = await Promise.all([
        maybe(db.from('class_groups').select('*').eq('id', input.class_group_id).maybeSingle()),
        maybe(db.from('class_group_members').select('*').eq('class_group_id', input.class_group_id).eq('user_id', user.userId).maybeSingle()),
      ]);
      return { group, me };
    },
  }),

  dataRoute({
    name: 'class-members',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    // The app filtered class_group_members_public by status in ('active','pending'), but that view has no status
    // column (it lists active members only), so the query always failed. Active members come from the view; pending
    // requests from class_group_members, which RLS shows to the Turma's owner and moderators (and a student's own row).
    run: async ({ db, input }) => {
      const [active, pending] = await Promise.all([
        rows<Record<string, unknown>>(db.from('class_group_members_public').select('*').eq('class_group_id', input.class_group_id)),
        rows<Record<string, unknown>>(
          db.from('class_group_members').select('class_group_id,user_id,role,status,nickname').eq('class_group_id', input.class_group_id).eq('status', 'pending'),
        ),
      ]);
      return [...active.map((m) => ({ ...m, status: 'active' })), ...pending.map((m) => ({ ...m, display_name: null, avatar_path: null }))];
    },
  }),

  dataRoute({
    name: 'class-requests-count',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: async ({ db, user }) => {
      const mods = await rows<{ class_group_id: string }>(
        db.from('class_group_members').select('class_group_id,role').eq('user_id', user.userId).eq('status', 'active').in('role', ['owner', 'moderator']),
      );
      if (!mods.length) return { count: 0 };
      const n = await count(
        db.from('class_group_members').select('user_id', { count: 'exact', head: true }).in('class_group_id', mods.map((m) => m.class_group_id)).eq('status', 'pending'),
      );
      return { count: n };
    },
  }),

  dataRoute({
    name: 'class-create',
    write: true,
    input: z.object({ name: z.string().trim().min(1).max(60), school: z.string().trim().max(120).nullable().optional(), school_year: z.string().trim().max(40).nullable().optional() }),
    // The name check (2 to 60 characters) is the table's, as before; the example is refused by it on purpose: a Turma
    // created here would outlive the seeded student (class_groups.owner_id has no cascade) and block its cleanup.
    example: () => ({ name: 'T', school: null, school_year: null }),
    run: ({ db, input }) =>
      rpc(db.rpc('create_class_group', { p_name: input.name, p_school: input.school || null, p_school_year: input.school_year || null }), 'create_class_group'),
  }),

  dataRoute({
    name: 'class-join',
    write: true,
    input: z.object({ code: z.string().trim().min(1).max(64) }),
    example: () => ({ code: 'ZZZZZZZZ' }),
    run: ({ db, input }) => rpc(db.rpc('join_class_group', { p_code: input.code }), 'join_class_group'),
  }),

  dataRoute({
    name: 'class-invite-rotate',
    write: true,
    input: z.object({ class_group_id: Id, expires_in_days: z.number().int().min(1).max(365) }),
    example: (seed) => ({ class_group_id: seed.classGroupId, expires_in_days: 14 }),
    run: ({ db, input }) =>
      rpc(db.rpc('rotate_invite', { p_class_group_id: input.class_group_id, p_expires_in_days: input.expires_in_days, p_uses_left: null }), 'rotate_invite'),
  }),

  dataRoute({
    name: 'class-moderate',
    write: true,
    input: z.object({ class_group_id: Id, user_id: Id, action: z.enum(['approve', 'reject', 'remove', 'ban', 'unban', 'promote', 'demote']) }),
    example: (seed) => ({ class_group_id: seed.classGroupId, user_id: seed.missingId, action: 'remove' }),
    run: async ({ db, input }) => {
      await rpc(db.rpc('moderate_member', { p_class_group_id: input.class_group_id, p_user_id: input.user_id, p_action: input.action }), 'moderate_member');
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'class-leave',
    write: true,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.missingId }),
    run: async ({ db, input }) => {
      await rpc(db.rpc('leave_class_group', { p_class_group_id: input.class_group_id }), 'leave_class_group');
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'class-delete',
    write: true,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.missingId }),
    run: async ({ db, input }) => {
      await rpc(db.rpc('delete_class_group', { p_class_group_id: input.class_group_id }), 'delete_class_group');
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'class-subject-create',
    write: true,
    input: z.object({ class_group_id: Id, name: z.string().trim().min(1).max(80), color: z.string().regex(/^#[0-9a-fA-F]{6}$/), icon: z.string().min(1).max(40) }),
    example: (seed) => ({ class_group_id: seed.missingId, name: 'Química', color: '#4f46e5', icon: 'flask' }),
    run: async ({ db, input }) => {
      const id = await rpc<string>(db.rpc('create_shared_subject', { p_class_group_id: input.class_group_id, p_name: input.name, p_color: input.color, p_icon: input.icon }),
        'create_shared_subject',
      );
      return { id };
    },
  }),

  dataRoute({
    name: 'class-block-user',
    write: true,
    input: z.object({ user_id: Id }),
    example: (seed) => ({ user_id: seed.missingId }),
    run: async ({ db, input }) => {
      await rpc(db.rpc('block_user', { p_user_id: input.user_id }), 'block_user');
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'class-invite',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: ({ db, input }) =>
      maybe(
        db.from('invites').select('code,expires_at').eq('class_group_id', input.class_group_id).is('revoked_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ),
  }),

  dataRoute({
    name: 'class-membership-update',
    write: true,
    input: z.object({ class_group_id: Id, patch: MembershipPatch }),
    example: (seed) => ({ class_group_id: seed.classGroupId, patch: { accepts_duels: true } }),
    run: async ({ db, user, input }) => {
      const patch = defined(input.patch);
      if (Object.keys(patch).length > 0) {
        await done(db.from('class_group_members').update(patch).eq('class_group_id', input.class_group_id).eq('user_id', user.userId));
      }
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'class-update',
    write: true,
    input: z.object({ class_group_id: Id, patch: GroupPatch }),
    example: (seed) => ({ class_group_id: seed.classGroupId, patch: { name: 'Turma A' } }),
    run: async ({ db, input }) => {
      const patch = defined(input.patch);
      if (Object.keys(patch).length > 0) await done(db.from('class_groups').update(patch).eq('id', input.class_group_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'class-subjects',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: ({ db, input }) => rows(db.from('subjects').select('id,name,color,icon').eq('owner_class_group_id', input.class_group_id).is('deleted_at', null)),
  }),

  dataRoute({
    name: 'class-insights',
    write: false,
    input: z.object({ class_group_id: Id, subject_id: Id.nullable().optional() }),
    example: (seed) => ({ class_group_id: seed.classGroupId, subject_id: null }),
    run: ({ db, input }) =>
      rpc(db.rpc('class_insights_for', { p_class_group_id: input.class_group_id, p_subject_id: input.subject_id ?? null }), 'class_insights_for'),
  }),

  dataRoute({
    name: 'class-duels',
    write: false,
    input: z.object({ class_group_id: Id.optional() }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: ({ db, user, input }) => {
      let q = db
        .from('duels')
        .select('*')
        .or(`challenger_id.eq.${user.userId},opponent_id.eq.${user.userId}`)
        .order('created_at', { ascending: false })
        .limit(30);
      if (input.class_group_id) q = q.eq('class_group_id', input.class_group_id);
      return rows(q);
    },
  }),

  dataRoute({
    name: 'class-duel-get',
    write: false,
    input: z.object({ duel_id: Id }),
    example: (seed) => ({ duel_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('duels').select('*').eq('id', input.duel_id).maybeSingle()),
  }),

  dataRoute({
    name: 'class-battles-live',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: ({ db, input }) =>
      rows(db.from('battles').select('*').eq('class_group_id', input.class_group_id).in('status', ['lobby', 'question_open', 'question_closed', 'reveal'])),
  }),

  dataRoute({
    name: 'class-flags',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: ({ db, input }) =>
      rows(db.from('content_flags').select('*').eq('class_group_id', input.class_group_id).in('status', ['open', 'triaged', 'hidden_pending']).order('created_at')),
  }),

  dataRoute<{ flag_id: string; decision: 'accept' | 'reject' | 'remove'; fix?: unknown }>({
    name: 'class-flag-resolve',
    write: true,
    input: z.object({ flag_id: Id, decision: z.enum(['accept', 'reject', 'remove']), fix: z.unknown().optional() }),
    example: (seed) => ({ flag_id: seed.missingId, decision: 'reject' }),
    run: async ({ db, input }) => {
      await rpc(db.rpc('resolve_flag', { p_flag_id: input.flag_id, p_decision: input.decision, p_fix: input.fix ?? null }), 'resolve_flag');
      return { ok: true };
    },
  }),
];

// ---------------------------------------------------------------- Phase 5 (turma5.ts)

const turmaRoutes: DataRoute[] = [
  dataRoute({
    name: 'turma-divide-plans',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: ({ db, input }) =>
      rows(db.from('divide_plans').select('*').eq('class_group_id', input.class_group_id).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(30)),
  }),

  dataRoute({
    name: 'turma-divide-plan',
    write: false,
    input: z.object({ plan_id: Id }),
    example: (seed) => ({ plan_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('divide_plans').select('*').eq('id', input.plan_id).maybeSingle()),
  }),

  dataRoute({
    name: 'turma-divide-progress',
    write: false,
    input: z.object({ plan_id: Id }),
    example: (seed) => ({ plan_id: seed.missingId }),
    run: async ({ db, input }) => (await rpc<unknown[] | null>(db.rpc('divide_progress', { p_plan: input.plan_id }), 'divide_progress')) ?? [],
  }),

  dataRoute({
    name: 'turma-subject-topics',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: ({ db, input }) =>
      rows(db.from('knowledge_nodes').select('id,title,parent_id,position').eq('subject_id', input.subject_id).eq('kind', 'topic').is('deleted_at', null).order('position')),
  }),

  dataRoute({
    name: 'turma-divide-create',
    write: true,
    input: z.object({
      id: Id,
      class_group_id: Id,
      subject_id: Id,
      title: z.string().trim().min(1).max(80),
      node_ids: z.array(Id).min(1).max(60),
      max_claims: z.number().int().min(1).max(10),
    }),
    example: (seed) => ({ id: crypto.randomUUID(), class_group_id: seed.classGroupId, subject_id: seed.subjectId, title: 'Prova 1', node_ids: [seed.nodeId], max_claims: 3 }),
    run: async ({ db, user, input }) => {
      await done(
        db.from('divide_plans').insert({
          id: input.id,
          class_group_id: input.class_group_id,
          subject_id: input.subject_id,
          title: input.title,
          node_ids: input.node_ids,
          max_claims: input.max_claims,
          created_by: user.userId,
        }),
      );
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'turma-divide-claim',
    write: true,
    input: z.object({ plan_id: Id, node_id: Id, claim: z.boolean() }),
    example: (seed) => ({ plan_id: seed.missingId, node_id: seed.nodeId, claim: true }),
    run: async ({ db, input }) => {
      await rpc(db.rpc('claim_divide_topic', { p_plan: input.plan_id, p_node: input.node_id, p_claim: input.claim }), 'claim_divide_topic');
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'turma-divide-cancel',
    write: true,
    input: z.object({ plan_id: Id }),
    example: (seed) => ({ plan_id: seed.missingId }),
    run: async ({ db, input }) => {
      await done(db.from('divide_plans').update({ status: 'cancelled' }).eq('id', input.plan_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'turma-contribution-mine',
    write: false,
    input: z.object({ plan_id: Id, node_id: Id }),
    example: (seed) => ({ plan_id: seed.missingId, node_id: seed.nodeId }),
    run: ({ db, user, input }) =>
      maybe(db.from('contributions').select('*').eq('divide_plan_id', input.plan_id).eq('node_id', input.node_id).eq('author_id', user.userId).maybeSingle()),
  }),

  dataRoute({
    name: 'turma-contribution-create',
    write: true,
    input: z.object({ id: Id, plan_id: Id, node_id: Id, body: z.string().max(20000) }),
    example: (seed) => ({ id: crypto.randomUUID(), plan_id: seed.missingId, node_id: seed.nodeId, body: 'Resumo' }),
    run: async ({ db, user, input }) => {
      await done(db.from('contributions').insert({ id: input.id, divide_plan_id: input.plan_id, node_id: input.node_id, author_id: user.userId, body_md: input.body }));
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'turma-contribution-update',
    write: true,
    input: z.object({ id: Id, body: z.string().max(20000) }),
    example: (seed) => ({ id: seed.missingId, body: 'Resumo' }),
    run: async ({ db, input }) => {
      await done(db.from('contributions').update({ body_md: input.body }).eq('id', input.id));
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'turma-contribution-append',
    write: true,
    input: z.object({ id: Id, text: z.string().max(20000) }),
    example: (seed) => ({ id: seed.missingId, text: 'Transcrição' }),
    run: async ({ db, input }) => {
      const current = await maybe<{ body_md: string }>(db.from('contributions').select('body_md').eq('id', input.id).maybeSingle());
      const body = [current?.body_md?.trim(), input.text].filter(Boolean).join('\n\n').slice(0, 20000);
      await done(db.from('contributions').update({ body_md: body }).eq('id', input.id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'turma-class-summary',
    write: false,
    input: z.object({ node_id: Id, class_group_id: Id }),
    example: (seed) => ({ node_id: seed.nodeId, class_group_id: seed.classGroupId }),
    run: async ({ db, input }) => {
      const note = await maybe<{ id: string; body: string; citations: unknown; contributors: string[] }>(
        db.from('notes').select('id,body,citations,contributors').eq('node_id', input.node_id).eq('depth', 'class_summary').eq('status', 'ready').is('deleted_at', null).maybeSingle(),
      );
      if (!note) return null;
      const names = note.contributors.length
        ? await rows<{ user_id: string; nickname: string | null; display_name: string | null }>(
            db.from('class_group_members_public').select('user_id,nickname,display_name').eq('class_group_id', input.class_group_id).in('user_id', note.contributors),
          )
        : [];
      return { note, names };
    },
  }),

  dataRoute({
    name: 'turma-peer-questions',
    write: false,
    input: z.object({ subject_ids: z.array(Id).max(200) }),
    example: (seed) => ({ subject_ids: [seed.subjectId] }),
    run: async ({ db, input }) => {
      if (input.subject_ids.length === 0) return { list: [], voted: [] };
      const list = await rows<{ id: string }>(
        db
          .from('questions')
          .select('id,subject_id,node_id,type,stem,payload,explanation,author_id,author_anonymous,review_status,created_at')
          .in('subject_id', input.subject_ids)
          .eq('origin', 'peer')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(100),
      );
      // question_votes is readable only for the student's own votes (RLS), as when the app read it directly.
      const votes = list.length ? await rows<{ question_id: string }>(db.from('question_votes').select('question_id').in('question_id', list.map((q) => q.id))) : [];
      return { list, voted: votes.map((v) => v.question_id) };
    },
  }),

  dataRoute({
    name: 'turma-peer-vote',
    write: true,
    input: z.object({ question_id: Id }),
    example: (seed) => ({ question_id: seed.missingId }),
    run: async ({ db, input }) => ({ result: await rpc<string>(db.rpc('vote_peer_question', { p_question: input.question_id }), 'vote_peer_question') }),
  }),

  dataRoute({
    name: 'turma-peer-review',
    write: true,
    input: z.object({ question_id: Id, approve: z.boolean() }),
    example: (seed) => ({ question_id: seed.missingId, approve: true }),
    run: async ({ db, input }) => ({
      result: await rpc<string>(db.rpc('review_peer_question', { p_question: input.question_id, p_approve: input.approve }), 'review_peer_question'),
    }),
  }),

  dataRoute<{ class_group_id: string; week?: string }>({
    name: 'turma-league-board',
    write: false,
    input: z.object({ class_group_id: Id, week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    // league_board refuses (42501, "join the league first") a student who has not opted in; the app only asks once
    // opted in and shows the empty board when the read fails, so that refusal is answered as an empty board.
    run: async ({ db, input }) => {
      try {
        return (await rpc<unknown[] | null>(db.rpc('league_board', { p_group: input.class_group_id, ...(input.week ? { p_week: input.week } : {}) }), 'league_board')) ?? [];
      } catch (e) {
        if (e instanceof ApiFailure && e.code === 'forbidden') return [];
        throw e;
      }
    },
  }),

  dataRoute({
    name: 'turma-league-weeks',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: ({ db, user, input }) =>
      rows(
        db
          .from('league_entries')
          .select('week_start,league_xp,rank,badges')
          .eq('class_group_id', input.class_group_id)
          .eq('user_id', user.userId)
          .order('week_start', { ascending: false })
          .limit(12),
      ),
  }),
];

export const routes: DataRoute[] = [...classRoutes, ...turmaRoutes];
