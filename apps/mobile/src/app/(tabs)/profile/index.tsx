import Constants from 'expo-constants';
import { router } from 'expo-router';
import { View } from 'react-native';
import { Card, ListItem, Screen, Text, useOverlay } from '../../../components';
import { useSyncStatus } from '../../../db/sync';
import { useSession } from '../../../features/auth/session';
import { t } from '../../../i18n';
import { space } from '../../../theme';

/** S-PERF-01 Perfil. */
export default function Profile() {
  const { profile, signOut } = useSession();
  const sync = useSyncStatus();
  const overlay = useOverlay();
  return (
    <Screen title={t('profile.title')} root largeTitle>
      <View style={{ gap: space.xs }}>
        <Text variant="title">{profile?.display_name}</Text>
        {profile?.display_name_status === 'pending' ? <Text variant="bodySmall" tone="secondary">Nome em análise</Text> : null}
      </View>
      <Card>
        <ListItem icon="flag-outline" title={t('profile.goals')} onPress={() => router.push('/profile/goals')} />
        <ListItem icon="trophy-outline" title={t('profile.progress')} onPress={() => router.push('/profile/progress')} />
        <ListItem icon="sparkles-outline" title={t('profile.ai_usage')} onPress={() => router.push('/profile/ai-usage')} />
      </Card>
      <Card>
        <ListItem icon="settings-outline" title={t('profile.settings')} onPress={() => router.push('/profile/settings')} />
        <ListItem icon="shield-checkmark-outline" title={t('profile.privacy')} onPress={() => router.push('/profile/privacy')} />
        <ListItem icon="help-circle-outline" title={t('profile.help')} onPress={() => router.push('/profile/help')} />
      </Card>
      <Card>
        <ListItem
          icon="log-out-outline"
          title={t('profile.sign_out')}
          onPress={async () => {
            // Unsynced reviews stay on the phone; warn before signing out (spec 00 §5).
            if (sync.pending > 0 && !(await overlay.confirm({ title: 'Você tem revisões que ainda não foram salvas na nuvem. Quer esperar a internet voltar?', confirmLabel: t('profile.sign_out'), cancelLabel: 'Esperar' }))) return;
            await signOut('local');
          }}
        />
      </Card>
      <Text variant="caption" tone="secondary" align="center">
        {t('profile.version', { v: Constants.expoConfig?.version ?? '0.1.0' })}
      </Text>
    </Screen>
  );
}
