// Auto visuals (LRN-05): generated on request by visual-generate (cached per topic and type on the server),
// read back by id for the Feed's diagram cards.
import { useQuery } from '@tanstack/react-query';
import type { VisualGenerateReq, VisualGenerateRes, VisualRow } from '@studify/shared';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { row } from '../common/query';

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
    queryFn: () => row<VisualRow>(supabase.from('visuals').select('id,node_id,type,title,spec,alt_text,source_pages').eq('id', visualId!).maybeSingle()),
  });
}
