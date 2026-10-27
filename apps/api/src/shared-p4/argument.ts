// Treino de Argumentação (INT-03, spec 12 §7.5, §8.7): session loading, the thesis step and one debate round.
// The opponent reply and the round feedback run in parallel. School sessions replay the topic slices of the
// first round (stored, never selectable by the client); ENEM sessions send no documents.
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTask, type RawTurn } from '@studify/prompts';
import { ApiFailure, type ArgumentCriteria, type ArgumentRound } from '@studify/shared';
import { callTask, citationsForStorage, unwrapResult } from '../shared/ai.ts';
import { loadSubject } from '../shared/access.ts';
import { budgetCtxFor } from '../shared/ctx.ts';
import { claudeDepsFor, type Deps } from '../shared/deps.ts';
import { slicesFromStored, type StoredSlice } from '../shared/retrieval.ts';
import { restoreTurns, stripSupport, toStoredTurns } from '../shared-p3/teaching.ts';

export interface ArgumentRow {
  id: string;
  user_id: string;
  goal_mode: 'exam_week' | 'enem';
  subject_id: string | null;
  theme: string;
  theme_id: string | null;
  theme_source: 'suggested' | 'enem' | 'custom';
  mode: 'debate' | 'build';
  thesis: string | null;
  thesis_feedback: unknown;
  rounds: ArgumentRound[];
  round_limit: number;
  raw_turns: RawTurn[];
  context: { node_id?: string | null; slices?: StoredSlice[] };
  rubric: unknown;
  summary: unknown;
  outline: unknown;
  essay_id: string | null;
  status: 'active' | 'finished' | 'abandoned';
  deleted_at: string | null;
}

export async function loadOwnArgument(db: SupabaseClient, userId: string, sessionId: string): Promise<ArgumentRow | null> {
  const res = await db.from('argument_sessions').select('*').eq('id', sessionId).maybeSingle();
  if (res.error) throw res.error;
  const row = res.data as ArgumentRow | null;
  if (!row || row.user_id !== userId || row.deleted_at) return null;
  return row;
}

/** Fixed openings (no AI): the student states the thesis first (INT-03.4). */
export function argumentOpening(theme: string, mode: 'debate' | 'build', goalMode: 'exam_week' | 'enem'): string {
  if (mode === 'debate') return `Bora treinar! 🗣️ Tema: "${theme}". Eu vou fazer o papel de Advogado do Diabo. Primeiro, escreva sua tese em 1–2 frases: qual é a sua posição?`;
  return `Vamos construir seu argumento passo a passo. Tema: "${theme}". Comece pela tese, em 1–2 frases.${goalMode === 'enem' ? ' No fim, a conclusão vira uma proposta de intervenção.' : ''}`;
}

export interface ThesisOutcome {
  feedback: { clear: boolean; has_position: boolean; specific: boolean; feedback: string; suggestion: string | null };
}

export async function runThesisStep(deps: Deps, session: ArgumentRow, thesis: string): Promise<ThesisOutcome> {
  const subject = session.subject_id ? await loadSubject(deps.db, session.subject_id) : null;
  const built = getTask('argument.thesis').build({ theme: session.theme, thesis });
  const feedback = unwrapResult(await callTask(claudeDepsFor(deps), { built, taskId: 'argument.thesis', ctx: budgetCtxFor(subject, session.user_id, 'INT-03', 'user') })) as ThesisOutcome['feedback'];
  const update = await deps.db.from('argument_sessions').update({ thesis, thesis_feedback: feedback }).eq('id', session.id);
  if (update.error) throw update.error;
  session.thesis = thesis;
  session.thesis_feedback = feedback;
  return { feedback };
}

export interface RoundOutcome {
  reply: string;
  support: boolean;
  round: number;
  final: boolean;
  feedback: ArgumentRound['feedback'];
  citations: ReturnType<typeof citationsForStorage>;
}

/** One debate round: opponent reply (citations in school mode) and micro-feedback, in parallel (spec 12 §7.5). */
export async function runArgumentRound(deps: Deps, session: ArgumentRow, message: string, now: Date): Promise<RoundOutcome> {
  if (!session.thesis) throw new ApiFailure('invalid_request', { message: 'Escreva sua tese primeiro.' });
  const round = session.rounds.length + 1;
  if (round > session.round_limit) throw new ApiFailure('invalid_request', { message: 'As rodadas acabaram. Toque em "Terminar" para ver o resumo.' });
  const subject = session.subject_id ? await loadSubject(deps.db, session.subject_id) : null;
  const ctxFor = () => budgetCtxFor(subject, session.user_id, 'INT-03', 'user', { nodeId: session.context.node_id ?? null });
  const stored = session.context.slices ?? [];
  const school = session.goal_mode === 'exam_week' && stored.length > 0;
  const taskId = school ? 'argument.reply' : 'argument.replyGeneral';
  const history = await restoreTurns(deps.db, session.raw_turns, stored);
  const slices = school && history.length === 0 ? await slicesFromStored(deps, stored, new Map()) : [];
  const built = getTask(taskId).build({ theme: session.theme, mode: session.mode, thesis: session.thesis, round, roundLimit: session.round_limit, history, message, slices });
  const lastOpponent = session.rounds[session.rounds.length - 1]?.opponent_text ?? null;
  const feedbackBuilt = getTask('argument.feedback').build({ theme: session.theme, goalMode: session.goal_mode, thesis: session.thesis, round, opponentText: lastOpponent, argument: message });
  const [reply, feedbackResult] = await Promise.all([
    callTask(claudeDepsFor(deps), {
      built,
      taskId,
      ctx: ctxFor(),
      ...(school && history.length > 0 ? { historySources: stored.map((s) => ({ id: s.row_id, documentId: s.document_id, title: s.title, pages: s.pages })) } : {}),
    }),
    callTask(claudeDepsFor(deps), { built: feedbackBuilt, taskId: 'argument.feedback', ctx: ctxFor() }),
  ]);
  const text = unwrapResult(reply) as string;
  const feedback = unwrapResult(feedbackResult) as ArgumentRound['feedback'];
  const { text: clean, support } = stripSupport(text);
  const citations = citationsForStorage(reply.citations);

  const newTurns = toStoredTurns(built.messages.slice(history.length) as RawTurn[], stored);
  const rawTurns: RawTurn[] = [...session.raw_turns, ...newTurns, { role: 'assistant', content: reply.content }];
  const entry: ArgumentRound = { user_text: message, opponent_text: clean, feedback, ...(citations.length ? { citations } : {}), at: now.toISOString() };
  const rounds = [...session.rounds, entry];
  const update = await deps.db.from('argument_sessions').update({ rounds, raw_turns: rawTurns }).eq('id', session.id);
  if (update.error) throw update.error;
  session.rounds = rounds;
  session.raw_turns = rawTurns;
  return { reply: clean, support, round, final: round >= session.round_limit, feedback, citations };
}

/** Rubric total in % of the 24 points (6 criteria × 4). */
export function rubricTotal(c: ArgumentCriteria): number {
  return Math.round(((c.tese + c.fundamentacao + c.repertorio + c.coerencia + c.refutacao + c.falacias) / 24) * 100);
}
