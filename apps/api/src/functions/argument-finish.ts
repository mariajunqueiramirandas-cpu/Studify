// argument-finish (INT-03.7; api §4.8). The session summary: overall rubric (spec 12 §8.7), strongest argument,
// weakest point, fallacies and repertório suggestions; in ENEM mode an Esqueleto de redação that can open a
// redação draft ("Escrever redação com este esqueleto" → ENM-05).
import { getTask } from '@studify/prompts';
import { ApiFailure, ArgumentFinishReqSchema, type ArgumentFinishReq, type ArgumentFinishRes, type ArgumentCriteria, type EssayOutline } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { loadSubject } from '../shared/access.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor } from '../shared/deps.ts';
import { loadOwnArgument, rubricTotal } from '../shared-p4/argument.ts';

interface SummaryOut {
  rubric: ArgumentCriteria;
  strongest_argument: string | null;
  weakest_point: string | null;
  fallacies: Array<{ name: string; count: number }>;
  repertorio_suggestions: Array<{ text: string; origin: 'material' | 'geral' }>;
  strengths: string[];
  improve: string[];
  outline: EssayOutline | null;
}

/** The outline as a starting text for the redação editor (the student rewrites it in their own words). */
export function outlineDraft(o: EssayOutline): string {
  const p = o.conclusao.proposta;
  return [
    `${o.introducao.contexto} ${o.introducao.tese}`,
    `${o.d1.topico} ${o.d1.argumento}${o.d1.repertorio ? ` ${o.d1.repertorio}` : ''}`,
    `${o.d2.topico} ${o.d2.argumento}${o.d2.repertorio ? ` ${o.d2.repertorio}` : ''}`,
    `${o.conclusao.retomada} ${p.agente} deve ${p.acao}, ${p.meio}, ${p.finalidade}. ${p.detalhamento}`,
  ].join('\n\n');
}

export const handler = defineFunction<ArgumentFinishReq>({
  name: 'argument-finish',
  mutating: true,
  aiCall: true,
  input: ArgumentFinishReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const { db } = deps;
    const userId = ctx.user.userId;
    const session = await loadOwnArgument(db, userId, input.session_id);
    if (!session) throw new ApiFailure('not_found');
    if (!session.thesis || session.rounds.length === 0) throw new ApiFailure('invalid_request', { message: 'Faça pelo menos uma rodada antes de terminar.' });

    let out: SummaryOut;
    if (session.status === 'finished' && session.summary) {
      out = session.summary as SummaryOut;
    } else {
      const subject = session.subject_id ? await loadSubject(db, session.subject_id) : null;
      const built = getTask('argument.summary').build({
        theme: session.theme,
        goalMode: session.goal_mode,
        mode: session.mode,
        thesis: session.thesis,
        rounds: session.rounds.map((r) => ({ user_text: r.user_text, opponent_text: r.opponent_text, feedback: r.feedback })),
      });
      out = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'argument.summary', ctx: budgetCtxFor(subject, userId, 'INT-03', 'user') })) as SummaryOut;
      if (session.goal_mode !== 'enem') out = { ...out, outline: null };
    }
    const rubric = { ...out.rubric, total: rubricTotal(out.rubric) };

    let essayId = session.essay_id;
    if (input.create_essay && session.goal_mode === 'enem' && out.outline && !essayId) {
      essayId = deps.newId();
      const essay = await db.from('essays').insert({
        id: essayId,
        user_id: userId,
        kind: 'enem_redacao',
        theme_id: session.theme_id,
        text: outlineDraft(out.outline),
        input_mode: 'typed',
        status: 'draft',
        prompt: { theme: session.theme, outline: out.outline, argument_session_id: session.id },
      });
      if (essay.error) throw essay.error;
    }
    const update = await db
      .from('argument_sessions')
      .update({ status: 'finished', finished_at: session.status === 'finished' ? undefined : ctx.now.toISOString(), rubric, summary: out, outline: out.outline, essay_id: essayId })
      .eq('id', session.id);
    if (update.error) throw update.error;

    const body: ArgumentFinishRes = {
      rubric,
      summary: {
        strongest_argument: out.strongest_argument,
        weakest_point: out.weakest_point,
        fallacies: out.fallacies,
        repertorio_suggestions: out.repertorio_suggestions,
        strengths: out.strengths,
        improve: out.improve,
      },
      outline: out.outline,
      essay_id: essayId,
    };
    return ctx.json(body);
  },
});

export default handler;
