import { z } from 'zod';
import { CLOZE_DELETION, ConceptKey, Difficulty, SourcePages } from './common.ts';

const CardType = z.enum(['basic', 'cloze', 'reverse']);

/** Cloze syntax {{cN::texto}}; at most 3 deletions per sentence (spec 04 §8.1 rule 5). */
export function checkCardShape(
  card: { type: 'basic' | 'cloze' | 'reverse'; front: string; back: string; cloze_text: string | null },
  ctx: z.RefinementCtx,
): void {
  if (card.type === 'cloze') {
    const deletions = card.cloze_text ? [...card.cloze_text.matchAll(CLOZE_DELETION)] : [];
    if (deletions.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'cloze sem {{cN::…}}', path: ['cloze_text'] });
    } else if (deletions.length > 3) {
      ctx.addIssue({ code: 'custom', message: 'mais de 3 lacunas na frase', path: ['cloze_text'] });
    }
  } else if (card.cloze_text !== null) {
    ctx.addIssue({ code: 'custom', message: 'cloze_text só para cartões cloze', path: ['cloze_text'] });
  }
  const back = card.back.trim().toLowerCase();
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

