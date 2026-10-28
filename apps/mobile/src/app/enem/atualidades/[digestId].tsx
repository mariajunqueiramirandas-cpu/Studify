import { router, useLocalSearchParams } from 'expo-router';
import { Linking, View } from 'react-native';
import { Button, Card, Chip, ChipGroup, ErrorState, RichContent, Screen, SkeletonList, Text, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { generateTheme, saveRepertorio, startBankPractice, useDigestItems } from '../../../features/enem/api';
import { areaName } from '../../../features/enem/components';
import { t } from '../../../i18n';
import { space } from '../../../theme';
import { messageFor } from '../../../api/messages';

/** S-ENEM Atualidades item list (ENM-09.2, 09.5): summary, why it matters, repertório, sources, practice. */
export default function DigestScreen() {
  const { digestId } = useLocalSearchParams<{ digestId: string }>();
  const items = useDigestItems(digestId);
  const { userId } = useSession();
  const overlay = useOverlay();

  if (items.isError) return <Screen title={t('atual.title')}><ErrorState onRetry={items.refetch} /></Screen>;
  if (!items.data) return <Screen title={t('atual.title')}><SkeletonList rows={4} /></Screen>;
  return (
    <Screen title={t('atual.title')} onBack={() => router.back()}>
      {items.data.map((it) => (
        <Card key={it.id}>
          <Text variant="heading">{it.title}</Text>
          <ChipGroup>
            {it.areas.map((a) => (
              <Chip key={a} label={areaName(a as 'LC')} />
            ))}
          </ChipGroup>
          <RichContent text={it.summary_md} variant="bodySmall" />
          <Text variant="label">{t('atual.why')}</Text>
          <RichContent text={it.why_md} variant="bodySmall" />
          {it.repertorio.map((r) => (
            <View key={r.text} style={{ gap: 2 }}>
              <Text variant="bodySmall">• {r.text}</Text>
              <Button
                compact
                variant="text"
                icon="bookmark-outline"
                label={t('atual.save')}
                onPress={() =>
                  void saveRepertorio(userId!, { kind: 'data', text: r.text, sourceUrl: r.source_url, sourceName: it.sources.find((s) => s.url === r.source_url)?.name ?? null, atualidadesItemId: it.id, tags: it.redacao_axes })
                    .then(() => overlay.snack(t('atual.saved')))
                    .catch((e: unknown) => overlay.snack(messageFor(e)))
                }
              />
            </View>
          ))}
          <Text variant="label">{t('atual.sources')}</Text>
          {it.sources.map((s) => (
            <Button key={s.url} compact variant="text" label={`${s.name}${s.published_at ? ` · ${s.published_at.slice(0, 10)}` : ''}`} onPress={() => void Linking.openURL(s.url)} />
          ))}
          <View style={{ gap: space.sm }}>
            {it.question_ids.length ? (
              <Button
                variant="secondary"
                label={t('atual.practice')}
                onPress={() => void startBankPractice(userId!, it.question_ids, false, it.title).then((quizId) => router.push({ pathname: '/quiz/[quizId]', params: { quizId } }))}
              />
            ) : null}
            <Button
              variant="text"
              label={t('atual.theme')}
              onPress={() =>
                void generateTheme({ source: 'atualidades', atualidades_item_id: it.id })
                  .then((r) => router.push({ pathname: '/enem/essay/new', params: { themeId: r.theme_id } }))
                  .catch((e: unknown) => overlay.snack(messageFor(e)))
              }
            />
          </View>
        </Card>
      ))}
    </Screen>
  );
}
