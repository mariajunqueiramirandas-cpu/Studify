import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import { Chip, ChipGroup, Text, TextField } from '../../components';
import { options, t } from '../../i18n';
import { radius, space, SUBJECT_COLOR_KEYS, SUBJECT_COLORS, SUBJECT_ICONS, useTheme, type SubjectColor } from '../../theme';
import { Notebook } from './Notebook';

export interface SubjectDraft {
  name: string;
  color: SubjectColor;
  icon: string;
}

/** S-MAT-02 fields: name, one of 12 colors, icon. */
export function SubjectForm({ value, onChange, suggestions = true }: { value: SubjectDraft; onChange: (v: SubjectDraft) => void; suggestions?: boolean }) {
  const { colors, scheme } = useTheme();
  const tint = SUBJECT_COLORS[value.color][scheme];
  return (
    <View style={{ gap: space.lg }}>
      {/* What it will look like on the shelf, as you pick. */}
      <Notebook name={value.name.trim() || t('subjects.new')} tint={tint} icon={value.icon} style={{ width: '48.3%', alignSelf: 'center' }} />
      <TextField label={t('subjects.name')} value={value.name} onChangeText={(name) => onChange({ ...value, name })} maxLength={60} autoCapitalize="sentences" />
      {suggestions && !value.name ? (
        <ChipGroup>
          {options('onb.first_subject.suggestions').map((s) => (
            <Chip key={s} label={s} onPress={() => onChange({ ...value, name: s })} />
          ))}
        </ChipGroup>
      ) : null}
      <Text variant="label">{t('subjects.color')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} accessibilityRole="radiogroup">
        {SUBJECT_COLOR_KEYS.map((key) => {
          const selected = value.color === key;
          return (
            <Pressable
              key={key}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={SUBJECT_COLORS[key].label}
              onPress={() => onChange({ ...value, color: key })}
              style={{ width: 48, height: 48, borderRadius: radius.round, backgroundColor: SUBJECT_COLORS[key][scheme], alignItems: 'center', justifyContent: 'center', borderWidth: selected ? 3 : 0, borderColor: colors.textPrimary }}
            >
              {selected ? <Ionicons name="checkmark" size={22} color={colors.onPrimary} /> : null}
            </Pressable>
          );
        })}
      </View>
      <Text variant="label">{t('subjects.icon')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }} accessibilityRole="radiogroup">
        {SUBJECT_ICONS.map((icon) => {
          const selected = value.icon === icon;
          return (
            <Pressable
              key={icon}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={icon.replace('-outline', '')}
              onPress={() => onChange({ ...value, icon })}
              style={{ width: 48, height: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: selected ? `${tint}${scheme === 'dark' ? '33' : '1F'}` : colors.surface1, borderWidth: selected ? 2 : 0, borderColor: tint }}
            >
              <Ionicons name={icon} size={24} color={selected ? tint : colors.textSecondary} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
