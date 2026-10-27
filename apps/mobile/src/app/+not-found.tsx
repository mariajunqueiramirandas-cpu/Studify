import { router } from 'expo-router';
import { EmptyState, Screen } from '../components';
import { t } from '../i18n';

export default function NotFound() {
  return (
    <Screen title="">
      <EmptyState icon="help-circle-outline" message={t('error.not_found')} action={{ label: t('result.back_home'), onPress: () => router.replace('/today') }} />
    </Screen>
  );
}
