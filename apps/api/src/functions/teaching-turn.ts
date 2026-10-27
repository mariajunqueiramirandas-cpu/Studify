// teaching-turn (INT-02.4–02.6, INT-02.10; api §4.8). One student message to Lucas. The reply arrives over SSE
// (meta → delta → done); the evaluation is applied server-side and never shown during the lesson. The last
// turn of the lesson is Lucas's teach-back (INT-02.6). Distress steps out of character with the help card.
import { ApiFailure, TeachingTurnReqSchema, type TeachingTurnReq } from '@studify/shared';
import { defineFunction } from '../shared/http.ts';
import { loadOwnSession } from '../shared-p3/teaching.ts';
import { runLucasTurn } from '../shared-p3/lucas.ts';

export const handler = defineFunction<TeachingTurnReq>({
  name: 'teaching-turn',
  mutating: true,
  aiCall: true,
  input: TeachingTurnReqSchema,
  run: async (ctx) => {
    const { deps, input } = ctx;
    const session = await loadOwnSession(deps.db, ctx.user.userId, input.session_id);
    if (!session) throw new ApiFailure('not_found');
    if (session.status !== 'active') throw new ApiFailure('invalid_request', { message: 'Essa aula já terminou.' });
    // The call happens before the stream opens, so budget and AI errors keep their HTTP status.
    const outcome = await runLucasTurn(deps, session, input.message, ctx.now);
    return ctx.sse(async (writer) => {
      writer.send('meta', { request_id: ctx.requestId, session_id: session.id });
      writer.send('delta', { text: outcome.reply });
      writer.send('done', {
        stop_reason: 'end_turn',
        usage_pct_today: await ctx.usagePct(),
        result: { turn: outcome.turn, turn_limit: outcome.turnLimit, final: outcome.final, support: outcome.support, safety: outcome.safety },
      });
    });
  },
});

export default handler;
