import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, TextInput, View, type TextInputProps } from 'react-native';
import { shortDate, timeHM, weekdayDate } from '../features/common/format';
import { radius, space, touch, useTheme } from '../theme';
import { Text } from './Text';

interface FieldProps extends TextInputProps {
  label?: string;
  hint?: string;
  error?: string | null;
  counter?: { max: number; showAfter?: number };
}

export function TextField({ label, hint, error, counter, style, multiline, value, ...rest }: FieldProps) {
  const { colors: c, type } = useTheme();
  const [focused, setFocused] = useState(false);
  const len = value?.length ?? 0;
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Text variant="label">{label}</Text> : null}
      <TextInput
        accessibilityLabel={label ?? rest.placeholder}
        placeholderTextColor={c.textSecondary}
        allowFontScaling
        value={value}
        multiline={multiline}
        onFocus={(e) => {
          setFocused(true);
          rest.onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          rest.onBlur?.(e);
        }}
        style={[
          type('body'),
          styles.input,
          multiline && styles.multiline,
          { color: c.textPrimary, borderColor: error ? c.danger : focused ? c.focusRing : c.border, borderWidth: focused || error ? 2 : 1, backgroundColor: c.surface1 },
          style,
        ]}
        {...rest}
      />
      {error ? (
        <Text variant="bodySmall" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="bodySmall" tone="secondary">
          {hint}
        </Text>
      ) : null}
      {counter && len >= (counter.showAfter ?? 0) ? (
        <Text variant="bodySmall" tone={len > counter.max ? 'danger' : 'secondary'} align="right">
          {len}/{counter.max}
        </Text>
      ) : null}
    </View>
  );
}

export function SwitchRow({ label, hint, value, onChange, disabled }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const { colors: c } = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={() => !disabled && onChange(!value)}
      style={[styles.switchRow, disabled && { opacity: 0.5 }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text>{label}</Text>
        {hint ? (
          <Text variant="bodySmall" tone="secondary">
            {hint}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ true: c.primary, false: c.border }}
        thumbColor={c.bg}
        importantForAccessibility="no"
      />
    </Pressable>
  );
}

/** Underlined tabs: the chosen option is inked and sits on a bar; no track, no capsule. */
export function SegmentedControl<T extends string>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label?: string }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      {label ? <Text variant="label">{label}</Text> : null}
      <View style={[styles.segment, { borderBottomColor: c.border }]} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(o.value)}
              style={({ pressed }) => [styles.segmentItem, pressed && !selected && { opacity: 0.6 }]}
            >
              <Text variant="label" weight={selected ? 'bold' : undefined} style={{ color: selected ? c.textPrimary : c.textSecondary }} align="center" numberOfLines={2}>
                {o.label}
              </Text>
              <View style={[styles.segmentBar, { backgroundColor: selected ? c.primary : 'transparent' }]} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function RadioList<T extends string>({ options, value, onChange }: { options: { value: T; label: string; hint?: string }[]; value: T | null; onChange: (v: T) => void }) {
  const { colors: c } = useTheme();
  return (
    <View style={{ gap: space.sm }} accessibilityRole="radiogroup">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={o.hint ? `${o.label}. ${o.hint}` : o.label}
            onPress={() => onChange(o.value)}
            style={[styles.radio, { borderColor: selected ? c.primary : c.border, backgroundColor: selected ? c.primarySoft : c.surface1 }]}
          >
            <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={22} color={selected ? c.primary : c.textSecondary} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="body" weight={selected ? 'bold' : 'regular'}>
                {o.label}
              </Text>
              {o.hint ? (
                <Text variant="bodySmall" tone="secondary">
                  {o.hint}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Stepper input for small integers (weights, minutes). */
export function NumberStepper({ value, onChange, min = 0, max = 999, step = 1, label, format }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; label: string; format?: (v: number) => string }) {
  const { colors: c } = useTheme();
  const dec = () => onChange(Math.max(min, +(value - step).toFixed(2)));
  const inc = () => onChange(Math.min(max, +(value + step).toFixed(2)));
  return (
    <View style={styles.stepperRow} accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ text: format ? format(value) : String(value) }} accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'increment' ? inc() : dec())}>
      <Text style={{ flex: 1 }}>{label}</Text>
      <Pressable accessibilityLabel={`Diminuir ${label}`} onPress={dec} style={[styles.stepBtn, { borderColor: c.border }]}>
        <Ionicons name="remove" size={20} color={c.textPrimary} />
      </Pressable>
      <Text variant="label" style={{ minWidth: 56, textAlign: 'center' }}>
        {format ? format(value) : value}
      </Text>
      <Pressable accessibilityLabel={`Aumentar ${label}`} onPress={inc} style={[styles.stepBtn, { borderColor: c.border }]}>
        <Ionicons name="add" size={20} color={c.textPrimary} />
      </Pressable>
    </View>
  );
}

/** dd/mm date and 24 h time fields (ux §6 DatePicker/TimePicker). */
export function DateField({ label, value, onChange, mode = 'date', minimumDate, placeholder }: { label: string; value: Date | null; onChange: (d: Date) => void; mode?: 'date' | 'time'; minimumDate?: Date; placeholder?: string }) {
  const { colors: c } = useTheme();
  const [open, setOpen] = useState(false);
  const display = value ? (mode === 'date' ? weekdayDate(value) : timeHM(value)) : placeholder ?? '—';
  return (
    <View style={{ gap: space.xs, flex: 1 }}>
      <Text variant="label">{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value ? (mode === 'date' ? shortDate(value) : timeHM(value)) : placeholder ?? ''}`}
        onPress={() => setOpen(true)}
        style={[styles.input, styles.dateBtn, { borderColor: c.border, backgroundColor: c.surface1 }]}
      >
        <Ionicons name={mode === 'date' ? 'calendar-outline' : 'time-outline'} size={20} color={c.textSecondary} />
        <Text>{display}</Text>
      </Pressable>
      {open ? (
        <DateTimePicker
          value={value ?? new Date()}
          mode={mode}
          is24Hour
          minimumDate={minimumDate}
          onChange={(event, d) => {
            setOpen(false);
            if (event.type === 'set' && d) onChange(d);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: touch.min, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  multiline: { minHeight: 120, textAlignVertical: 'top' },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: touch.option, paddingVertical: space.xs },
  segment: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth * 2, gap: space.xs },
  segmentItem: { flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: space.xs, gap: space.sm },
  segmentBar: { alignSelf: 'stretch', height: 3, borderTopLeftRadius: 2, borderTopRightRadius: 2, marginBottom: -1 },
  radio: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1.5, minHeight: touch.option },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: touch.option },
  stepBtn: { width: touch.min, height: touch.min, borderRadius: radius.round, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dateBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1 },
});
