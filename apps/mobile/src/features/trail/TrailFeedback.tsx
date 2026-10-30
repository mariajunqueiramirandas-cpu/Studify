import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native';
import type { TrailStepAnswer } from '@studify/shared';
import { Button, RichContent, RichText, Text } from '../../components';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

/**
 * The verdict, in the thumb zone the moment the answer is checked: a badge, one line on what happened and the key to
 * move on. It slides up from where "Verificar" was, so the eye doesn't have to go looking for it.
 */
export function VerdictBar({ correct, letter, onContinue }: { correct: boolean; letter: string; onContinue: () => void }) {
  const { colors: c, reduceMotion } = useTheme();
  const tint = correct ? { ink: c.success, soft: c.successSoft } : { ink: c.danger, soft: c.dangerSoft };
  const [anim] = useState(() => new Animated.Value(reduceMotion ? 1 : 0));
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(correct ? t('trail.correct') : `${t('trail.wrong')}. ${t('trail.wrong_sub', { letter }).replace(/\*/g, '')}`);
    if (!reduceMotion) Animated.spring(anim, { toValue: 1, friction: 8, tension: 90, useNativeDriver: true }).start();
  }, [anim, correct, letter, reduceMotion]);
  return (
    <Animated.View
      style={[
        styles.bar,
        { backgroundColor: tint.soft, borderTopColor: tint.ink, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [36, 0] }) }] },
      ]}
    >
      <View style={styles.verdict}>
        <View style={[styles.badge, { backgroundColor: tint.ink }]}>
          <Ionicons name={correct ? 'checkmark' : 'close'} size={26} color={c.onPrimary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="title" style={{ color: tint.ink }}>
            {correct ? t('trail.correct') : t('trail.wrong')}
          </Text>
          <RichText variant="bodySmall" style={{ color: c.textPrimary }}>
            {correct ? t('trail.correct_sub') : t('trail.wrong_sub', { letter })}
          </RichText>
        </View>
      </View>
      <Button label={t('trail.continue')} iconRight="arrow-forward" onPress={onContinue} />
    </Animated.View>
  );
}

/** Under the alternatives: the explanation, the tip to remember, and the ways to dig deeper. */
export function Explanation({
  feedback,
  correct,
  saved,
  reteach,
  onExplain,
  onAskTutor,
}: {
  feedback: TrailStepAnswer;
  correct: boolean;
  saved: boolean;
  reteach: boolean;
  onExplain: () => void;
  onAskTutor: () => void;
}) {
  const { colors: c, reduceMotion } = useTheme();
  const [anim] = useState(() => new Animated.Value(reduceMotion ? 1 : 0));
  useEffect(() => {
    if (!reduceMotion) Animated.timing(anim, { toValue: 1, duration: 320, delay: 180, useNativeDriver: true }).start();
  }, [anim, reduceMotion]);
  return (
    <Animated.View style={{ gap: space.md, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }}>
      <View style={[styles.card, { backgroundColor: c.surface1, borderColor: c.border }]}>
        <View style={styles.cardHead}>
          <Ionicons name="book-outline" size={18} color={c.primary} />
          <Text variant="label" tone="accent">
            {t('trail.understand')}
          </Text>
        </View>
        <RichContent variant="reading" text={feedback.explanation} />
      </View>

      {feedback.tip ? (
        <View style={[styles.tip, { backgroundColor: c.infoSoft, borderLeftColor: c.lagoon }]}>
          <Ionicons name="bulb" size={20} color={c.lamp} />
          <View style={{ flex: 1, gap: space.xxs }}>
            <Text variant="label" style={{ color: c.info }}>
              {t('trail.tip')}
            </Text>
            <RichContent text={feedback.tip} />
          </View>
        </View>
      ) : null}

      {saved || reteach ? (
        <View style={{ gap: space.xs }}>
          {reteach ? <Note icon="refresh" text={t('trail.reteach_soon')} /> : null}
          {saved ? <Note icon="bookmark-outline" text={t('trail.saved_to_caderno')} /> : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        <Button compact variant="tonal" icon="sparkles-outline" label={t('notes.explain')} onPress={onExplain} />
        <Button compact variant={correct ? 'text' : 'secondary'} icon="chatbubbles-outline" label={correct ? t('trail.ask_tutor') : t('quiz.dont_understand')} onPress={onAskTutor} />
      </View>
    </Animated.View>
  );
}

function Note({ icon, text }: { icon: 'refresh' | 'bookmark-outline'; text: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.note}>
      <Ionicons name={icon} size={16} color={c.textSecondary} />
      <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: 2, paddingHorizontal: space.gutter, paddingTop: space.lg, paddingBottom: space.sm, gap: space.md },
  verdict: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  badge: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: space.lg, gap: space.sm },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  tip: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start', borderRadius: radius.md, borderLeftWidth: 4, padding: space.md },
  note: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
