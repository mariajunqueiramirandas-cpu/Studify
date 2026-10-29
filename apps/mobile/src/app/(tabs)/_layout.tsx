import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { View, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomTabBar, type BottomTabBarProps } from 'expo-router/tabs';
import { MiniPlayer } from '../../features/podcast/MiniPlayer';
import type { ComponentProps } from 'react';
import { t } from '../../i18n';
import { tap } from '../../lib/haptics';
import { radius, useTheme } from '../../theme';
import { Text } from '../../components/Text';
import { usePendingRequestsBadge } from '../../features/class/api';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** The chosen tab's icon sits in a tinted key, so where you are reads at a glance (ux §6 BottomTabBar). */
function TabIcon({ name, color, focused }: { name: IconName; color: string; focused: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ width: 56, height: 32, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: focused ? colors.primarySoft : 'transparent' }}>
      <Ionicons name={name} size={22} color={color} />
    </View>
  );
}

function icon(active: IconName, inactive: IconName) {
  return ({ color, focused }: { color: unknown; focused: boolean }) => <TabIcon name={focused ? active : inactive} color={color as string} focused={focused} />;
}

function label({ focused, color, children }: { focused: boolean; color: ColorValue; children: string }) {
  return (
    <Text variant="label" weight={focused ? 'bold' : undefined} numberOfLines={1} style={{ color, fontSize: 12, lineHeight: 16 }}>
      {children}
    </Text>
  );
}

/** The podcast mini-player sits on top of the tab bar while an episode is loaded (spec 12 §5.1). */
function TabBarWithPlayer(props: BottomTabBarProps) {
  return (
    <>
      <MiniPlayer />
      <BottomTabBar {...props} />
    </>
  );
}

const renderTabBar = (props: BottomTabBarProps) => <TabBarWithPlayer {...props} />;

/** Five bottom tabs with labels always visible (ux §2, §6 BottomTabBar). */
export default function TabsLayout() {
  const { colors } = useTheme();
  const requests = usePendingRequestsBadge();
  const insets = useSafeAreaInsets();
  // Some Android gesture bars report a small (or zero) bottom inset, which left the labels under the gesture
  // pill. Keep at least 12 dp below the labels, plus a little room above the pill.
  const bottomPad = Math.max(insets.bottom, 12) + 6;
  return (
    <Tabs
      tabBar={renderTabBar}
      screenListeners={{ tabPress: tap }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: { backgroundColor: colors.surface1, borderTopColor: colors.border, height: 62 + bottomPad, paddingTop: 6, paddingBottom: bottomPad },
        tabBarLabel: label,
        tabBarItemStyle: { paddingVertical: 2, gap: 2 },
      }}
    >
      <Tabs.Screen name="today" options={{ title: t('tab.today'), tabBarIcon: icon('sunny', 'sunny-outline') }} />
      <Tabs.Screen name="subjects" options={{ title: t('tab.subjects'), tabBarIcon: icon('book', 'book-outline') }} />
      <Tabs.Screen name="practice" options={{ title: t('tab.practice'), tabBarIcon: icon('locate', 'locate-outline') }} />
      <Tabs.Screen
        name="class"
        options={{
          title: t('tab.class'),
          tabBarIcon: icon('people', 'people-outline'),
          // Badge dot for pending Turma join requests (ux §6), never a count of missed days.
          tabBarBadge: requests > 0 ? '' : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.primary, minWidth: 10, maxHeight: 10, borderRadius: 5, borderWidth: 2, borderColor: colors.surface1 },
        }}
      />
      <Tabs.Screen name="profile" options={{ title: t('tab.profile'), tabBarIcon: icon('person-circle', 'person-circle-outline') }} />
    </Tabs>
  );
}
