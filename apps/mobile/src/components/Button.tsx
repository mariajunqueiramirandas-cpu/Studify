import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { radius, space, touch, useTheme } from '../theme';
import { Text } from './Text';

export type IconName = ComponentProps<typeof Ionicons>['name'];

type Variant = 'primary' | 'secondary' | 'text' | 'destructive' | 'tonal';

interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: Variant;
  icon?: IconName;
  iconRight?: IconName;
  disabled?: boolean;
  /** Shown to TalkBack and as a toast when a disabled AI button is tapped (ux §5.5). */
  disabledReason?: string;
  onDisabledPress?: () => void;
  loading?: boolean;
  fullWidth?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  iconRight,
  disabled,
  disabledReason,
  onDisabledPress,
  loading,
  fullWidth,
  compact,
  style,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const { colors: c } = useTheme();
  // One loud button per screen (primary); the rest stay quiet: an inked outline, a tinted fill or plain text.
  const palette: Record<Variant, { bg: string; fg: string; border?: string }> = {
    primary: { bg: c.primary, fg: c.onPrimary },
    secondary: { bg: c.surface1, fg: c.textPrimary, border: c.border },
    tonal: { bg: c.primarySoft, fg: c.primary },
    text: { bg: 'transparent', fg: c.primary },
    destructive: { bg: c.danger, fg: c.onPrimary },
  };
  const p = palette[variant];
  const inactive = disabled || loading;
  const tone = variant === 'primary' || variant === 'destructive' ? 'onPrimary' : 'accent';

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={disabled && disabledReason ? disabledReason : accessibilityHint}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      onPress={inactive ? (disabled ? onDisabledPress : undefined) : onPress}
      style={({ pressed }) => [
        styles.base,
        compact && styles.compact,
        fullWidth && styles.full,
        { backgroundColor: p.bg, borderColor: p.border ?? 'transparent', opacity: disabled ? 0.45 : 1 },
        pressed && !inactive && { transform: [{ scale: 0.98 }], opacity: 0.9 },
        variant === 'text' && styles.textVariant,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={p.fg} />
      ) : (
        <View style={styles.row}>
          {icon ? <Ionicons name={icon} size={20} color={p.fg} /> : null}
          <Text variant="label" tone={tone} weight={variant === 'primary' || variant === 'destructive' ? 'bold' : undefined} style={{ color: p.fg }} numberOfLines={2} align="center">
            {label}
          </Text>
          {iconRight ? <Ionicons name={iconRight} size={20} color={p.fg} /> : null}
        </View>
      )}
    </Pressable>
  );
}

interface IconButtonProps {
  icon: IconName;
  /** Mandatory PT-BR label (ux §6). */
  label: string;
  onPress?: () => void;
  color?: string;
  size?: number;
  disabled?: boolean;
  filled?: boolean;
  testID?: string;
}

export function IconButton({ icon, label, onPress, color, size = 24, disabled, filled, testID }: IconButtonProps) {
  const { colors: c } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={4}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.icon,
        filled && { backgroundColor: c.surface2 },
        { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 },
      ]}
    >
      <Ionicons name={icon} size={size} color={color ?? c.textPrimary} />
    </Pressable>
  );
}

/** Sticky bottom area for the one primary action of a screen (thumb zone, ux §3). */
export function ActionBar({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme();
  return <View style={[styles.actionBar, { backgroundColor: c.bg, borderTopColor: c.border }]}>{children}</View>;
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compact: { minHeight: 42, paddingHorizontal: space.lg, paddingVertical: space.sm, borderRadius: radius.sm },
  full: { alignSelf: 'stretch' },
  textVariant: { paddingHorizontal: space.md },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  icon: { width: touch.min, height: touch.min, borderRadius: radius.round, alignItems: 'center', justifyContent: 'center' },
  actionBar: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space.sm,
  },
});
