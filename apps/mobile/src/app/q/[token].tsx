import { Redirect, useLocalSearchParams } from 'expo-router';

/** App Link `https://{BASE_URL}/q/{token}` → shared challenge (SOC-09). */
export default function SharedQuizLink() {
  const { token } = useLocalSearchParams<{ token: string }>();
  return <Redirect href={{ pathname: '/quiz/shared/[token]', params: { token } }} />;
}
