import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { radius, space, subjectColor, touch, useTheme } from '../theme';
import type { IconName } from './Button';
import { Text } from './Text';

interface CardProps {
  children: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Subject color as the left accent bar (ux §6). */
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
      {accent ? <View style={[styles.accent, { backgroundColor: accent }]} /> : null}
      <View style={[styles.inner, accent ? { paddingLeft: space.lg + 4 } : null]}>{children}</View>
    </>
  );
  const base = [styles.card, { backgroundColor: bg, borderColor: c.border, borderWidth: tone === 'outline' ? 1 : 0 }, style];
  if (!onPress && !onLongPress) return <View style={base} testID={testID}>{content}</View>;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [...base, pressed && { opacity: 0.85 }]}
    >
      {content}
    </Pressable>
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
  const { colors: c } = useTheme();
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
        <Text variant="body" tone={destructive ? 'danger' : 'primary'}>
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
    <View style={{ width: size, height: size, borderRadius: radius.md, backgroundColor: `${tint}22`, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={(icon ?? 'book-outline') as IconName} size={size * 0.55} color={tint} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, overflow: 'hidden' },
  inner: { padding: space.lg, gap: space.sm },
  accent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.option, paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: radius.sm },
});
