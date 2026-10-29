import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, View, type TextInputProps } from 'react-native';
import { shortDate, timeHM, weekdayDate } from '../features/common/format';
import { tap } from '../lib/haptics';
import { depth, FONTS, radius, shade, space, touch, useTheme } from '../theme';
import { Tactile } from './Tactile';
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
    <View style={{ gap: space.sm }}>
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

/**
 * A one-time code as a row of key caps, one digit each. A single invisible field sits on top and takes the
 * keyboard, paste and SMS/e-mail autofill, so the caps only show what was typed.
 */
export function CodeField({ value, onChange, length = 6, label, error, autoFocus }: { value: string; onChange: (v: string) => void; length?: number; label?: string; error?: string | null; autoFocus?: boolean }) {
  const { colors: c, easyReading } = useTheme();
  const [focused, setFocused] = useState(!!autoFocus);
  const active = Math.min(value.length, length - 1);
  return (
    <View style={{ gap: space.sm }}>
      {label ? <Text variant="label">{label}</Text> : null}
      <View style={styles.codeRow}>
        {Array.from({ length }, (_, i) => {
          const digit = value[i] ?? '';
          const current = focused && i === active;
          const ink = error ? c.danger : current ? c.primary : c.border;
          return (
            <View
              key={i}
              importantForAccessibility="no-hide-descendants"
              style={[styles.codeCell, { backgroundColor: current ? c.primarySoft : c.surface1, borderColor: ink, borderBottomColor: error || current ? ink : shade(c.border, 0.14) }]}
            >
              <Text variant="title" style={easyReading ? undefined : { fontFamily: FONTS.display }}>
                {digit}
              </Text>
            </View>
          );
        })}
        <TextInput
          value={value}
          onChangeText={(v) => onChange(v.replace(/\D/g, '').slice(0, length))}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={length}
          autoFocus={autoFocus}
          caretHidden
          accessibilityLabel={label}
          style={[StyleSheet.absoluteFill, styles.codeInput]}
        />
      </View>
      {error ? (
        <Text variant="bodySmall" tone="danger" accessibilityLiveRegion="polite">
          {error}
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
      onPress={() => {
        if (disabled) return;
        tap();
        onChange(!value);
      }}
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
        onValueChange={(v) => {
          tap();
          onChange(v);
        }}
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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.segment, { borderBottomColor: c.border }]}
        contentContainerStyle={styles.segmentRow}
        accessibilityRole="radiogroup"
        accessibilityLabel={label}
      >
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => {
                if (!selected) tap();
                onChange(o.value);
              }}
              style={({ pressed }) => [styles.segmentItem, pressed && !selected && { opacity: 0.6 }]}
            >
              <Text variant="label" weight={selected ? 'bold' : undefined} style={{ color: selected ? c.textPrimary : c.textSecondary }} align="center" numberOfLines={1}>
                {o.label}
              </Text>
              <View style={[styles.segmentBar, { backgroundColor: selected ? c.primary : 'transparent' }]} />
            </Pressable>
          );
        })}
      </ScrollView>
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
          // A choice is a key, like a chip: it stands on a ledge and inks in when chosen.
          <Tactile
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={o.hint ? `${o.label}. ${o.hint}` : o.label}
            onPress={() => onChange(o.value)}
            color={selected ? c.primarySoft : c.surface1}
            borderColor={selected ? c.primary : c.border}
            ledge={selected ? shade(c.primary, 0.15) : shade(c.border, 0.12)}
            borderWidth={2}
            radius={radius.md}
            depth={depth.sm}
            style={styles.radio}
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
          </Tactile>
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
  // Tabs size to their labels and share any spare width; when they don't fit, the row scrolls instead of wrapping.
  segment: { flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth * 2 },
  segmentRow: { flexGrow: 1, gap: space.sm },
  segmentItem: { flexGrow: 1, minHeight: 46, alignItems: 'center', justifyContent: 'flex-end', paddingHorizontal: space.xxs, gap: space.sm },
  segmentBar: { alignSelf: 'stretch', height: 3, borderTopLeftRadius: 2, borderTopRightRadius: 2, marginBottom: -1 },
  radio: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, minHeight: touch.option },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: touch.option },
  stepBtn: { width: touch.min, height: touch.min, borderRadius: radius.round, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dateBtn: { flexDirection: 'row', alignItems: 'center', gap: space.sm, borderWidth: 1 },
  codeRow: { flexDirection: 'row', gap: space.sm },
  codeCell: { flex: 1, aspectRatio: 0.82, maxHeight: 72, borderRadius: radius.md, borderWidth: 2, borderBottomWidth: 4, alignItems: 'center', justifyContent: 'center' },
  // Invisible but still focusable and tappable: it covers the caps.
  codeInput: { opacity: 0.02, color: 'transparent', fontSize: 1 },
});
