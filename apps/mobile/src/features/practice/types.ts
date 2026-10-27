// Question payloads (spec 05 §8.1) and the response shapes the UI writes to attempt_answers.response.

export type QuestionType =
  | 'mcq_single'
  | 'multi_select'
  | 'true_false'
  | 'fill_blank'
  | 'numeric'
  | 'matching'
  | 'ordering'
  | 'short_answer'
  | 'essay_question'
  | 'find_error'
  | 'problem';

export interface Option {
  id: string;
  text: string;
  rationale?: string;
  misconception_concept_id?: string | null;
  value?: number;
}

export type QuestionPayload =
  | { options: Option[]; correct: string } // mcq_single
  | { options: Option[]; correct: string[]; somatoria?: boolean } // multi_select
  | { statement: string; correct: boolean; justification?: string } // true_false
  | { text: string; blanks: { id: number | string; accepted: string[] }[] } // fill_blank
  | { answer: number; tolerance_abs?: number; tolerance_rel?: number; unit?: string; unit_required?: boolean } // numeric
  | { left: { id: string; text: string }[]; right: { id: string; text: string }[]; pairs: [string, string][] } // matching
  | { items: { id: string; text: string }[]; correct_order: string[] } // ordering
  | { model_answer: string; rubric: { id: string; criterion: string; points: number }[]; max_points: number; key_terms?: string[] } // short_answer
  | Record<string, unknown>;

export interface QuestionRow {
  id: string;
  subject_id: string;
  node_id: string;
  type: QuestionType;
  stem: string;
  stimulus?: { markdown?: string; table_markdown?: string; image_path?: string } | null;
  payload: QuestionPayload;
  explanation?: string | null;
  source_pages?: { document_id: string; page_start: number; page_end?: number }[] | null;
  difficulty?: number | null;
  version?: number;
  hidden_reason?: string | null;
}

export type QuestionResponse =
  | { choice: string }
  | { choices: string[] }
  | { value: boolean }
  | { blanks: Record<string, string> }
  | { number: number; unit?: string }
  | { pairs: [string, string][] }
  | { order: string[] }
  | { text: string };

export interface GradeResult {
  correct: boolean | null;
  score: number | null;
  /** fill_blank typo tolerance: "Aceitei, mas confere a grafia" (spec 05). */
  typo?: string | null;
  /** True when the answer needs AI grading (short answer). */
  pending?: boolean;
}

export const CONFIDENCE_LEVELS = [1, 2, 3, 4] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const MISTAKE_CAUSES = ['didnt_know', 'confused', 'careless', 'misread'] as const;
export type MistakeCause = (typeof MISTAKE_CAUSES)[number];

export function isAnswered(type: QuestionType, r: QuestionResponse | null | undefined): boolean {
  if (!r) return false;
  if ('choice' in r) return !!r.choice;
  if ('choices' in r) return r.choices.length > 0;
  if ('value' in r) return typeof r.value === 'boolean';
  if ('blanks' in r) return Object.values(r.blanks).some((v) => v.trim().length > 0);
  if ('number' in r) return Number.isFinite(r.number);
  if ('pairs' in r) return r.pairs.length > 0;
  if ('order' in r) return r.order.length > 0;
  if ('text' in r) return r.text.trim().length > 0 || type !== 'short_answer';
  return false;
}
