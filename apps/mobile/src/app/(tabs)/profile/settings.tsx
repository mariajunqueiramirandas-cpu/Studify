import { router } from 'expo-router';
import { Card, ListItem, Screen, Section, SegmentedControl } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { updateSettings } from '../../../features/profile/api';
import { options, t } from '../../../i18n';
import { useUiStore } from '../../../stores/ui';

/** S-PERF-04 Configurações: theme + links to sections (PLT-01). */
export default function Settings() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const { refreshProfile } = useSession();
  const labels = options('settings.theme_options');
  return (
    <Screen title={t('settings.title')}>
      <Section title={t('settings.appearance')}>
        <SegmentedControl
          label={t('settings.theme')}
          value={theme}
          onChange={(v) => {
            setTheme(v);
            void updateSettings({ theme: v }).then(refreshProfile).catch(() => undefined);
          }}
          options={[
            { value: 'system', label: labels[0] ?? '' },
            { value: 'light', label: labels[1] ?? '' },
            { value: 'dark', label: labels[2] ?? '' },
          ]}
        />
      </Section>
      <Card>
        <ListItem icon="notifications-outline" title={t('settings.notifications')} onPress={() => router.push('/profile/notifications')} />
        <ListItem icon="calendar-outline" title={t('calendar.title')} subtitle={t('calendar.entry_hint')} onPress={() => router.push('/profile/calendar')} />
        <ListItem icon="albums-outline" title={t('settings.memory')} onPress={() => router.push('/profile/memory')} />
        <ListItem icon="cloud-download-outline" title={t('settings.storage')} onPress={() => router.push('/profile/storage')} />
        <ListItem icon="sync-outline" title={t('settings.sync')} onPress={() => router.push('/profile/sync')} />
        <ListItem icon="accessibility-outline" title={t('settings.accessibility')} onPress={() => router.push('/profile/accessibility')} />
        <ListItem icon="heart-outline" title={t('settings.wellbeing')} onPress={() => router.push('/profile/wellbeing')} />
      </Card>
      <ListItem icon="language-outline" title={t('settings.content_language')} subtitle={t('settings.content_language_hint')} />
    </Screen>
  );
}
