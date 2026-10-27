import { z } from 'zod';
import { NodeKey, DocPageRef } from './common.ts';

/** GOL-07.2 / vespera.cheatsheet output. Sources must come from pages cited by the input notes. */
export const Cheatsheet = z.strictObject({
  title: z.string().min(1).max(80),
  sections: z
    .array(
      z.strictObject({
        node_key: NodeKey,
        heading: z.string().min(1).max(80),
        bullets: z
          .array(z.strictObject({ text: z.string().min(1).max(200), source_pages: z.array(DocPageRef).min(1).max(4) }))
          .min(1)
          .max(6),
        formula: z.string().min(1).max(200).nullable(),
      }),
    )
    .min(1)
    .max(10),
  watch_out: z
    .array(z.strictObject({ text: z.string().min(1).max(200), from_mistake_id: z.string().min(1).max(64).nullable() }))
    .max(6),
});
