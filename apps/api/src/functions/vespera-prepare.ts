// vespera-prepare (GOL-07). The Modo Véspera sheet is normally pre-generated at D−1 04:00 by the worker.
// This endpoint queues vespera.prepare for the student's exam and answers "preparing". The ready path
// (returning sheet_note_id) needs the exam → sheet link, which is not in the data model yet.
import { z } from 'zod';
import { ApiFailure, VesperaPrepareReqSchema } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';

type Req = z.infer<typeof VesperaPrepareReqSchema>;

export const handler = defineFunction<Req>({
  name: 'vespera-prepare',
  mutating: true,
  input: VesperaPrepareReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const exam = await deps.db.from('exams').select('id, user_id, status').eq('id', input.exam_id).is('deleted_at', null).maybeSingle();
    if (exam.error) throw exam.error;
    if (!exam.data || exam.data.user_id !== userId) throw new ApiFailure('not_found');
    if (exam.data.status === 'cancelled' || exam.data.status === 'done') {
      throw new ApiFailure('invalid_request', { message: 'Essa prova não está mais agendada.' });
    }
    const jobId = await deps.execute('vespera.prepare', { exam_id: input.exam_id, user_id: userId }, { singletonKey: input.exam_id, });
    return ctx.json({ status: 'preparing', job_id: jobId ?? '' }, 202);
  },
});

export default handler;
