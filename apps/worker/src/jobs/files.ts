// files.sweep (api.md §7): hourly cleanup of expired Files API uploads (ai-pipeline §4.2).
import type { JobDefinition } from '../framework/types.ts';
import { runFilesSweep } from '../ingest/sweep.ts';

export const jobs: JobDefinition<any>[] = [
  {
    name: 'files.sweep',
    schedule: '17 * * * *',
    retryLimit: 1,
    expireInSeconds: 900,
    handler: async (ctx) => {
      const result = await runFilesSweep(ctx, ctx.now().getTime());
      ctx.log.info(result, 'files sweep finished');
    },
  },
];
