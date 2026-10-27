import { Stack } from 'expo-router';
import { useTheme } from '../../../theme';

export default function TabStack() {
  const { colors } = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg }, animation: 'slide_from_right' }} />;
}
