import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { IconButton, Text } from '../../components';
import { t } from '../../i18n';
import { useTheme } from '../../theme';
import { useUnreadCount } from './inbox';

/** The Hoje app-bar bell: opens the Central de notificações, with the unread count on it. */
export function InboxBell() {
  const { colors: c } = useTheme();
  const unread = useUnreadCount();
  return (
    <View>
      <IconButton
        icon={unread > 0 ? 'notifications' : 'notifications-outline'}
        label={unread > 0 ? t('inbox.open_unread', { n: unread }) : t('inbox.open')}
        onPress={() => router.push('/notifications')}
        testID="inbox-bell"
      />
      {unread > 0 ? (
        <View pointerEvents="none" style={[styles.badge, { backgroundColor: c.danger, borderColor: c.bg }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text variant="caption" weight="bold" style={{ color: '#FFFFFF' }}>
            {unread > 99 ? '99+' : unread}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', top: 4, right: 2, minWidth: 20, height: 20, borderRadius: 10, borderWidth: 2, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center' },
});
