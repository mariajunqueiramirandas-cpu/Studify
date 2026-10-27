import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { TextInput, View } from 'react-native';
import { ActionBar, AiBadge, Banner, Button, Card, PageChips, Row, Screen, SkeletonList, Text, useOnline, useOverlay } from '../../../../../components';
import { useSession } from '../../../../../features/auth/session';
import { reviewContribution, saveContribution, submitContribution, useMyContribution } from '../../../../../features/class/turma5';
import { t } from '../../../../../i18n';
import { radius, space, useTheme } from '../../../../../theme';

const MIN_CHARS = 80;

/** SOC-06.2–06.4: write the summary of a claimed topic, get a private AI review against the pages, then send it. */
export default function WriteContribution() {
  const { planId, nodeId, title } = useLocalSearchParams<{ classGroupId: string; planId: string; nodeId: string; title?: string }>();
  const mine = useMyContribution(planId, nodeId);
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const { colors: c, type } = useTheme();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'review' | 'submit' | null>(null);
  const body = text ?? mine.data?.body_md ?? '';
  const locked = mine.data ? mine.data.status !== 'draft' : false;
  const feedback = mine.data?.ai_feedback ?? null;

  // A photographed page comes back through the camera flow and lands in the draft.
  useFocusEffect(
    useCallback(() => {
      void mine.refetch().then(() => setText(null));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  const persist = async () => {
    const id = await saveContribution(userId!, { id: mine.data?.id ?? null, planId, nodeId, body });
    await mine.refetch();
    setText(null);
    return id;
  };
  const run = async (step: 'save' | 'review' | 'submit') => {
    setBusy(step);
    try {
      const id = await persist();
      if (step === 'review') await reviewContribution(id);
      if (step === 'submit') {
        const res = await submitContribution(id);
        overlay.snack(res.merge_started ? t('divide.merge_started') : t('divide.sent'));
      }
      await mine.refetch();
      if (step === 'save') overlay.snack(t('divide.saved'));
    } catch (e) {
      overlay.snack((e as { message?: string }).message ?? t('error.generic'));
    } finally {
      setBusy(null);
    }
  };

  if (mine.isLoading) return <Screen title={title ?? t('divide.write')}><SkeletonList rows={3} /></Screen>;
  return (
    <Screen
      title={title ?? t('divide.write')}
      onBack={() => router.back()}
      footer={
        locked ? undefined : (
          <ActionBar>
            <Button label={t('divide.submit')} loading={busy === 'submit'} disabled={!online || body.trim().length < MIN_CHARS} onPress={() => void run('submit')} />
            <Button variant="text" label={t('divide.review')} loading={busy === 'review'} disabled={!online || body.trim().length < MIN_CHARS} onPress={() => void run('review')} />
          </ActionBar>
        )
      }
    >
      {locked ? <Banner kind="success" message={t('divide.locked')} /> : <Text tone="secondary">{t('divide.write_hint')}</Text>}
      <TextInput
        multiline
        editable={!locked}
        value={body}
        onChangeText={setText}
        placeholder={t('divide.write_placeholder')}
        accessibilityLabel={t('divide.write')}
        style={[type('body'), { borderWidth: 1.5, borderColor: c.border, borderRadius: radius.md, padding: space.md, minHeight: 280, textAlignVertical: 'top', color: c.textPrimary }]}
      />
      {!locked ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button compact variant="text" icon="save-outline" label={t('global.save')} loading={busy === 'save'} disabled={!online || !body.trim()} onPress={() => void run('save')} />
          <Button
            compact
            variant="text"
            icon="camera-outline"
            label={t('divide.photo')}
            disabled={!online}
            onPress={() => void persist().then((id) => router.push({ pathname: '/camera', params: { intent: 'grade_answer', purpose: 'contribution', contributionId: id } }))}
          />
        </View>
      ) : null}
      {feedback ? (
        <Card tone="soft">
          <Row>
            <Text variant="heading" style={{ flex: 1 }}>
              {t('divide.feedback')}
            </Text>
            <AiBadge />
          </Row>
          <Text variant="bodySmall">{feedback.summary}</Text>
          {feedback.errors.map((e, i) => (
            <View key={i} style={{ gap: 2 }}>
              <Text variant="bodySmall">“{e.quote}”</Text>
              <Text variant="bodySmall" tone="success">
                → {e.correction}
              </Text>
              {e.document_id && e.page ? <PageChips sources={[{ document_id: e.document_id, page_start: e.page, page_end: e.page }]} /> : null}
            </View>
          ))}
          {feedback.missing_concepts.length ? (
            <Text variant="bodySmall" tone="secondary">
              {t('divide.missing')}: {feedback.missing_concepts.join(', ')}
            </Text>
          ) : null}
          <Text variant="caption" tone="secondary">
            {t('divide.private')}
          </Text>
        </Card>
      ) : null}
    </Screen>
  );
}
