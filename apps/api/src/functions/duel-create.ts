// duel-create — SOC-02.1–2, SOC-02.9, SOC-02.11–12. Challenges a Turma member to a 5/7/10 question duel.
// The challenger plays right away; the opponent gets a push and 48 h to respond (SOC-02.5).
import { z } from 'zod';
import { ApiFailure } from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';
import {
  activeMember,
  blockedEitherWay,
  displayNameOf,
  loadGroup,
  nicknameOrName,
  requireActiveMember,
} from '../shared-p2/turma.ts';
import { pickQuestions } from '../shared-p2/questions.ts';
import { DUEL_EXPIRY_HOURS, DUEL_LIMITS, loadDuel, scheduleDuelExpiry } from '../shared-p2/duel.ts';
import { pushTo } from '../shared-p2/jobs.ts';
import { requireSubject } from '../shared/access.ts';
import { startOfLocalDayIso } from '../shared-p2/util.ts';

export const DuelCreateInput = z.object({
  class_group_id: z.uuid(),
  opponent_id: z.uuid(),
  subject_id: z.uuid(),
  node_ids: z.array(z.uuid()).max(50).optional(),
  length: z.union([z.literal(5), z.literal(7), z.literal(10)]),
  rematch_of: z.uuid().optional(),
});
export type DuelCreateInput = z.infer<typeof DuelCreateInput>;

async function countRows(query: PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<number> {
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).length;
}

export const handler = defineP2<DuelCreateInput>({
  name: 'duel-create',
  mutating: true,
  input: DuelCreateInput,
  run: async (ctx) => {
    const { p2, input: i, now } = ctx;
    const db = p2.db;
    const me = ctx.user.userId;
    if (i.opponent_id === me) {
      throw new ApiFailure('invalid_request', { message: 'Você não pode desafiar a si mesmo.' });
    }

    const member = await requireActiveMember(db, i.class_group_id, me);
    const group = await loadGroup(db, i.class_group_id);
    if (!group) throw new ApiFailure('not_member');
    if (group.settings.duels_enabled === false) {
      throw new ApiFailure('forbidden', { message: 'Os duelos estão desligados nessa turma.' });
    }

    const opponent = await activeMember(db, i.class_group_id, i.opponent_id);
    if (!opponent || !opponent.accepts_duels) throw new ApiFailure('not_found');
    if (await blockedEitherWay(db, me, i.opponent_id)) throw new ApiFailure('blocked');

    const subject = await requireSubject(db, me, i.subject_id, 'read');
    if (subject.owner_class_group_id !== i.class_group_id) throw new ApiFailure('not_found');

    if (i.rematch_of) {
      const previous = await loadDuel(db, i.rematch_of);
      const participant = previous && (previous.challenger_id === me || previous.opponent_id === me);
      if (!previous || !participant || previous.status !== 'finished') throw new ApiFailure('not_found');
    }

    // SOC-02.9 limits.
    const openMine = await countRows(
      db.from('duels').select('id').eq('challenger_id', me).eq('status', 'waiting_opponent'),
    );
    const openTheirs = await countRows(
      db.from('duels').select('id').eq('opponent_id', me).eq('status', 'waiting_opponent'),
    );
    if (openMine + openTheirs >= DUEL_LIMITS.openPerUser) {
      throw new ApiFailure('rate_limited', {
        message: 'Você já tem 10 duelos abertos. Termine um antes de desafiar outro.',
      });
    }
    const today = await countRows(
      db.from('duels').select('id').eq('challenger_id', me).gte('created_at', startOfLocalDayIso(now)),
    );
    if (today >= DUEL_LIMITS.newPerDay) {
      throw new ApiFailure('rate_limited', { message: 'Você já desafiou 20 pessoas hoje. Amanhã tem mais!' });
    }
    const pair = await countRows(
      db.from('duels').select('id').eq('challenger_id', me).eq('opponent_id', i.opponent_id).eq(
        'status',
        'waiting_opponent',
      ),
    );
    if (pair >= DUEL_LIMITS.openPerPair) {
      throw new ApiFailure('rate_limited', { message: 'Você já tem desafios abertos pra essa pessoa.' });
    }

    const duelId = p2.newId();
    const picked = await pickQuestions({
      db,
      subjectId: subject.id,
      nodeIds: i.node_ids ?? null,
      count: i.length,
      userIds: [me, i.opponent_id],
      now,
      seedId: duelId,
    });

    const quizId = p2.newId();
    const attemptId = p2.newId();
    const expiresAt = new Date(now.getTime() + DUEL_EXPIRY_HOURS * 60 * 60 * 1000);
    const quiz = await db.from('quizzes').insert({
      id: quizId,
      owner_id: me,
      subject_id: subject.id,
      class_group_id: i.class_group_id,
      kind: 'duel',
      mode: 'practice',
      title: `Duelo de ${subject.name}`,
      question_ids: picked.questionIds,
      scope: { subject_id: subject.id, node_ids: i.node_ids ?? [] },
      config: { length: i.length, duel_id: duelId },
    });
    if (quiz.error) throw quiz.error;

    const duel = await db.from('duels').insert({
      id: duelId,
      class_group_id: i.class_group_id,
      challenger_id: me,
      opponent_id: i.opponent_id,
      quiz_id: quizId,
      status: 'waiting_opponent',
      expires_at: expiresAt.toISOString(),
      challenger_attempt_id: attemptId,
      rematch_of: i.rematch_of ?? null,
    });
    if (duel.error) throw duel.error;

    const attempt = await db.from('quiz_attempts').insert({
      id: attemptId,
      user_id: me,
      quiz_id: quizId,
      status: 'in_progress',
      started_at: now.toISOString(),
      device_id: ctx.req.headers.get('x-device-id') ?? 'server',
    });
    if (attempt.error) throw attempt.error;

    await scheduleDuelExpiry(p2, { id: duelId, expires_at: expiresAt.toISOString() });
    const nome = nicknameOrName(member, await displayNameOf(db, me));
    await pushTo(p2, i.opponent_id, 'duel_challenge', {
      class_group_id: i.class_group_id,
      duel_id: duelId,
      nome,
      materia: subject.name,
      body: `${nome} te desafiou num duelo de ${subject.name}!`,
    });
    return ctx.json({ duel_id: duelId, quiz_id: quizId, attempt_id: attemptId });
  },
});
