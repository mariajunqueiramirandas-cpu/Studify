import { Redirect, useLocalSearchParams } from 'expo-router';

/** App Link `https://{BASE_URL}/b/{pin}` → join a live battle (SOC-03). */
export default function BattleLink() {
  const { pin } = useLocalSearchParams<{ pin: string }>();
  return <Redirect href={{ pathname: '/battle/join', params: { pin } }} />;
}
