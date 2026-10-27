import { Redirect, useLocalSearchParams } from 'expo-router';

/** `studify://class/battle/join?pin=` (mobile-app.md §2.3). */
export default function ClassBattleJoin() {
  const { pin } = useLocalSearchParams<{ pin?: string }>();
  return <Redirect href={{ pathname: '/battle/join', params: { pin: pin ?? '' } }} />;
}
