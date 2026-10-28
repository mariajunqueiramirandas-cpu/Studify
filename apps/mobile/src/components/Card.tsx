import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { depth, FONTS, radius, shade, space, subjectColor, touch, useTheme } from '../theme';
import type { IconName } from './Button';
import { Tactile } from './Tactile';
import { Text } from './Text';

interface CardProps {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Subject color, shown as a bookmark ribbon hanging from the top edge (ux §6). */
  accent?: string | null;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  tone?: 'default' | 'soft' | 'outline';
  testID?: string;
}

export function Card({ children, onPress, onLongPress, accent, style, accessibilityLabel, tone = 'default', testID }: CardProps) {
  const { colors: c } = useTheme();
  const bg = tone === 'soft' ? c.primarySoft : tone === 'outline' ? 'transparent' : c.surface1;
  const content = (
    <>
      {accent ? <Ribbon color={accent} /> : null}
      <View style={[styles.inner, accent ? { paddingTop: space.lg + 8 } : null]}>{children}</View>
    </>
  );
  const border = tone === 'soft' ? 'transparent' : c.border;
  const base = [styles.card, { backgroundColor: bg, borderColor: border, borderWidth: tone === 'outline' ? 1.5 : StyleSheet.hairlineWidth * 2 }, style];
  if (!onPress && !onLongPress) return <View style={base} testID={testID}>{content}</View>;
  // Tappable cards stand on a ledge and sink when pressed, so you can tell them from the ones you only read.
  const rim = tone === 'soft' ? shade(c.primarySoft, 0.08) : c.border;
  return (
    <Tactile
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      color={bg === 'transparent' ? c.bg : bg}
      borderColor={rim}
      ledge={shade(rim, 0.14)}
      borderWidth={1.5}
      depth={depth.sm}
      style={[styles.card, style]}
      pressedStyle={tone === 'soft' ? undefined : { backgroundColor: c.surface2 }}
    >
      {content}
    </Tactile>
  );
}

/** A cloth bookmark in the subject's color, notched at the end. */
function Ribbon({ color }: { color: string }) {
  return (
    <View style={styles.ribbon} pointerEvents="none">
      <Svg width={12} height={18} viewBox="0 0 12 18">
        <Path d="M0 0 H12 V18 L6 13.5 L0 18 Z" fill={color} />
      </Svg>
    </View>
  );
}

interface ListItemProps {
  title: string;
  subtitle?: string;
  icon?: IconName;
  iconColor?: string;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  accessibilityLabel?: string;
  disabled?: boolean;
  testID?: string;
}

export function ListItem({ title, subtitle, icon, iconColor, right, onPress, onLongPress, chevron = !!onPress, destructive, accessibilityLabel, disabled, testID }: ListItemProps) {
  const { colors: c, easyReading } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}. ${subtitle}` : title)}
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.item, pressed && onPress ? { backgroundColor: c.surface2 } : null, disabled && { opacity: 0.5 }]}
    >
      {icon ? <Ionicons name={icon} size={22} color={destructive ? c.danger : (iconColor ?? c.textSecondary)} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" tone={destructive ? 'danger' : 'primary'} style={easyReading ? undefined : { fontFamily: FONTS.uiMedium }}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="bodySmall" tone="secondary">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {chevron ? <Ionicons name="chevron-forward" size={20} color={c.textSecondary} /> : null}
    </Pressable>
  );
}

export function SubjectBadge({ color, icon, size = 40 }: { color?: string | null; icon?: string | null; size?: number }) {
  const theme = useTheme();
  const tint = subjectColor(color, theme.scheme);
  return (
    <View style={{ width: size, height: size, borderRadius: radius.md, backgroundColor: `${tint}24`, borderLeftWidth: 4, borderLeftColor: tint, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={(icon ?? 'book-outline') as IconName} size={size * 0.55} color={tint} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, overflow: 'hidden' },
  inner: { padding: space.lg, gap: space.sm },
  ribbon: { position: 'absolute', left: space.lg, top: 0 },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.option, paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: radius.sm },
});
