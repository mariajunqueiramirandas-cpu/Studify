import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Button, Chip, ChipGroup, Screen, Text, TextField, useOverlay } from '../../components';
import { battleControl, useClassSubjects } from '../../features/class/api';
import { t } from '../../i18n';

const COUNTS = [5, 10, 15] as const;

/** Create a live battle (SOC-03.1) — or join one by PIN when no Turma is given. */
export default function NewBattle() {
  const { classGroupId } = useLocalSearchParams<{ classGroupId?: string }>();
  const subjects = useClassSubjects(classGroupId);
  const overlay = useOverlay();
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [count, setCount] = useState<(typeof COUNTS)[number]>(10);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  if (!classGroupId) {
    return (
      <Screen title={t('battle.join_pin')} footer={<ActionBar><Button label={t('class.join_button')} disabled={!/^\d{4}$/.test(pin)} onPress={() => router.replace({ pathname: '/battle/join', params: { pin } })} /></ActionBar>}>
        <TextField value={pin} onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" placeholder="0000" accessibilityLabel={t('battle.join_pin')} style={{ fontSize: 32, letterSpacing: 8, textAlign: 'center' }} />
      </Screen>
    );
  }

  return (
    <Screen
      title={t('battle.host_new')}
      footer={
        <ActionBar>
          <Button
            label={t('battle.host_new')}
            loading={busy}
            disabled={!subjectId}
            onPress={async () => {
              setBusy(true);
              try {
                const res = await battleControl({ action: 'create', class_group_id: classGroupId, subject_id: subjectId!, count });
                router.replace({ pathname: '/battle/[battleId]', params: { battleId: res.battle_id, pin: res.pin ?? '', host: '1' } });
              } catch {
                overlay.snack(t('error.generation'));
              } finally {
                setBusy(false);
              }
            }}
          />
        </ActionBar>
      }
    >
      <Text variant="label">{t('quiz.builder.subject')}</Text>
      <ChipGroup>
        {(subjects.data ?? []).map((s) => (
          <Chip key={s.id} label={s.name} selected={subjectId === s.id} onPress={() => setSubjectId(s.id)} />
        ))}
      </ChipGroup>
      <Text variant="label">{t('quiz.builder.count')}</Text>
      <ChipGroup>
        {COUNTS.map((c) => (
          <Chip key={c} label={String(c)} selected={count === c} onPress={() => setCount(c)} />
        ))}
      </ChipGroup>
    </Screen>
  );
}
