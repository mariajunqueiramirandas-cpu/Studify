import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BottomTabBar, type BottomTabBarProps } from 'expo-router/tabs';
import { MiniPlayer } from '../../features/podcast/MiniPlayer';
import type { ComponentProps } from 'react';
import { t } from '../../i18n';
import { useTheme } from '../../theme';
import { usePendingRequestsBadge } from '../../features/class/api';

type IconName = ComponentProps<typeof Ionicons>['name'];

function icon(active: IconName, inactive: IconName) {
  return ({ color, focused }: { color: unknown; focused: boolean }) => <Ionicons name={focused ? active : inactive} size={24} color={color as string} />;
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
  const { colors, type } = useTheme();
  const requests = usePendingRequestsBadge();
  const insets = useSafeAreaInsets();
  // Some Android gesture bars report a small (or zero) bottom inset, which left the labels under the gesture
  // pill. Keep at least 12 dp below the labels, plus a little room above the pill.
  const bottomPad = Math.max(insets.bottom, 12) + 6;
  return (
    <Tabs
      tabBar={renderTabBar}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: { backgroundColor: colors.surface1, borderTopColor: colors.border, height: 58 + bottomPad, paddingTop: 4, paddingBottom: bottomPad },
        tabBarLabelStyle: { ...type('label'), fontSize: 12 },
        tabBarItemStyle: { paddingVertical: 4 },
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
          tabBarBadgeStyle: { backgroundColor: colors.primary, minWidth: 10, maxHeight: 10, borderRadius: 5 },
        }}
      />
      <Tabs.Screen name="profile" options={{ title: t('tab.profile'), tabBarIcon: icon('person-circle', 'person-circle-outline') }} />
    </Tabs>
  );
}
