// Data endpoints of apps/mobile/src/features/material: findings of the material checker (ING-06), the student's own
// votes, and the vote RPC. define.ts explains the contract.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { dataRoute, dbFailure, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();

const COLUMNS = 'id,document_id,subject_id,node_id,related_document_id,type,severity,page_start,page_end,related_page,description,suggested_fix,status,confirmations,dismissals';

export const routes: DataRoute[] = [
  dataRoute({
    name: 'material-findings',
    write: false,
    input: z
      .object({ document_id: Id.optional(), node_id: Id.optional() })
      .refine((f) => !!(f.document_id || f.node_id), 'document_id or node_id is required'),
    example: (seed) => ({ document_id: seed.documentId }),
    run: ({ db, input }) => {
      let q = db.from('material_findings').select(COLUMNS);
      if (input.document_id) q = q.eq('document_id', input.document_id);
      if (input.node_id) q = q.eq('node_id', input.node_id);
      return rows(q.limit(60), 'material_findings');
    },
  }),

  dataRoute({
    // The caller's votes on these findings (RLS shows only their own).
    name: 'material-finding-votes',
    write: false,
    input: z.object({ finding_ids: z.array(Id).min(1).max(200) }),
    example: (seed) => ({ finding_ids: [seed.missingId] }),
    run: ({ db, input }) => rows(db.from('material_finding_votes').select('finding_id,vote').in('finding_id', input.finding_ids), 'material_finding_votes'),
  }),

  dataRoute({
    // Keeps the counters and the status consistent (vote_material_finding); answers the finding's new status.
    name: 'material-finding-vote',
    write: true,
    input: z.object({ finding_id: Id, vote: z.enum(['is_error', 'not_error']) }),
    example: (seed) => ({ finding_id: seed.missingId, vote: 'is_error' }),
    run: async ({ db, input }) => {
      const res = await db.rpc('vote_material_finding', { p_finding: input.finding_id, p_vote: input.vote });
      if (res.error) {
        // The function raises P0002 for a finding that does not exist or that the student cannot read.
        if (res.error.code === 'P0002') throw new ApiFailure('not_found');
        throw dbFailure(res.error, 'vote_material_finding');
      }
      const data = res.data as Array<{ status: string }> | null;
      return { status: data?.[0]?.status ?? 'open' };
    },
  }),
];
