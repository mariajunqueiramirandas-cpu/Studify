import { router } from 'expo-router';
import { AppState } from 'react-native';
import { useEffect, useState } from 'react';
import { Banner, Button, DateField, ListItem, Row, Screen, Section, SwitchRow, Text, useOverlay } from '../../../components';
import { isMinor, useSession } from '../../../features/auth/session';
import { saveStudyPreferences, useStudyPreferences } from '../../../features/goals/api';
import { updateSettings } from '../../../features/profile/api';
import { t } from '../../../i18n';
import { requestNotificationPermission } from '../../../platform/notifications';
import { richNotifier } from '../../../platform/rich-notify';

type Channel = 'reviews' | 'plan' | 'class' | 'processing';
const CHANNELS: Channel[] = ['reviews', 'plan', 'class', 'processing'];

const toDate = (hhmm: string | undefined, fallback: string) => {
  const [h, m] = (hhmm ?? fallback).split(':').map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
};
const toHHMM = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** S-PERF-05 Notificações: channels, quiet hours (≥ 8 h for under-18s), 3/day cap (PLT-05). */
export default function NotificationSettings() {
  const { profile, userId, refreshProfile } = useSession();
  const prefs = useStudyPreferences();
  const overlay = useOverlay();
  const settings = (profile?.settings ?? {}) as { notifications?: Partial<Record<Channel, boolean>>; reminders_enabled?: boolean };
  const channels = (settings.notifications ?? {}) as Partial<Record<Channel, boolean>>;
  // Re-read when the student comes back from the Android settings.
  const [caps, setCaps] = useState(() => richNotifier.capabilities());
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setCaps(richNotifier.capabilities());
    });
    return () => sub.remove();
  }, []);
  const [quietStart, setQuietStart] = useState(toDate(undefined, '22:00'));
  const [quietEnd, setQuietEnd] = useState(toDate(undefined, '07:00'));
  const [vespera, setVespera] = useState(toDate(undefined, '19:00'));
  useEffect(() => {
    if (!prefs.data) return;
    setQuietStart(toDate(prefs.data.quiet_start?.slice(0, 5), '22:00'));
    setQuietEnd(toDate(prefs.data.quiet_end?.slice(0, 5), '07:00'));
    setVespera(toDate(prefs.data.vespera_time?.slice(0, 5), '19:00'));
  }, [prefs.data]);

  const minor = isMinor(profile);
  const quietHours = (() => {
    const s = quietStart.getHours() * 60 + quietStart.getMinutes();
    const e = quietEnd.getHours() * 60 + quietEnd.getMinutes();
    return ((e - s + 1440) % 1440) / 60;
  })();

  const saveQuiet = async () => {
    // D-27: under-18s may move quiet hours but keep at least 8 h (also enforced by a DB trigger).
    if (minor && quietHours < 8) {
      overlay.snack(t('notif.quiet_minor_note'));
      return;
    }
    await saveStudyPreferences(userId!, { quiet_start: toHHMM(quietStart), quiet_end: toHHMM(quietEnd), vespera_time: toHHMM(vespera) }).catch(() => overlay.snack(t('error.generic')));
    overlay.snack(t('global.done'));
  };

  const setReminders = async (v: boolean) => {
    if (v) await requestNotificationPermission().catch(() => false);
    await updateSettings({ reminders_enabled: v })
      .then(refreshProfile)
      .catch(() => overlay.snack(t('error.generic')));
  };

  const status = !richNotifier.native ? t('notif.rich_plain') : !caps.enabled ? t('notif.disabled') : t('notif.rich_on');
  const live = !richNotifier.native || caps.sdk < 36 ? t('notif.live_unsupported') : caps.liveUpdates && caps.promoted ? t('notif.live_on') : t('notif.live_off');

  return (
    <Screen title={t('notif.title')}>
      <Section title={t('notif.rich_title')}>
        <Banner kind={richNotifier.native && caps.enabled ? 'success' : 'neutral'} message={status} />
        {richNotifier.native && caps.enabled ? (
          <Text variant="bodySmall" tone="secondary">
            {live}
          </Text>
        ) : null}
        <ListItem title={t('notif.preview')} icon="color-palette-outline" onPress={() => router.push('/notifications/preview')} />
      </Section>
      <Section>
        <SwitchRow label={t('notif.reminders')} hint={t('notif.reminders_hint')} value={settings.reminders_enabled !== false} onChange={(v) => void setReminders(v)} />
        {CHANNELS.map((c) => (
          <SwitchRow
            key={c}
            label={t(`notif.channels.${c}`)}
            value={channels[c] !== false}
            onChange={(v) => void updateSettings({ notifications: { ...channels, [c]: v } }).then(refreshProfile)}
          />
        ))}
      </Section>
      <Section title={t('notif.quiet_hours')}>
        <Row>
          <DateField mode="time" label={t('notif.quiet_from')} value={quietStart} onChange={setQuietStart} />
          <DateField mode="time" label={t('notif.quiet_to')} value={quietEnd} onChange={setQuietEnd} />
        </Row>
        {minor ? <Banner kind="neutral" message={t('notif.quiet_minor_note')} /> : null}
        <DateField mode="time" label={t('notif.vespera_time')} value={vespera} onChange={setVespera} />
        <Button variant="tonal" label={t('global.save')} onPress={saveQuiet} />
      </Section>
      <Text variant="bodySmall" tone="secondary">
        {t('notif.cap_note')}
      </Text>
      <Button variant="text" label={t('notif.open_app_settings')} onPress={() => richNotifier.openSettings()} />
    </Screen>
  );
}
