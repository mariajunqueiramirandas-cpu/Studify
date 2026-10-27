import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { maxContentWidth, radius, space, useTheme } from '../theme';
import { IconButton } from './Button';
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
}

export function AppBar({ title, root, onBack, actions, context, closeIcon, large }: AppBarProps) {
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
          {title ? (
            <Text variant={large ? 'display' : 'title'} numberOfLines={2} accessibilityRole="header">
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
}: ScreenProps) {
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const bg = calm ? c.calmSurface : c.bg;
  const body = (
    <View style={[styles.content, padded && styles.padded, contentStyle]}>{children}</View>
  );
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: bg, paddingTop: insets.top }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {!hideOfflineBanner ? <OfflineBanner /> : null}
      {title !== undefined || !root ? (
        <AppBar title={title} root={root} actions={actions} context={context} onBack={onBack} closeIcon={closeIcon || immersive} large={largeTitle} />
      ) : null}
      {header}
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: footer ? space.lg : insets.bottom + space.xxl }}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={c.primary} colors={[c.primary]} /> : undefined}
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{body}</View>
      )}
      {footer ? <View style={{ paddingBottom: insets.bottom, backgroundColor: bg }}>{footer}</View> : null}
    </KeyboardAvoidingView>
  );
}

export function Section({ title, action, children, style }: { title?: string; action?: ReactNode; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.section, style]}>
      {title ? (
        <View style={styles.sectionHeader}>
          <Text variant="heading" accessibilityRole="header" style={{ flex: 1 }}>
            {title}
          </Text>
          {action}
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

export function Pill({ icon, text, color }: { icon?: React.ComponentProps<typeof Ionicons>['name']; text: string; color?: string }) {
  const { colors: c } = useTheme();
  const tint = color ?? c.textSecondary;
  return (
    <View style={[styles.pill, { borderColor: c.border }]}>
      {icon ? <Ionicons name={icon} size={14} color={tint} /> : null}
      <Text variant="bodySmall" style={{ color: tint }}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  appBar: { paddingHorizontal: space.xs, paddingBottom: space.xs },
  appBarRow: { flexDirection: 'row', alignItems: 'center', minHeight: 56 },
  titleWrap: { flex: 1, paddingHorizontal: space.xs },
  actions: { flexDirection: 'row', alignItems: 'center' },
  context: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  content: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.lg },
  padded: { paddingHorizontal: space.lg, paddingTop: space.sm },
  section: { gap: space.md },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pill: { flexDirection: 'row', alignItems: 'center', gap: space.xs, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
});
