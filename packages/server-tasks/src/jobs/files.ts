// files.sweep (api.md §7): hourly cleanup of expired Files API uploads (ai-pipeline §4.2).
import type { OperationDefinition } from '../framework/types.ts';
import { runFilesSweep } from '../ingest/sweep.ts';

export const jobs: OperationDefinition<any>[] = [
  {
    name: 'files.sweep',
    schedule: '17 * * * *',
    handler: async (ctx) => {
      const result = await runFilesSweep(ctx, ctx.now().getTime());
      ctx.log.info(result, 'files sweep finished');
    },
  },
];
