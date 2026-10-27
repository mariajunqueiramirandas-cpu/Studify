// argument-turn (INT-03.4–03.6; api §4.8). The first message is the thesis (immediate feedback on clarity and
// position); every later message is a round: the opponent's move and the micro-feedback on the argument. The
// reply arrives over SSE (meta → delta → citation* → done), like teaching-turn.
import { ApiFailure, ArgumentTurnReqSchema, type ArgumentTurnReq, type ArgumentTurnResult } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { loadOwnArgument, runArgumentRound, runThesisStep } from '../shared-p4/argument.ts';

export const handler = defineFunction<ArgumentTurnReq>({
  name: 'argument-turn',
  mutating: true,
  aiCall: true,
  input: ArgumentTurnReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const session = await loadOwnArgument(deps.db, ctx.user.userId, input.session_id);
    if (!session) throw new ApiFailure('not_found');
    if (session.status !== 'active') throw new ApiFailure('invalid_request', { message: 'Esse treino já terminou.' });

    if (!session.thesis) {
      const outcome = await runThesisStep(deps, session, input.message.trim());
      return ctx.sse(async (writer) => {
        writer.send('meta', { request_id: ctx.requestId, session_id: session.id });
        writer.send('delta', { text: outcome.feedback.feedback });
        writer.send('done', { stop_reason: 'end_turn', usage_pct_today: await ctx.usagePct(), result: { stage: 'thesis', thesis_feedback: outcome.feedback } satisfies ArgumentTurnResult });
      });
    }

    const outcome = await runArgumentRound(deps, session, input.message, ctx.now);
    return ctx.sse(async (writer) => {
      writer.send('meta', { request_id: ctx.requestId, session_id: session.id });
      writer.send('delta', { text: outcome.reply });
      for (const c of outcome.citations) writer.send('citation', c);
      writer.send('done', {
        stop_reason: 'end_turn',
        usage_pct_today: await ctx.usagePct(),
        result: { stage: 'round', round: outcome.round, round_limit: session.round_limit, final: outcome.final, feedback: outcome.feedback } satisfies ArgumentTurnResult,
        ...(outcome.support ? { support: true } : {}),
      });
    });
  },
});

export default handler;
