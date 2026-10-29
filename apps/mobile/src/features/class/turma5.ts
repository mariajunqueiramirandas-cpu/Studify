// Phase 5 Turma features: Dividir e conquistar (SOC-06), Perguntas da turma (SOC-07) and Ligas semanais (SOC-08).
// Plans, claims, votes and the league go through RLS and RPCs; the AI steps through the Edge functions.
import { useQuery } from '@tanstack/react-query';
import type { ContributionFeedback, LeagueBoardRow, PeerQuestionCreateReq, PeerQuestionCreateRes } from '@studify/shared';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { callFunction } from '../../api/functions';
import { useSession } from '../auth/session';

// ---------------------------------------------------------------- SOC-06 Dividir e conquistar

export interface DividePlan {
  id: string;
  class_group_id: string;
  subject_id: string;
  exam_id: string | null;
  title: string;
  node_ids: string[];
  assignments: Record<string, string>;
  max_claims: number;
  status: 'open' | 'merging' | 'done' | 'cancelled';
  created_by: string;
  created_at: string;
}

export interface DivideProgressRow {
  node_id: string;
  user_id: string;
  nickname: string | null;
  status: 'claimed' | 'draft' | 'submitted' | 'approved' | 'rejected';
}

export interface Contribution {
  id: string;
  divide_plan_id: string;
  node_id: string;
  author_id: string;
  body_md: string;
  ai_feedback: ContributionFeedback | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
}

export function useDividePlans(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['divide', classGroupId],
    enabled: !!classGroupId,
    queryFn: () => data<DividePlan[]>('turma-divide-plans', { class_group_id: classGroupId! }),
  });
}

export function useDividePlan(planId: string | undefined) {
  return useQuery({
    queryKey: ['divide', 'plan', planId],
    enabled: !!planId,
    queryFn: () => data<DividePlan | null>('turma-divide-plan', { plan_id: planId! }),
  });
}

export function useDivideProgress(planId: string | undefined) {
  return useQuery({
    queryKey: ['divide', 'progress', planId],
    enabled: !!planId,
    queryFn: () => data<DivideProgressRow[]>('turma-divide-progress', { plan_id: planId! }),
  });
}

/** Topics of a Turma subject (online: the divisão is planned with the network). */
export function useSubjectTopics(subjectId: string | undefined) {
  return useQuery({
    queryKey: ['subject-topics', subjectId],
    enabled: !!subjectId,
    queryFn: () => data<{ id: string; title: string; parent_id: string | null; position: number }[]>('turma-subject-topics', { subject_id: subjectId! }),
  });
}

/** The plan's author is the signed-in student (the server uses the token's user). */
export async function createDividePlan(_userId: string, input: { classGroupId: string; subjectId: string; title: string; nodeIds: string[]; maxClaims: number }): Promise<string> {
  const id = uuidv7();
  await data(
    'turma-divide-create',
    { id, class_group_id: input.classGroupId, subject_id: input.subjectId, title: input.title, node_ids: input.nodeIds, max_claims: input.maxClaims },
    { idempotencyKey: id },
  );
  return id;
}

export async function claimTopic(planId: string, nodeId: string, claim: boolean) {
  await data('turma-divide-claim', { plan_id: planId, node_id: nodeId, claim });
}

export async function cancelDividePlan(planId: string) {
  await data('turma-divide-cancel', { plan_id: planId });
}

export function useMyContribution(planId: string | undefined, nodeId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['contribution', planId, nodeId, userId],
    enabled: !!planId && !!nodeId && !!userId,
    queryFn: () => data<Contribution | null>('turma-contribution-mine', { plan_id: planId!, node_id: nodeId! }),
  });
}

/** Creates the draft on first save; later saves update it (drafts only, RLS). */
export async function saveContribution(_userId: string, input: { id: string | null; planId: string; nodeId: string; body: string }): Promise<string> {
  if (input.id) {
    await data('turma-contribution-update', { id: input.id, body: input.body });
    return input.id;
  }
  const id = uuidv7();
  await data('turma-contribution-create', { id, plan_id: input.planId, node_id: input.nodeId, body: input.body }, { idempotencyKey: id });
  return id;
}

/** SOC-06.2: the transcription of a photographed page is appended to the draft (drafts only, RLS). */
export async function appendToContribution(contributionId: string, text: string) {
  await data('turma-contribution-append', { id: contributionId, text });
}

export function reviewContribution(contributionId: string) {
  return callFunction<{ contribution_id: string }, { feedback: ContributionFeedback }>('divide-review', { contribution_id: contributionId }, { idempotencyKey: uuidv7() });
}

export function submitContribution(contributionId: string) {
  return callFunction<{ contribution_id: string }, { status: 'submitted' | 'approved'; merge_started: boolean }>('divide-submit', { contribution_id: contributionId }, { idempotencyKey: uuidv7() });
}

export function mergeDividePlan(planId: string) {
  return callFunction<{ divide_plan_id: string }, { job_id: string | null; status: string }>('divide-merge', { divide_plan_id: planId }, { idempotencyKey: uuidv7() });
}

/** The Resumo da turma of a topic (SOC-06.4) with the contributors' Turma nicknames. */
export function useClassSummary(nodeId: string | undefined, classGroupId: string | null | undefined) {
  return useQuery({
    queryKey: ['class-summary', nodeId],
    enabled: !!nodeId && !!classGroupId,
    queryFn: async () => {
      const found = await data<{
        note: { id: string; body: string; citations: unknown; contributors: string[] };
        names: { user_id: string; nickname: string | null; display_name: string | null }[];
      } | null>('turma-class-summary', { node_id: nodeId!, class_group_id: classGroupId! });
      if (!found) return null;
      const { note, names } = found;
      return { ...note, credits: names.map((n) => n.nickname ?? n.display_name ?? '—') };
    },
  });
}

// ---------------------------------------------------------------- SOC-07 Perguntas da turma

export interface PeerQuestion {
  id: string;
  subject_id: string;
  node_id: string;
  type: 'mcq_single' | 'true_false' | 'short_answer';
  stem: string;
  payload: Record<string, unknown>;
  explanation: string | null;
  author_id: string | null;
  author_anonymous: boolean;
  review_status: 'approved' | 'pending' | 'rejected';
  created_at: string;
}

export function usePeerQuestions(classGroupId: string | undefined, subjectIds: string[]) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['peer-questions', classGroupId, subjectIds.join(','), userId],
    enabled: !!classGroupId && subjectIds.length > 0 && !!userId,
    queryFn: async () => {
      const { list, voted } = await data<{ list: PeerQuestion[]; voted: string[] }>('turma-peer-questions', { subject_ids: subjectIds });
      return { list, voted: new Set(voted) };
    },
  });
}

export async function votePeerQuestion(questionId: string): Promise<string> {
  return (await data<{ result: string }>('turma-peer-vote', { question_id: questionId })).result;
}

export async function reviewPeerQuestion(questionId: string, approve: boolean): Promise<string> {
  return (await data<{ result: string }>('turma-peer-review', { question_id: questionId, approve })).result;
}

export function createPeerQuestion(req: PeerQuestionCreateReq) {
  return callFunction<PeerQuestionCreateReq, PeerQuestionCreateRes>('peer-question-create', req, { idempotencyKey: uuidv7() });
}

// ---------------------------------------------------------------- SOC-08 Ligas semanais

export function useLeagueBoard(classGroupId: string | undefined, enabled: boolean, week?: string) {
  return useQuery({
    queryKey: ['league', classGroupId, week ?? 'current'],
    enabled: !!classGroupId && enabled,
    queryFn: () => data<LeagueBoardRow[]>('turma-league-board', { class_group_id: classGroupId!, ...(week ? { week } : {}) }),
  });
}

export function useMyLeagueWeeks(classGroupId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['league-weeks', classGroupId, userId],
    enabled: !!classGroupId && !!userId,
    queryFn: () => data<{ week_start: string; league_xp: number; rank: number | null; badges: string[] }[]>('turma-league-weeks', { class_group_id: classGroupId! }),
  });
}
