import { router } from 'expo-router';
import { Banner, Card, ListItem, Screen, Section, Text, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { requestExport } from '../../../features/profile/api';
import { t } from '../../../i18n';

/** S-PERF-11 Privacidade: visibility, guardian, export, delete (SP-14). */
export default function Privacy() {
  const { signOut } = useSession();
  const overlay = useOverlay();
  return (
    <Screen title={t('privacy.title')}>
      <Section title={t('privacy.visibility')}>
        <Text tone="secondary">{t('privacy.visibility_body')}</Text>
      </Section>
      <Card>
        <ListItem
          icon="download-outline"
          title={t('privacy.export')}
          onPress={async () => {
            try {
              await requestExport();
              overlay.snack(t('privacy.export_started'));
            } catch {
              overlay.snack(t('error.network'));
            }
          }}
        />
        <ListItem icon="people-outline" title={t('privacy.guardian')} onPress={() => router.push('/onboarding/guardian')} />
        <ListItem icon="phone-portrait-outline" title={t('profile.sign_out_all')} onPress={async () => (await overlay.confirm({ title: t('profile.sign_out_all') })) && signOut('global')} />
        <ListItem icon="trash-outline" destructive title={t('privacy.delete')} onPress={() => router.push('/profile/delete-account')} />
      </Card>
      <Banner kind="neutral" message={t('global.ai_generated')} />
    </Screen>
  );
}
