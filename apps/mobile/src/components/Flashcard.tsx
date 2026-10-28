import { Ionicons } from '@expo/vector-icons';
import type { OcclusionCardMedia } from '@studify/shared';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { tap } from '../lib/haptics';
import { depth, radius, shade, space, useTheme } from '../theme';
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
  const [press] = useState(() => new Animated.Value(1));

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

  // Squish under the thumb, spring back on release: the card feels like a thing, not a picture.
  const squish = (to: number) => {
    if (reduceMotion) return;
    Animated.spring(press, { toValue: to, useNativeDriver: true, speed: 40, bounciness: to === 1 ? 10 : 0 }).start();
  };
  const ledge = shade(c.border, 0.14);

  return (
    <Pressable
      onPress={
        flipped
          ? undefined
          : () => {
              tap();
              onFlip();
            }
      }
      onPressIn={flipped ? undefined : () => squish(0.97)}
      onPressOut={() => squish(1)}
      accessibilityRole="button"
      accessibilityLabel={flipped ? `${t('review.back')}: ${backText}` : `${t('review.front')}: ${frontText}`}
      accessibilityHint={flipped ? undefined : t('review.reveal')}
      style={styles.wrap}
    >
      {tags?.length ? (
        <View style={styles.tags}>
          {tags.map((tag) => (
            <View key={tag} style={[styles.tag, { backgroundColor: c.infoSoft }]}>
              <Text variant="label" weight="bold" style={{ color: c.info }}>
                {tag}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <Animated.View style={{ flex: 1, transform: [{ scale: press }] }}>
        <Animated.View style={[styles.face, { backgroundColor: c.surface1, borderColor: c.border, borderBottomColor: ledge }, frontStyle]} pointerEvents={flipped ? 'none' : 'auto'}>
          <View style={styles.content}>
            {occlusion ? <OcclusionCardImage media={occlusion} uri={mediaUri ?? null} revealed={false} /> : null}
            <RichContent text={frontText} variant={occlusion ? 'body' : 'cardFace'} align="center" />
          </View>
          <View style={styles.hint}>
            <Ionicons name="sync-outline" size={16} color={c.textSecondary} />
            <Text variant="bodySmall" tone="secondary">
              {t('review.tap_to_flip')}
            </Text>
          </View>
        </Animated.View>
        <Animated.View style={[styles.face, { backgroundColor: c.surface1, borderColor: c.lagoon, borderBottomColor: shade(c.lagoon, 0.25) }, backStyle]} pointerEvents={flipped ? 'auto' : 'none'}>
          {!occlusion && !isCloze && frontText.trim() ? (
            <View style={[styles.backBand, { backgroundColor: c.infoSoft }]}>
              <Text variant="bodySmall" weight="bold" style={{ color: c.info }} align="center" numberOfLines={2}>
                {frontText.replace(/[*_$`#>]/g, '').slice(0, 90)}
              </Text>
            </View>
          ) : null}
          <View style={styles.content}>
            {occlusion ? <OcclusionCardImage media={occlusion} uri={mediaUri ?? null} revealed /> : null}
            <RichContent text={backText} variant="cardFace" align="center" />
          </View>
          {footer}
        </Animated.View>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, gap: space.md, minHeight: 340 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  tag: { borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 3 },
  // A chunky card standing on a ledge; the answer side gets a lagoon rim and a band repeating the question.
  face: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radius.xl,
    borderWidth: 2,
    borderBottomWidth: depth.lg,
    padding: space.xl,
    backfaceVisibility: 'hidden',
    gap: space.md,
    overflow: 'hidden',
  },
  backBand: { marginHorizontal: -space.xl, marginTop: -space.xl, paddingHorizontal: space.xl, paddingVertical: space.md },
  hint: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xs },
  content: { flex: 1, justifyContent: 'center' },
});
