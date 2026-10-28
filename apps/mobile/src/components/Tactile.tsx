import type { ReactNode } from 'react';
import { Pressable, type AccessibilityRole, type AccessibilityState, type StyleProp, type ViewStyle } from 'react-native';
import { tap } from '../lib/haptics';
import { depth as depths, radius as radii } from '../theme';

export interface TactileProps {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** Face colour. */
  color: string;
  /** The ledge under the face; usually `shade(color, …)` or the border colour, a step darker. */
  ledge: string;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
  depth?: number;
  /** Tick under the finger on press-in (default on). */
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Extra styles while pressed (e.g. a tinted face). */
  pressedStyle?: StyleProp<ViewStyle>;
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: AccessibilityState;
  hitSlop?: number;
  testID?: string;
}

/**
 * Something you can press that feels like a key: it stands on a ledge a few dp tall and sinks onto it under the
 * finger, with a light tick. The outer height never changes, so nothing around it jumps.
 */
export function Tactile({
  children,
  onPress,
  onLongPress,
  disabled,
  color,
  ledge,
  borderColor,
  borderWidth = 0,
  radius = radii.lg,
  depth = depths.md,
  haptic = true,
  style,
  pressedStyle,
  accessibilityRole = 'button',
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  hitSlop,
  testID,
}: TactileProps) {
  const rest = Math.max(borderWidth, 1);
  return (
    <Pressable
      testID={testID}
      onPress={disabled ? undefined : onPress}
      onLongPress={disabled ? undefined : onLongPress}
      onPressIn={disabled || !haptic ? undefined : tap}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, ...accessibilityState }}
      hitSlop={hitSlop}
      style={({ pressed }) => {
        const down = pressed && !disabled && !!(onPress || onLongPress);
        return [
          {
            backgroundColor: color,
            borderRadius: radius,
            borderWidth,
            borderColor: borderColor ?? color,
            borderBottomColor: ledge,
            borderBottomWidth: down ? rest : depth,
            marginTop: down ? depth - rest : 0,
          },
          style,
          down && pressedStyle,
        ];
      }}
    >
      {children}
    </Pressable>
  );
}
