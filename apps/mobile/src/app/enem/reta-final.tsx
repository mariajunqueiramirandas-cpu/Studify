import { retaFinalStart } from '@studify/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';
import { Banner, Button, Card, Screen, Section, SkeletonList, Text } from '../../components';
import { weekdayDate } from '../../features/common/format';
import { enemDatesFor, useEditions, useEnemGoal } from '../../features/enem/api';
import { daysUntil } from '../../features/enem/format';
import { studyDateOf } from '../../lib/dates';
import { t } from '../../i18n';

/**
 * S-ENEM Reta Final (ENM-10): countdown, the checklist read from enem_editions (never hard-coded), gate times in
 * Brasília time with the edital link, and how the last weeks are planned.
 */
export default function RetaFinal() {
  const { goal } = useEnemGoal();
  const editions = useEditions();
  // The study day is fixed for the life of the screen (rolls over at 04:00).
  const [today] = useState(() => studyDateOf(Date.now()));
  if (!goal || editions.isLoading) return <Screen title={t('final.title')} onBack={() => router.back()}><SkeletonList rows={3} /></Screen>;
  const dates = enemDatesFor(goal, editions.data ?? [], today);
  const e = dates.edition;
  const start = dates.day1 ? retaFinalStart(dates.day1, goal.settings?.reta_final_weeks ?? 4) : null;
  const left = dates.day1 ? daysUntil(dates.day1, today) : null;
  const checklist = (e?.checklist ?? []).map((c) => (typeof c === 'string' ? c : c.text));

  return (
    <Screen title={t('final.title')} onBack={() => router.back()}>
      <Card tone="soft">
        {left !== null && left >= 0 ? <Text variant="title">{t('final.days', { n: left })}</Text> : null}
        {start && today >= start ? <Text variant="heading">{t('final.start')}</Text> : start ? <Text tone="secondary">{t('final.starts_on', { date: weekdayDate(start) })}</Text> : null}
        {dates.provisional && dates.day1 ? <Banner kind="info" message={t('enem.dates.provisional', { data: weekdayDate(dates.day1) })} /> : null}
      </Card>
      <Section title={t('final.checklist.title')}>
        {checklist.length === 0 ? <Text tone="secondary">{t('final.no_checklist')}</Text> : null}
        {checklist.map((c) => (
          <Text key={c}>☐ {c}</Text>
        ))}
        {e?.gates_open && e.gates_close && e.start_time ? <Text variant="bodySmall">{t('final.gates', { open: e.gates_open.slice(0, 5), close: e.gates_close.slice(0, 5), start: e.start_time.slice(0, 5) })}</Text> : null}
        <Banner kind="neutral" message={t('final.checklist.note')} />
        {e?.edital_url ? <Button variant="secondary" icon="open-outline" label={t('final.edital')} onPress={() => void Linking.openURL(e.edital_url!)} /> : null}
      </Section>
      <Section title={t('final.schedule')}>
        {(['focus', 'mocks', 'eve', 'between'] as const).map((k) => (
          <Text key={k} variant="bodySmall">
            • {t(`final.tips.${k}`)}
          </Text>
        ))}
      </Section>
    </Screen>
  );
}
