import { Ionicons } from '@expo/vector-icons';
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
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
  // A card holding only list rows becomes a list: rows run edge to edge, split by inset hairlines.
  const rows = Children.toArray(children);
  const list = rows.length > 0 && rows.every((r) => isValidElement(r) && r.type === ListItem);
  const content = (
    <>
      {accent ? <Ribbon color={accent} /> : null}
      {list ? (
        <View style={styles.list}>{rows.map((r, i) => cloneElement(r as ReactElement<ListItemProps>, { inList: true, first: i === 0 }))}</View>
      ) : (
        <View style={[styles.inner, accent ? { paddingTop: space.lg + 8 } : null]}>{children}</View>
      )}
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

/** The tint of a list row's icon tile. */
export type IconTone = 'primary' | 'lagoon' | 'lamp' | 'success' | 'danger' | 'neutral';

interface ListItemProps {
  title: string;
  subtitle?: string;
  icon?: IconName;
  /** Tile tint; `iconColor` (a subject colour, say) wins over it. */
  tone?: IconTone;
  iconColor?: string;
  right?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  accessibilityLabel?: string;
  disabled?: boolean;
  testID?: string;
  /** Set by Card when the row is part of a list card. */
  inList?: boolean;
  first?: boolean;
}

export function ListItem({ title, subtitle, icon, tone = 'primary', iconColor, right, onPress, onLongPress, chevron = !!onPress, destructive, accessibilityLabel, disabled, testID, inList, first }: ListItemProps) {
  const { colors: c, easyReading } = useTheme();
  // Radio buttons and checkboxes are controls, not pictures: they stay bare and ink in when chosen.
  const control = !!icon && (icon.startsWith('radio-button') || icon.startsWith('checkbox'));
  const on = control && (icon.endsWith('-on') || icon === 'checkbox');
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}. ${subtitle}` : title)}
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.item, inList && styles.listRow, pressed && onPress ? { backgroundColor: c.surface2 } : null, disabled && { opacity: 0.5 }]}
    >
      {inList && !first ? <View style={[styles.divider, { left: icon ? space.lg + (control ? 24 : TILE) + space.md : space.lg, backgroundColor: c.border }]} /> : null}
      {control ? <Ionicons name={icon} size={24} color={on ? c.primary : c.textSecondary} /> : icon ? <IconTile icon={icon} tone={destructive ? 'danger' : tone} color={iconColor} /> : null}
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
      {chevron ? <Ionicons name="chevron-forward" size={18} color={c.textSecondary} /> : null}
    </Pressable>
  );
}

const TILE = 36;

/** A small tinted square holding an icon: list rows, hub tiles and stat cards share it. */
export function IconTile({ icon, tone = 'primary', color, size = TILE }: { icon: IconName; tone?: IconTone; color?: string; size?: number }) {
  const { colors: c, scheme } = useTheme();
  const tones: Record<IconTone, { bg: string; fg: string }> = {
    primary: { bg: c.primarySoft, fg: c.primary },
    lagoon: { bg: c.infoSoft, fg: c.lagoon },
    lamp: { bg: c.warningSoft, fg: c.warning },
    success: { bg: c.successSoft, fg: c.success },
    danger: { bg: c.dangerSoft, fg: c.danger },
    neutral: { bg: c.surface2, fg: c.textSecondary },
  };
  const ink = color ? { bg: `${color}${scheme === 'dark' ? '33' : '1F'}`, fg: color } : tones[tone];
  return (
    <View style={{ width: size, height: size, borderRadius: size >= 44 ? radius.md : radius.sm + 2, backgroundColor: ink.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name={icon} size={Math.round(size * 0.56)} color={ink.fg} />
    </View>
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
  list: { paddingVertical: space.xs },
  listRow: { paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: 0 },
  divider: { position: 'absolute', top: 0, right: 0, height: StyleSheet.hairlineWidth * 2 },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.option, paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: radius.sm },
});
