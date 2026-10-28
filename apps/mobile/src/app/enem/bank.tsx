import type { EnemArea } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActionBar, Button, Chip, ChipGroup, EmptyState, ErrorState, ListItem, Screen, SegmentedControl, SkeletonList, Text, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { AREAS, startBankPractice, useAnswered, useBankItems, useEditions, useEnemGoal } from '../../features/enem/api';
import { areaName } from '../../features/enem/components';
import { bookletPosition } from '../../features/enem/format';
import { t } from '../../i18n';
import { messageFor } from '../../api/messages';

const BANDS = ['facil', 'media', 'dificil', 'muito_dificil'] as const;
const PRACTICE_MAX = 30;

/** S-ENEM Banco de Questões (ENM-02.4): filters, the official items, list or timed practice. */
export default function EnemBank() {
  const params = useLocalSearchParams<{ area?: EnemArea; skill?: string; topicId?: string; title?: string }>();
  const { userId } = useSession();
  const overlay = useOverlay();
  const { goal } = useEnemGoal();
  const editions = useEditions();
  const [area, setArea] = useState<EnemArea>(params.area ?? 'MT');
  const [edition, setEdition] = useState<number | null>(null);
  const [band, setBand] = useState<string | null>(null);
  const [status, setStatus] = useState<'all' | 'new' | 'wrong'>('all');
  const [busy, setBusy] = useState(false);
  const items = useBankItems({ area, edition, band, skill: params.skill ?? null, topicId: params.topicId ?? null, language: goal?.settings?.language });
  const answered = useAnswered((items.data ?? []).map((i) => i.question_id));

  const visible = useMemo(() => {
    const all = items.data ?? [];
    const a = answered.data ?? new Map<string, boolean>();
    if (status === 'new') return all.filter((i) => !a.has(i.question_id));
    if (status === 'wrong') return all.filter((i) => a.has(i.question_id) && a.get(i.question_id) === false);
    return all;
  }, [items.data, answered.data, status]);

  const practice = async (timed: boolean) => {
    if (!userId) return;
    setBusy(true);
    try {
      const ids = visible.filter((i) => !i.annulled).slice(0, PRACTICE_MAX).map((i) => i.question_id);
      const quizId = await startBankPractice(userId, ids, timed, params.title ? `ENEM — ${params.title}` : `ENEM — ${areaName(area)}`);
      router.push({ pathname: '/quiz/[quizId]', params: { quizId } });
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={params.title || t('bank.title')}
      onBack={() => router.back()}
      footer={
        visible.length > 0 ? (
          <ActionBar>
            <Button label={t('bank.practice_list')} loading={busy} onPress={() => void practice(false)} />
            <Button variant="secondary" label={t('bank.practice_timed')} loading={busy} onPress={() => void practice(true)} />
          </ActionBar>
        ) : undefined
      }
    >
      {!params.area ? <SegmentedControl options={AREAS.map((a) => ({ value: a, label: a }))} value={area} onChange={setArea} /> : null}
      {params.skill ? <Chip label={t('bank.skill', { code: params.skill })} selected /> : null}
      <Text variant="label">{t('bank.edition')}</Text>
      <ChipGroup>
        <Chip label={t('bank.any')} selected={edition === null} onPress={() => setEdition(null)} />
        {[...(editions.data ?? [])].reverse().map((e) => (
          <Chip key={e.year} label={String(e.year)} selected={edition === e.year} onPress={() => setEdition(e.year)} />
        ))}
      </ChipGroup>
      <ChipGroup>
        {BANDS.map((b) => (
          <Chip key={b} label={t(`bank.band.${b}`)} selected={band === b} onPress={() => setBand(band === b ? null : b)} />
        ))}
      </ChipGroup>
      <ChipGroup>
        <Chip label={t('bank.any')} selected={status === 'all'} onPress={() => setStatus('all')} />
        <Chip label={t('bank.not_answered')} selected={status === 'new'} onPress={() => setStatus('new')} />
        <Chip label={t('bank.wrong')} selected={status === 'wrong'} onPress={() => setStatus('wrong')} />
      </ChipGroup>
      {items.isError ? <ErrorState onRetry={items.refetch} /> : null}
      {items.isLoading ? <SkeletonList rows={5} /> : null}
      {!items.isLoading && visible.length === 0 ? <EmptyState icon="library-outline" message={t('bank.empty')} /> : null}
      {visible.length > 0 ? <Text tone="secondary">{t('bank.count', { n: visible.length })}</Text> : null}
      {visible.slice(0, 120).map((i) => (
        <ListItem
          key={i.id}
          title={(i.questions?.stem ?? '').replace(/[#*_>$]/g, '').slice(0, 110) || t('bank.source', { ano: i.edition_year, dia: i.day, n: bookletPosition(i.positions) ?? '?' })}
          subtitle={[`ENEM ${i.edition_year}`, i.skill_code, i.questions?.difficulty_band ? t(`bank.band.${i.questions.difficulty_band}`) : null, i.annulled ? t('bank.annulled') : null, answered.data?.has(i.question_id) ? (answered.data.get(i.question_id) ? '✓' : '✗') : null]
            .filter(Boolean)
            .join(' · ')}
          onPress={() => router.push({ pathname: '/enem/item/[itemId]', params: { itemId: i.id } })}
        />
      ))}
    </Screen>
  );
}
