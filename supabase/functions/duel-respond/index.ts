// duel-respond — SOC-02.5. The opponent accepts (gets the attempt to play) or declines (no penalty, SOC-02.10).
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../_shared_p2/http.ts';
import { isDuelOpen, loadDuel } from '../_shared_p2/duel.ts';

export const DuelRespondInput = z.object({ duel_id: z.uuid(), accept: z.boolean() });
export type DuelRespondInput = z.infer<typeof DuelRespondInput>;

export const handler = defineP2<DuelRespondInput>({
  name: 'duel-respond',
  mutating: true,
  input: DuelRespondInput,
  run: async (ctx) => {
    const { p2, input: i, now } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;
    const duel = await loadDuel(db, i.duel_id);
    if (!duel || (duel.challenger_id !== me && duel.opponent_id !== me)) throw new ApiFailure('not_found');
    if (duel.opponent_id !== me) {
      throw new ApiFailure('forbidden', { message: 'Só quem foi desafiado pode responder.' });
    }
    if (!isDuelOpen(duel, now)) throw new ApiFailure('duel_not_open');

    if (!i.accept) {
      if (duel.opponent_attempt_id) throw new ApiFailure('duel_not_open');
      const declined = await db
        .from('duels')
        .update({ status: 'declined' })
        .eq('id', duel.id)
        .eq('status', 'waiting_opponent')
        .is('opponent_attempt_id', null)
        .select('id');
      if (declined.error) throw declined.error;
      if (!declined.data || declined.data.length === 0) throw new ApiFailure('duel_not_open');
      return ctx.json({ duel_id: duel.id, status: 'declined' });
    }

    // Accepting is idempotent: a second accept returns the attempt already created.
    if (duel.opponent_attempt_id) return ctx.json({ duel_id: duel.id, attempt_id: duel.opponent_attempt_id });
    const attemptId = p2.newId();
    const claimed = await db
      .from('duels')
      .update({ opponent_attempt_id: attemptId })
      .eq('id', duel.id)
      .eq('status', 'waiting_opponent')
      .is('opponent_attempt_id', null)
      .select('id');
    if (claimed.error) throw claimed.error;
    if (!claimed.data || claimed.data.length === 0) {
      const again = await loadDuel(db, duel.id);
      if (again?.opponent_attempt_id) return ctx.json({ duel_id: duel.id, attempt_id: again.opponent_attempt_id });
      throw new ApiFailure('duel_not_open');
    }
    const attempt = await db.from('quiz_attempts').insert({
      id: attemptId,
      user_id: me,
      quiz_id: duel.quiz_id,
      status: 'in_progress',
      started_at: now.toISOString(),
      device_id: ctx.req.headers.get('x-device-id') ?? 'server',
    });
    if (attempt.error) throw attempt.error;
    return ctx.json({ duel_id: duel.id, attempt_id: attemptId });
  },
});

if (import.meta.main) {
  const { prodP2Deps } = await import('../_shared_p2/prod.ts');
  const deps = prodP2Deps();
  Deno.serve((req) => handler(req, deps));
}
