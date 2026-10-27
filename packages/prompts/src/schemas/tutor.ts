import { z } from 'zod';
import { NodeKey } from './common.ts';

/** TUT-01 / TUT-03 routing fallback (spec 03 §8.1): at most three outline nodes. */
export const RouteNodes = z.strictObject({
  node_keys: z.array(NodeKey).max(3),
});

/** Tool `registrar_avaliacao` (TUT-02.5). Strict: no extra keys. */
export const RegistrarAvaliacaoInput = z.strictObject({
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  score: z.number().min(0).max(1),
  node_key: NodeKey,
  misconception: z.string().min(1).max(200).nullable(),
});

/** Tool `marcar_fora_do_material` (TUT-04.1). Strict: no extra keys. */
export const MarcarForaDoMaterialInput = z.strictObject({
  closest_node_key: NodeKey.nullable(),
  reason: z.string().min(1).max(300),
});
