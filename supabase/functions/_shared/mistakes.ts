// Caderno de Erros (PRA-04) and the auto remediation card (PRA-02): one place that turns a graded wrong
// answer into a mistakes row plus a card, used by quiz-submit and grade-answer. No AI call here.
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_TIME_ZONE,
  localDateOf,
  mistakeEntryAction,
  newRetrySchedule,
  nextRetry,
  suggestMistakeCause,
  type MistakeCause,
  type QuestionType,
} from '@studify/shared';

export interface MistakeInput {
  userId: string;
  answerId: string;
  question: {
    id: string;
    node_id: string;
    subject_id: string;
    type: QuestionType;
    stem: string;
    payload: unknown;
    explanation: string | null;
    concept_ids: string[];
    source_pages: unknown;
  };
  score: number;
  confidence: 1 | 2 | 3 | 4 | null;
  /** Caller-known cause (AI grader). Otherwise the rule order of suggestMistakeCause decides. */
  suggestedCause?: MistakeCause | null;
  response: unknown;
  timeSeconds: number;
  now: Date;
}

export interface MistakeOutcome {
  mistakeId: string | null;
  cardId: string | null;
}

export async function recordMistake(db: SupabaseClient, newId: () => string, input: MistakeInput): Promise<MistakeOutcome> {
  if (mistakeEntryAction(input.score, input.confidence) !== 'create') return { mistakeId: null, cardId: null };

  const open = await db
    .from('mistakes')
    .select('id')
    .eq('user_id', input.userId)
    .eq('question_id', input.question.id)
    .is('resolved_at', null)
    .is('deleted_at', null)
    .maybeSingle();
  if (open.error) throw open.error;
  if (open.data) return { mistakeId: open.data.id as string, cardId: null };

  const cause: MistakeCause =
    input.suggestedCause ??
    suggestMistakeCause({
      type: input.question.type,
      stem: input.question.stem,
      payload: input.question.payload as never,
      response: (input.response ?? null) as never,
      confidence: input.confidence,
      timeSeconds: input.timeSeconds,
      medianTimeSeconds: null,
    });

  const today = localDateOf(input.now, DEFAULT_TIME_ZONE);
  const schedule = newRetrySchedule(today);

  // PRA-02: the remediation card is built from the question's own explanation (no AI call).
  const cardId = newId();
  const front = input.question.stem.slice(0, 200);
  const back = (input.question.explanation ?? 'Revise esse conceito no material.').slice(0, 300);
  const card = await db.from('cards').insert({
    id: cardId,
    subject_id: input.question.subject_id,
    node_id: input.question.node_id,
    concept_id: input.question.concept_ids[0] ?? null,
    type: 'basic',
    front,
    back,
    source_pages: input.question.source_pages ?? [],
    origin: 'from_mistake',
    created_by: input.userId,
    personal_for_user_id: input.userId,
    status: 'active',
  });
  if (card.error) throw card.error;

  const mistakeId = newId();
  const inserted = await db.from('mistakes').insert({
    id: mistakeId,
    user_id: input.userId,
    question_id: input.question.id,
    attempt_answer_id: input.answerId,
    subject_id: input.question.subject_id,
    node_id: input.question.node_id,
    cause,
    suggested_cause: cause,
    cause_source: 'suggested',
    next_retry_at: nextRetry(schedule) as string,
    retry_step: 0,
    success_days: 0,
    remediation_card_id: cardId,
  });
  if (inserted.error) {
    if (inserted.error.code === '23505') return { mistakeId: null, cardId: null };
    throw inserted.error;
  }
  return { mistakeId, cardId };
}
