// Avisos do material (ING-06): findings of the material checker, the student's own votes, and the vote RPC
// that keeps the counters and the status consistent (vote_material_finding).
import { useQuery } from '@tanstack/react-query';
import type { FindingStatusName } from '@studify/shared';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { rows } from '../common/query';

export interface FindingRow {
  id: string;
  document_id: string;
  subject_id: string;
  node_id: string | null;
  related_document_id: string | null;
  type: 'contradiction' | 'numeric_or_formula_typo' | 'skipped_step' | 'unclear';
  severity: 'low' | 'medium' | 'high';
  page_start: number;
  page_end: number;
  related_page: number | null;
  description: string;
  suggested_fix: string | null;
  status: FindingStatusName;
  confirmations: number;
  dismissals: number;
}

const COLUMNS = 'id,document_id,subject_id,node_id,related_document_id,type,severity,page_start,page_end,related_page,description,suggested_fix,status,confirmations,dismissals';

export function useFindings(filter: { documentId?: string; nodeId?: string }) {
  return useQuery({
    queryKey: ['findings', filter.documentId ?? null, filter.nodeId ?? null],
    enabled: !!(filter.documentId || filter.nodeId),
    queryFn: () => {
      let q = supabase.from('material_findings').select(COLUMNS);
      if (filter.documentId) q = q.eq('document_id', filter.documentId);
      if (filter.nodeId) q = q.eq('node_id', filter.nodeId);
      return rows<FindingRow>(q.limit(60));
    },
  });
}

export function useMyFindingVotes(findingIds: string[]) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['finding-votes', userId, findingIds.join(',')],
    enabled: !!userId && findingIds.length > 0,
    queryFn: async () => {
      const list = await rows<{ finding_id: string; vote: 'is_error' | 'not_error' }>(supabase.from('material_finding_votes').select('finding_id,vote').in('finding_id', findingIds));
      return new Map(list.map((v) => [v.finding_id, v.vote]));
    },
  });
}

export async function voteFinding(findingId: string, vote: 'is_error' | 'not_error') {
  const { data, error } = await supabase.rpc('vote_material_finding', { p_finding: findingId, p_vote: vote });
  if (error) throw error;
  return (data as Array<{ status: FindingStatusName }> | null)?.[0]?.status ?? 'open';
}
