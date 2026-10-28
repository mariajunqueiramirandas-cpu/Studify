import { retroCards } from '@studify/shared';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, View, useWindowDimensions } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import { ActionBar, Button, EmptyState, IconButton, Row, Screen, SkeletonList, SwitchRow, Text, useOverlay } from '../../components';
import { shortDate } from '../../features/common/format';
import { useCapi } from '../../features/motivation/capi';
import { RetroCardView, type RetroCardRef } from '../../features/retro/RetroCardView';
import { useMarkRetroSeen, useRetrospective } from '../../features/retro/api';
import { t } from '../../i18n';
import { space } from '../../theme';
import { messageFor } from '../../api/messages';

/** Retrospectiva story (MOT-04.2–.3): 6–8 swipeable 9:16 cards, each shareable as an image made on the phone. */
export default function RetroStory() {
  const { retroId } = useLocalSearchParams<{ retroId: string }>();
  const retro = useRetrospective(retroId);
  const markSeen = useMarkRetroSeen();
  const capi = useCapi();
  const overlay = useOverlay();
  const { width, height } = useWindowDimensions();
  const [showGrades, setShowGrades] = useState(false);
  const [index, setIndex] = useState(0);
  const [sharing, setSharing] = useState(false);
  const list = useRef<FlatList>(null);
  const cardRefs = useRef(new Map<number, RetroCardRef>());
  const r = retro.data;

  // FlatList needs a stable callback for viewability changes.
  const onViewable = useCallback(({ viewableItems }: { viewableItems: { index?: number | null }[] }) => {
    const first = viewableItems[0];
    if (first?.index != null) setIndex(first.index);
  }, []);

  useEffect(() => {
    if (r && !r.seen_at) void markSeen(r.id).catch(() => undefined);
  }, [r, markSeen]);

  if (retro.isLoading) return <Screen title={t('retro.title')}><SkeletonList rows={2} height={240} /></Screen>;
  if (!r) return <Screen title={t('retro.title')}><EmptyState message={t('retro.not_found')} /></Screen>;

  const cards = retroCards(r.stats, r.title, r.subtitle, { showGrades });
  // Fit the 9:16 card in the space left by the bars.
  const cardWidth = Math.min(width - space.lg * 2, ((height - 260) * 9) / 16);
  const period = `${shortDate(r.period_start)} – ${shortDate(r.period_end)}`;

  const go = (i: number) => {
    const next = Math.max(0, Math.min(cards.length - 1, i));
    list.current?.scrollToIndex({ index: next, animated: true });
    setIndex(next);
  };

  const share = async () => {
    const view = cardRefs.current.get(index);
    if (!view) return;
    setSharing(true);
    try {
      const uri = await captureRef(view, { format: 'png', quality: 1, result: 'tmpfile' });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'image/png', dialogTitle: t('retro.share') });
    } catch (e) {
      overlay.snack(messageFor(e));
    } finally {
      setSharing(false);
    }
  };

  return (
    <Screen
      title={t('retro.title')}
      scroll={false}
      footer={
        <ActionBar>
          <Button icon="share-social-outline" label={t('retro.share')} onPress={share} loading={sharing} />
        </ActionBar>
      }
    >
      <SwitchRow label={t('retro.show_grades')} hint={t('retro.show_grades_hint')} value={showGrades} onChange={setShowGrades} />
      <FlatList
        ref={list}
        data={cards}
        horizontal
        pagingEnabled
        snapToInterval={cardWidth + space.md}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        keyExtractor={(c, i) => `${c.kind}-${i}`}
        onViewableItemsChanged={onViewable}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        getItemLayout={(_, i) => ({ length: cardWidth + space.md, offset: (cardWidth + space.md) * i, index: i })}
        renderItem={({ item, index: i }) => (
          <View style={{ marginRight: space.md }}>
            <RetroCardView
              ref={(v) => {
                if (v) cardRefs.current.set(i, v);
                else cardRefs.current.delete(i);
              }}
              card={item}
              index={i}
              period={period}
              width={cardWidth}
              capi={{ stage: capi.stage, accessories: capi.accessories, visible: capi.visible }}
            />
          </View>
        )}
      />
      {/* WEL-04.7: every swipe has a button alternative. */}
      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <IconButton icon="chevron-back" label={t('retro.prev')} onPress={() => go(index - 1)} disabled={index === 0} />
        <Text variant="bodySmall" tone="secondary">
          {t('retro.position', { n: index + 1, total: cards.length })}
        </Text>
        <IconButton icon="chevron-forward" label={t('retro.next')} onPress={() => go(index + 1)} disabled={index >= cards.length - 1} />
      </Row>
    </Screen>
  );
}
