import { useEffect, useState } from 'react';
import { Banner, Button, Card, Screen, Section, SwitchRow, Text, useOverlay } from '../../../components';
import { useDb } from '../../../db/DatabaseProvider';
import { useSession } from '../../../features/auth/session';
import { calendarSettings, disableCalendarSync, enableCalendarSync, listDeviceCalendars, runCalendarSync, setBusyCalendars, type DeviceCalendar } from '../../../features/calendar/sync';
import { timeHM, relativeDay } from '../../../features/common/format';
import { usePerformanceWindows } from '../../../features/energy/api';
import { t } from '../../../i18n';

/** Perfil → Agenda (GOL-09): opt-in device calendar sync. Event titles never leave the phone. */
export default function CalendarSettings() {
  const db = useDb();
  const { userId } = useSession();
  const overlay = useOverlay();
  const windows = usePerformanceWindows();
  const [settings, setSettings] = useState(() => calendarSettings());
  const [calendars, setCalendars] = useState<DeviceCalendar[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!settings.enabled) return;
    let alive = true;
    void listDeviceCalendars()
      .then((list) => alive && setCalendars(list))
      .catch(() => alive && setCalendars([]));
    return () => {
      alive = false;
    };
  }, [settings.enabled]);

  const syncNow = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      const r = await runCalendarSync(db, userId, windows.data?.best ?? []);
      setSettings(calendarSettings());
      if (r) overlay.snack(t('calendar.synced', { n: r.placed }));
    } catch {
      overlay.snack(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (on: boolean) => {
    if (on) {
      const ok = await enableCalendarSync().catch(() => false);
      if (!ok) {
        overlay.snack(t('calendar.permission_denied'));
        return;
      }
      setSettings(calendarSettings());
      void syncNow();
      return;
    }
    if (!(await overlay.confirm({ title: t('calendar.off_title'), message: t('calendar.off_body'), confirmLabel: t('calendar.off_confirm'), cancelLabel: t('global.cancel') }))) return;
    await disableCalendarSync(db);
    setCalendars(null);
    setSettings(calendarSettings());
  };

  const markBusy = (id: string, on: boolean) => {
    setBusyCalendars(on ? [...settings.busyIds, id] : settings.busyIds.filter((x) => x !== id));
    setSettings(calendarSettings());
  };

  return (
    <Screen title={t('calendar.title')}>
      <Text tone="secondary">{t('calendar.intro')}</Text>
      <SwitchRow label={t('calendar.enable')} value={settings.enabled} onChange={(v) => void toggle(v)} />
      <Banner kind="neutral" icon="lock-closed-outline" message={t('calendar.privacy')} />
      {settings.enabled ? (
        <>
          <Section title={t('calendar.busy_title')}>
            <Text variant="bodySmall" tone="secondary">
              {t('calendar.busy_hint')}
            </Text>
            {(calendars ?? []).map((c) => (
              <SwitchRow key={c.id} label={c.title} hint={c.account ?? undefined} value={settings.busyIds.includes(c.id)} onChange={(v) => markBusy(c.id, v)} />
            ))}
            {calendars && calendars.length === 0 ? <Text tone="secondary">{t('calendar.none')}</Text> : null}
          </Section>
          <Card>
            <Text>{t('calendar.writes')}</Text>
            {settings.lastSync ? (
              <Text variant="caption" tone="secondary">
                {t('calendar.last_sync', { when: `${relativeDay(new Date(settings.lastSync))} ${timeHM(new Date(settings.lastSync))}` })}
              </Text>
            ) : null}
            <Button variant="secondary" icon="sync-outline" label={t('calendar.sync_now')} onPress={syncNow} loading={busy} />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
