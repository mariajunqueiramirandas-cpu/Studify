// Data endpoints of apps/mobile/src/features/tutor (define.ts explains the contract): the thread list, a thread's
// messages, rating an answer and archiving a thread. Chatting itself is tutor-chat.
import { z } from 'zod';
import { dataRoute, done, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();

export const routes: DataRoute[] = [
  dataRoute({
    name: 'tutor-data-threads',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: ({ db, user }) =>
      rows(db.from('tutor_threads').select('*').eq('user_id', user.userId).is('archived_at', null).order('last_message_at', { ascending: false, nullsFirst: false }).limit(100)),
  }),

  dataRoute({
    name: 'tutor-data-messages',
    write: false,
    input: z.object({ thread_id: Id }),
    example: (seed) => ({ thread_id: seed.missingId }),
    run: ({ db, input }) => rows(db.from('tutor_messages').select('*').eq('thread_id', input.thread_id).order('created_at')),
  }),

  dataRoute({
    name: 'tutor-data-rate',
    write: true,
    input: z.object({ message_id: Id, feedback: z.union([z.literal(-1), z.literal(1)]), reason: z.string().max(500).optional() }),
    example: (seed) => ({ message_id: seed.missingId, feedback: 1 as const }),
    run: async ({ db, input }) => {
      await done(db.from('tutor_messages').update({ feedback: input.feedback, feedback_reason: input.reason ?? null }).eq('id', input.message_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'tutor-data-archive',
    write: true,
    input: z.object({ thread_id: Id }),
    example: (seed) => ({ thread_id: seed.missingId }),
    run: async ({ db, input, now }) => {
      await done(db.from('tutor_threads').update({ archived_at: now.toISOString() }).eq('id', input.thread_id));
      return { ok: true };
    },
  }),
];
