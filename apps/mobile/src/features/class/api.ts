import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { callFunction } from '../../api/functions';
import { useSession } from '../auth/session';

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
    queryFn: () => data<(ClassGroup & { membership: Membership })[]>('class-groups'),
  });
}

export function useClassGroup(classGroupId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['classGroup', classGroupId, userId],
    enabled: !!classGroupId && !!userId,
    queryFn: async () => {
      const { group, me } = await data<{ group: ClassGroup | null; me: Membership | null }>('class-get', { class_group_id: classGroupId! });
      return { group, me, isMod: me?.role === 'owner' || me?.role === 'moderator' };
    },
  });
}

export function useMembers(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['classGroup', classGroupId, 'members'],
    enabled: !!classGroupId,
    queryFn: () => data<MemberPublic[]>('class-members', { class_group_id: classGroupId! }),
  });
}

/** Badge dot on the Turma tab for pending join requests (owner/mods only see them via RLS). */
export function usePendingRequestsBadge(): number {
  const { userId } = useSession();
  const q = useQuery({
    queryKey: ['classRequests', userId],
    enabled: !!userId,
    refetchInterval: 120_000,
    queryFn: async () => (await data<{ count: number }>('class-requests-count')).count,
  });
  return q.data ?? 0;
}

export const createClassGroup = (name: string, school?: string, schoolYear?: string) =>
  data<{ class_group_id: string; invite_code: string }>('class-create', { name, school: school || null, school_year: schoolYear || null });

export const joinClassGroup = (code: string) => data<{ class_group_id: string; status: 'active' | 'pending' }>('class-join', { code });

export const rotateInvite = (classGroupId: string, days = 14) => data<{ invite_code: string; expires_at: string }>('class-invite-rotate', { class_group_id: classGroupId, expires_in_days: days });

export const moderateMember = async (classGroupId: string, userId: string, action: 'approve' | 'reject' | 'remove' | 'ban' | 'unban' | 'promote' | 'demote'): Promise<void> => {
  await data('class-moderate', { class_group_id: classGroupId, user_id: userId, action });
};

export const leaveClassGroup = async (classGroupId: string): Promise<void> => {
  await data('class-leave', { class_group_id: classGroupId });
};

/** SOC-01.15: owner only; the caller confirms by typing the Turma name. */
export const deleteClassGroup = async (classGroupId: string): Promise<void> => {
  await data('class-delete', { class_group_id: classGroupId });
};

export const createSharedSubject = async (classGroupId: string, name: string, color: string, icon: string): Promise<string> =>
  (await data<{ id: string }>('class-subject-create', { class_group_id: classGroupId, name, color, icon })).id;

export const blockUser = async (userId: string): Promise<void> => {
  await data('class-block-user', { user_id: userId });
};

export function useInvite(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['classGroup', classGroupId, 'invite'],
    enabled: !!classGroupId,
    queryFn: () => data<{ code: string; expires_at: string } | null>('class-invite', { class_group_id: classGroupId! }),
  });
}

/** The membership updated is always the signed-in student's own (the server uses the token's user). */
export async function updateMyMembership(classGroupId: string, _userId: string, patch: Partial<Pick<Membership, 'nickname' | 'contribute_insights' | 'accepts_duels' | 'league_opt_in'>>) {
  await data('class-membership-update', { class_group_id: classGroupId, patch });
}

export async function updateClassGroup(classGroupId: string, patch: Partial<Pick<ClassGroup, 'name' | 'join_policy' | 'allow_member_uploads' | 'settings'>>) {
  await data('class-update', { class_group_id: classGroupId, patch });
}

export function useClassSubjects(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['classGroup', classGroupId, 'subjects'],
    enabled: !!classGroupId,
    queryFn: () => data<{ id: string; name: string; color: string; icon: string }[]>('class-subjects', { class_group_id: classGroupId! }),
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
    queryFn: () => data<ClassInsight[]>('class-insights', { class_group_id: classGroupId!, subject_id: subjectId ?? null }).catch(() => [] as ClassInsight[]),
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
    queryFn: () => data<Duel[]>('class-duels', classGroupId ? { class_group_id: classGroupId } : {}),
  });
}

export function useDuel(duelId: string | undefined) {
  return useQuery({
    queryKey: ['duel', duelId],
    enabled: !!duelId,
    refetchInterval: 10_000,
    queryFn: () => data<Duel | null>('class-duel-get', { duel_id: duelId! }),
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
    queryFn: () => data<Battle[]>('class-battles-live', { class_group_id: classGroupId! }),
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
    queryFn: () => data<FlagRow[]>('class-flags', { class_group_id: classGroupId! }),
  });
}

export const resolveFlag = async (flagId: string, decision: 'accept' | 'reject' | 'remove', fix?: unknown): Promise<void> => {
  await data('class-flag-resolve', { flag_id: flagId, decision, fix: fix ?? null });
};

export const reportAbuse = (req: { reported_id?: string; class_group_id?: string; reason: string; context_type?: string; context_id?: string; comment?: string }) =>
  callFunction<typeof req, { report_id: string }>('report-create', req, { idempotencyKey: uuidv7() });
