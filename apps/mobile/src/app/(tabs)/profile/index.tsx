import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Capi, Card, ListItem, Screen, Text, useOverlay, type IconName } from '../../../components';
import { useSyncStatus } from '../../../db/sync';
import { useSession } from '../../../features/auth/session';
import { useMotivation } from '../../../features/motivation/api';
import { useCapi } from '../../../features/motivation/capi';
import { t } from '../../../i18n';
import { FONTS, space, subjectColor, useTheme } from '../../../theme';
import { messageFor } from '../../../api/messages';

/** S-PERF-01 Perfil. */
export default function Profile() {
  const { profile, signOut } = useSession();
  const sync = useSyncStatus();
  const overlay = useOverlay();
  const capi = useCapi();
  const motivation = useMotivation();
  const { colors, scheme } = useTheme();
  const m = motivation.data;
  return (
    <Screen title={t('profile.title')} root largeTitle>
      {/* Who you are and how you're doing, in one card that opens Progresso. */}
      <Card onPress={() => router.push('/profile/progress')} accessibilityLabel={`${profile?.display_name ?? ''}. ${t('profile.progress')}`}>
        <View style={styles.head}>
          <View style={{ flex: 1, gap: space.xxs }}>
            <Text variant="title" numberOfLines={2}>
              {profile?.display_name}
            </Text>
            {profile?.display_name_status === 'pending' ? <Text variant="bodySmall" tone="secondary">Nome em análise</Text> : null}
            <Text variant="bodySmall" tone="secondary">
              {m ? `${t('progress.level', { n: m.level })} · ` : ''}
              {t('capi.stage_title', { stage: t(`capi.stage.${capi.stage}`) })}
            </Text>
          </View>
          {capi.visible ? <Capi stage={capi.stage} mood={capi.mood} accessories={capi.accessories} size={88} /> : null}
        </View>
        {m ? (
          <View style={[styles.stats, { borderTopColor: colors.border }]}>
            <Stat icon="flame" color={colors.lamp} value={String(m.streak)} label={t('profile.stat_streak')} />
            <Stat icon="time" color={colors.lagoon} value={String(Math.round(m.todayMinutes))} label={t('profile.stat_minutes')} />
            <Stat icon="star" color={colors.primary} value={String(m.xp)} label={t('profile.stat_xp')} />
          </View>
        ) : null}
      </Card>
      <Card>
        <ListItem icon="flag-outline" title={t('profile.goals')} onPress={() => router.push('/profile/goals')} />
        <ListItem icon="trophy-outline" tone="lamp" title={t('profile.progress')} onPress={() => router.push('/profile/progress')} />
        <ListItem icon="paw-outline" iconColor={colors.fur} title={t('capi.title')} onPress={() => router.push('/profile/capi')} />
        <ListItem icon="sparkles-outline" tone="lagoon" title={t('retro.title')} onPress={() => router.push('/retro')} />
        <ListItem icon="timer-outline" tone="success" title={t('focus.title')} onPress={() => router.push('/focus')} />
        <ListItem icon="hardware-chip-outline" title={t('profile.ai_usage')} onPress={() => router.push('/profile/ai-usage')} />
      </Card>
      <Card>
        <ListItem icon="settings-outline" tone="neutral" title={t('profile.settings')} onPress={() => router.push('/profile/settings')} />
        <ListItem icon="heart-outline" iconColor={subjectColor('pink', scheme)} title={t('wellbeing.title')} onPress={() => router.push('/profile/wellbeing')} />
        <ListItem icon="shield-checkmark-outline" tone="lagoon" title={t('profile.privacy')} onPress={() => router.push('/profile/privacy')} />
        <ListItem icon="help-circle-outline" tone="neutral" title={t('profile.help')} onPress={() => router.push('/profile/help')} />
      </Card>
      <Card>
        <ListItem
          icon="log-out-outline"
          destructive
          chevron={false}
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

function Stat({ icon, color, value, label }: { icon: IconName; color: string; value: string; label: string }) {
  const { easyReading } = useTheme();
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${value} ${label}`}>
      <View style={styles.statValue}>
        <Ionicons name={icon} size={18} color={color} />
        <Text variant="heading" style={easyReading ? undefined : { fontFamily: FONTS.display }} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <Text variant="bodySmall" tone="secondary" numberOfLines={1} align="center">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  stats: { flexDirection: 'row', gap: space.sm, borderTopWidth: StyleSheet.hairlineWidth * 2, paddingTop: space.md, marginTop: space.xs },
  stat: { flex: 1, alignItems: 'center', gap: space.xxs },
  statValue: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
