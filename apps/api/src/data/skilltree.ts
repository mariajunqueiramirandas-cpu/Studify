// Data endpoints of apps/mobile/src/features/skilltree (define.ts explains the contract): the Mapa's prerequisite
// edges and boss attempts, read online when available (units and topics come from SQLite).
import { z } from 'zod';
import { dataRoute, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();

export const routes: DataRoute[] = [
  dataRoute({
    name: 'skilltree-prereqs',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: async ({ db, input }) => {
      const nodes = await rows<{ id: string }>(db.from('knowledge_nodes').select('id').eq('subject_id', input.subject_id).eq('kind', 'topic').is('deleted_at', null));
      if (!nodes.length) return [];
      return rows(db.from('node_prerequisites').select('node_id,prerequisite_node_id').in('node_id', nodes.map((n) => n.id)));
    },
  }),

  dataRoute({
    name: 'skilltree-boss-attempts',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) => rows(db.from('boss_attempts').select('unit_node_id,passed,score,created_at').eq('user_id', user.userId).order('created_at', { ascending: false }).limit(200)),
  }),
];
