import type { EnemArea, EnemSimuladoCreateReq } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Banner, Button, Chip, ChipGroup, RadioList, Screen, SegmentedControl, Text, useOnline, useOverlay } from '../../../components';
import { AREAS, createSimulado, useEditions, useEnemGoal } from '../../../features/enem/api';
import { t } from '../../../i18n';

type Mode = EnemSimuladoCreateReq['mode'];
type Source = EnemSimuladoCreateReq['source'];

/** S-ENEM Simulado setup (ENM-04.1–04.2): mode, item source (Réplica/Misto/Provável), edition, language. */
export default function NewSimulado() {
  const params = useLocalSearchParams<{ area?: EnemArea; mode?: Mode }>();
  const { goal } = useEnemGoal();
  const editions = useEditions();
  const online = useOnline();
  const overlay = useOverlay();
  const [mode, setMode] = useState<Mode>(params.mode ?? (params.area ? 'area' : 'full_day2'));
  const [area, setArea] = useState<EnemArea>(params.area ?? 'MT');
  const [mini, setMini] = useState<15 | 30>(15);
  const [source, setSource] = useState<Source>('provavel');
  const [edition, setEdition] = useState<number | null>(null);
  const [language, setLanguage] = useState<'en' | 'es'>(goal?.settings?.language ?? 'en');
  const [busy, setBusy] = useState(false);
  const pastEditions = (editions.data ?? []).filter((e) => e.year < new Date().getFullYear() || (e.day2_date && e.day2_date < new Date().toISOString().slice(0, 10)));

  const create = async () => {
    if (!goal) return;
    setBusy(true);
    try {
      const res = await createSimulado({
        goal_id: goal.id,
        mode,
        ...(mode === 'area' || mode === 'mini' ? { area } : {}),
        ...(mode === 'mini' ? { mini_size: mini } : {}),
        source,
        ...(edition ? { edition } : {}),
        language,
        ...(mode === 'full_day1' ? { includes_essay: true } : {}),
      });
      if (res.shortfall) {
        const n = Object.values(res.shortfall).reduce((s, x) => s + x, 0);
        overlay.snack(t('sim.shortfall', { n }));
      }
      router.replace({ pathname: '/quiz/[quizId]', params: { quizId: res.quiz_id, attemptId: res.attempt_id } });
    } catch (e) {
      overlay.snack((e as { message?: string }).message ?? t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={t('sim.new.title')}
      onBack={() => router.back()}
      footer={
        <ActionBar>
          <Button label={t('sim.new.create')} loading={busy} disabled={!goal || !online || (source === 'replica' && !edition)} onPress={() => void create()} />
        </ActionBar>
      }
    >
      {!online ? <Banner kind="warning" message={t('sim.new.offline')} /> : null}
      <Text variant="label">{t('sim.new.mode')}</Text>
      <RadioList
        value={mode}
        onChange={setMode}
        options={(['full_day1', 'full_day2', 'area', 'mini'] as const).map((m) => {
          const key = m === 'full_day1' ? 'day1' : m === 'full_day2' ? 'day2' : m;
          return { value: m, label: t(`sim.mode.${key}`), hint: t(`sim.mode_hint.${key}`) };
        })}
      />
      {mode === 'area' || mode === 'mini' ? <SegmentedControl options={AREAS.map((a) => ({ value: a, label: a }))} value={area} onChange={setArea} /> : null}
      {mode === 'mini' ? (
        <>
          <Text variant="label">{t('sim.new.mini_size')}</Text>
          <SegmentedControl options={[{ value: '15', label: '15' }, { value: '30', label: '30' }]} value={String(mini)} onChange={(v) => setMini(Number(v) as 15 | 30)} />
        </>
      ) : null}
      <Text variant="label">{t('sim.new.source')}</Text>
      <RadioList value={source} onChange={setSource} options={(['provavel', 'misto', 'replica'] as const).map((s) => ({ value: s, label: t(`sim.source.${s}`), hint: t(`sim.source_hint.${s}`) }))} />
      {source !== 'provavel' || edition ? (
        <>
          <Text variant="label">{t('sim.new.edition')}</Text>
          <ChipGroup>
            {source !== 'replica' ? <Chip label={t('bank.any')} selected={edition === null} onPress={() => setEdition(null)} /> : null}
            {[...pastEditions].reverse().map((e) => (
              <Chip key={e.year} label={String(e.year)} selected={edition === e.year} onPress={() => setEdition(e.year)} />
            ))}
          </ChipGroup>
        </>
      ) : null}
      {mode === 'full_day1' || ((mode === 'area' || mode === 'mini') && area === 'LC') ? (
        <>
          <Text variant="label">{t('sim.new.language')}</Text>
          <SegmentedControl options={[{ value: 'en', label: t('enem.lang.en') }, { value: 'es', label: t('enem.lang.es') }]} value={language} onChange={(v) => setLanguage(v as 'en' | 'es')} />
        </>
      ) : null}
      <Banner kind="neutral" message={t('sim.blank')} />
    </Screen>
  );
}
