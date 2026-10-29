import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { router, type Href } from 'expo-router';
import { levelThreshold } from '@studify/shared';
import { StyleSheet, View } from 'react-native';
import { Capi, Card, IconTile, ListItem, Screen, Tactile, Text, useOverlay, type IconName, type IconTone } from '../../../components';
import { useSyncStatus } from '../../../db/sync';
import { SCHOOL_YEARS, useSession } from '../../../features/auth/session';
import { useMotivation } from '../../../features/motivation/api';
import { useCapi } from '../../../features/motivation/capi';
import { options, t } from '../../../i18n';
import { depth, FONTS, radius, shade, space, subjectColor, useTheme } from '../../../theme';
import { messageFor } from '../../../api/messages';

/** S-PERF-01 Perfil. */
export default function Profile() {
  const { profile, signOut } = useSession();
  const sync = useSyncStatus();
  const overlay = useOverlay();
  const capi = useCapi();
  const motivation = useMotivation();
  const { colors, scheme, easyReading } = useTheme();
  const m = motivation.data;
  const yearIndex = profile?.school_year ? SCHOOL_YEARS.indexOf(profile.school_year) : -1;
  const year = yearIndex >= 0 ? options('onb.school_years')[yearIndex] : null;
  const corner: { icon: IconName; label: string; tone?: IconTone; color?: string; to: Href }[] = [
    { icon: 'flag-outline', label: t('profile.goals'), to: '/profile/goals' },
    { icon: 'trophy-outline', label: t('profile.progress'), tone: 'lamp', to: '/profile/progress' },
    { icon: 'paw-outline', label: t('capi.title'), color: colors.fur, to: '/profile/capi' },
    { icon: 'sparkles-outline', label: t('retro.title'), tone: 'lagoon', to: '/retro' },
    { icon: 'timer-outline', label: t('focus.title'), tone: 'success', to: '/focus' },
    { icon: 'hardware-chip-outline', label: t('profile.ai_usage'), to: '/profile/ai-usage' },
  ];
  return (
    <Screen title={t('profile.title')} root largeTitle>
      {/* You, as a student ID card: photo (Capi), name, year and level, and how the streak is going. Opens Progresso. */}
      <Tactile
        onPress={() => router.push('/profile/progress')}
        accessibilityLabel={`${profile?.display_name ?? ''}. ${t('profile.progress')}`}
        color={colors.hero}
        ledge={shade(colors.hero, 0.4)}
        radius={radius.xl}
        depth={depth.lg}
        style={styles.card}
      >
        <View style={[styles.slot, { backgroundColor: colors.bg }]} />
        <View style={styles.cardHead}>
          <Text variant="bodySmall" weight="bold" style={[styles.caps, { color: colors.heroMuted }]} numberOfLines={1}>
            {t('profile.card_title').toUpperCase()}
          </Text>
          <Ionicons name="school" size={18} color={colors.lamp} />
        </View>
        <View style={styles.cardMain}>
          <View style={[styles.photo, { backgroundColor: colors.surface1, borderColor: colors.onHero }]}>
            {capi.visible ? (
              <Capi stage={capi.stage} mood={capi.mood} accessories={capi.accessories} size={80} />
            ) : (
              <Text variant="display" style={easyReading ? undefined : { fontFamily: FONTS.display }}>
                {(profile?.display_name ?? '?').charAt(0).toUpperCase()}
              </Text>
            )}
          </View>
          <View style={{ flex: 1, gap: space.xxs }}>
            <Text variant="title" numberOfLines={2} style={{ color: colors.onHero }}>
              {profile?.display_name}
            </Text>
            {profile?.display_name_status === 'pending' ? (
              <Text variant="bodySmall" style={{ color: colors.heroMuted }}>
                Nome em análise
              </Text>
            ) : null}
            <Text variant="bodySmall" style={{ color: colors.heroMuted }}>
              {[year, t('capi.stage_title', { stage: t(`capi.stage.${capi.stage}`) })].filter(Boolean).join(' · ')}
            </Text>
            {m ? (
              <View style={{ gap: space.xs, marginTop: space.xs }}>
                <View style={styles.levelRow}>
                  <Text variant="label" weight="bold" style={{ color: colors.lamp }}>
                    {t('progress.level', { n: m.level })}
                  </Text>
                  <Text variant="bodySmall" style={{ color: colors.heroMuted }}>
                    {m.xp} XP
                  </Text>
                </View>
                <View style={[styles.xpTrack, { backgroundColor: colors.heroKey }]} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(levelProgress(m.xp, m.level) * 100) }}>
                  <View style={[styles.xpFill, { width: `${Math.max(4, levelProgress(m.xp, m.level) * 100)}%`, backgroundColor: colors.lamp }]} />
                </View>
              </View>
            ) : null}
          </View>
        </View>
        {m ? (
          <View style={[styles.stats, { borderTopColor: colors.heroKey }]}>
            <Stat icon="flame" color={colors.lamp} value={String(m.streak)} label={t('profile.stat_streak')} />
            <Stat icon="time" color={colors.lamp} value={String(Math.round(m.todayMinutes))} label={t('profile.stat_minutes')} />
            <Stat icon="shield-checkmark" color={colors.lamp} value={String(m.shields)} label={t('profile.stat_shields')} />
          </View>
        ) : null}
      </Tactile>
      {/* Your corner of the app, as keys. */}
      <View style={styles.grid}>
        {corner.map((k) => (
          <Tactile
            key={k.label}
            onPress={() => router.push(k.to)}
            accessibilityLabel={k.label}
            color={colors.surface1}
            borderColor={colors.border}
            ledge={shade(colors.border, 0.14)}
            borderWidth={1.5}
            radius={radius.lg}
            depth={depth.sm}
            style={styles.key}
            pressedStyle={{ backgroundColor: colors.surface2 }}
          >
            <IconTile icon={k.icon} tone={k.tone} color={k.color} size={36} />
            <Text variant="label" numberOfLines={2} style={{ flex: 1 }}>
              {k.label}
            </Text>
          </Tactile>
        ))}
      </View>
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

/** How far through the current level the XP is, 0–1. */
function levelProgress(xp: number, level: number): number {
  const from = levelThreshold(level);
  const to = levelThreshold(level + 1);
  return to > from ? Math.max(0, Math.min(1, (xp - from) / (to - from))) : 0;
}

/** A number on the student card, with what it counts under it. */
function Stat({ icon, color, value, label }: { icon: IconName; color: string; value: string; label: string }) {
  const { colors, easyReading } = useTheme();
  return (
    <View style={styles.stat} accessible accessibilityLabel={`${value} ${label}`}>
      <View style={styles.statValue}>
        <Ionicons name={icon} size={18} color={color} />
        <Text variant="heading" style={[{ color: colors.onHero }, !easyReading && { fontFamily: FONTS.display }]} numberOfLines={1}>
          {value}
        </Text>
      </View>
      <Text variant="bodySmall" style={{ color: colors.heroMuted }} numberOfLines={1} align="center">
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: space.lg, paddingTop: space.md, gap: space.md, overflow: 'hidden' },
  // The punched slot a lanyard goes through.
  slot: { alignSelf: 'center', width: 44, height: 8, borderRadius: 4 },
  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  caps: { letterSpacing: 1.2, flexShrink: 1 },
  cardMain: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  photo: { width: 92, height: 104, borderRadius: radius.md, borderWidth: 3, alignItems: 'center', justifyContent: 'flex-end', overflow: 'hidden' },
  levelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  xpTrack: { height: 8, borderRadius: 4, overflow: 'hidden' },
  xpFill: { height: 8, borderRadius: 4 },
  stats: { flexDirection: 'row', gap: space.sm, borderTopWidth: 2, borderStyle: 'dashed', paddingTop: space.md },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.sm },
  key: { width: '48.6%', minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
  stat: { flex: 1, alignItems: 'center', gap: space.xxs },
  statValue: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
