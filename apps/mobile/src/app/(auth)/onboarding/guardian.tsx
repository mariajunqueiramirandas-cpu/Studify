import { router } from 'expo-router';
import { ActionBar, Banner, Button, Screen, Stepper, Text, TextField } from '../../../components';
import { useOnboarding } from '../../../features/auth/onboarding';
import { t } from '../../../i18n';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * S-AUTH-05 Responsável (SP-03, Phase 2) for ages 12–15. The e-mail is kept in memory and sent
 * through `guardian-link` right after `signup-complete` creates the profile.
 */
export default function GuardianStep() {
  const email = useOnboarding((s) => s.guardianEmail);
  const set = useOnboarding((s) => s.set);
  return (
    <Screen
      title=""
      footer={
        <ActionBar>
          <Button label={t('global.continue')} disabled={!EMAIL_RE.test(email.trim())} onPress={() => router.push('/onboarding/profile')} />
          {/* D-04 default: mandatory before Turma social features, so it can be skipped here. */}
          <Button variant="text" label={t('global.skip_for_now')} onPress={() => router.push('/onboarding/profile')} />
        </ActionBar>
      }
    >
      <Stepper step={3} total={5} />
      <Text variant="title">{t('onb.guardian.title')}</Text>
      <Banner kind="info" message={t('onb.guardian.why')} />
      <TextField label={t('onb.guardian.label')} value={email} onChangeText={(v) => set({ guardianEmail: v })} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
    </Screen>
  );
}
