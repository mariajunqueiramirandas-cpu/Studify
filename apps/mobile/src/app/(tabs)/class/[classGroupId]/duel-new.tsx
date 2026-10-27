import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Banner, Button, Chip, ChipGroup, RadioList, Screen, Text, useOverlay } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { createDuel, useClassSubjects, useMembers } from '../../../../features/class/api';
import { errorCode } from '../../../../features/common/query';
import { t } from '../../../../i18n';

const LENGTHS = [5, 7, 10] as const;

/** S-TUR-09 Novo duelo: opponent, subject, length (SOC-02.2). Blocked / opted-out users are hidden. */
export default function NewDuel() {
  const { classGroupId, opponentId } = useLocalSearchParams<{ classGroupId: string; opponentId?: string }>();
  const { userId } = useSession();
  const members = useMembers(classGroupId);
  const subjects = useClassSubjects(classGroupId);
  const overlay = useOverlay();
  const [opponent, setOpponent] = useState<string | null>(opponentId ?? null);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [length, setLength] = useState<(typeof LENGTHS)[number]>(7);
  const [busy, setBusy] = useState(false);
  const candidates = (members.data ?? []).filter((m) => m.status === 'active' && m.user_id !== userId);

  return (
    <Screen
      title={t('duel.new_title')}
      footer={
        <ActionBar>
          <Button
            label={t('duel.play')}
            loading={busy}
            disabled={!opponent || !subjectId}
            onPress={async () => {
              setBusy(true);
              try {
                const res = await createDuel({ class_group_id: classGroupId, opponent_id: opponent!, subject_id: subjectId!, length });
                router.replace({ pathname: '/duel/[duelId]', params: { duelId: res.duel_id, attemptId: res.attempt_id } });
              } catch (e) {
                const code = errorCode(e);
                overlay.snack(code === 'blocked' || code === 'forbidden' ? t('duel.no_opponents') : code === 'rate_limited' ? t('error.rate_limited') : t('error.generation'));
              } finally {
                setBusy(false);
              }
            }}
          />
        </ActionBar>
      }
    >
      <Banner kind="neutral" icon="timer-outline" message={t('duel.timer_notice')} />
      <Text variant="label">{t('duel.opponent')}</Text>
      {candidates.length ? (
        <RadioList value={opponent} onChange={setOpponent} options={candidates.map((m) => ({ value: m.user_id, label: m.nickname ?? m.display_name ?? '—' }))} />
      ) : (
        <Text tone="secondary">{t('duel.no_opponents')}</Text>
      )}
      <Text variant="label">{t('quiz.builder.subject')}</Text>
      <ChipGroup>
        {(subjects.data ?? []).map((s) => (
          <Chip key={s.id} label={s.name} selected={subjectId === s.id} onPress={() => setSubjectId(s.id)} />
        ))}
      </ChipGroup>
      <Text variant="label">{t('duel.length')}</Text>
      <ChipGroup>
        {LENGTHS.map((l) => (
          <Chip key={l} label={String(l)} selected={length === l} onPress={() => setLength(l)} />
        ))}
      </ChipGroup>
    </Screen>
  );
}
