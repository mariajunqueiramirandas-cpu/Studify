// room-control (SOC-05; api §4.7). Salas de estudo: a member opens a room for the Turma with a shared focus
// timer and an optional group goal; members join and leave; only the host controls the timer, stamped with
// server time so every phone shows the same countdown (SOC-05.3); reactions are the only interaction, one per
// 5 s (SOC-05.5); a room holds 20 members (SOC-05.6). Changes are broadcast on the private room:{id} channel.
import {
  ApiFailure,
  ROOM_LIMITS,
  RoomControlReqSchema,
  applyRoomTimerAction,
  canReact,
  roomGoalProgress,
  validTimerConfig,
  type RoomControlReq,
  type RoomControlRes,
  type RoomTimerConfig,
  type RoomTimerState,
} from '@studify/shared';
import { defineP2 } from '../shared-p2/http.ts';
import type { P2Deps } from '../shared-p2/deps.ts';
import { activeMember, displayNameOf, nicknameOrName, requireActiveMember } from '../shared-p2/turma.ts';

interface RoomRow {
  id: string;
  class_group_id: string;
  host_id: string;
  name: string;
  timer_config: RoomTimerConfig;
  timer_state: RoomTimerState;
  group_goal: { kind: 'cards' | 'questions'; target: number } | null;
  status: 'open' | 'closed';
  created_at: string;
  last_active_at: string;
}

interface MemberRow {
  room_id: string;
  user_id: string;
  joined_at: string;
  left_at: string | null;
  last_reaction_at: string | null;
}

async function loadRoom(p2: P2Deps, roomId: string): Promise<RoomRow> {
  const { data, error } = await p2.db.from('study_rooms').select('*').eq('id', roomId).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiFailure('not_found');
  return data as RoomRow;
}

async function membersOf(p2: P2Deps, roomId: string): Promise<MemberRow[]> {
  const { data, error } = await p2.db.from('study_room_members').select('room_id, user_id, joined_at, left_at, last_reaction_at').eq('room_id', roomId);
  if (error) throw error;
  return data as MemberRow[];
}

/**
 * SOC-05.4: cards reviewed or questions answered by the members while they were in the room. Only the total is
 * returned; individual contributions are never listed.
 */
async function goalOf(p2: P2Deps, room: RoomRow, members: MemberRow[], now: Date): Promise<RoomControlRes['goal']> {
  if (!room.group_goal) return null;
  const counts: number[] = [];
  for (const m of members) {
    const until = m.left_at ?? now.toISOString();
    const table = room.group_goal.kind === 'cards' ? 'review_logs' : 'attempt_answers';
    const column = room.group_goal.kind === 'cards' ? 'reviewed_at' : 'answered_at';
    const res = await p2.db.from(table).select('id', { count: 'exact', head: true }).eq('user_id', m.user_id).gte(column, m.joined_at).lte(column, until);
    if (res.error) throw res.error;
    counts.push(res.count ?? 0);
  }
  const g = roomGoalProgress(counts, room.group_goal.target);
  return { progress: g.progress, target: g.target, kind: room.group_goal.kind };
}

async function respond(p2: P2Deps, room: RoomRow, now: Date): Promise<RoomControlRes> {
  const members = await membersOf(p2, room.id);
  return {
    room_id: room.id,
    status: room.status,
    timer_state: room.timer_state as unknown as Record<string, unknown>,
    timer_config: room.timer_config,
    goal: await goalOf(p2, room, members, now),
    members: members.filter((m) => !m.left_at).length,
  };
}

function broadcast(p2: P2Deps, roomId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  return p2.broadcast([{ topic: `room:${roomId}`, event, payload, private: true }]);
}

export const handler = defineP2<RoomControlReq>({
  name: 'room-control',
  mutating: true,
  input: RoomControlReqSchema,
  run: async (ctx) => {
    const { p2, input } = ctx;
    const { db } = p2;
    const me = ctx.user.userId;
    const now = ctx.now;
    const at = now.toISOString();

    if (input.action === 'create') {
      await requireActiveMember(db, input.class_group_id, me);
      const config = input.timer_config ?? { focus_min: 25, break_min: 5 };
      if (!validTimerConfig(config)) throw new ApiFailure('invalid_request', { message: 'Tempo de foco entre 5 e 120 min e pausa entre 1 e 30 min.' });
      const roomId = p2.newId();
      const room: RoomRow = {
        id: roomId,
        class_group_id: input.class_group_id,
        host_id: me,
        name: input.name.trim(),
        timer_config: config,
        timer_state: { phase: 'idle', cycle: 0 },
        group_goal: input.group_goal ?? null,
        status: 'open',
        created_at: at,
        last_active_at: at,
      };
      const inserted = await db.from('study_rooms').insert(room);
      if (inserted.error) throw inserted.error;
      const joined = await db.from('study_room_members').insert({ room_id: roomId, user_id: me, joined_at: at });
      if (joined.error) throw joined.error;
      await p2.broadcast([{ topic: `turma:${input.class_group_id}`, event: 'room_opened', payload: { room_id: roomId, name: room.name }, private: true }]);
      return ctx.json(await respond(p2, room, now));
    }

    const room = await loadRoom(p2, input.room_id);
    const member = await activeMember(db, room.class_group_id, me);
    if (!member) throw new ApiFailure('not_found');
    if (room.status === 'closed') throw new ApiFailure('invalid_request', { message: 'Essa sala já foi fechada.' });
    const members = await membersOf(p2, room.id);
    const mine = members.find((m) => m.user_id === me && !m.left_at) ?? null;
    const isHost = room.host_id === me;
    const isModerator = member.role === 'owner' || member.role === 'moderator';

    switch (input.action) {
      case 'join': {
        if (!mine) {
          if (members.filter((m) => !m.left_at).length >= ROOM_LIMITS.maxMembers) {
            throw new ApiFailure('class_full', { message: 'A sala está cheia (máx. 20 pessoas).' });
          }
          const row = { room_id: room.id, user_id: me, joined_at: at, left_at: null, status_mode: input.status_mode ?? 'auto' };
          const prior = members.find((m) => m.user_id === me);
          const res = prior
            ? await db.from('study_room_members').update(row).eq('room_id', room.id).eq('user_id', me)
            : await db.from('study_room_members').insert(row);
          if (res.error) throw res.error;
        }
        await db.from('study_rooms').update({ last_active_at: at }).eq('id', room.id);
        break;
      }
      case 'leave': {
        if (mine) {
          const res = await db.from('study_room_members').update({ left_at: at }).eq('room_id', room.id).eq('user_id', me);
          if (res.error) throw res.error;
        }
        await db.from('study_rooms').update({ last_active_at: at }).eq('id', room.id);
        break;
      }
      case 'status': {
        if (!mine) throw new ApiFailure('invalid_request', { message: 'Entre na sala primeiro.' });
        const res = await db.from('study_room_members').update({ status_mode: input.status_mode }).eq('room_id', room.id).eq('user_id', me);
        if (res.error) throw res.error;
        break;
      }
      case 'react': {
        if (!mine) throw new ApiFailure('invalid_request', { message: 'Entre na sala primeiro.' });
        if (!canReact(mine.last_reaction_at, now)) throw new ApiFailure('rate_limited');
        const res = await db.from('study_room_members').update({ last_reaction_at: at }).eq('room_id', room.id).eq('user_id', me);
        if (res.error) throw res.error;
        const nickname = nicknameOrName(member, await displayNameOf(db, me));
        await broadcast(p2, room.id, 'reaction', { nickname, reaction: input.reaction });
        break;
      }
      case 'close': {
        if (!isHost && !isModerator) throw new ApiFailure('forbidden', { message: 'Só quem abriu a sala pode fechar.' });
        const res = await db.from('study_rooms').update({ status: 'closed', closed_at: at }).eq('id', room.id);
        if (res.error) throw res.error;
        room.status = 'closed';
        await broadcast(p2, room.id, 'closed', {});
        break;
      }
      default: {
        // start, pause, resume, skip: the host controls the shared timer (SOC-05.3).
        if (!isHost) throw new ApiFailure('forbidden', { message: 'Só quem abriu a sala controla o timer.' });
        const next = applyRoomTimerAction(room.timer_state, room.timer_config, input.action, now);
        const res = await db.from('study_rooms').update({ timer_state: next, last_active_at: at }).eq('id', room.id);
        if (res.error) throw res.error;
        room.timer_state = next;
        await broadcast(p2, room.id, 'timer', { ...next, config: room.timer_config });
      }
    }
    const body = await respond(p2, room, now);
    if (input.action === 'join' || input.action === 'leave') {
      await broadcast(p2, room.id, 'members', { count: body.members });
      if (body.goal) await broadcast(p2, room.id, 'goal', { progress: body.goal.progress, target: body.goal.target });
    }
    return ctx.json(body);
  },
});

export default handler;
