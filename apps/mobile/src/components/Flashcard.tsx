import type { OcclusionCardMedia } from '@studify/shared';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { radius, space, useTheme } from '../theme';
import { RichContent } from './MarkdownView';
import { OcclusionCardImage } from './OcclusionImage';
import { renderCloze } from './cloze';

export { renderCloze };
import { Text } from './Text';

interface FlashcardProps {
  front: string;
  back: string;
  flipped: boolean;
  onFlip: () => void;
  tags?: string[];
  type?: string;
  clozeIndex?: number | null;
  footer?: React.ReactNode;
  /** MEM-03: occlusion media and a signed URL of its image. */
  media?: OcclusionCardMedia | null;
  mediaUri?: string | null;
}

/**
 * Front/back card. The back is rendered off-screen before the flip so flipping stays < 100 ms
 * (mobile-app.md §8). Reduced motion → crossfade instead of a flip (ux §10).
 */
export function Flashcard({ front, back, flipped, onFlip, tags, type, clozeIndex, footer, media, mediaUri }: FlashcardProps) {
  const { colors: c, reduceMotion } = useTheme();
  const anim = useRef(new Animated.Value(flipped ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, { toValue: flipped ? 1 : 0, duration: reduceMotion ? 150 : 250, useNativeDriver: true }).start();
    if (flipped) AccessibilityInfo.announceForAccessibility(t('review.back'));
  }, [flipped, anim, reduceMotion]);

  const isCloze = type === 'cloze';
  const occlusion = type === 'image_occlusion' && media ? media : null;
  const frontText = isCloze ? renderCloze(front, 'front', clozeIndex) : front;
  const backText = isCloze ? renderCloze(front, 'back', clozeIndex) + (back ? `\n\n${back}` : '') : back;

  const frontStyle = reduceMotion
    ? { opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }) }
    : { transform: [{ perspective: 1200 }, { rotateY: anim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }) }] };
  const backStyle = reduceMotion
    ? { opacity: anim }
    : { transform: [{ perspective: 1200 }, { rotateY: anim.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] }) }] };

  return (
    <Pressable
      onPress={flipped ? undefined : onFlip}
      accessibilityRole="button"
      accessibilityLabel={flipped ? `${t('review.back')}: ${backText}` : `${t('review.front')}: ${frontText}`}
      accessibilityHint={flipped ? undefined : t('review.reveal')}
      style={styles.wrap}
    >
      {tags?.length ? (
        <View style={styles.tags}>
          {tags.map((tag) => (
            <Text key={tag} variant="label" style={{ color: c.lagoon }}>
              {tag}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Animated.View style={[styles.face, { backgroundColor: c.surface1, borderColor: c.border }, frontStyle]} pointerEvents={flipped ? 'none' : 'auto'}>
          <Text variant="label" tone="secondary">
            {t('review.front')}
          </Text>
          <View style={[styles.rule, { backgroundColor: c.danger }]} />
          <View style={styles.content}>
            {occlusion ? <OcclusionCardImage media={occlusion} uri={mediaUri ?? null} revealed={false} /> : null}
            <RichContent text={frontText} variant={occlusion ? 'body' : 'cardFace'} align="center" />
          </View>
        </Animated.View>
        <Animated.View style={[styles.face, styles.back, { backgroundColor: c.surface1, borderColor: c.primary }, backStyle]} pointerEvents={flipped ? 'auto' : 'none'}>
          <Text variant="label" tone="secondary">
            {t('review.back')}
          </Text>
          <View style={[styles.rule, { backgroundColor: c.primary }]} />
          <View style={styles.content}>
            {occlusion ? <OcclusionCardImage media={occlusion} uri={mediaUri ?? null} revealed /> : null}
            <RichContent text={backText} variant="cardFace" align="center" />
          </View>
          {footer}
        </Animated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: space.sm, minHeight: 320 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.md, rowGap: space.xs },
  // An index card: a coloured rule under the header line, the answer area below it.
  face: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.lg, borderWidth: 1, padding: space.xl, paddingTop: space.lg, backfaceVisibility: 'hidden', gap: space.md },
  rule: { height: 1.5, marginHorizontal: -space.xl, opacity: 0.45 },
  back: { borderWidth: 1 },
  content: { flex: 1, justifyContent: 'center' },
});
