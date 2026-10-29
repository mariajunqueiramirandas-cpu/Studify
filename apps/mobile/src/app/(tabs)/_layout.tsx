import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { View, type ColorValue } from 'react-native';
import { BottomTabBar, type BottomTabBarProps } from 'expo-router/tabs';
import { MiniPlayer } from '../../features/podcast/MiniPlayer';
import type { ComponentProps } from 'react';
import { t } from '../../i18n';
import { tap } from '../../lib/haptics';
import { radius, shade, space, useTheme } from '../../theme';
import { Text } from '../../components/Text';
import { usePendingRequestsBadge } from '../../features/class/api';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** The chosen tab's icon sits in an inked key, so where you are reads at a glance (ux §6 BottomTabBar). */
function TabIcon({ name, color, focused }: { name: IconName; color: string; focused: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ width: 52, height: 30, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: focused ? colors.primary : 'transparent' }}>
      <Ionicons name={name} size={21} color={focused ? colors.onPrimary : color} />
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

/**
 * The tabs are a dock: a key-like bar floating off the screen edges, on its own ledge. The podcast mini-player sits on
 * top of it while an episode is loaded (spec 12 §5.1).
 */
function TabBarWithPlayer(props: BottomTabBarProps) {
  const { colors } = useTheme();
  // Some Android gesture bars report a small (or zero) bottom inset, which left the labels under the gesture
  // pill: keep the dock at least 8 dp clear of it.
  const bottom = Math.max(props.insets.bottom, 8) + space.xs;
  return (
    <>
      <MiniPlayer />
      <View style={{ backgroundColor: colors.bg, paddingHorizontal: space.md, paddingTop: space.xs, paddingBottom: bottom }}>
        <BottomTabBar {...props} insets={{ ...props.insets, bottom: 0 }} />
      </View>
    </>
  );
}

const renderTabBar = (props: BottomTabBarProps) => <TabBarWithPlayer {...props} />;

/** Five bottom tabs with labels always visible (ux §2, §6 BottomTabBar). */
export default function TabsLayout() {
  const { colors } = useTheme();
  const requests = usePendingRequestsBadge();
  return (
    <Tabs
      tabBar={renderTabBar}
      screenListeners={{ tabPress: tap }}
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.surface1,
          height: 72,
          paddingTop: 6,
          paddingBottom: 4,
          borderRadius: radius.xl,
          borderWidth: 1.5,
          borderTopWidth: 1.5,
          borderColor: colors.border,
          borderTopColor: colors.border,
          borderBottomWidth: 4,
          borderBottomColor: shade(colors.border, 0.14),
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarLabel: label,
        tabBarItemStyle: { paddingVertical: 0, gap: 3 },
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
