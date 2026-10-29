// Server-sent events of streaming Edge endpoints (api.md §2.6). Citations arrive as separate events
// so the UI can render 📄 chips progressively; `start`/`end` refer to the final concatenated text.
import { z } from 'zod';
import { CitationBaseSchema } from '../citations.ts';
import { ApiErrorBodySchema } from '../errors.ts';
import { UuidSchema } from './common.ts';

const metaSchema = z.object({
  request_id: z.string().min(1).optional(),
  message_id: UuidSchema.optional(),
  thread_id: UuidSchema.optional(),
  explanation_id: UuidSchema.optional(), // `explain` opens with this id
  capture_id: UuidSchema.optional(), // capture-act (CAM-01, CAM-02)
  session_id: UuidSchema.optional(), // teaching-turn (INT-02)
  interaction_id: UuidSchema.optional(), // podcast-ask (INT-01.8)
});

export const SseEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('meta'), data: metaSchema }),
  z.object({ event: z.literal('delta'), data: z.object({ text: z.string() }) }),
  z.object({
    event: z.literal('citation'),
    data: CitationBaseSchema.extend({ index: z.int().min(0) }),
  }),
  z.object({ event: z.literal('tool'), data: z.object({ name: z.string().min(1), payload: z.unknown() }) }),
  z.object({
    event: z.literal('status'),
    data: z.object({ key: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() }),
  }),
  z.object({
    event: z.literal('done'),
    data: z.object({
      stop_reason: z.enum(['end_turn', 'max_tokens', 'refusal']),
      usage_pct_today: z.int().min(0).max(100), // percent only, never dollars (PLT-04.2)
      result: z.unknown().optional(),
      status: z.int().min(200).max(399).optional(),
    }),
  }),
  z.object({ event: z.literal('error'), data: ApiErrorBodySchema.extend({ status: z.int().min(400).max(599).optional() }) }),
]);
export type SseEvent = z.infer<typeof SseEventSchema>;
