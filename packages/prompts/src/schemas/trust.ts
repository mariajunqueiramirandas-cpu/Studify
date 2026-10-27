import { z } from 'zod';
import { DocPageRef } from './common.ts';

/** TRU-02.4 triage verdict. `corrected_item` lists only the fields that change. */
export const FlagVerdict = z
  .strictObject({
    verdict: z.enum(['error_confirmed', 'not_an_error', 'unclear']),
    confidence: z.enum(['low', 'medium', 'high']),
    explanation_pt: z.string().min(1).max(400),
    evidence_pages: z.array(DocPageRef).max(6),
    corrected_item: z
      .strictObject({
        fields: z.array(z.strictObject({ name: z.string().min(1).max(40), value: z.string().min(1).max(2000) })).min(1).max(12),
      })
      .nullable(),
    answer_changed: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.verdict !== 'error_confirmed' && (v.corrected_item !== null || v.answer_changed)) {
      ctx.addIssue({ code: 'custom', message: 'correção só com verdict error_confirmed', path: ['corrected_item'] });
    }
    if (v.answer_changed && v.corrected_item === null) {
      ctx.addIssue({ code: 'custom', message: 'answer_changed exige corrected_item', path: ['corrected_item'] });
    }
  });

/** PLT-02.5 / spec 10 §7.4 moderation. `allowed` is derived from `category`. */
export const ModerationVerdict = z
  .strictObject({
    allowed: z.boolean(),
    category: z.enum(['ok', 'offensive', 'personal_data', 'sexual', 'hate', 'impersonation', 'other']),
  })
  .superRefine((v, ctx) => {
    if (v.allowed !== (v.category === 'ok')) ctx.addIssue({ code: 'custom', message: 'allowed deve ser true só com category ok', path: ['allowed'] });
  });
