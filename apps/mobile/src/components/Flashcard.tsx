import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { radius, space, useTheme } from '../theme';
import { RichContent } from './MarkdownView';
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
}

/** Turns "{{c1::mitocôndria}}" into a blank on the front and bold on the back (MEM-01 cloze). */
export function renderCloze(text: string, side: 'front' | 'back', index?: number | null): string {
  return text.replace(/\{\{c(\d+)::([^}]+?)(?:::([^}]+))?\}\}/g, (_, n: string, answer: string, hint?: string) => {
    const active = index == null || Number(n) === index;
    if (!active) return answer;
    if (side === 'front') return hint ? `[… ${hint}]` : '[…]';
    return `**${answer}**`;
  });
}

/**
 * Front/back card. The back is rendered off-screen before the flip so flipping stays < 100 ms
 * (mobile-app.md §8). Reduced motion → crossfade instead of a flip (ux §10).
 */
export function Flashcard({ front, back, flipped, onFlip, tags, type, clozeIndex, footer }: FlashcardProps) {
  const { colors: c, reduceMotion } = useTheme();
  const anim = useRef(new Animated.Value(flipped ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, { toValue: flipped ? 1 : 0, duration: reduceMotion ? 150 : 250, useNativeDriver: true }).start();
    if (flipped) AccessibilityInfo.announceForAccessibility(t('review.back'));
  }, [flipped, anim, reduceMotion]);

  const isCloze = type === 'cloze';
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
            <View key={tag} style={[styles.tag, { backgroundColor: c.primarySoft }]}>
              <Text variant="label" tone="accent">
                {tag}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      <View style={{ flex: 1 }}>
        <Animated.View style={[styles.face, { backgroundColor: c.surface1, borderColor: c.border }, frontStyle]} pointerEvents={flipped ? 'none' : 'auto'}>
          <Text variant="label" tone="secondary">
            {t('review.front')}
          </Text>
          <View style={styles.content}>
            <RichContent text={frontText} variant="cardFace" align="center" />
          </View>
        </Animated.View>
        <Animated.View style={[styles.face, styles.back, { backgroundColor: c.surface1, borderColor: c.primary }, backStyle]} pointerEvents={flipped ? 'auto' : 'none'}>
          <Text variant="label" tone="secondary">
            {t('review.back')}
          </Text>
          <View style={styles.content}>
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
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  tag: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 4 },
  face: { ...StyleSheet.absoluteFillObject, borderRadius: radius.xl, borderWidth: 1, padding: space.xl, backfaceVisibility: 'hidden', gap: space.md },
  back: { borderWidth: 2 },
  content: { flex: 1, justifyContent: 'center' },
});
