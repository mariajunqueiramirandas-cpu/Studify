import { router, type Href } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Chip, ChipGroup, EmptyState, ErrorState, IconButton, Screen, Section, SkeletonList, useOverlay } from '../../components';
import { RichCard } from '../../features/notifications/RichCard';
import { groupInbox, relativeTime, useInbox, useInboxActions, type InboxChannel, type InboxItem } from '../../features/notifications/inbox';
import { t } from '../../i18n';
import { pathForDeepLink } from '../../platform/notification-links';
import { richNotifier } from '../../platform/rich-notify';
import { space } from '../../theme';

type Filter = 'all' | InboxChannel;
const FILTERS: Filter[] = ['all', 'reviews', 'plan', 'class', 'processing'];

/** S-NOTIF-01 Central de notificações (PLT-05, api.md §9.1): every push kept for 60 days, grouped by day. */
export default function NotificationCenter() {
  const inbox = useInbox();
  const actions = useInboxActions();
  const overlay = useOverlay();
  const [filter, setFilter] = useState<Filter>('all');
  const items = useMemo(() => (inbox.data ?? []).filter((i) => filter === 'all' || i.channel === filter), [inbox.data, filter]);
  const groups = useMemo(() => groupInbox(items), [items]);
  const unread = (inbox.data ?? []).some((i) => !i.read_at);
  const now = new Date();

  const open = (item: InboxItem, link = item.deep_link ?? item.rich.deep_link) => {
    if (!item.read_at) void actions.markRead(item.id);
    // Seen here, so the copy in the shade can go.
    richNotifier.cancel(item.key);
    const path = link ? pathForDeepLink(link) : null;
    if (path) router.push(path as Href);
  };

  const remove = async (item: InboxItem) => {
    if (await overlay.confirm({ title: t('inbox.remove'), message: t('inbox.remove_confirm'), confirmLabel: t('global.delete'), destructive: true })) {
      void actions.remove(item.id);
    }
  };

  return (
    <Screen
      title={t('inbox.title')}
      onRefresh={() => void inbox.refetch()}
      refreshing={inbox.isRefetching}
      actions={unread ? <IconButton icon="checkmark-done-outline" label={t('inbox.mark_all')} onPress={() => void actions.markAllRead()} /> : null}
    >
      <ChipGroup>
        {FILTERS.map((f) => (
          <Chip key={f} label={t(`inbox.filters.${f}`)} selected={filter === f} onPress={() => setFilter(f)} />
        ))}
      </ChipGroup>
      {inbox.isLoading ? (
        <SkeletonList rows={5} height={96} />
      ) : inbox.isError ? (
        <ErrorState onRetry={() => void inbox.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState icon="notifications-outline" title={t('inbox.empty_title')} message={t('inbox.empty')} />
      ) : (
        groups.map((g) => (
          <Section key={g.section} title={t(`inbox.sections.${g.section}`)}>
            <View style={{ gap: space.sm }}>
              {g.items.map((item) => (
                <RichCard
                  key={item.id}
                  n={item.rich}
                  time={relativeTime(item.created_at, now)}
                  unread={!item.read_at}
                  now={now}
                  onPress={() => open(item)}
                  onLongPress={() => void remove(item)}
                  onOpenLink={(link) => open(item, link)}
                  testID={`inbox-${item.key}`}
                />
              ))}
            </View>
          </Section>
        ))
      )}
    </Screen>
  );
}
