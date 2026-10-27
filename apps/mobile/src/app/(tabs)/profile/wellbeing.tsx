import { parseProfileSettings } from '@studify/shared';
import { router } from 'expo-router';
import { Card, ListItem, Screen, Section, SwitchRow, Text, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { updateSettings } from '../../../features/profile/api';
import { HelpCard } from '../../../features/wellbeing/HelpCard';
import { WeeklyCheckin } from '../../../features/wellbeing/WeeklyCheckin';
import { t } from '../../../i18n';

/** S-PERF-10 Bem-estar (WEL-03): nudges toggle, weekly check-in, quiet hours and the help card (always here). */
export default function Wellbeing() {
  const { profile, refreshProfile } = useSession();
  const overlay = useOverlay();
  let settings = parseProfileSettings({});
  try {
    settings = parseProfileSettings(profile?.settings);
  } catch {
    // keep the defaults
  }
  const save = (patch: Record<string, unknown>) =>
    void updateSettings(patch)
      .then(refreshProfile)
      .catch(() => overlay.snack(t('error.generic')));

  return (
    <Screen title={t('wellbeing.title')}>
      <Text tone="secondary">{t('wellbeing.intro')}</Text>
      <Section>
        <SwitchRow label={t('wellbeing.nudges')} hint={t('wellbeing.nudges_hint')} value={settings.wellbeing_nudges_enabled !== false} onChange={(v) => save({ wellbeing_nudges_enabled: v })} />
        <SwitchRow label={t('wellbeing.checkin')} hint={t('wellbeing.checkin_hint')} value={!!settings.checkin_enabled} onChange={(v) => save({ checkin_enabled: v })} />
      </Section>
      <WeeklyCheckin />
      <Card>
        <ListItem icon="moon-outline" title={t('wellbeing.quiet_hours')} subtitle={t('wellbeing.quiet_hours_hint')} onPress={() => router.push('/profile/notifications')} />
        <ListItem icon="timer-outline" title={t('focus.title')} subtitle={t('wellbeing.focus_hint')} onPress={() => router.push('/focus')} />
      </Card>
      <HelpCard />
    </Screen>
  );
}
