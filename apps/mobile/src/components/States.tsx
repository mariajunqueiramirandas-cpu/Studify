import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type DimensionValue } from 'react-native';
import { t } from '../i18n';
import { radius, space, useTheme } from '../theme';
import { Button, type IconName } from './Button';
import { CapiScene, useMascotVisible } from './Capi';
import { Text } from './Text';

/**
 * One sentence + one primary action — never just "Nada aqui" (ux §5.5). Capi with the empty box keeps it company;
 * `compact` (inside a tab or a short list) and a hidden mascot use the icon instead.
 */
export function EmptyState({ icon = 'sparkles-outline', title, message, action, compact }: { icon?: IconName; title?: string; message: string; action?: { label: string; onPress: () => void; icon?: IconName }; compact?: boolean }) {
  const { colors: c } = useTheme();
  const mascot = useMascotVisible();
  return (
    <View style={[styles.center, compact && styles.compact]}>
      {mascot && !compact ? (
        <CapiScene scene="empty" size={148} />
      ) : (
        <View style={[styles.illustration, { backgroundColor: c.primarySoft }]}>
          <Ionicons name={icon} size={30} color={c.primary} />
        </View>
      )}
      {title ? (
        <Text variant="heading" align="center">
          {title}
        </Text>
      ) : null}
      <Text variant="body" tone="secondary" align="center">
        {message}
      </Text>
      {action ? <Button label={action.label} icon={action.icon} onPress={action.onPress} /> : null}
    </View>
  );
}

/** Plain PT-BR + "Tentar de novo". No codes, no stack traces. */
export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  const { colors: c } = useTheme();
  const mascot = useMascotVisible();
  return (
    <View style={styles.center} accessibilityRole="alert">
      {mascot ? <CapiScene scene="offline" size={140} /> : <Ionicons name="cloud-offline-outline" size={36} color={c.textSecondary} />}
      <Text variant="body" align="center">
        {message ?? t('error.generic')}
      </Text>
      {onRetry ? <Button variant="secondary" label={t('global.retry')} onPress={onRetry} /> : null}
    </View>
  );
}

/** Skeletons shaped like content; no spinners for long waits (ux §5.5). */
export function Skeleton({ width = '100%', height = 16, rounded = radius.sm }: { width?: DimensionValue; height?: number; rounded?: number }) {
  const { colors: c, reduceMotion } = useTheme();
  const opacity = useRef(new Animated.Value(0.6)).current;
  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.6, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduceMotion]);
  return <Animated.View style={{ width, height, borderRadius: rounded, backgroundColor: c.surface2, opacity }} />;
}

export function SkeletonList({ rows = 4, height = 64 }: { rows?: number; height?: number }) {
  return (
    <View style={{ gap: space.md }} accessibilityLabel={t('global.loading')}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height={height} rounded={radius.lg} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center', gap: space.md, paddingVertical: space.xl, paddingHorizontal: space.lg },
  compact: { paddingVertical: space.lg },
  illustration: { width: 64, height: 64, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
});
