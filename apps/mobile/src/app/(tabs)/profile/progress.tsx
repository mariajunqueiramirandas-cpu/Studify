import { ACHIEVEMENTS, suggestedReminderTimes } from '@studify/shared';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';
import { data } from '../../../api/data';
import { Capi, Card, ListItem, ProgressBar, Row, Screen, Section, Stat, Text } from '../../../components';
import { bucketLabel, usePerformanceWindows } from '../../../features/energy/api';
import { useStudyPreferences } from '../../../features/goals/api';
import { useCapi } from '../../../features/motivation/capi';
import { useSession } from '../../../features/auth/session';
import { addDays, toLocalDate } from '../../../features/common/format';
import { useAchievements, useMotivation } from '../../../features/motivation/api';
import { t } from '../../../i18n';
import { radius, space, useTheme } from '../../../theme';

/** S-PERF-03 Progresso (MOT-01): level, XP, streak calendar, achievements. No comparisons. */
export default function Progress() {
  const { userId } = useSession();
  const m = useMotivation();
  const { colors } = useTheme();
  const from = toLocalDate(addDays(new Date(), -34));
  const days = useQuery({
    queryKey: ['dailyActivity', userId, from],
    enabled: !!userId,
    queryFn: () => data<Array<{ local_date: string; active_minutes: number; counted: boolean | null }>>('progress-daily-activity', { from }).catch(() => []),
  });
  const achievements = useAchievements();
  const capi = useCapi();
  const energy = usePerformanceWindows();
  const prefs = useStudyPreferences();
  const best = energy.data?.best ?? [];
  const hm = (v: string | undefined, d: string) => (v ?? d).slice(0, 5);
  const reminderTimes = best.length
    ? suggestedReminderTimes(best, { start: hm(prefs.data?.window_start, '14:00'), end: hm(prefs.data?.window_end, '21:30') }, { start: hm(prefs.data?.quiet_start, '22:00'), end: hm(prefs.data?.quiet_end, '07:00') })
    : [];
  const xp = m.data?.xp ?? 0;
  const level = m.data?.level ?? 1;
  let base = 0;
  for (let l = 1; l < level; l++) base += 100 * l;
  const need = 100 * level;
  const active = new Set((days.data ?? []).filter((d) => d.active_minutes > 0).map((d) => d.local_date));
  const mine = new Map((achievements.data ?? []).map((a) => [a.code, a]));

  return (
    <Screen title={t('progress.title')}>
      <Card>
        {capi.visible ? (
          <Row>
            <Capi stage={capi.stage} mood={capi.mood} accessories={capi.accessories} size={64} />
            <Text variant="bodySmall" tone="secondary" style={{ flex: 1 }}>
              {t('capi.stage_title', { stage: t(`capi.stage.${capi.stage}`) })}
            </Text>
          </Row>
        ) : null}
        <Row>
          <Stat value={t('progress.level', { n: level })} label={`${xp} XP`} />
          <Stat value={String(m.data?.streak ?? 0)} label={t('streak.count', { n: m.data?.streak ?? 0 }).split(':')[0] ?? ''} />
          <Stat value={String(m.data?.shields ?? 0)} label="🛡️" />
        </Row>
        <ProgressBar value={(xp - base) / need} label={t('progress.xp_to_next', { n: Math.max(0, base + need - xp) })} />
        <Text variant="bodySmall" tone="secondary">
          {t('progress.xp_to_next', { n: Math.max(0, base + need - xp) })}
        </Text>
      </Card>
      <Section title={t('progress.streak_calendar')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {Array.from({ length: 35 }, (_, i) => {
            const d = toLocalDate(addDays(new Date(), i - 34));
            const on = active.has(d);
            return <View key={d} accessibilityLabel={`${d}: ${on ? 'estudou' : 'sem estudo'}`} style={{ width: 36, height: 36, borderRadius: radius.sm, backgroundColor: on ? colors.primary : colors.surface2 }} />;
          })}
        </View>
      </Section>
      <Section title={t('energy.title')}>
        {best.length ? (
          <>
            <Text>{t('energy.best', { windows: best.map(bucketLabel).join(' e ') })}</Text>
            {reminderTimes.length ? (
              <Text variant="bodySmall" tone="secondary">
                {t('energy.reminders', { times: reminderTimes.join(', ') })}
              </Text>
            ) : null}
          </>
        ) : (
          <Text tone="secondary">{t('energy.not_ready')}</Text>
        )}
      </Section>
      <Card>
        <ListItem icon="sparkles-outline" title={t('retro.title')} subtitle={t('retro.entry_hint')} onPress={() => router.push('/retro')} />
      </Card>
      <Section title={t('progress.achievements')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {ACHIEVEMENTS.filter((a) => a.computable).map((a) => {
            const row = mine.get(a.code);
            const got = !!row?.unlocked_at;
            // Partial progress only for counted goals ("37/100"), never for one-shot ones.
            const partial = !got && a.threshold > 1 && row?.progress ? `${Math.min(row.progress, a.threshold)}/${a.threshold}` : null;
            return (
              <View
                key={a.code}
                style={{ width: '30%', padding: space.sm, borderRadius: radius.md, backgroundColor: got ? colors.primarySoft : colors.surface1, opacity: got ? 1 : 0.6 }}
                accessibilityLabel={`${a.name}. ${a.criterion}${got ? '' : ` ${t('progress.locked')}${partial ? ` ${partial}` : ''}`}`}
              >
                <Text variant="bodySmall" align="center">{`${got ? '🏆' : '🔒'}\n${a.name}`}</Text>
                {partial ? (
                  <Text variant="caption" tone="secondary" align="center">
                    {partial}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      </Section>
    </Screen>
  );
}
