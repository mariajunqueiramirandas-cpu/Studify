// prova-provavel-generate — PRA-09.7–8. Queues `pp.generate` for an exam the caller owns. The first generation is
// free; a regeneration is allowed up to 3 times per exam per user (PRA-09.8). The worker reserves AI budget.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';

export const ProvaProvavelInput = z.object({ exam_id: z.uuid(), regenerate: z.boolean().optional() });
export type ProvaProvavelInput = z.infer<typeof ProvaProvavelInput>;

/** One first generation plus three regenerations. */
export const PP_MAX_GENERATIONS = 4;

export const handler = defineP2<ProvaProvavelInput>({
  name: 'prova-provavel-generate',
  mutating: true,
  input: ProvaProvavelInput,
  run: async (ctx) => {
    const { p2, input: i } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;

    const exam = await db.from('exams').select('id, user_id').eq('id', i.exam_id).is('deleted_at', null).maybeSingle();
    if (exam.error) throw exam.error;
    if (!exam.data || exam.data.user_id !== me) throw new ApiFailure('not_found');

    const existing = await db.from('quizzes').select('id, scope').eq('owner_id', me).eq('kind', 'predicted_test').is(
      'deleted_at',
      null,
    );
    if (existing.error) throw existing.error;
    const generations = (existing.data ?? []).filter((q) =>
      (q.scope as { exam_id?: string } | null)?.exam_id === i.exam_id
    ).length;
    if (generations > 0 && !i.regenerate) {
      throw new ApiFailure('already_exists', {
        message: 'Você já tem uma Prova Provável pra essa prova. Quer gerar outra?',
      });
    }
    if (generations >= PP_MAX_GENERATIONS) throw new ApiFailure('regenerate_limit');

    const jobId = await p2.enqueue(
      'pp.generate',
      { exam_id: i.exam_id, user_id: me },
      { singletonKey: `pp-generate:${me}:${i.exam_id}` },
    );
    if (!jobId) {
      throw new ApiFailure('already_exists', {
        message: 'Já estou gerando essa prova. Espera um pouquinho.',
      });
    }
    return ctx.json({ job_id: jobId, quiz_id_when_ready: null }, 202);
  },
});
