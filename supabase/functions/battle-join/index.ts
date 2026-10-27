// battle-join — SOC-03.2–3, SOC-03.7. Joins a live battle by its 4-digit PIN. Only Turma members can join.
// Joining is allowed in the lobby or while question 1 or 2 is current; a rejoin keeps the score.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../_shared_p2/http.ts';
import { displayNameOf, nicknameOrName, requireActiveMember } from '../_shared_p2/turma.ts';
import { LIVE_BATTLE_STATUSES, MAX_BATTLE_PLAYERS, canJoinNow, type BattleStatus } from '../_shared_p2/battle.ts';
import { rosterOf } from '../_shared_p2/battle-ops.ts';

export const BattleJoinInput = z.object({ pin: z.string().regex(/^\d{4}$/, 'PIN de 4 dígitos') });
export type BattleJoinInput = z.infer<typeof BattleJoinInput>;

export const handler = defineP2<BattleJoinInput>({
  name: 'battle-join',
  mutating: true,
  input: BattleJoinInput,
  run: async (ctx) => {
    const { p2, input: i, now } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;

    const found = await db
      .from('battles')
      .select('id, class_group_id, quiz_id, status, current_index')
      .eq('pin', i.pin)
      .in('status', [...LIVE_BATTLE_STATUSES])
      .maybeSingle();
    if (found.error) throw found.error;
    if (!found.data) throw new ApiFailure('not_found', { message: 'Não encontrei uma batalha com esse PIN.' });
    const battle = found.data as {
      id: string;
      class_group_id: string;
      quiz_id: string;
      status: string;
      current_index: number;
    };

    const member = await requireActiveMember(db, battle.class_group_id, me);
    const existing = await db.from('battle_players').select('nickname, quiz_attempt_id').eq('battle_id', battle.id).eq(
      'user_id',
      me,
    ).maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      return ctx.json({
        battle_id: battle.id,
        nickname: existing.data.nickname,
        status: battle.status,
        current_index: battle.current_index,
        server_time: now.toISOString(),
        rejoined: true,
      });
    }

    if (!canJoinNow({ status: battle.status as BattleStatus, current_index: battle.current_index })) {
      throw new ApiFailure('invalid_request', { message: 'Essa batalha já começou. Peça pra quem criou abrir outra.' });
    }
    if ((await rosterOf(db, battle.id)).length >= MAX_BATTLE_PLAYERS) {
      throw new ApiFailure('invalid_request', { message: 'Essa batalha já está cheia.' });
    }

    const nickname = nicknameOrName(member, await displayNameOf(db, me));
    const attemptId = p2.newId();
    const attempt = await db.from('quiz_attempts').insert({
      id: attemptId,
      user_id: me,
      quiz_id: battle.quiz_id,
      status: 'in_progress',
      started_at: now.toISOString(),
      device_id: ctx.req.headers.get('x-device-id') ?? 'server',
    });
    if (attempt.error) throw attempt.error;
    const player = await db.from('battle_players').insert({
      battle_id: battle.id,
      user_id: me,
      nickname,
      score: 0,
      answer_streak: 0,
      joined_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      quiz_attempt_id: attemptId,
    });
    if (player.error) {
      if (player.error.code === '23505') {
        throw new ApiFailure('already_exists', { message: 'Você já entrou nessa batalha.' });
      }
      throw player.error;
    }
    return ctx.json({
      battle_id: battle.id,
      nickname,
      status: battle.status,
      current_index: battle.current_index,
      server_time: now.toISOString(),
    });
  },
});

if (import.meta.main) {
  const { prodP2Deps } = await import('../_shared_p2/prod.ts');
  const deps = prodP2Deps();
  Deno.serve((req) => handler(req, deps));
}
