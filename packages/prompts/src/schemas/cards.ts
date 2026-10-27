import { z } from 'zod';
import { CLOZE_DELETION, ConceptKey, Difficulty, SourcePages } from './common.ts';

const CardType = z.enum(['basic', 'cloze', 'reverse']);

/** Answer of each cloze marker: `{{c1::ATP}}` → ATP, `{{c1::ATP::energia}}` → ATP (the hint is not the answer). */
export function clozeAnswers(marked: string): string[] {
  return [...marked.matchAll(CLOZE_DELETION)].map((m) => (m[0].slice(2, -2).split('::')[1] ?? '').trim());
}

function normalizedAnswer(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * Card shape checks (spec 04 §8.1–8.2). Cloze cards keep their markers in `cloze_text` (the sentence the
 * prompt asks for, `front` is the same sentence without markers, and the stored front is `cloze_text`):
 * they need 1–3 `{{cN::…}}` markers and the answer (`back`) must be the text of one marker. For cloze the
 * answer is expected in the sentence, so the "answer appears in the front" rule applies to basic and
 * reverse cards only.
 */
export function checkCardShape(
  card: { type: 'basic' | 'cloze' | 'reverse'; front: string; back: string; cloze_text: string | null },
  ctx: z.RefinementCtx,
): void {
  const back = normalizedAnswer(card.back);
  if (card.type === 'cloze') {
    const marked = card.cloze_text ?? '';
    const deletions = [...marked.matchAll(CLOZE_DELETION)];
    if (deletions.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'cloze sem {{cN::…}}', path: ['cloze_text'] });
    } else if (deletions.length > 3) {
      ctx.addIssue({ code: 'custom', message: 'mais de 3 lacunas na frase', path: ['cloze_text'] });
    } else if (!clozeAnswers(marked).some((answer) => normalizedAnswer(answer) !== '' && normalizedAnswer(answer).includes(back))) {
      ctx.addIssue({ code: 'custom', message: 'a resposta precisa estar dentro de uma lacuna {{cN::…}}', path: ['back'] });
    }
    return;
  }
  if (card.cloze_text !== null) {
    ctx.addIssue({ code: 'custom', message: 'cloze_text só para cartões cloze', path: ['cloze_text'] });
  }
  if (back.length > 3 && card.front.toLowerCase().includes(back)) {
    ctx.addIssue({ code: 'custom', message: 'a resposta aparece na frente', path: ['back'] });
  }
}

export const CardDraft = z
  .strictObject({
    type: CardType,
    front: z.string().min(1).max(200),
    back: z.string().min(1).max(300),
    cloze_text: z.string().min(1).max(400).nullable(),
    concept_key: ConceptKey,
    source_pages: SourcePages,
    difficulty_estimate: Difficulty,
  })
  .superRefine(checkCardShape);

export const TopicCards = z.strictObject({
  cards: z.array(CardDraft).min(1).max(30),
});

/** One card drafted from a text selection (MEM-01.7). */
export const SelectionCard = z
  .strictObject({
    type: CardType,
    front: z.string().min(1).max(200),
    back: z.string().min(1).max(300),
    cloze_text: z.string().min(1).max(400).nullable(),
    concept_key: ConceptKey.nullable(),
  })
  .superRefine(checkCardShape);

/** Card from a tutor answer (TUT-01.6): basic or cloze only. */
export const TutorCard = z
  .strictObject({
    type: z.enum(['basic', 'cloze']),
    front: z.string().min(1).max(200),
    back: z.string().min(1).max(300),
    cloze_text: z.string().min(1).max(400).nullable(),
  })
  .superRefine(checkCardShape);

