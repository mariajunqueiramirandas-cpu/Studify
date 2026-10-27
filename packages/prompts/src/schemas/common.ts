import { z } from 'zod';

export const LanguageTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'BCP 47, ex.: pt-BR');
export const Difficulty = z.number().int().min(1).max(5);
export const Confidence = z.number().min(0).max(1);
export const BloomLevel = z.enum(['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']);
export const MistakeCause = z.enum(['didnt_know', 'confused', 'careless', 'misread']);
export const ConceptKey = z.string().min(1).max(40);
export const NodeKey = z.string().min(1).max(40);
export const DocLabel = z.string().regex(/^D\d{1,2}$/, 'rótulo de documento, ex.: D1');
export const PageNumber = z.number().int().min(1);

export function pageRangeIssue(start: number, end: number): string | null {
  return end < start ? 'page_end menor que page_start' : null;
}

/** Original page range inside one labelled document block. */
export const DocPageRef = z
  .strictObject({
    doc: DocLabel,
    page_start: PageNumber,
    page_end: PageNumber,
  })
  .superRefine((v, ctx) => {
    const issue = pageRangeIssue(v.page_start, v.page_end);
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['page_end'] });
  });

export const SourcePages = z.array(DocPageRef).min(1).max(12);

export const RemediationCard = z.strictObject({
  front: z.string().min(1).max(200),
  back: z.string().min(1).max(300),
});

export const CLOZE_DELETION = /\{\{c\d+::[^{}]+\}\}/g;
