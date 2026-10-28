import { ROOM_REACTIONS, roomTimerView, type RoomTimerState } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Banner, Button, Card, ErrorState, ProgressBar, Row, Screen, SegmentedControl, SkeletonList, Text, TimerRing, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { useClassGroup } from '../../features/class/api';
import { formatClock } from '../../features/common/format';
import { roomControl, useRoom, useRoomChannel } from '../../features/rooms/api';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

/**
 * S-SOC-05 room (SOC-05.2–05.6): shared timer driven by the host and stamped with server time, presence with a
 * status (automatic or "Estudando"), fixed reactions (1 per 5 s, no chat) and the group goal bar. Members
 * blocked either way are not shown (SOC-X.3).
 */
export default function Room() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const { colors: c } = useTheme();
  const overlay = useOverlay();
  const { userId, profile } = useSession();
  const room = useRoom(roomId);
  const group = useClassGroup(room.data?.class_group_id);
  const [timer, setTimer] = useState<RoomTimerState | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'auto' | 'hidden'>('auto');
  const [closed, setClosed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const r = room.data;
  const config = r?.timer_config ?? { focus_min: 25, break_min: 5 };
  const state = timer ?? r?.timer_state ?? { phase: 'idle' as const, cycle: 0 };
  const view = roomTimerView(state, config, new Date(now));
  const nickname = group.data?.me?.nickname ?? (profile?.display_name as string | undefined) ?? '';
  const status = mode === 'hidden' ? t('rooms.status_hidden') : view.phase === 'break' ? t('rooms.status_break') : view.phase === 'focus' ? t('rooms.status_focus') : t('rooms.status_waiting');
  const channel = useRoomChannel(roomId, { userId, nickname, status }, hidden, setTimer, () => setClosed(true));
  const isHost = !!r && r.host_id === userId;

  // Join (idempotent) to get the authoritative state, the goal and who to hide.
  useEffect(() => {
    void roomControl({ action: 'join', room_id: roomId })
      .then((res) => {
        setTimer(res.timer_state as unknown as RoomTimerState);
        setHidden(new Set(res.hidden_user_ids));
        if (res.goal) channel.setGoal({ progress: res.goal.progress, target: res.goal.target });
        if (res.status === 'closed') setClosed(true);
      })
      .catch((e: { code?: string }) => overlay.snack(e.code === 'class_full' ? t('rooms.full') : t('error.generic')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const control = async (action: 'start' | 'pause' | 'resume' | 'skip' | 'close') => {
    try {
      const res = await roomControl({ action, room_id: roomId });
      setTimer(res.timer_state as unknown as RoomTimerState);
      if (action === 'close') router.back();
    } catch {
      overlay.snack(t('error.generic'));
    }
  };

  const react = async (reaction: (typeof ROOM_REACTIONS)[number]) => {
    try {
      await roomControl({ action: 'react', room_id: roomId, reaction });
    } catch (e) {
      if ((e as { code?: string }).code === 'rate_limited') overlay.snack(t('rooms.react_wait'));
    }
  };

  const leave = async () => {
    await roomControl({ action: 'leave', room_id: roomId }).catch(() => undefined);
    router.back();
  };

  const phaseTotal = useMemo(() => (view.phase === 'break' ? config.break_min : config.focus_min) * 60_000, [view.phase, config]);

  if (room.isError) return <Screen title={t('rooms.title')}><ErrorState onRetry={room.refetch} /></Screen>;
  if (!r) return <Screen title={t('rooms.title')}><SkeletonList rows={3} /></Screen>;

  return (
    <Screen title={r.name} onBack={() => void leave()} calm>
      {closed ? <Banner kind="neutral" message={t('rooms.closed')} action={{ label: t('global.back'), onPress: () => router.back() }} /> : null}
      <Card>
        <View style={{ alignItems: 'center', gap: space.sm }}>
          <Text variant="label" tone="secondary">
            {t(`rooms.phase.${view.phase}`)} · {t('rooms.cycle', { n: view.cycle + (view.phase === 'focus' ? 1 : 0) })}
          </Text>
          {view.phase === 'idle' ? (
            <Text variant="display">{`${config.focus_min}:00`}</Text>
          ) : (
            <TimerRing totalMs={phaseTotal} remainingMs={view.remainingMs} size={140} />
          )}
          <Text variant="title" accessibilityLiveRegion="polite">
            {view.phase === 'idle' ? '' : formatClock(Math.ceil(view.remainingMs / 1000))}
          </Text>
        </View>
        {isHost && !closed ? (
          <Row style={{ justifyContent: 'center' }}>
            {view.phase === 'idle' ? <Button label={t('rooms.start')} onPress={() => void control('start')} /> : null}
            {view.phase === 'focus' || view.phase === 'break' ? <Button variant="secondary" label={t('rooms.pause')} onPress={() => void control('pause')} /> : null}
            {view.phase === 'paused' ? <Button label={t('rooms.resume')} onPress={() => void control('resume')} /> : null}
            {view.phase !== 'idle' ? <Button variant="text" label={t('rooms.skip')} onPress={() => void control('skip')} /> : null}
          </Row>
        ) : !isHost ? (
          <Text variant="bodySmall" tone="secondary" align="center">{t('rooms.host_controls')}</Text>
        ) : null}
      </Card>
      {channel.goal ? (
        <Card>
          <Text variant="label">{t('rooms.goal_progress', { n: channel.goal.progress, target: channel.goal.target, kind: t(`rooms.goal_kind.${r.group_goal?.kind ?? 'cards'}`) })}</Text>
          <ProgressBar value={channel.goal.progress / Math.max(1, channel.goal.target)} />
        </Card>
      ) : null}
      <Card>
        <Text variant="label">{t('rooms.here', { n: channel.members.length })}</Text>
        {channel.members.map((m) => (
          <Row key={m.user_id}>
            <Text style={{ flex: 1 }}>{m.user_id === userId ? t('rooms.you', { name: m.nickname }) : m.nickname}</Text>
            <Text variant="bodySmall" tone="secondary">{m.status}</Text>
          </Row>
        ))}
        <SegmentedControl<'auto' | 'hidden'>
          label={t('rooms.my_status')}
          value={mode}
          onChange={(v) => {
            setMode(v);
            void roomControl({ action: 'status', room_id: roomId, status_mode: v }).catch(() => undefined);
          }}
          options={[
            { value: 'auto', label: t('rooms.status_auto') },
            { value: 'hidden', label: t('rooms.status_hidden') },
          ]}
        />
      </Card>
      <View style={styles.reactions}>
        {ROOM_REACTIONS.map((emoji) => (
          <Pressable key={emoji} accessibilityRole="button" accessibilityLabel={t('rooms.react', { emoji })} onPress={() => void react(emoji)} style={[styles.reaction, { backgroundColor: c.surface1 }]}>
            <Text variant="title">{emoji}</Text>
          </Pressable>
        ))}
      </View>
      {channel.reactions.map((x) => (
        <Text key={x.key} variant="bodySmall" tone="secondary" accessibilityLiveRegion="polite">
          {x.reaction} {x.nickname}
        </Text>
      ))}
      <Row>
        <Button style={{ flex: 1 }} variant="tonal" icon="albums-outline" label={t('rooms.study_cards')} onPress={() => router.push('/review')} />
        {isHost ? <Button style={{ flex: 1 }} variant="text" label={t('rooms.close')} onPress={() => void control('close')} /> : null}
      </Row>
    </Screen>
  );
}

const styles = StyleSheet.create({
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, justifyContent: 'center' },
  reaction: { width: 52, height: 52, borderRadius: radius.round, alignItems: 'center', justifyContent: 'center' },
});
