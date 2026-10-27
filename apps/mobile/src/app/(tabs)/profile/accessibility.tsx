import { Linking } from 'react-native';
import { Button, Screen, Section, SegmentedControl, SwitchRow, Text } from '../../../components';
import { readAloud } from '../../../features/voice/voice';
import { updateSettings } from '../../../features/profile/api';
import { t } from '../../../i18n';
import { useUiStore } from '../../../stores/ui';

/** S-PERF-09 Acessibilidade (WEL-04): font size, Leitura facilitada, contrast, motion, extra time, read-aloud speed. */
export default function Accessibility() {
  const ui = useUiStore();
  const sync = (patch: Record<string, unknown>) => void updateSettings(patch).catch(() => undefined);
  return (
    <Screen title={t('a11y.title')}>
      <Section title={t('a11y.font_size')}>
        <Text tone="secondary">{t('a11y.font_size_hint')}</Text>
        <Button variant="text" label={t('notif.system_settings')} onPress={() => void Linking.openSettings()} />
      </Section>
      <SwitchRow label={t('a11y.easy_reading')} hint={t('a11y.easy_reading_hint')} value={ui.easyReading} onChange={(v) => (ui.setEasyReading(v), sync({ font_family: v ? 'atkinson' : 'system' }))} />
      <SwitchRow label={t('a11y.high_contrast')} value={ui.highContrast} onChange={(v) => (ui.setHighContrast(v), sync({ high_contrast: v }))} />
      <SwitchRow label={t('a11y.reduce_motion')} value={ui.reduceMotion} onChange={(v) => (ui.setReduceMotion(v), sync({ reduce_motion: v }))} />
      <SwitchRow label={t('a11y.extra_time')} hint={t('a11y.extra_time_hint')} value={ui.extraTime} onChange={(v) => (ui.setExtraTime(v), sync({ time_extension: v ? 1.5 : 1 }))} />
      <Section title={t('a11y.read_aloud')}>
        <Text tone="secondary">{t('a11y.read_aloud_hint')}</Text>
        <SegmentedControl<string>
          label={t('a11y.read_aloud_speed')}
          value={String(ui.readAloudRate)}
          onChange={(v) => {
            ui.setReadAloudRate(Number(v));
            readAloud('a11y.sample', t('a11y.read_aloud_sample'), { rate: Number(v) });
          }}
          options={['0.75', '1', '1.25', '1.5', '2'].map((v) => ({ value: v, label: `${v.replace('.', ',')}×` }))}
        />
      </Section>
    </Screen>
  );
}
