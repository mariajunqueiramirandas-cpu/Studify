import { Banner, ListItem, ProgressBar, Screen, Section, Text } from '../../../components';
import { useAiUsage } from '../../../features/profile/api';
import { t } from '../../../i18n';

/** S-PERF-13 Uso de IA (PLT-04.2): today's usage as % of the limit — never money. */
export default function AiUsage() {
  const usage = useAiUsage();
  const pct = usage.data?.pct ?? 0;
  return (
    <Screen title={t('ai_usage.title')} onRefresh={usage.refetch} refreshing={usage.isRefetching}>
      <Section title={t('ai_usage.today')}>
        <ProgressBar value={pct / 100} height={12} label={t('ai_usage.usage', { p: pct })} />
        <Text>{t('ai_usage.usage', { p: pct })}</Text>
        <Text variant="bodySmall" tone="secondary">
          {t('ai_usage.resets')}
        </Text>
      </Section>
      {pct >= 100 ? <Banner kind="warning" message={t('budget.user_daily')} /> : pct >= 80 ? <Banner kind="info" message="Você já usou boa parte da IA de hoje. Revisões e o que já foi gerado continuam liberados." /> : null}
      {usage.data?.byFeature.length ? (
        <Section title={t('ai_usage.by_feature')}>
          {usage.data.byFeature.map((f) => (
            <ListItem key={f.feature} title={f.feature} subtitle={`${f.pct}%`} />
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}
