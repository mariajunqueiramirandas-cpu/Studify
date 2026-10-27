// Framework-owned jobs: deferred push delivery (quiet hours, PLT-05.3) and Expo receipt checks.
// Registered by runtime.ts alongside the job modules in src/jobs/.
import type { JobDefinition } from './types.ts';
import type { PushMessage, PushService } from './push.ts';
import { parsePayload } from './errors.ts';
import { z } from 'zod';

const DeliverPayload = z.object({
  userId: z.uuid(),
  logId: z.string().default(''),
  message: z.object({
    channel: z.enum(['reviews', 'plan', 'class', 'processing']),
    title: z.string().min(1),
    body: z.string().min(1),
    data: z.record(z.string(), z.unknown()).optional(),
    requested: z.boolean().optional(),
  }),
});

const ReceiptsPayload = z.object({
  receipts: z.array(z.object({ id: z.string().min(1), token: z.string().min(1) })).max(1000),
  attempt: z.number().int().min(1).default(1),
});

/** Built-in definitions. `push` is the framework push service bound to this runtime. */
export function builtinJobs(push: () => PushService): JobDefinition<any>[] {
  return [
    {
      name: 'notify.deliver',
      retryLimit: 3,
      handler: async (_ctx, data) => {
        const payload = parsePayload(DeliverPayload, data, 'notify.deliver');
        await push().deliverDeferred({
          userId: payload.userId,
          logId: payload.logId,
          message: payload.message as PushMessage,
        });
      },
    },
    {
      name: 'push.receipts',
      retryLimit: 2,
      handler: async (_ctx, data) => {
        const payload = parsePayload(ReceiptsPayload, data, 'push.receipts');
        await push().checkReceipts({ receipts: payload.receipts });
      },
    },
  ];
}
