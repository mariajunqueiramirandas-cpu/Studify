// problem-check-work (PRA-08.5 "Mostrar meu raciocínio"). The student types (or photographs and confirms,
// CAM-03) the working of a `problem` item; problems.firstWrongStep points at the first wrong step and gives a
// nudge without revealing the rest of the solution. The working is fenced as data in the prompt.
import { ApiFailure, ProblemCheckWorkReqSchema, parseQuestionPayload, type ProblemCheckWorkRes } from '@studify/shared';
import { getTask } from '@studify/prompts';
import type { z } from 'zod';
import { defineFunction } from '../shared/http.ts';
import { requireSubject } from '../shared/access.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';

export const handler = defineFunction<z.infer<typeof ProblemCheckWorkReqSchema>>({
  name: 'problem-check-work',
  mutating: true,
  aiCall: true,
  input: ProblemCheckWorkReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const userId = ctx.user.userId;
    const q = await deps.db.from('questions').select('id, subject_id, node_id, type, stem, payload, personal_for_user_id').eq('id', input.question_id).is('deleted_at', null).maybeSingle();
    if (q.error) throw q.error;
    if (!q.data || (q.data.personal_for_user_id && q.data.personal_for_user_id !== userId)) throw new ApiFailure('not_found');
    if (q.data.type !== 'problem') throw new ApiFailure('invalid_request', { message: 'Isso só vale para problemas.' });
    const subject = await requireSubject(deps.db, userId, q.data.subject_id as string, 'read');
    const payload = parseQuestionPayload('problem', q.data.payload);
    const built = getTask('problems.firstWrongStep').build({
      problem: { statement: q.data.stem as string, solutionSteps: payload.solution_steps, finalAnswer: String(payload.final_answer) },
      working: input.working,
      contentLanguage: subject.content_language ?? 'pt-BR',
      languageSubject: subject.is_language_subject,
    });
    const result = await callTask(claudeDepsFor(deps), {
      built,
      taskId: 'problems.firstWrongStep',
      ctx: budgetCtxFor(subject, userId, 'PRA-08', 'user', { nodeId: q.data.node_id as string }),
    });
    const data = unwrapResult(result) as { student_steps: string[]; first_wrong_step_index: number | null; what_went_wrong: string; nudge: string };
    const index = data.first_wrong_step_index !== null && data.first_wrong_step_index < data.student_steps.length ? data.first_wrong_step_index : null;
    const body: ProblemCheckWorkRes = { first_wrong_step_index: index, what_went_wrong: data.what_went_wrong, nudge: data.nudge };
    return ctx.json(body);
  },
});

export default handler;
