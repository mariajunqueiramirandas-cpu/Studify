import { Ionicons } from '@expo/vector-icons';
import { createContext, useContext, type ComponentProps, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { tap } from '../lib/haptics';
import { depth, radius, shade, space, touch, useTheme } from '../theme';
import { Tactile } from './Tactile';
import { Text } from './Text';

export type IconName = ComponentProps<typeof Ionicons>['name'];

type Variant = 'primary' | 'secondary' | 'text' | 'destructive' | 'tonal' | 'lamp';

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
  const inBar = useContext(InActionBar);
  // One loud button per screen (primary); the rest stay quieter: a raised paper key, a tinted key or plain text.
  const palette: Record<Variant, { bg: string; fg: string; ledge: string; border?: string }> = {
    primary: { bg: c.primary, fg: c.onPrimary, ledge: shade(c.primary, 0.32) },
    secondary: { bg: c.surface1, fg: c.textPrimary, ledge: shade(c.border, 0.12), border: c.border },
    tonal: { bg: c.primarySoft, fg: c.primary, ledge: shade(c.primarySoft, 0.14) },
    text: { bg: 'transparent', fg: c.primary, ledge: 'transparent' },
    destructive: { bg: c.danger, fg: c.onPrimary, ledge: shade(c.danger, 0.32) },
    // The loud key on an ink-filled hero, where an indigo primary would disappear.
    lamp: { bg: c.lamp, fg: c.onLamp, ledge: shade(c.lamp, 0.35) },
  };
  // A disabled key goes grey and flat-coloured instead of fading: it reads as "not yet", not as a washed-out colour.
  const greyed = disabled && (variant === 'primary' || variant === 'destructive' || variant === 'tonal' || variant === 'lamp');
  const p = greyed ? { bg: c.surface2, fg: c.textSecondary, ledge: shade(c.surface2, 0.12) } : palette[variant];
  const inactive = disabled || loading;
  const tone = variant === 'primary' || variant === 'destructive' ? 'onPrimary' : 'accent';
  const press = inactive ? (disabled ? onDisabledPress : undefined) : onPress;
  const a11y = {
    testID,
    accessibilityLabel: accessibilityLabel ?? label,
    accessibilityHint: disabled && disabledReason ? disabledReason : accessibilityHint,
    accessibilityState: { disabled: !!inactive, busy: !!loading },
  };
  const content = loading ? (
    <ActivityIndicator color={p.fg} />
  ) : (
    <View style={styles.row}>
      {icon ? <Ionicons name={icon} size={20} color={p.fg} /> : null}
      <Text variant="label" tone={tone} weight={variant === 'text' ? undefined : 'bold'} style={{ color: p.fg }} numberOfLines={2} align="center">
        {label}
      </Text>
      {iconRight ? <Ionicons name={iconRight} size={20} color={p.fg} /> : null}
    </View>
  );

  if (variant === 'text') {
    return (
      <Pressable
        {...a11y}
        accessibilityRole="button"
        onPress={press}
        onPressIn={press ? tap : undefined}
        hitSlop={inBar ? 4 : undefined}
        style={({ pressed }) => [styles.base, compact && styles.compact, fullWidth && styles.full, styles.textVariant, inBar && styles.barText, { opacity: disabled ? 0.45 : pressed ? 0.6 : 1 }, style]}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <Tactile
      {...a11y}
      onPress={press}
      color={p.bg}
      ledge={p.ledge}
      borderColor={p.border}
      borderWidth={p.border ? 2 : 0}
      radius={compact ? radius.md : radius.lg}
      depth={compact ? depth.sm : depth.md}
      haptic={!!press}
      style={[styles.base, inBar && styles.barKey, compact && styles.compact, fullWidth && styles.full, disabled && !greyed && { opacity: 0.45 }, style]}
    >
      {content}
    </Tactile>
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
      onPressIn={disabled || !onPress ? undefined : tap}
      style={({ pressed }) => [
        styles.icon,
        filled && { backgroundColor: c.surface2 },
        pressed && !disabled && { backgroundColor: c.surface2, transform: [{ scale: 0.9 }] },
        { opacity: disabled ? 0.4 : 1 },
      ]}
    >
      <Ionicons name={icon} size={size} color={color ?? c.textPrimary} />
    </Pressable>
  );
}

/** Buttons inside an ActionBar sit tighter, so the sticky footer stays a strip rather than a slab. */
const InActionBar = createContext(false);

/** Sticky bottom area for the one primary action of a screen (thumb zone, ux §3). */
export function ActionBar({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme();
  return (
    <InActionBar.Provider value>
      <View style={[styles.actionBar, { backgroundColor: c.bg, borderTopColor: c.border }]}>{children}</View>
    </InActionBar.Provider>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 54,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compact: { minHeight: 44, paddingHorizontal: space.lg, paddingVertical: space.sm },
  full: { alignSelf: 'stretch' },
  textVariant: { minHeight: touch.min, paddingHorizontal: space.md, paddingVertical: space.sm },
  // In the footer a text button is a short line under the key; hitSlop keeps the 48 dp target.
  barText: { minHeight: 40, paddingVertical: space.xs },
  barKey: { minHeight: 50, paddingVertical: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  icon: { width: touch.min, height: touch.min, borderRadius: radius.round, alignItems: 'center', justifyContent: 'center' },
  actionBar: {
    paddingHorizontal: space.gutter,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: space.xs,
  },
});
