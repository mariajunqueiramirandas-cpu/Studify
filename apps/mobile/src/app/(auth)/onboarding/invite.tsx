import { router } from 'expo-router';
import { ActionBar, Button, Screen, Stepper, Text, TextField } from '../../../components';
import { formatInviteCode, isValidInviteCode, normalizeInviteCode, useOnboarding } from '../../../features/auth/onboarding';
import { useSession } from '../../../features/auth/session';
import { t } from '../../../i18n';

/** S-AUTH-03 Convite (SP-02 pilot gating). Code is validated for real by `signup-complete`. */
export default function InviteStep() {
  const code = useOnboarding((s) => s.inviteCode);
  const set = useOnboarding((s) => s.set);
  const { signOut } = useSession();
  return (
    <Screen
      title=""
      onBack={() => void signOut()}
      footer={
        <ActionBar>
          <Button label={t('global.continue')} disabled={!isValidInviteCode(code)} onPress={() => router.push('/onboarding/age')} />
        </ActionBar>
      }
    >
      <Stepper step={1} total={5} />
      <Text variant="title">{t('onb.invite.title')}</Text>
      <Text tone="secondary">{t('onb.invite.hint')}</Text>
      <TextField
        label={t('onb.invite.label')}
        placeholder={t('onb.invite.placeholder')}
        value={formatInviteCode(code)}
        onChangeText={(v) => set({ inviteCode: normalizeInviteCode(v) })}
        autoCapitalize="characters"
        autoCorrect={false}
        style={{ fontSize: 24, letterSpacing: 4, textAlign: 'center' }}
      />
    </Screen>
  );
}
