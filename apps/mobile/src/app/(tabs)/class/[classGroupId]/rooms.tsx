import { ROOM_TIMER_PRESETS } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { BottomSheet, Button, Card, Chip, ChipGroup, EmptyState, ListItem, Screen, SegmentedControl, SkeletonList, SwitchRow, Text, TextField, useOnline, useOverlay } from '../../../../components';
import { roomControl, useOpenRooms } from '../../../../features/rooms/api';
import { options, t } from '../../../../i18n';
import { messageFor } from '../../../../api/messages';

type Preset = '25' | '50';

/** S-SOC-05 Salas de estudo of a Turma (SOC-05.1–05.2): open rooms, join, or open a new one. */
export default function Rooms() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId: string }>();
  const online = useOnline();
  const overlay = useOverlay();
  const rooms = useOpenRooms(classGroupId);
  const [sheet, setSheet] = useState(false);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<Preset>('25');
  const [goalOn, setGoalOn] = useState(false);
  const [goalKind, setGoalKind] = useState<'cards' | 'questions'>('cards');
  const [busy, setBusy] = useState(false);
  const presetNames = options('rooms.name_presets');

  const open = async () => {
    setBusy(true);
    try {
      const timer = preset === '25' ? ROOM_TIMER_PRESETS[0] : ROOM_TIMER_PRESETS[1];
      const res = await roomControl({ action: 'create', class_group_id: classGroupId, name: name.trim(), timer_config: { ...timer }, ...(goalOn ? { group_goal: { kind: goalKind, target: goalKind === 'cards' ? 200 : 50 } } : {}) });
      setSheet(false);
      router.push({ pathname: '/room/[roomId]', params: { roomId: res.room_id } });
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const join = async (roomId: string) => {
    try {
      await roomControl({ action: 'join', room_id: roomId });
      router.push({ pathname: '/room/[roomId]', params: { roomId } });
    } catch (e) {
      overlay.snack((e as { code?: string }).code === 'class_full' ? t('rooms.full') : messageFor(e));
    }
  };

  return (
    <Screen title={t('rooms.title')} onRefresh={() => void rooms.refetch()} refreshing={rooms.isRefetching}>
      <Text tone="secondary">{t('rooms.intro')}</Text>
      <Button label={t('rooms.open')} icon="add" disabled={!online} onPress={() => setSheet(true)} />
      {rooms.isLoading ? (
        <SkeletonList rows={2} />
      ) : rooms.data?.length ? (
        rooms.data.map((r) => (
          <Card key={r.id}>
            <ListItem
              icon="people-circle-outline"
              title={r.name}
              subtitle={`${r.timer_config.focus_min}/${r.timer_config.break_min} · ${t(`rooms.phase.${r.timer_state.phase}`)}${r.group_goal ? ` · ${t('rooms.goal_short', { n: r.group_goal.target, kind: t(`rooms.goal_kind.${r.group_goal.kind}`) })}` : ''}`}
              onPress={() => void join(r.id)}
            />
          </Card>
        ))
      ) : (
        <EmptyState icon="cafe-outline" message={t('rooms.empty')} />
      )}
      <BottomSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        title={t('rooms.open')}
        footer={<Button label={t('rooms.create')} loading={busy} disabled={name.trim().length < 2} onPress={() => void open()} />}
      >
        <TextField label={t('rooms.name')} value={name} onChangeText={(v) => setName(v.slice(0, 40))} placeholder={presetNames[0]} />
        <ChipGroup>
          {presetNames.map((p) => (
            <Chip key={p} label={p} selected={name === p} onPress={() => setName(p)} />
          ))}
        </ChipGroup>
        <SegmentedControl<Preset> label={t('rooms.timer')} value={preset} onChange={setPreset} options={[{ value: '25', label: '25/5' }, { value: '50', label: '50/10' }]} />
        <SwitchRow label={t('rooms.goal')} hint={t('rooms.goal_hint')} value={goalOn} onChange={setGoalOn} />
        {goalOn ? (
          <SegmentedControl<'cards' | 'questions'>
            value={goalKind}
            onChange={setGoalKind}
            options={[
              { value: 'cards', label: t('rooms.goal_cards', { n: 200 }) },
              { value: 'questions', label: t('rooms.goal_questions', { n: 50 }) },
            ]}
          />
        ) : null}
      </BottomSheet>
    </Screen>
  );
}
