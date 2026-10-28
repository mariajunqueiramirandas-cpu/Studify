import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { Capi, Card, ListItem, Screen, Text, useOverlay } from '../../../components';
import { useSyncStatus } from '../../../db/sync';
import { useSession } from '../../../features/auth/session';
import { useCapi } from '../../../features/motivation/capi';
import { t } from '../../../i18n';
import { space } from '../../../theme';
import { messageFor } from '../../../api/messages';

/** S-PERF-01 Perfil. */
export default function Profile() {
  const { profile, signOut } = useSession();
  const sync = useSyncStatus();
  const overlay = useOverlay();
  const capi = useCapi();
  return (
    <Screen title={t('profile.title')} root largeTitle>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
        <View style={{ flex: 1, gap: space.xs }}>
          <Text variant="title">{profile?.display_name}</Text>
          {profile?.display_name_status === 'pending' ? <Text variant="bodySmall" tone="secondary">Nome em análise</Text> : null}
          <Text variant="bodySmall" tone="secondary">
            {t('capi.stage_title', { stage: t(`capi.stage.${capi.stage}`) })}
          </Text>
        </View>
        {capi.visible ? (
          <Pressable onPress={() => router.push('/profile/capi')} accessibilityRole="button" accessibilityLabel={t('capi.title')}>
            <Capi stage={capi.stage} mood={capi.mood} accessories={capi.accessories} size={92} />
          </Pressable>
        ) : null}
      </View>
      <Card>
        <ListItem icon="flag-outline" title={t('profile.goals')} onPress={() => router.push('/profile/goals')} />
        <ListItem icon="trophy-outline" title={t('profile.progress')} onPress={() => router.push('/profile/progress')} />
        <ListItem icon="paw-outline" title={t('capi.title')} onPress={() => router.push('/profile/capi')} />
        <ListItem icon="sparkles-outline" title={t('retro.title')} onPress={() => router.push('/retro')} />
        <ListItem icon="timer-outline" title={t('focus.title')} onPress={() => router.push('/focus')} />
        <ListItem icon="sparkles-outline" title={t('profile.ai_usage')} onPress={() => router.push('/profile/ai-usage')} />
      </Card>
      <Card>
        <ListItem icon="settings-outline" title={t('profile.settings')} onPress={() => router.push('/profile/settings')} />
        <ListItem icon="heart-outline" title={t('wellbeing.title')} onPress={() => router.push('/profile/wellbeing')} />
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
            try {
              await signOut('local');
            } catch (e) {
              overlay.snack(messageFor(e));
            }
          }}
        />
      </Card>
      <Text variant="caption" tone="secondary" align="center">
        {t('profile.version', { v: Constants.expoConfig?.version ?? '0.1.0' })}
      </Text>
    </Screen>
  );
}
