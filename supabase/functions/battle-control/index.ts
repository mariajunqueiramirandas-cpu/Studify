// battle-control — SOC-03.1–3, SOC-03.8. Host actions for a live battle. Any Turma member may create one
// (unless the Turma restricts hosting, class_groups.settings.battles_host). Start, next, end and kick are
// host-only. State changes broadcast `state` (and `podium`) on the private channel battle:{id}.
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../_shared_p2/http.ts';
import { activeMember, displayNameOf, loadGroup, nicknameOrName, requireActiveMember } from '../_shared_p2/turma.ts';
import { pickQuestions } from '../_shared_p2/questions.ts';
import { loadQuiz } from '../_shared_p2/duel.ts';
import { LIVE_BATTLE_STATUSES, loadBattle, pickFreePin, pinIsLive } from '../_shared_p2/battle.ts';
import { broadcastPodium, openQuestion, rosterOf } from '../_shared_p2/battle-ops.ts';
import { requireSubject } from '../_shared/access.ts';
import type { P2Deps } from '../_shared_p2/deps.ts';

const CreateInput = z.object({
  action: z.literal('create'),
  class_group_id: z.uuid(),
  subject_id: z.uuid(),
  node_ids: z.array(z.uuid()).max(50).optional(),
  count: z.union([z.literal(5), z.literal(10), z.literal(15)]),
  seconds_per_question: z.union([z.literal(10), z.literal(20), z.literal(30)]).optional(),
});
const ControlInput = z.object({ action: z.enum(['start', 'next', 'end']), battle_id: z.uuid() });
const KickInput = z.object({ action: z.literal('kick'), battle_id: z.uuid(), user_id: z.uuid() });
export const BattleControlInput = z.discriminatedUnion('action', [CreateInput, ControlInput, KickInput]);
export type BattleControlInput = z.infer<typeof BattleControlInput>;

async function create(
  p2: P2Deps,
  ctx: { user: { userId: string }; now: Date; json: (b: unknown) => Response },
  i: z.infer<typeof CreateInput>,
): Promise<Response> {
  const db = p2.db;
  const me = ctx.user.userId;
  const member = await requireActiveMember(db, i.class_group_id, me);
  const group = await loadGroup(db, i.class_group_id);
  if (!group) throw new ApiFailure('not_member');
  if (group.settings.battles_host === 'owner_mods' && member.role === 'member') {
    throw new ApiFailure('forbidden', { message: 'Só o dono e os moderadores podem criar batalhas nessa turma.' });
  }
  const subject = await requireSubject(db, me, i.subject_id, 'read');
  if (subject.owner_class_group_id !== i.class_group_id) throw new ApiFailure('not_found');

  const battleId = p2.newId();
  const quizId = p2.newId();
  const seconds = i.seconds_per_question ?? 20;
  const picked = await pickQuestions({
    db,
    subjectId: subject.id,
    nodeIds: i.node_ids ?? null,
    count: i.count,
    userIds: [me],
    now: ctx.now,
    seedId: battleId,
  });
  const pin = await pickFreePin(p2.randomInt, (candidate) => pinIsLive(db, candidate));
  if (!pin) throw new ApiFailure('internal_error', { message: 'Não consegui gerar um PIN agora. Tenta de novo.' });

  const quiz = await db.from('quizzes').insert({
    id: quizId,
    owner_id: me,
    subject_id: subject.id,
    class_group_id: i.class_group_id,
    kind: 'battle',
    mode: 'practice',
    title: `Batalha de ${subject.name}`,
    question_ids: picked.questionIds,
    scope: { subject_id: subject.id, node_ids: i.node_ids ?? [] },
    config: { count: i.count, seconds_per_question: seconds },
  });
  if (quiz.error) throw quiz.error;
  const battle = await db.from('battles').insert({
    id: battleId,
    class_group_id: i.class_group_id,
    host_id: me,
    quiz_id: quizId,
    pin,
    status: 'lobby',
    current_index: 0,
    seconds_per_question: seconds,
  });
  if (battle.error) throw battle.error;

  const hostName = nicknameOrName(member, await displayNameOf(db, me));
  await p2.broadcast([
    {
      topic: `turma:${i.class_group_id}`,
      event: 'battle_started',
      payload: { battle_id: battleId, pin, host_nickname: hostName },
      private: true,
    },
  ]);
  return ctx.json({ battle_id: battleId, pin, status: 'lobby' });
}

export const handler = defineP2<BattleControlInput>({
  name: 'battle-control',
  mutating: true,
  input: BattleControlInput,
  run: async (ctx) => {
    const { p2, input: i, now } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;
    if (i.action === 'create') return create(p2, ctx, i);

    const battle = await loadBattle(db, i.battle_id);
    if (!battle) throw new ApiFailure('not_found');
    const member = await activeMember(db, battle.class_group_id, me);
    if (!member) throw new ApiFailure('not_found');
    if (battle.host_id !== me) {
      throw new ApiFailure('forbidden', { message: 'Só quem criou a batalha pode fazer isso.' });
    }
    const quiz = await loadQuiz(db, battle.quiz_id);
    const total = quiz?.question_ids.length ?? 0;

    if (i.action === 'kick') {
      if (i.user_id === me) throw new ApiFailure('invalid_request');
      const removed = await db.from('battle_players').delete().eq('battle_id', battle.id).eq('user_id', i.user_id);
      if (removed.error) throw removed.error;
      return ctx.json({ battle_id: battle.id, status: battle.status });
    }

    if (i.action === 'start') {
      if (battle.status !== 'lobby') throw new ApiFailure('invalid_request', { message: 'A batalha já começou.' });
      const players = (await rosterOf(db, battle.id)).length;
      if (players < 2) {
        throw new ApiFailure('invalid_request', { message: 'Precisa de pelo menos 2 jogadores pra começar.' });
      }
      await openQuestion({ deps: p2, battle, index: 0, total, from: { status: 'lobby', index: 0 }, now });
      return ctx.json({ battle_id: battle.id, status: 'question_open', current_index: 0 });
    }

    if (i.action === 'next') {
      if (battle.status !== 'reveal') {
        throw new ApiFailure('invalid_request', { message: 'Espera a resposta aparecer antes de ir pra próxima.' });
      }
      const next = battle.current_index + 1;
      if (next >= total) {
        const podium = await db
          .from('battles')
          .update({ status: 'podium' })
          .eq('id', battle.id)
          .eq('status', 'reveal')
          .eq('current_index', battle.current_index)
          .select('id');
        if (podium.error) throw podium.error;
        if (!podium.data || podium.data.length === 0) {
          throw new ApiFailure('invalid_request', { message: 'A batalha mudou. Atualiza a tela.' });
        }
        await broadcastPodium(p2, battle.id, 'podium', battle.current_index, total);
        return ctx.json({ battle_id: battle.id, status: 'podium', current_index: battle.current_index });
      }
      await openQuestion({
        deps: p2,
        battle,
        index: next,
        total,
        from: { status: 'reveal', index: battle.current_index },
        now,
      });
      return ctx.json({ battle_id: battle.id, status: 'question_open', current_index: next });
    }

    // end: any live state, at any time (spec 10 §8.3).
    const ended = await db
      .from('battles')
      .update({ status: 'ended', ended_at: now.toISOString() })
      .eq('id', battle.id)
      .in('status', [...LIVE_BATTLE_STATUSES])
      .select('id');
    if (ended.error) throw ended.error;
    if (!ended.data || ended.data.length === 0) {
      throw new ApiFailure('invalid_request', { message: 'Essa batalha já terminou.' });
    }
    await broadcastPodium(p2, battle.id, 'ended', battle.current_index, total);
    return ctx.json({ battle_id: battle.id, status: 'ended' });
  },
});

if (import.meta.main) {
  const { prodP2Deps } = await import('../_shared_p2/prod.ts');
  const deps = prodP2Deps();
  Deno.serve((req) => handler(req, deps));
}
