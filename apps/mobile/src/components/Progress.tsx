import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
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

interface RingProps {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  children?: ReactNode;
  label?: string;
}

/** ProgressRing / GoalRing / readiness ring (ux §6). */
export function ProgressRing({ value, size = 64, stroke = 7, color, children, label }: RingProps) {
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
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={c.surface2} strokeWidth={stroke} fill="none" />
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
    <ProgressRing value={value ?? 0} size={size} label={label}>
      <Text variant="label">{value == null ? '—' : `${Math.round(value * 100)}%`}</Text>
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
  stepper: { flexDirection: 'row', gap: space.xs, paddingVertical: space.sm },
  dot: { height: 5, borderRadius: radius.xs },
});
