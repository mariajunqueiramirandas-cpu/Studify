import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { row, rows, rpc } from '../common/query';

export interface ClassGroup {
  id: string;
  name: string;
  owner_id: string;
  school: string | null;
  school_year: string | null;
  join_policy: 'approval' | 'open';
  member_cap: number;
  allow_member_uploads: boolean;
  settings: { battles_host?: 'anyone' | 'owner_mods'; duels_enabled?: boolean };
}

export interface Membership {
  class_group_id: string;
  user_id: string;
  role: 'owner' | 'moderator' | 'member';
  status: 'pending' | 'active' | 'removed' | 'banned' | 'left';
  nickname: string | null;
  contribute_insights: boolean;
  accepts_duels: boolean;
  league_opt_in: boolean;
}

export interface MemberPublic {
  class_group_id: string;
  user_id: string;
  role: Membership['role'];
  status: Membership['status'];
  nickname: string | null;
  display_name: string | null;
  avatar_preset: string | null;
}

export function useMyClassGroups() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['classGroups', userId],
    enabled: !!userId,
    queryFn: async () => {
      const mine = await rows<Membership>(supabase.from('class_group_members').select('*').eq('user_id', userId!).in('status', ['active', 'pending']));
      if (!mine.length) return [];
      const groups = await rows<ClassGroup>(supabase.from('class_groups').select('*').in('id', mine.map((m) => m.class_group_id)).is('deleted_at', null));
      return groups.map((g) => ({ ...g, membership: mine.find((m) => m.class_group_id === g.id)! }));
    },
  });
}

export function useClassGroup(classGroupId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['classGroup', classGroupId, userId],
    enabled: !!classGroupId && !!userId,
    queryFn: async () => {
      const [group, me] = await Promise.all([
        row<ClassGroup>(supabase.from('class_groups').select('*').eq('id', classGroupId!).maybeSingle()),
        row<Membership>(supabase.from('class_group_members').select('*').eq('class_group_id', classGroupId!).eq('user_id', userId!).maybeSingle()),
      ]);
      return { group, me, isMod: me?.role === 'owner' || me?.role === 'moderator' };
    },
  });
}

export function useMembers(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['classGroup', classGroupId, 'members'],
    enabled: !!classGroupId,
    queryFn: () => rows<MemberPublic>(supabase.from('class_group_members_public').select('*').eq('class_group_id', classGroupId!).in('status', ['active', 'pending'])),
  });
}

/** Badge dot on the Turma tab for pending join requests (owner/mods only see them via RLS). */
export function usePendingRequestsBadge(): number {
  const { userId } = useSession();
  const q = useQuery({
    queryKey: ['classRequests', userId],
    enabled: !!userId,
    refetchInterval: 120_000,
    queryFn: async () => {
      const mods = await rows<Membership>(supabase.from('class_group_members').select('class_group_id,role').eq('user_id', userId!).eq('status', 'active').in('role', ['owner', 'moderator']));
      if (!mods.length) return 0;
      const { count } = await supabase.from('class_group_members').select('user_id', { count: 'exact', head: true }).in('class_group_id', mods.map((m) => m.class_group_id)).eq('status', 'pending');
      return count ?? 0;
    },
  });
  return q.data ?? 0;
}

export const createClassGroup = (name: string, school?: string, schoolYear?: string) =>
  rpc<{ class_group_id: string; invite_code: string }>('create_class_group', { name, school: school || null, school_year: schoolYear || null });

export const joinClassGroup = (code: string) => rpc<{ class_group_id: string; status: 'active' | 'pending' }>('join_class_group', { code });

export const rotateInvite = (classGroupId: string, days = 14) => rpc<{ invite_code: string; expires_at: string }>('rotate_invite', { class_group_id: classGroupId, expires_in_days: days, uses_left: null });

export const moderateMember = (classGroupId: string, userId: string, action: 'approve' | 'reject' | 'remove' | 'ban' | 'unban' | 'promote' | 'demote') =>
  rpc<void>('moderate_member', { class_group_id: classGroupId, user_id: userId, action });

export const leaveClassGroup = (classGroupId: string) => rpc<void>('leave_class_group', { class_group_id: classGroupId });

/** SOC-01.15: owner only; the caller confirms by typing the Turma name. */
export const deleteClassGroup = (classGroupId: string) => rpc<void>('delete_class_group', { class_group_id: classGroupId });

export const createSharedSubject = (classGroupId: string, name: string, color: string, icon: string) => rpc<string>('create_shared_subject', { class_group_id: classGroupId, name, color, icon });

export const blockUser = (userId: string) => rpc<void>('block_user', { user_id: userId });

export function useInvite(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['classGroup', classGroupId, 'invite'],
    enabled: !!classGroupId,
    queryFn: () =>
      row<{ code: string; expires_at: string }>(
        supabase.from('invites').select('code,expires_at').eq('class_group_id', classGroupId!).is('revoked_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ),
  });
}

export async function updateMyMembership(classGroupId: string, userId: string, patch: Partial<Pick<Membership, 'nickname' | 'contribute_insights' | 'accepts_duels' | 'league_opt_in'>>) {
  const { error } = await supabase.from('class_group_members').update(patch).eq('class_group_id', classGroupId).eq('user_id', userId);
  if (error) throw error;
}

export async function updateClassGroup(classGroupId: string, patch: Partial<Pick<ClassGroup, 'name' | 'join_policy' | 'allow_member_uploads' | 'settings'>>) {
  const { error } = await supabase.from('class_groups').update(patch).eq('id', classGroupId);
  if (error) throw error;
}

export function useClassSubjects(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['classGroup', classGroupId, 'subjects'],
    enabled: !!classGroupId,
    queryFn: () => rows<{ id: string; name: string; color: string; icon: string }>(supabase.from('subjects').select('id,name,color,icon').eq('owner_class_group_id', classGroupId!).is('deleted_at', null)),
  });
}

export interface ClassInsight {
  question_id: string | null;
  node_id: string | null;
  pct_wrong: number;
  n_bucket: string;
  option_pcts: Record<string, number> | null;
}

/** SOC-04: anonymized aggregates through the k-anonymity RPC only (k ≥ 5). */
export function useClassInsights(classGroupId: string | undefined, subjectId?: string) {
  return useQuery({
    queryKey: ['classGroup', classGroupId, 'insights', subjectId],
    enabled: !!classGroupId,
    queryFn: () => rpc<ClassInsight[]>('class_insights_for', { class_group_id: classGroupId, subject_id: subjectId ?? null }).catch(() => [] as ClassInsight[]),
  });
}

// ---------- Duels (SOC-02) ----------

export interface Duel {
  id: string;
  class_group_id: string;
  challenger_id: string;
  opponent_id: string;
  quiz_id: string;
  status: 'waiting_opponent' | 'declined' | 'finished' | 'expired' | 'cancelled';
  expires_at: string;
  challenger_attempt_id: string | null;
  opponent_attempt_id: string | null;
  challenger_score: number | null;
  opponent_score: number | null;
  winner_id: string | null;
  rematch_of: string | null;
  created_at: string;
}

export function useDuels(classGroupId?: string) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['duels', userId, classGroupId],
    enabled: !!userId,
    refetchInterval: 30_000,
    queryFn: () => {
      let q = supabase.from('duels').select('*').or(`challenger_id.eq.${userId},opponent_id.eq.${userId}`).order('created_at', { ascending: false }).limit(30);
      if (classGroupId) q = q.eq('class_group_id', classGroupId);
      return rows<Duel>(q);
    },
  });
}

export function useDuel(duelId: string | undefined) {
  return useQuery({
    queryKey: ['duel', duelId],
    enabled: !!duelId,
    refetchInterval: 10_000,
    queryFn: () => row<Duel>(supabase.from('duels').select('*').eq('id', duelId!).maybeSingle()),
  });
}

export const createDuel = (req: { class_group_id: string; opponent_id: string; subject_id: string; node_ids?: string[]; length: 5 | 7 | 10; rematch_of?: string }) =>
  callFunction<typeof req, { duel_id: string; quiz_id: string; attempt_id: string }>('duel-create', req, { idempotencyKey: uuidv7() });

export const respondDuel = (duelId: string, accept: boolean) => callFunction<{ duel_id: string; accept: boolean }, { attempt_id?: string }>('duel-respond', { duel_id: duelId, accept }, { idempotencyKey: uuidv7() });

export interface QuestionPublic {
  id: string;
  type: string;
  stem: string;
  stimulus?: { markdown?: string } | null;
  payload: Record<string, unknown>;
  subject_id: string;
  node_id: string;
}

export const duelNext = (attemptId: string) =>
  callFunction<{ attempt_id: string }, { index: number; total: number; question: QuestionPublic; deadline_at: string } | { finished: true }>('duel-next', { attempt_id: attemptId }, { idempotencyKey: uuidv7() });

export const duelAnswer = (attemptId: string, questionId: string, response: unknown) =>
  callFunction<{ attempt_id: string; question_id: string; response: unknown; answer_id: string }, { correct: boolean; points: number; correct_response: unknown; explanation: string; source_pages: { document_id: string; page_start: number; page_end: number }[] }>(
    'duel-answer',
    { attempt_id: attemptId, question_id: questionId, response, answer_id: uuidv7() },
    { idempotencyKey: uuidv7() },
  );

// ---------- Battles (SOC-03) ----------

export type BattleStatus = 'lobby' | 'question_open' | 'question_closed' | 'reveal' | 'podium' | 'ended' | 'cancelled';

export interface Battle {
  id: string;
  class_group_id: string;
  host_id: string;
  quiz_id: string;
  pin: string;
  status: BattleStatus;
  current_index: number;
  question_opens_at: string | null;
  question_closes_at: string | null;
  seconds_per_question: number;
}

export interface BattlePlayer {
  battle_id: string;
  user_id: string;
  nickname: string;
  score: number;
  answer_streak: number;
}

export const battleControl = (req: { action: 'create'; class_group_id: string; subject_id: string; node_ids?: string[]; count: 5 | 10 | 15; seconds_per_question?: number } | { action: 'start' | 'next' | 'end'; battle_id: string } | { action: 'kick'; battle_id: string; user_id: string }) =>
  callFunction<typeof req, { battle_id: string; pin?: string; status: BattleStatus }>('battle-control', req, { idempotencyKey: uuidv7() });

export const battleJoin = (pin: string) => callFunction<{ pin: string }, { battle_id: string; nickname: string }>('battle-join', { pin }, { idempotencyKey: uuidv7() });

export const battleAnswer = (battleId: string, questionIndex: number, response: unknown) =>
  callFunction<{ battle_id: string; question_index: number; response: unknown; answer_id: string }, { accepted: boolean }>('battle-answer', { battle_id: battleId, question_index: questionIndex, response, answer_id: uuidv7() }, { idempotencyKey: uuidv7() });

export function useLiveBattles(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['classGroup', classGroupId, 'battles'],
    enabled: !!classGroupId,
    refetchInterval: 20_000,
    queryFn: () => rows<Battle>(supabase.from('battles').select('*').eq('class_group_id', classGroupId!).in('status', ['lobby', 'question_open', 'question_closed', 'reveal'])),
  });
}

// ---------- SOC-09 share quiz ----------

export const shareQuiz = (quizId: string) => callFunction<{ quiz_id: string }, { token: string; url: string; expires_at: string }>('quiz-share', { quiz_id: quizId }, { idempotencyKey: uuidv7() });

// ---------- TRU-02 review queue ----------

export interface FlagRow {
  id: string;
  item_type: string;
  item_id: string;
  class_group_id: string | null;
  reason: string;
  comment: string | null;
  ai_verdict: 'confirmed' | 'rejected' | 'unsure' | null;
  ai_confidence: 'low' | 'medium' | 'high' | null;
  ai_explanation: string | null;
  ai_source_pages: { document_id: string; page_start: number; page_end: number }[] | null;
  ai_proposed_fix: { fields?: { name: string; value: string }[] } | null;
  status: string;
  created_at: string;
}

export function useReviewQueue(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['classGroup', classGroupId, 'flags'],
    enabled: !!classGroupId,
    queryFn: () => rows<FlagRow>(supabase.from('content_flags').select('*').eq('class_group_id', classGroupId!).in('status', ['open', 'triaged', 'hidden_pending']).order('created_at')),
  });
}

export const resolveFlag = (flagId: string, decision: 'accept' | 'reject' | 'remove', fix?: unknown) => rpc<void>('resolve_flag', { flag_id: flagId, decision, fix: fix ?? null });

export const reportAbuse = (req: { reported_id?: string; class_group_id?: string; reason: string; context_type?: string; context_id?: string; comment?: string }) =>
  callFunction<typeof req, { report_id: string }>('report-create', req, { idempotencyKey: uuidv7() });
