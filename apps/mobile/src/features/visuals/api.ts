// Auto visuals (LRN-05): generated on request by visual-generate (cached per topic and type on the server),
// read back by id for the Feed's diagram cards.
import { useQuery } from '@tanstack/react-query';
import type { VisualGenerateReq, VisualGenerateRes, VisualRow } from '@studify/shared';
import { uuidv7 } from 'uuidv7';
import { data } from '../../api/data';
import { callFunction } from '../../api/functions';

export type VisualKind = NonNullable<VisualGenerateReq['type']>;
export const VISUAL_KINDS: VisualKind[] = ['flowchart', 'cycle', 'timeline', 'comparison_table', 'hierarchy'];

export function generateVisual(nodeId: string, type?: VisualKind) {
  return callFunction<VisualGenerateReq, VisualGenerateRes>('visual-generate', { node_id: nodeId, ...(type ? { type } : {}) }, { idempotencyKey: uuidv7() });
}

export function useVisual(visualId: string | undefined) {
  return useQuery({
    queryKey: ['visual', visualId],
    enabled: !!visualId,
    staleTime: Infinity,
    queryFn: () => data<VisualRow | null>('visuals-get', { visual_id: visualId }),
  });
}
