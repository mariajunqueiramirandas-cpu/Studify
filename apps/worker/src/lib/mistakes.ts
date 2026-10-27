// Caderno de Erros writes shared by grading.answer and flag.apply_fix (PRA-04, PRA-02.3).
import { nextRetry, newRetrySchedule, type LocalDate } from '@studify/shared';
import type { JobContext } from '../framework/types.ts';
import { JobDataError, unwrap } from './db.ts';

export interface MistakeInput {
  userId: string;
  questionId: string;
  attemptAnswerId: string;
  subjectId: string;
  nodeId: string;
  cause: string;
  today: LocalDate;
  remediationCardId: string | null;
}

/** Creates the open Caderno entry for (user, question) unless one exists (PRA-04 unique rule). */
export async function ensureOpenMistake(ctx: JobContext, input: MistakeInput): Promise<{ created: boolean; id: string | null }> {
  const existing = unwrap(
    await ctx.supabase
      .from('mistakes')
      .select('id')
      .eq('user_id', input.userId)
      .eq('question_id', input.questionId)
      .is('resolved_at', null)
      .is('deleted_at', null)
      .maybeSingle(),
    'mistakes',
  ) as { id: string } | null;
  if (existing) return { created: false, id: existing.id };

  const due = nextRetry(newRetrySchedule(input.today));
  if (due === 'resolved') throw new JobDataError('retry schedule resolved on creation', 'invariant');
  const inserted = unwrap(
    await ctx.supabase
      .from('mistakes')
      .insert({
        user_id: input.userId,
        question_id: input.questionId,
        attempt_answer_id: input.attemptAnswerId,
        subject_id: input.subjectId,
        node_id: input.nodeId,
        cause: input.cause,
        suggested_cause: input.cause,
        cause_source: 'suggested',
        next_retry_at: due,
        retry_step: 0,
        success_days: 0,
        remediation_card_id: input.remediationCardId,
      })
      .select('id')
      .single(),
    'mistakes insert',
  ) as { id: string } | null;
  return { created: true, id: inserted?.id ?? null };
}

export interface RemediationInput {
  userId: string;
  subjectId: string;
  nodeId: string;
  /** Personal card id owner for shared subjects (R8); null for the subject owner's own subject. */
  personalFor: string | null;
  front: string;
  back: string;
}

/** A from_mistake card (PRA-02.3). Cards are created as data; the card's review state starts as New. */
export async function createRemediationCard(ctx: JobContext, input: RemediationInput): Promise<string | null> {
  const row = unwrap(
    await ctx.supabase
      .from('cards')
      .insert({
        subject_id: input.subjectId,
        node_id: input.nodeId,
        type: 'basic',
        front: input.front,
        back: input.back,
        source_pages: [],
        origin: 'from_mistake',
        created_by: input.userId,
        personal_for_user_id: input.personalFor,
        status: 'active',
      })
      .select('id')
      .single(),
    'cards insert',
  ) as { id: string } | null;
  return row?.id ?? null;
}
