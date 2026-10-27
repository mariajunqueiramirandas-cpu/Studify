// Phase 5 Turma features: Dividir e conquistar (SOC-06), Perguntas da turma (SOC-07) and Ligas semanais (SOC-08).
// Plans, claims, votes and the league go through RLS and RPCs; the AI steps through the Edge functions.
import { useQuery } from '@tanstack/react-query';
import type { ContributionFeedback, LeagueBoardRow, PeerQuestionCreateReq, PeerQuestionCreateRes } from '@studify/shared';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { row, rows } from '../common/query';

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
    queryFn: () => rows<DividePlan>(supabase.from('divide_plans').select('*').eq('class_group_id', classGroupId!).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(30)),
  });
}

export function useDividePlan(planId: string | undefined) {
  return useQuery({
    queryKey: ['divide', 'plan', planId],
    enabled: !!planId,
    queryFn: () => row<DividePlan>(supabase.from('divide_plans').select('*').eq('id', planId!).maybeSingle()),
  });
}

export function useDivideProgress(planId: string | undefined) {
  return useQuery({
    queryKey: ['divide', 'progress', planId],
    enabled: !!planId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('divide_progress', { p_plan: planId });
      if (error) throw error;
      return (data ?? []) as DivideProgressRow[];
    },
  });
}

/** Topics of a Turma subject (online: the divisão is planned with the network). */
export function useSubjectTopics(subjectId: string | undefined) {
  return useQuery({
    queryKey: ['subject-topics', subjectId],
    enabled: !!subjectId,
    queryFn: () => rows<{ id: string; title: string; parent_id: string | null; position: number }>(supabase.from('knowledge_nodes').select('id,title,parent_id,position').eq('subject_id', subjectId!).eq('kind', 'topic').is('deleted_at', null).order('position')),
  });
}

export async function createDividePlan(userId: string, input: { classGroupId: string; subjectId: string; title: string; nodeIds: string[]; maxClaims: number }): Promise<string> {
  const id = uuidv7();
  const { error } = await supabase.from('divide_plans').insert({ id, class_group_id: input.classGroupId, subject_id: input.subjectId, title: input.title, node_ids: input.nodeIds, max_claims: input.maxClaims, created_by: userId });
  if (error) throw error;
  return id;
}

export async function claimTopic(planId: string, nodeId: string, claim: boolean) {
  const { error } = await supabase.rpc('claim_divide_topic', { p_plan: planId, p_node: nodeId, p_claim: claim });
  if (error) throw error;
}

export async function cancelDividePlan(planId: string) {
  const { error } = await supabase.from('divide_plans').update({ status: 'cancelled' }).eq('id', planId);
  if (error) throw error;
}

export function useMyContribution(planId: string | undefined, nodeId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['contribution', planId, nodeId, userId],
    enabled: !!planId && !!nodeId && !!userId,
    queryFn: () => row<Contribution>(supabase.from('contributions').select('*').eq('divide_plan_id', planId!).eq('node_id', nodeId!).eq('author_id', userId!).maybeSingle()),
  });
}

/** Creates the draft on first save; later saves update it (drafts only, RLS). */
export async function saveContribution(userId: string, input: { id: string | null; planId: string; nodeId: string; body: string }): Promise<string> {
  if (input.id) {
    const { error } = await supabase.from('contributions').update({ body_md: input.body }).eq('id', input.id);
    if (error) throw error;
    return input.id;
  }
  const id = uuidv7();
  const { error } = await supabase.from('contributions').insert({ id, divide_plan_id: input.planId, node_id: input.nodeId, author_id: userId, body_md: input.body });
  if (error) throw error;
  return id;
}

/** SOC-06.2: the transcription of a photographed page is appended to the draft (drafts only, RLS). */
export async function appendToContribution(contributionId: string, text: string) {
  const current = await row<{ body_md: string }>(supabase.from('contributions').select('body_md').eq('id', contributionId).maybeSingle());
  const body = [current?.body_md?.trim(), text].filter(Boolean).join('\n\n').slice(0, 20000);
  const { error } = await supabase.from('contributions').update({ body_md: body }).eq('id', contributionId);
  if (error) throw error;
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
      const note = await row<{ id: string; body: string; citations: unknown; contributors: string[] }>(
        supabase.from('notes').select('id,body,citations,contributors').eq('node_id', nodeId!).eq('depth', 'class_summary').eq('status', 'ready').is('deleted_at', null).maybeSingle(),
      );
      if (!note) return null;
      const names = note.contributors.length
        ? await rows<{ user_id: string; nickname: string | null; display_name: string | null }>(
            supabase.from('class_group_members_public').select('user_id,nickname,display_name').eq('class_group_id', classGroupId!).in('user_id', note.contributors),
          )
        : [];
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
      const list = await rows<PeerQuestion>(
        supabase
          .from('questions')
          .select('id,subject_id,node_id,type,stem,payload,explanation,author_id,author_anonymous,review_status,created_at')
          .in('subject_id', subjectIds)
          .eq('origin', 'peer')
          .is('deleted_at', null)
          .order('created_at', { ascending: false })
          .limit(100),
      );
      const votes = list.length ? await rows<{ question_id: string }>(supabase.from('question_votes').select('question_id').in('question_id', list.map((q) => q.id))) : [];
      return { list, voted: new Set(votes.map((v) => v.question_id)) };
    },
  });
}

export async function votePeerQuestion(questionId: string): Promise<string> {
  const { data, error } = await supabase.rpc('vote_peer_question', { p_question: questionId });
  if (error) throw error;
  return data as string;
}

export async function reviewPeerQuestion(questionId: string, approve: boolean): Promise<string> {
  const { data, error } = await supabase.rpc('review_peer_question', { p_question: questionId, p_approve: approve });
  if (error) throw error;
  return data as string;
}

export function createPeerQuestion(req: PeerQuestionCreateReq) {
  return callFunction<PeerQuestionCreateReq, PeerQuestionCreateRes>('peer-question-create', req, { idempotencyKey: uuidv7() });
}

// ---------------------------------------------------------------- SOC-08 Ligas semanais

export function useLeagueBoard(classGroupId: string | undefined, enabled: boolean, week?: string) {
  return useQuery({
    queryKey: ['league', classGroupId, week ?? 'current'],
    enabled: !!classGroupId && enabled,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('league_board', { p_group: classGroupId, ...(week ? { p_week: week } : {}) });
      if (error) throw error;
      return (data ?? []) as LeagueBoardRow[];
    },
  });
}

export function useMyLeagueWeeks(classGroupId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['league-weeks', classGroupId, userId],
    enabled: !!classGroupId && !!userId,
    queryFn: () => rows<{ week_start: string; league_xp: number; rank: number | null; badges: string[] }>(supabase.from('league_entries').select('week_start,league_xp,rank,badges').eq('class_group_id', classGroupId!).eq('user_id', userId!).order('week_start', { ascending: false }).limit(12)),
  });
}
