import { Redirect, useLocalSearchParams } from 'expo-router';

/** App Link `https://{BASE_URL}/i/{code}` → pilot invite (PLT-02.2). */
export default function InviteLink() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return <Redirect href={{ pathname: '/auth/invite', params: { code } }} />;
}
