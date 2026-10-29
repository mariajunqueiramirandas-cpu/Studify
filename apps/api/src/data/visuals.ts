// Data endpoints of apps/mobile/src/features/visuals (define.ts explains the contract).
import { z } from 'zod';
import { dataRoute, maybe, type DataRoute } from './define.ts';

const Id = z.string().uuid();

export const routes: DataRoute[] = [
  dataRoute({
    name: 'visuals-get',
    write: false,
    input: z.object({ visual_id: Id }),
    example: (seed) => ({ visual_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('visuals').select('id,node_id,type,title,spec,alt_text,source_pages').eq('id', input.visual_id).maybeSingle()),
  }),
];
