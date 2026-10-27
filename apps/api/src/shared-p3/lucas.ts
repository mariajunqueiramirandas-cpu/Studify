// One Lucas turn (INT-02, spec 12 §7.3): replay the stored turns, add the student's message and the current
// evaluation state as an appended system message (ai-pipeline §6.6 rule 4), call lucas.turn, fold the
// evaluation into the state, and append the new turns. Used by teaching-turn and by teaching-finish for the
// teach-back of a lesson the student ends early (INT-02.6).
import { getTask, type RawTurn } from '@studify/prompts';
import { ApiFailure, LUCAS_TURNS, applyLucasEvaluation, misconceptionsDue, type LucasEvaluationState } from '@studify/shared';
import { callTask, unwrapResult } from '../shared/ai.ts';
import { loadSubject } from '../shared/access.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor, type Deps } from '../shared/deps.ts';
import { slicesFromStored } from '../shared/retrieval.ts';
import { mapTurnEvaluation, restoreTurns, stripSupport, toStoredTurns, type TeachingRow } from './teaching.ts';

export interface LucasTurnOutcome {
  reply: string;
  support: boolean;
  safety: 'ok' | 'distress' | 'off_topic' | 'inappropriate';
  turn: number;
  turnLimit: number;
  final: boolean;
  state: LucasEvaluationState;
}

interface TurnOut {
  lucas_reply: string;
  safety: LucasTurnOutcome['safety'];
  evaluation: Parameters<typeof mapTurnEvaluation>[0];
}

export async function runLucasTurn(deps: Deps, session: TeachingRow, message: string, now: Date, forceFinal = false): Promise<LucasTurnOutcome> {
  const turnLimit = LUCAS_TURNS[session.length];
  if (session.turn_count >= turnLimit && !forceFinal) {
    throw new ApiFailure('invalid_request', { message: 'A aula acabou. Toque em "Terminar aula" para ver o resultado.' });
  }
  const turn = session.turn_count + 1;
  const final = forceFinal || turn >= turnLimit;
  const plan = session.plan;
  const history = await restoreTurns(deps.db, session.raw_turns, plan.slices);
  const slices = history.length === 0 ? await slicesFromStored(deps, plan.slices, new Map()) : [];
  const topic = await deps.db.from('knowledge_nodes').select('title').eq('id', session.node_id).maybeSingle();
  const built = getTask('lucas.turn').build({
    history,
    topicTitle: (topic.data?.title as string | undefined) ?? '',
    plan: plan.model,
    slices,
    opener: plan.scoring.opener,
    message,
    turn,
    turnLimit,
    final,
    evaluationState: session.evaluation_state,
    dueMisconceptions: misconceptionsDue(plan.scoring, session.evaluation_state, turn),
  });
  const subject = await loadSubject(deps.db, session.subject_id);
  const result = await callTask(claudeDepsFor(deps), {
    built,
    taskId: 'lucas.turn',
    ctx: budgetCtxFor(subject, session.user_id, 'INT-02', 'user', { nodeId: session.node_id }),
    // Earlier document blocks are replayed: their slices count for the estimate and the citation map.
    historySources: history.length > 0 ? plan.slices.map((s) => ({ id: s.row_id, documentId: s.document_id, title: s.title, pages: s.pages })) : [],
    // Later turns send no document block: errors_taught may still cite the pages of the first turn.
    textPages: plan.documents.allowedPages,
  });
  const out = unwrapResult(result) as TurnOut;
  const state = applyLucasEvaluation(session.evaluation_state, mapTurnEvaluation(out.evaluation, plan.documents));
  const { text: reply, support } = stripSupport(out.lucas_reply);

  const newTurns = toStoredTurns(built.messages.slice(history.length) as RawTurn[], plan.slices);
  const rawTurns: RawTurn[] = [...session.raw_turns, ...newTurns, { role: 'assistant', content: result.content }];
  const at = now.toISOString();
  const messages = [
    ...session.messages,
    ...(forceFinal && message.startsWith('(') ? [] : [{ role: 'student' as const, text: message, at }]),
    { role: 'lucas' as const, text: reply, at },
  ];
  const update = await deps.db
    .from('teaching_sessions')
    .update({ raw_turns: rawTurns, messages, evaluation_state: state, turn_count: turn, ...(final ? { teach_back: reply } : {}) })
    .eq('id', session.id);
  if (update.error) throw update.error;
  session.raw_turns = rawTurns;
  session.messages = messages;
  session.evaluation_state = state;
  session.turn_count = turn;
  if (final) session.teach_back = reply;
  return { reply, support: support || out.safety === 'distress', safety: out.safety, turn, turnLimit, final, state };
}
