import type { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { BottomTabBarHeightContext } from 'expo-router/tabs';
import { useContext, type ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { maxContentWidth, space, useTheme } from '../theme';
import { IconButton } from './Button';
import { Meta } from './Chip';
import { Text } from './Text';
import { OfflineBanner } from './Banner';

interface AppBarProps {
  title?: string;
  /** Hides the back arrow (tab roots). */
  root?: boolean;
  onBack?: () => void;
  /** At most 2 (ux §3). */
  actions?: ReactNode;
  /** Optional context chip below the title, e.g. "Prova de Biologia · 3 dias". */
  context?: ReactNode;
  closeIcon?: boolean;
  large?: boolean;
  /** A quiet line above the title (or in its place), e.g. today's date on Hoje. */
  eyebrow?: string;
}

export function AppBar({ title, root, onBack, actions, context, closeIcon, large, eyebrow }: AppBarProps) {
  const { colors: c } = useTheme();
  const back = onBack ?? (() => (router.canGoBack() ? router.back() : router.replace('/')));
  return (
    <View style={[styles.appBar, { backgroundColor: c.bg }]}>
      <View style={styles.appBarRow}>
        {!root ? (
          <IconButton icon={closeIcon ? 'close' : 'arrow-back'} label={closeIcon ? 'Fechar' : 'Voltar'} onPress={back} />
        ) : (
          <View style={{ width: space.sm }} />
        )}
        <View style={styles.titleWrap}>
          {eyebrow ? (
            <Text variant="label" tone="secondary" numberOfLines={1}>
              {eyebrow}
            </Text>
          ) : null}
          {title ? (
            <Text variant={large || root ? 'display' : 'title'} numberOfLines={2} accessibilityRole="header">
              {title}
            </Text>
          ) : null}
        </View>
        <View style={styles.actions}>{actions}</View>
      </View>
      {context ? <View style={styles.context}>{context}</View> : null}
    </View>
  );
}

interface ScreenProps {
  title?: string;
  root?: boolean;
  actions?: ReactNode;
  context?: ReactNode;
  /** Sticky primary action area (ActionBar). */
  footer?: ReactNode;
  children?: ReactNode;
  scroll?: boolean;
  /** Immersive screens hide chrome (ux §3). */
  immersive?: boolean;
  calm?: boolean;
  padded?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  onBack?: () => void;
  closeIcon?: boolean;
  largeTitle?: boolean;
  hideOfflineBanner?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
  header?: ReactNode;
  eyebrow?: string;
}

export function Screen({
  title,
  root,
  actions,
  context,
  footer,
  children,
  scroll = true,
  immersive,
  calm,
  padded = true,
  onRefresh,
  refreshing,
  onBack,
  closeIcon,
  largeTitle,
  hideOfflineBanner,
  contentStyle,
  header,
  eyebrow,
}: ScreenProps) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  // Inside the tabs the tab bar already sits on the bottom inset; adding it again left a blank strip
  // between the footer and the tab bar.
  const inTabs = useContext(BottomTabBarHeightContext) !== undefined;
  const bottomInset = inTabs ? 0 : insets.bottom;
  const bg = calm ? c.calmSurface : c.bg;
  // Without a ScrollView the body fills the screen, so flex children (a flashcard, a pager) get the room.
  const body = (
    <View style={[styles.content, !scroll && styles.fill, padded && styles.padded, contentStyle]}>{children}</View>
  );
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {!hideOfflineBanner ? <OfflineBanner /> : null}
      {title !== undefined || !root ? (
        <AppBar title={title} root={root} actions={actions} context={context} onBack={onBack} closeIcon={closeIcon || immersive} large={largeTitle} eyebrow={eyebrow} />
      ) : null}
      {header}
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: footer ? space.lg : bottomInset + space.xxl }}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.primary} colors={[c.primary]} /> : undefined}
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{body}</View>
      )}
      {footer ? <View style={{ paddingBottom: bottomInset, backgroundColor: bg }}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}

/** A titled group. The subtitle hugs its heading; the content sits one step below both. */
export function Section({ title, subtitle, action, children, style }: { title?: string; subtitle?: string; action?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.section, title ? styles.titled : null, style]}>
      {title ? (
        <View style={{ gap: space.xxs }}>
          <View style={styles.sectionHeader}>
            <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>
              {title}
            </Text>
            {action}
          </View>
          {subtitle ? (
            <Text variant="bodySmall" tone="secondary">
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function Row({ children, gap = space.sm, style, wrap }: { children: ReactNode; gap?: number; style?: StyleProp<ViewStyle>; wrap?: boolean }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, wrap && { flexWrap: 'wrap' }, style]}>{children}</View>;
}

export function Spacer({ size = space.lg }: { size?: number }) {
  return <View style={{ height: size }} />;
}

export function Divider() {
  const { colors: c } = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: space.sm }} />;
}

/** Status text with an icon (kept for older call sites; same as Meta, no capsule). */
export function Pill({ icon, text, color }: { icon?: React.ComponentProps<typeof Ionicons>['name']; text: string; color?: string }) {
  return <Meta icon={icon} text={text} color={color} />;
}

const styles = StyleSheet.create({
  appBar: { paddingHorizontal: space.xs, paddingBottom: space.sm },
  appBarRow: { flexDirection: 'row', alignItems: 'center', minHeight: 60 },
  titleWrap: { flex: 1, paddingHorizontal: space.sm },
  actions: { flexDirection: 'row', alignItems: 'center' },
  context: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  content: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.lg },
  fill: { flex: 1 },
  padded: { paddingHorizontal: space.gutter, paddingTop: space.sm },
  section: { gap: space.md },
  titled: { marginTop: space.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 32 },
});
