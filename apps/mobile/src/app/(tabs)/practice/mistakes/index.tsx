import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, EmptyState, ListItem, Screen, SkeletonList } from '../../../../components';
import { causeLabel } from '../../../../components/Practice';
import { relativeDay } from '../../../../features/common/format';
import { useMistakes } from '../../../../features/practice/api';
import { MISTAKE_CAUSES } from '../../../../features/practice/types';
import { options, t } from '../../../../i18n';

type Filter = 'open' | 'resolved' | 'all';

/** S-PRA-09 Caderno de Erros: list, filters, cause stats, "Refazer erros" (PRA-04). */
export default function Mistakes() {
  const [filter, setFilter] = useState<Filter>('open');
  const mistakes = useMistakes(filter);
  const labels = options('mistakes.filters');
  const list = mistakes.data ?? [];

  // "40% dos seus erros são desatenção" — the most frequent cause with ≥ 5 entries.
  const stat = useMemo(() => {
    const withCause = list.filter((m) => m.cause);
    if (withCause.length < 5) return null;
    const counts = MISTAKE_CAUSES.map((c) => ({ c, n: withCause.filter((m) => m.cause === c).length })).sort((a, b) => b.n - a.n)[0]!;
    return t('mistakes.stat', { p: Math.round((counts.n / withCause.length) * 100), cause: causeLabel(counts.c).toLowerCase() });
  }, [list]);

  const dueNow = list.filter((m) => !m.resolved_at && new Date(m.next_retry_at) <= new Date()).length;

  return (
    <Screen
      title={t('mistakes.title')}
      onRefresh={mistakes.refetch}
      refreshing={mistakes.isRefetching}
      footer={
        dueNow ? (
          <ActionBar>
            <Button label={`${t('mistakes.retry')} (${dueNow})`} onPress={() => router.push({ pathname: '/practice/quiz/new', params: { kind: 'mistake_retry' } })} />
          </ActionBar>
        ) : undefined
      }
    >
      <ChipGroup>
        {(['open', 'resolved', 'all'] as Filter[]).map((f, i) => (
          <Chip key={f} label={labels[i] ?? f} selected={filter === f} onPress={() => setFilter(f)} />
        ))}
      </ChipGroup>
      {stat ? <Banner kind="info" message={stat} /> : null}
      {mistakes.isLoading ? <SkeletonList rows={5} /> : null}
      {mistakes.isFetched && !list.length ? <EmptyState icon="happy-outline" message={t('mistakes.empty')} /> : null}
      {list.map((m) => (
        <Card key={m.id}>
          <ListItem
            title={(m.question?.stem ?? '').replace(/[*_$`#]/g, '').slice(0, 140)}
            subtitle={[causeLabel(m.cause ?? m.suggested_cause), m.resolved_at ? t('mistakes.resolved') : t('mistakes.next_retry', { when: relativeDay(m.next_retry_at) })].join(' · ')}
            onPress={() => router.push(`/practice/mistakes/${m.id}`)}
          />
        </Card>
      ))}
    </Screen>
  );
}
