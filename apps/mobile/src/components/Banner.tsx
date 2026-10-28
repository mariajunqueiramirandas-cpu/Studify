import { Ionicons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { radius, space, useTheme } from '../theme';
import type { IconName } from './Button';
import { RichText, Text } from './Text';

type Kind = 'info' | 'warning' | 'danger' | 'success' | 'neutral';

interface BannerProps {
  kind?: Kind;
  icon?: IconName;
  title?: string;
  message: string;
  action?: { label: string; onPress: () => void };
  onDismiss?: () => void;
  children?: ReactNode;
}

/** Offline / budget / processing / info banners (ux §5.5). Never a blocking modal. */
export function Banner({ kind = 'info', icon, title, message, action, onDismiss, children }: BannerProps) {
  const { colors: c } = useTheme();
  const map: Record<Kind, { bg: string; fg: string; icon: IconName }> = {
    info: { bg: c.infoSoft, fg: c.info, icon: 'information-circle-outline' },
    warning: { bg: c.warningSoft, fg: c.warning, icon: 'alert-circle-outline' },
    danger: { bg: c.dangerSoft, fg: c.danger, icon: 'alert-circle-outline' },
    success: { bg: c.successSoft, fg: c.success, icon: 'checkmark-circle-outline' },
    neutral: { bg: c.surface2, fg: c.textSecondary, icon: 'information-circle-outline' },
  };
  const s = map[kind];
  return (
    <View style={[styles.banner, { backgroundColor: s.bg }]} accessibilityRole="alert">
      <Ionicons name={icon ?? s.icon} size={22} color={s.fg} style={{ marginTop: 1 }} />
      <View style={{ flex: 1, gap: space.xs }}>
        {title ? (
          <Text variant="label" weight="bold" style={{ color: c.textPrimary }}>
            {title}
          </Text>
        ) : null}
        <RichText variant="bodySmall">{message}</RichText>
        {children}
        {action ? (
          <Pressable accessibilityRole="button" onPress={action.onPress} hitSlop={8} style={{ alignSelf: 'flex-start', paddingVertical: space.xs }}>
            <Text variant="label" style={{ color: s.fg }}>
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {onDismiss ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t('global.close')} onPress={onDismiss} hitSlop={12}>
          <Ionicons name="close" size={20} color={c.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(
    () =>
      NetInfo.addEventListener((state) => {
        setOnline(state.isConnected !== false && state.isInternetReachable !== false);
      }),
    [],
  );
  return online;
}

/** Thin top banner when NetInfo reports no connection (mobile-app.md §15). */
export function OfflineBanner() {
  const online = useOnline();
  const { colors: c } = useTheme();
  if (online) return null;
  return (
    <View style={[styles.offline, { backgroundColor: c.surface2 }]} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <Ionicons name="cloud-offline-outline" size={16} color={c.textSecondary} />
      <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
        {t('offline.banner')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', gap: space.md, paddingVertical: space.md, paddingHorizontal: space.lg, borderRadius: radius.lg, alignItems: 'flex-start' },
  offline: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.xs },
});
