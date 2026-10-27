import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { ChipGroup, Chip, EmptyState, ListItem, Screen, SkeletonList, TextField, useOverlay, IconButton } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { relativeDay } from '../../../../features/common/format';
import { setCardFlag, useSubjectCards } from '../../../../features/learn/api';
import { options, t } from '../../../../i18n';

type Filter = 'all' | 'new' | 'due' | 'suspended' | 'hidden';
const FILTERS: Filter[] = ['all', 'new', 'due', 'suspended', 'hidden'];

/** S-MAT-15 Cartões da matéria: search, filter, suspend, hidden cards (MEM-01). */
export default function CardBrowser() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const { userId } = useSession();
  const cards = useSubjectCards(subjectId);
  const overlay = useOverlay();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const labels = options('cards.filters');
  const now = Date.now();

  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    return (cards.data ?? []).filter((c) => {
      if (f && !`${c.front} ${c.back}`.toLowerCase().includes(f)) return false;
      const s = c.state;
      switch (filter) {
        case 'new':
          return !s || s.state === 0;
        case 'due':
          return !!s && !s.suspended && !s.hidden && new Date(s.due).getTime() <= now;
        case 'suspended':
          return !!s?.suspended;
        case 'hidden':
          return !!s?.hidden;
        default:
          return !s?.hidden;
      }
    });
  }, [cards.data, q, filter, now]);

  return (
    <Screen title={t('cards.title')} onRefresh={cards.refetch} refreshing={cards.isRefetching}>
      <TextField placeholder={t('cards.search')} value={q} onChangeText={setQ} accessibilityLabel={t('cards.search')} />
      <ChipGroup>
        {FILTERS.map((f, i) => (
          <Chip key={f} label={labels[i] ?? f} selected={filter === f} onPress={() => setFilter(f)} />
        ))}
      </ChipGroup>
      {cards.isLoading ? <SkeletonList rows={6} height={56} /> : null}
      {cards.isFetched && !list.length ? <EmptyState icon="albums-outline" message={t('topic.no_cards')} /> : null}
      {list.map((c) => (
        <ListItem
          key={c.id}
          title={c.front.replace(/\{\{c\d+::([^}]+?)(::[^}]+)?\}\}/g, '[$1]').slice(0, 140)}
          subtitle={c.state?.suspended ? t('review.suspended') : c.state ? t('cards.due_in', { when: relativeDay(c.state.due) }) : t('review.tag.new')}
          onPress={() => router.push({ pathname: '/subjects/[subjectId]/card/[cardId]', params: { subjectId, cardId: c.id } })}
          right={
            c.state?.suspended || c.state?.hidden ? (
              <IconButton
                icon="refresh-outline"
                label={t('cards.unsuspend')}
                onPress={async () => {
                  await setCardFlag(userId!, c.id, { suspended: false, hidden: false }).catch(() => overlay.snack(t('error.generic')));
                  void cards.refetch();
                }}
              />
            ) : undefined
          }
        />
      ))}
    </Screen>
  );
}
