// Avisos do material (ING-06): findings of the material checker, the student's own votes, and the vote RPC
// that keeps the counters and the status consistent (vote_material_finding).
import { useQuery } from '@tanstack/react-query';
import type { FindingStatusName } from '@studify/shared';
import { data } from '../../api/data';
import { useSession } from '../auth/session';

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

export function useFindings(filter: { documentId?: string; nodeId?: string }) {
  return useQuery({
    queryKey: ['findings', filter.documentId ?? null, filter.nodeId ?? null],
    enabled: !!(filter.documentId || filter.nodeId),
    queryFn: () =>
      data<FindingRow[]>('material-findings', {
        ...(filter.documentId ? { document_id: filter.documentId } : {}),
        ...(filter.nodeId ? { node_id: filter.nodeId } : {}),
      }),
  });
}

export function useMyFindingVotes(findingIds: string[]) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['finding-votes', userId, findingIds.join(',')],
    enabled: !!userId && findingIds.length > 0,
    queryFn: async () => {
      const list = await data<Array<{ finding_id: string; vote: 'is_error' | 'not_error' }>>('material-finding-votes', { finding_ids: findingIds });
      return new Map(list.map((v) => [v.finding_id, v.vote]));
    },
  });
}

export async function voteFinding(findingId: string, vote: 'is_error' | 'not_error') {
  const res = await data<{ status: FindingStatusName }>('material-finding-vote', { finding_id: findingId, vote });
  return res?.status ?? 'open';
}
