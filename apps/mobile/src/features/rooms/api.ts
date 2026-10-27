// Salas de estudo client (SOC-05; api §4.7): open rooms of a Turma, room-control actions, and the room:{id}
// channel (timer, reactions, members, goal broadcasts + presence). Members hidden by a block, in either
// direction, are filtered out of presence and reactions (SOC-X.3).
import type { RoomControlReq, RoomControlRes, RoomTimerConfig, RoomTimerState } from '@studify/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { rows } from '../common/query';

export interface RoomRow {
  id: string;
  class_group_id: string;
  host_id: string;
  name: string;
  timer_config: RoomTimerConfig;
  timer_state: RoomTimerState;
  group_goal: { kind: 'cards' | 'questions'; target: number } | null;
  status: 'open' | 'closed';
  created_at: string;
}

export function useOpenRooms(classGroupId: string | undefined) {
  return useQuery({
    queryKey: ['rooms', classGroupId],
    enabled: !!classGroupId,
    refetchInterval: 30_000,
    queryFn: () => rows<RoomRow>(supabase.from('study_rooms').select('*').eq('class_group_id', classGroupId!).eq('status', 'open').order('created_at', { ascending: false })),
  });
}

export function useRoom(roomId: string | undefined) {
  return useQuery({
    queryKey: ['room', roomId],
    enabled: !!roomId,
    queryFn: async () => (await rows<RoomRow>(supabase.from('study_rooms').select('*').eq('id', roomId!)))[0] ?? null,
  });
}

export function roomControl(req: RoomControlReq) {
  return callFunction<RoomControlReq, RoomControlRes>('room-control', req, { idempotencyKey: uuidv7() });
}

export interface PresenceMember {
  user_id: string;
  nickname: string;
  status: string;
}

export interface Reaction {
  key: number;
  user_id: string;
  nickname: string;
  reaction: string;
}

/** Joins the private room channel: presence (who is here, with a status) and the room broadcasts. */
export function useRoomChannel(roomId: string, me: { userId: string | null; nickname: string; status: string }, hidden: ReadonlySet<string>, onTimer: (state: RoomTimerState) => void, onClosed: () => void) {
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [goal, setGoal] = useState<{ progress: number; target: number } | null>(null);
  const hiddenRef = useRef(hidden);
  useEffect(() => {
    hiddenRef.current = hidden;
  }, [hidden]);
  const statusRef = useRef(me.status);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!me.userId) return undefined;
    const channel = supabase.channel(`room:${roomId}`, { config: { private: true, presence: { key: me.userId } } });
    channelRef.current = channel;
    channel
      .on('broadcast', { event: 'timer' }, ({ payload }) => onTimer(payload as RoomTimerState))
      .on('broadcast', { event: 'goal' }, ({ payload }) => setGoal(payload as { progress: number; target: number }))
      .on('broadcast', { event: 'closed' }, () => onClosed())
      .on('broadcast', { event: 'reaction' }, ({ payload }) => {
        const r = payload as Omit<Reaction, 'key'>;
        if (hiddenRef.current.has(r.user_id)) return;
        const key = Date.now() + Math.random();
        setReactions((all) => [...all.slice(-5), { ...r, key }]);
        setTimeout(() => setReactions((all) => all.filter((x) => x.key !== key)), 4000);
      })
      .on('presence', { event: 'sync' }, () => {
        const list = Object.values(channel.presenceState()).flat() as unknown as PresenceMember[];
        setMembers(list.filter((m) => !hiddenRef.current.has(m.user_id)));
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void channel.track({ user_id: me.userId, nickname: me.nickname, status: statusRef.current });
      });
    return () => {
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, me.userId]);

  // Status changes (e.g. focus → break, or "Estudando" when hidden) are re-tracked on the same channel.
  useEffect(() => {
    statusRef.current = me.status;
    void channelRef.current?.track({ user_id: me.userId, nickname: me.nickname, status: me.status });
  }, [me.status, me.nickname, me.userId]);

  return { members, reactions, goal, setGoal };
}
