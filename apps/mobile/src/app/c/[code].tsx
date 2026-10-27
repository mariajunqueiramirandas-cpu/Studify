import { Redirect, useLocalSearchParams } from 'expo-router';

/** App Link `https://{BASE_URL}/c/{code}` → join Turma (SOC-01, api.md §10). */
export default function TurmaLink() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return <Redirect href={{ pathname: '/class/join', params: { code } }} />;
}
