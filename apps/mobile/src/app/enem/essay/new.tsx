import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { ActionBar, Banner, BottomSheet, Button, Card, Chip, ChipGroup, ListItem, RichContent, Screen, Section, Text, TextField, useOnline, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { gradeEssay } from '../../../features/camera/api';
import { createEnemEssay, generateTheme, useEnemEssays, useEssayTheme, usePastThemes, usePredictedThemes, updateEssayText } from '../../../features/enem/api';
import { editorLines } from '../../../features/enem/format';
import { getKv } from '../../../lib/kv';
import { t } from '../../../i18n';
import { radius, space, useTheme } from '../../../theme';
import { messageFor } from '../../../api/messages';

const DRAFT_KEY = 'enem.essay.draft';

/**
 * S-ENEM Redação (ENM-05.1, 05.8): pick a theme (training, past, Atualidades or typed), read the proposal and write
 * in a 30-line editor with the line counter, or photograph the handwritten essay. Drafts survive the app closing.
 */
export default function NewEnemEssay() {
  const params = useLocalSearchParams<{ themeId?: string; themeTitle?: string; text?: string; essayId?: string }>();
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const { colors: c, type } = useTheme();
  const predicted = usePredictedThemes();
  const past = usePastThemes();
  const essays = useEnemEssays();
  const [themeId, setThemeId] = useState<string | null>(params.themeId ?? null);
  const theme = useEssayTheme(themeId ?? undefined);
  // A theme without a row (e.g. a typed debate theme from the Treino de Argumentação) travels as its title.
  const typedTheme = themeId ? null : (params.themeTitle ?? null);
  const [picker, setPicker] = useState(!params.themeId && !params.themeTitle);
  const [custom, setCustom] = useState('');
  const [text, setText] = useState(() => params.text ?? getKv().getString(DRAFT_KEY) ?? '');
  const [busy, setBusy] = useState(false);
  const lines = editorLines(text);

  // Drafts are saved locally on every change (offline-safe).
  useEffect(() => {
    getKv().set(DRAFT_KEY, text);
  }, [text]);

  const pick = async (req: Parameters<typeof generateTheme>[0]) => {
    setBusy(true);
    try {
      const res = await generateTheme(req);
      setThemeId(res.theme_id);
      setPicker(false);
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!userId || (!themeId && !typedTheme)) return;
    setBusy(true);
    try {
      const id = params.essayId ?? (await createEnemEssay(userId, { themeId, themeTitle: theme.data?.title ?? typedTheme, text }));
      if (params.essayId) await updateEssayText(params.essayId, text);
      const graded = await gradeEssay(id);
      getKv().remove(DRAFT_KEY);
      router.replace({ pathname: '/enem/essay/[essayId]', params: { essayId: id, ...(graded.mode === 'async' ? { jobId: graded.job_id } : {}) } });
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  const graded = (essays.data ?? []).filter((e) => e.status === 'graded');
  return (
    <Screen
      title={t('red.title')}
      onBack={() => router.back()}
      footer={
        themeId || typedTheme ? (
          <ActionBar>
            <Button label={t('red.submit')} loading={busy} disabled={!online || !text.trim()} onPress={() => void submit()} />
            {themeId ? <Button variant="text" icon="camera-outline" label={t('red.photo')} onPress={() => router.push({ pathname: '/camera', params: { intent: 'grade_essay', themeId } })} /> : null}
          </ActionBar>
        ) : undefined
      }
    >
      {theme.data ? (
        <Card tone="soft" onPress={() => setPicker(true)}>
          <Text variant="caption" tone="secondary">
            {t('red.theme.title')}
          </Text>
          <Text variant="heading">{theme.data.title}</Text>
          {theme.data.source === 'predicted' ? <Text variant="caption" tone="secondary">{t('red.theme.predicted_note')}</Text> : null}
          {theme.data.prompt?.instruction ? (
            <>
              <Text variant="label">{t('red.instruction')}</Text>
              <Text variant="bodySmall">{theme.data.prompt.instruction}</Text>
            </>
          ) : null}
          {(theme.data.prompt?.motivating_texts ?? []).length > 0 ? <Text variant="label">{t('red.motivating')}</Text> : null}
          {(theme.data.prompt?.motivating_texts ?? []).map((m) => (
            <View key={m.label} style={{ gap: 2 }}>
              <Text variant="caption">{m.label}</Text>
              <RichContent text={m.text_md} variant="bodySmall" />
              {m.source_name ? <Text variant="caption" tone="secondary">{m.source_name}</Text> : null}
            </View>
          ))}
        </Card>
      ) : typedTheme ? (
        <Card tone="soft" onPress={() => setPicker(true)}>
          <Text variant="caption" tone="secondary">
            {t('red.theme.title')}
          </Text>
          <Text variant="heading">{typedTheme}</Text>
        </Card>
      ) : (
        <Button icon="sparkles-outline" label={t('red.theme.pick')} onPress={() => setPicker(true)} />
      )}

      {themeId || typedTheme ? (
        <>
          <Text variant="label" tone={lines.tooShort || lines.tooLong ? 'warning' : 'secondary'}>
            {t('red.lines', { n: lines.lines })}
          </Text>
          <TextInput
            multiline
            value={text}
            onChangeText={setText}
            accessibilityLabel={t('red.write')}
            placeholder={t('red.write')}
            style={[type('body'), { borderWidth: 1.5, borderColor: c.border, borderRadius: radius.md, padding: space.md, minHeight: 360, textAlignVertical: 'top', color: c.textPrimary, lineHeight: 26 }]}
          />
          {lines.tooShort && text.trim() ? <Banner kind="warning" message={t('red.too_short')} /> : null}
          {lines.tooLong ? <Banner kind="warning" message={t('red.too_long')} /> : null}
        </>
      ) : null}

      {graded.length > 0 ? (
        <Section title={t('red.history')}>
          {graded.slice(0, 6).map((e) => (
            <ListItem key={e.id} title={e.prompt?.theme ?? t('red.title')} subtitle={`${t('red.score.label')}: ${e.total ?? '—'}`} onPress={() => router.push({ pathname: '/enem/essay/[essayId]', params: { essayId: e.id } })} />
          ))}
        </Section>
      ) : null}

      <BottomSheet visible={picker} onClose={() => setPicker(false)} title={t('red.theme.pick')}>
        <View style={{ gap: space.md }}>
          <Button icon="sparkles-outline" label={t('red.theme.predicted')} loading={busy} disabled={!online} onPress={() => void pick({ source: 'predicted' })} />
          <Text variant="caption" tone="secondary">
            {t('red.theme.predicted_note')}
          </Text>
          <ChipGroup>
            {(predicted.data ?? []).slice(0, 8).map((th) => (
              <Chip key={th.id} label={th.title.length > 60 ? `${th.title.slice(0, 57)}…` : th.title} onPress={() => (setThemeId(th.id), setPicker(false))} />
            ))}
          </ChipGroup>
          <Button variant="secondary" label={t('red.theme.past')} loading={busy} disabled={!online} onPress={() => void pick({ source: 'past_enem' })} />
          {(past.data ?? []).slice(0, 4).map((p) => (
            <Text key={p.edition_year} variant="caption" tone="secondary">
              {p.edition_year}: {p.theme}
            </Text>
          ))}
          <Button variant="secondary" label={t('red.theme.atualidades')} loading={busy} disabled={!online} onPress={() => void pick({ source: 'atualidades' })} />
          <TextField label={t('red.theme.custom')} value={custom} onChangeText={setCustom} placeholder={t('red.theme.custom_placeholder')} />
          <Button variant="tonal" label={t('red.theme.use')} loading={busy} disabled={!online || custom.trim().length < 5} onPress={() => void pick({ source: 'custom', title: custom.trim() })} />
        </View>
      </BottomSheet>
    </Screen>
  );
}
