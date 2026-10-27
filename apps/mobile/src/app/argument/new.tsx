import type { ArgumentStartReq } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, RadioList, Screen, Section, Text, TextField, useOnline, useOverlay } from '../../components';
import { startArgument, suggestArgumentThemes, usePredictedThemes } from '../../features/enem/api';
import { t } from '../../i18n';

type Picked = { theme: string; themeId?: string; nodeId?: string; source: ArgumentStartReq['theme_source'] };

/**
 * S-ARG setup (INT-03.1): mode (Debate or Construir argumento) and a theme — suggested from the subject's material,
 * an ENEM training theme, or typed. Opened from a subject (school mode) or from the ENEM home.
 */
export default function NewArgument() {
  const params = useLocalSearchParams<{ goalMode?: 'exam_week' | 'enem'; subjectId?: string; nodeId?: string; theme?: string; themeId?: string }>();
  const goalMode = params.goalMode ?? (params.subjectId ? 'exam_week' : 'enem');
  const online = useOnline();
  const overlay = useOverlay();
  const predicted = usePredictedThemes();
  const [mode, setMode] = useState<ArgumentStartReq['mode']>('debate');
  const [picked, setPicked] = useState<Picked | null>(params.theme ? { theme: params.theme, themeId: params.themeId, nodeId: params.nodeId, source: params.themeId ? 'enem' : 'custom' } : null);
  const [custom, setCustom] = useState('');
  const [suggested, setSuggested] = useState<Array<{ question: string; node_ids: string[]; why: string }>>([]);
  const [busy, setBusy] = useState<'suggest' | 'start' | null>(null);

  const suggest = async () => {
    if (!params.subjectId) return;
    setBusy('suggest');
    try {
      setSuggested((await suggestArgumentThemes(params.subjectId)).themes);
    } catch (e) {
      overlay.snack((e as { message?: string }).message ?? t('error.generic'));
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    const choice = picked ?? (custom.trim().length >= 5 ? { theme: custom.trim(), source: 'custom' as const } : null);
    if (!choice) return;
    setBusy('start');
    try {
      const res = await startArgument({
        goal_mode: goalMode,
        mode,
        theme_source: choice.source,
        ...(choice.themeId ? { theme_id: choice.themeId } : { theme: choice.theme }),
        ...(params.subjectId ? { subject_id: params.subjectId } : {}),
        ...(choice.nodeId ? { node_id: choice.nodeId } : {}),
      });
      router.replace({ pathname: '/argument/[sessionId]', params: { sessionId: res.session_id, opening: res.opening } });
    } catch (e) {
      overlay.snack((e as { message?: string }).message ?? t('error.generic'));
    } finally {
      setBusy(null);
    }
  };

  const ready = picked !== null || custom.trim().length >= 5;
  return (
    <Screen
      title={t('arg.title')}
      onBack={() => router.back()}
      footer={
        <ActionBar>
          <Button label={t('arg.start')} loading={busy === 'start'} disabled={!online || !ready} onPress={() => void start()} />
        </ActionBar>
      }
    >
      <RadioList value={mode} onChange={setMode} options={(['debate', 'build'] as const).map((m) => ({ value: m, label: t(`arg.mode.${m}`), hint: t(`arg.mode_hint.${m}`) }))} />
      <Section title={t('arg.theme')}>
        {picked ? (
          <Card tone="soft" onPress={() => setPicked(null)}>
            <Text variant="heading">{picked.theme}</Text>
          </Card>
        ) : null}
        {params.subjectId ? <Button variant="secondary" icon="sparkles-outline" label={t('arg.suggest')} loading={busy === 'suggest'} disabled={!online} onPress={() => void suggest()} /> : null}
        {suggested.map((s) => (
          <Card key={s.question} onPress={() => setPicked({ theme: s.question, nodeId: s.node_ids[0], source: 'suggested' })}>
            <Text variant="label">{s.question}</Text>
            <Text variant="caption" tone="secondary">
              {s.why}
            </Text>
          </Card>
        ))}
        {goalMode === 'enem' ? (
          <ChipGroup>
            {(predicted.data ?? []).slice(0, 6).map((th) => (
              <Chip key={th.id} label={th.title.length > 60 ? `${th.title.slice(0, 57)}…` : th.title} selected={picked?.themeId === th.id} onPress={() => setPicked({ theme: th.title, themeId: th.id, source: 'enem' })} />
            ))}
          </ChipGroup>
        ) : null}
        <TextField label={t('arg.custom')} placeholder={t('arg.custom_placeholder')} value={custom} onChangeText={(v) => (setCustom(v), setPicked(null))} maxLength={300} />
      </Section>
      <Banner kind="neutral" message={t('arg.role_note')} />
    </Screen>
  );
}
