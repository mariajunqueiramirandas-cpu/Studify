import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { t } from '../../i18n';
import { useTheme } from '../../theme';
import { usePendingRequestsBadge } from '../../features/class/api';

type IconName = ComponentProps<typeof Ionicons>['name'];

function icon(active: IconName, inactive: IconName) {
  return ({ color, focused }: { color: unknown; focused: boolean }) => <Ionicons name={focused ? active : inactive} size={24} color={color as string} />;
}

/** Five bottom tabs with labels always visible (ux §2, §6 BottomTabBar). */
export default function TabsLayout() {
  const { colors, type } = useTheme();
  const requests = usePendingRequestsBadge();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border, minHeight: 64 },
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
