import { View } from 'react-native';
import { Chip, ChipGroup, NumberStepper } from '../../components';
import { options, t } from '../../i18n';
import { space } from '../../theme';
import { formatMinutes } from '../common/format';

/** Mon…Sun minutes (study_preferences.minutes_by_weekday order). */
export type WeekMinutes = number[];

// spec 07 §5.1: presets Leve / Médio / Puxado = 30 / 60 / 90 min (weekend +50%, Sunday lighter).
const PRESETS: WeekMinutes[] = [
  [30, 30, 30, 30, 30, 45, 15],
  [60, 60, 60, 60, 60, 90, 30],
  [90, 90, 90, 90, 90, 120, 45],
];
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** S-OBJ-08 Seu tempo: minutes per weekday (GOL-04.3). */
export function TimeEditor({ value, onChange }: { value: WeekMinutes; onChange: (v: WeekMinutes) => void }) {
  const presets = options('time.presets');
  const days = options('weekdays_long');
  return (
    <View style={{ gap: space.md }}>
      <ChipGroup>
        {PRESETS.map((p, i) => (
          <Chip key={i} label={presets[i] ?? ''} selected={p.join() === value.join()} onPress={() => onChange(p)} />
        ))}
      </ChipGroup>
      {value.map((m, i) => (
        <NumberStepper
          key={i}
          label={days[WEEKDAY_ORDER[i]!] ?? ''}
          value={m}
          min={0}
          max={240}
          step={15}
          format={(v) => (v === 0 ? t('time.exception_none') : formatMinutes(v))}
          onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)))}
        />
      ))}
    </View>
  );
}
