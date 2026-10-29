// Maps AI-extracted or AI-generated questions to questions.payload (spec 05 §8.1) without trusting the
// model: each payload is validated with the shared QuestionPayload schema, and anything that does not
// validate is skipped with a reason, never stored half-formed.
import { parseQuestionPayload, type QuestionType } from '@studify/shared';

export interface ExtractedAlternative {
  label: string;
  text_md: string;
}

export interface ExtractedQuestion {
  type: string;
  statement_md: string;
  alternatives: ExtractedAlternative[] | null;
  answer: { value: string; source: 'printed' | 'generated' } | null;
  solution_md: string | null;
  points: number | null;
}

export type PayloadResult = { ok: true; type: QuestionType; payload: unknown } | { ok: false; reason: string };

const TRUE_WORDS = new Set(['v', 'verdadeiro', 'true', 'certo', 'c', 'sim']);
const FALSE_WORDS = new Set(['f', 'falso', 'false', 'errado', 'e', 'não', 'nao']);

/** Payload for a question of a past test or a predicted test. Unsupported types return a reason. */
export function questionPayloadFor(q: ExtractedQuestion): PayloadResult {
  const explanation = (q.solution_md ?? '').trim() || 'Veja a resolução do material.';
  const answerValue = q.answer?.value.trim() ?? '';
  const points = q.points && q.points > 0 ? q.points : 1;
  let candidate: { type: QuestionType; payload: unknown };
  switch (q.type) {
    case 'mcq_single': {
      const options = q.alternatives ?? [];
      const correct = answerValue.toUpperCase();
      if (!correct || !options.some((o) => o.label.trim().toUpperCase() === correct)) return { ok: false, reason: 'no_answer_key' };
      candidate = {
        type: 'mcq_single',
        payload: {
          options: options.map((o) => {
            const id = o.label.trim().toUpperCase();
            return { id, text: o.text_md, rationale: id === correct ? explanation : 'Alternativa incorreta.' };
          }),
          correct,
        },
      };
      break;
    }
    case 'true_false': {
      const word = answerValue.toLowerCase();
      const value = TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : null;
      if (value === null) return { ok: false, reason: 'no_answer_key' };
      candidate = { type: 'true_false', payload: { statement: q.statement_md, correct: value, justification: explanation } };
      break;
    }
    case 'numeric': {
      const value = Number(answerValue.replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(value)) return { ok: false, reason: 'no_answer_key' };
      candidate = { type: 'numeric', payload: { answer: value, unit_required: false, unit: null, tolerance_rel: 0.01 } };
      break;
    }
    case 'short_answer':
    case 'essay_question': {
      const modelAnswer = answerValue || (q.solution_md ?? '').trim();
      if (!modelAnswer) return { ok: false, reason: 'no_answer_key' };
      candidate = {
        type: q.type,
        payload: { model_answer: modelAnswer, rubric: [{ id: 'c1', criterion: 'Resposta correta', points }], max_points: points, key_terms: [] },
      };
      break;
    }
    default:
      return { ok: false, reason: 'unsupported_type' };
  }
  try {
    parseQuestionPayload(candidate.type, candidate.payload);
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }
  return { ok: true, type: candidate.type, payload: candidate.payload };
}

/** Bloom and difficulty come from the model and are range-checked here (the schema already bounds them). */
export function clampDifficulty(value: number): number {
  return Math.min(5, Math.max(1, Math.round(value)));
}
