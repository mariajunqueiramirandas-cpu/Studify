import { useEffect, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { radius, space, useTheme } from '../theme';
import { Text } from './Text';

export function ProgressBar({ value, color, height = 8, label }: { value: number; color?: string; height?: number; label?: string }) {
  const { colors: c } = useTheme();
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
      style={[styles.track, { height, backgroundColor: c.surface2, borderRadius: radius.xs }]}
    >
      <View style={{ width: `${pct * 100}%`, height, backgroundColor: color ?? c.primary, borderRadius: radius.xs }} />
    </View>
  );
}

/**
 * A bar for work whose share is not known yet: a segment glides across instead of a fill, so the wait always looks
 * alive. Still (a third filled) when the student turned motion off.
 */
export function IndeterminateBar({ color, height = 8, label }: { color?: string; height?: number; label?: string }) {
  const { colors: c, reduceMotion } = useTheme();
  const [anim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reduceMotion) return undefined;
    const loop = Animated.loop(Animated.timing(anim, { toValue: 1, duration: 1400, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [anim, reduceMotion]);
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={label} style={[styles.track, { height, backgroundColor: c.surface2, borderRadius: radius.xs }]}>
      <Animated.View
        style={{
          position: 'absolute',
          height,
          width: '35%',
          borderRadius: radius.xs,
          backgroundColor: color ?? c.primary,
          left: reduceMotion ? '0%' : anim.interpolate({ inputRange: [0, 1], outputRange: ['-35%', '100%'] }),
        }}
      />
    </View>
  );
}

/**
 * The session bar (review, quiz): thick, rounded, and it glides forward after each answer, with a soft shine on
 * top of the fill.
 */
export function SessionProgress({ value, color, label }: { value: number; color?: string; label?: string }) {
  const { colors: c, reduceMotion } = useTheme();
  const pct = Math.max(0, Math.min(1, value));
  const [anim] = useState(() => new Animated.Value(pct));
  useEffect(() => {
    Animated.timing(anim, { toValue: pct, duration: reduceMotion ? 0 : 320, useNativeDriver: false }).start();
  }, [pct, anim, reduceMotion]);
  const fill = color ?? c.success;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
      style={[styles.session, { backgroundColor: c.surface2 }]}
    >
      <Animated.View style={[styles.sessionFill, { backgroundColor: fill, width: anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]}>
        <View style={styles.shine} />
      </Animated.View>
    </View>
  );
}

interface RingProps {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  /** The unfilled part of the ring (default: the well colour). */
  trackColor?: string;
  children?: ReactNode;
  label?: string;
}

/** ProgressRing / GoalRing / readiness ring (ux §6). */
export function ProgressRing({ value, size = 64, stroke = 7, color, trackColor, children, label }: RingProps) {
  const { colors: c } = useTheme();
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct * 100) }}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={trackColor ?? c.surface2} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={color ?? c.primary}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${circumference} ${circumference}`}
          strokeDashoffset={circumference * (1 - pct)}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      {children}
    </View>
  );
}

export function PctRing({ value, size = 56, label }: { value: number | null | undefined; size?: number; label?: string }) {
  return (
    <ProgressRing value={value ?? 0} size={size} stroke={Math.max(4, Math.round(size * 0.12))} label={label}>
      <Text variant="label" weight="bold" style={size < 48 ? { fontSize: Math.round(size * 0.29), lineHeight: Math.round(size * 0.36) } : undefined}>
        {value == null ? '—' : `${Math.round(value * 100)}%`}
      </Text>
    </ProgressRing>
  );
}

/** Wizard progress dots (Stepper, ux §6). */
export function Stepper({ step, total }: { step: number; total: number }) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.stepper} accessibilityLabel={`Passo ${step} de ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <View key={i} style={[styles.dot, { backgroundColor: i < step ? c.primary : c.surface2, flex: 1 }]} />
      ))}
    </View>
  );
}

export function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ alignItems: 'center', flex: 1, gap: 2 }}>
      <Text variant="title">{value}</Text>
      <Text variant="bodySmall" tone="secondary" align="center">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: '100%', overflow: 'hidden' },
  session: { flex: 1, height: 16, borderRadius: 8, overflow: 'hidden' },
  sessionFill: { height: 16, borderRadius: 8, minWidth: 16, justifyContent: 'flex-start' },
  shine: { height: 4, marginTop: 3, marginHorizontal: 7, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)' },
  stepper: { flexDirection: 'row', gap: space.xs, paddingVertical: space.sm },
  dot: { height: 5, borderRadius: radius.xs },
});
