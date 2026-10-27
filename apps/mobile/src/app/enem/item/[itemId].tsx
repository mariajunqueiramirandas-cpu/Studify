import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, AiBadge, Button, Card, ErrorState, Options, RichContent, Row, Screen, SkeletonList, Text } from '../../../components';
import { useBankItem } from '../../../features/enem/api';
import { EnemItemHeader } from '../../../features/enem/components';
import { bookletPosition } from '../../../features/enem/format';
import { t } from '../../../i18n';

/**
 * S-ENEM item viewer (ENM-02.2, 02.5–02.7): the item as printed (crops) with the transcription toggle, answer, then
 * the official key and the "Resolução comentada pelo Studify" with why each other alternative is wrong.
 */
export default function EnemItem() {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const item = useBankItem(itemId);
  const [choice, setChoice] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const i = item.data;

  if (item.isError) return <Screen title={t('bank.title')}><ErrorState onRetry={item.refetch} /></Screen>;
  if (!i) return <Screen title={t('bank.title')}><SkeletonList rows={4} /></Screen>;
  const q = i.questions;
  const options = q.payload.options ?? [];

  return (
    <Screen
      title={`ENEM ${i.edition_year}`}
      onBack={() => router.back()}
      footer={
        !revealed ? (
          <ActionBar>
            <Button label={t('quiz.confirm')} disabled={!choice} onPress={() => setRevealed(true)} />
          </ActionBar>
        ) : undefined
      }
    >
      <EnemItemHeader
        meta={{ item_id: i.id, edition_year: i.edition_year, day: i.day, position: bookletPosition(i.positions), annulled: i.annulled, crop_paths: i.crop_paths, alt_text: i.alt_text }}
        transcription={q.stem}
      />
      <Options
        options={options.map((o) => ({ id: o.id, text: o.text }))}
        selected={choice ? [choice] : []}
        correct={revealed && !i.annulled ? [q.payload.correct] : undefined}
        onSelect={setChoice}
        disabled={revealed}
      />
      {revealed ? (
        <>
          {!i.annulled ? (
            <Text variant="heading" tone={choice === q.payload.correct ? 'success' : 'warning'}>
              {t('bank.key', { key: q.payload.correct })}
            </Text>
          ) : null}
          {q.explanation ? (
            <Card>
              <Row>
                <Text variant="heading" style={{ flex: 1 }}>
                  {t('bank.solution.label')}
                </Text>
                <AiBadge />
              </Row>
              <RichContent text={q.explanation} />
              <Text variant="label">{t('bank.wrong_why')}</Text>
              {options
                .filter((o) => o.id !== q.payload.correct && o.rationale && o.rationale !== '—')
                .map((o) => (
                  <Text key={o.id} variant="bodySmall">
                    {o.id}) {o.rationale}
                  </Text>
                ))}
            </Card>
          ) : null}
          {i.skill_code ? <Text variant="caption" tone="secondary">{t('bank.skill', { code: i.skill_code })}</Text> : null}
        </>
      ) : null}
    </Screen>
  );
}
