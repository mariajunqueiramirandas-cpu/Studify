import { z } from 'zod';
import { ConceptKey, NodeKey, SourcePages } from './common.ts';

export function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

/** L5 output (LRN-02.2): glossary definitions, one topic at a time. */
export const GlossaryTerms = z.strictObject({
  terms: z
    .array(
      z
        .strictObject({
          term: z.string().min(1).max(80),
          definition: z.string().min(1).max(300),
          example: z.string().min(1).max(200).nullable(),
          aliases: z.array(z.string().min(1).max(60)).max(6),
          concept_key: ConceptKey,
          source_pages: SourcePages,
        })
        .superRefine((v, ctx) => {
          if (countWords(v.definition) > 40) ctx.addIssue({ code: 'custom', message: 'definição com mais de 40 palavras', path: ['definition'] });
        }),
    )
    .min(1)
    .max(40),
});

/** L7 output (LRN-04.1): related and contrast edges between concepts or topics. */
export const Relations = z.strictObject({
  relations: z
    .array(
      z
        .strictObject({
          from_key: NodeKey,
          to_key: NodeKey,
          kind: z.enum(['related', 'contrast']),
          reason: z.string().min(1).max(200),
        })
        .superRefine((v, ctx) => {
          if (v.from_key === v.to_key) ctx.addIssue({ code: 'custom', message: 'relação de um nó com ele mesmo', path: ['to_key'] });
        }),
    )
    .max(200),
});
