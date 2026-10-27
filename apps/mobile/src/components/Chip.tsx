import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { countdown, pageLabel, parseDate, daysBetween } from '../features/common/format';
import { radius, space, useTheme } from '../theme';
import type { IconName } from './Button';
import { Text } from './Text';

interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  disabled?: boolean;
  accessibilityLabel?: string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  testID?: string;
}

/** Filter / scope / status chip (ux §6). */
export function Chip({ label, selected, onPress, icon, disabled, accessibilityLabel, tone = 'default', testID }: ChipProps) {
  const { colors: c } = useTheme();
  const toneColor = { default: c.primary, success: c.success, warning: c.warning, danger: c.danger, info: c.info }[tone];
  const bg = selected ? toneColor : c.surface1;
  const fg = selected ? c.onPrimary : tone === 'default' ? c.textPrimary : toneColor;
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={disabled ? undefined : onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: bg, borderColor: selected ? toneColor : c.border, opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}
    >
      {selected ? <Ionicons name="checkmark" size={16} color={fg} /> : icon ? <Ionicons name={icon} size={16} color={fg} /> : null}
      <Text variant="label" style={{ color: fg }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ChipGroup({ children }: { children: React.ReactNode }) {
  return <View style={styles.group}>{children}</View>;
}

export interface SourceRef {
  document_id: string;
  page_start: number;
  page_end?: number | null;
  cited_text?: string | null;
}

interface PageChipProps {
  source: SourceRef;
  subjectId?: string | null;
  documentTitle?: string | null;
  /** The source document was deleted → disabled "Material removido" chip (ux §5.3). */
  removed?: boolean;
  classOnly?: boolean;
}

/** 📄 p. 12 → opens the citation view at that page with the passage highlighted (ING-08, TRU-01). */
export function PageChip({ source, subjectId, documentTitle, removed, classOnly }: PageChipProps) {
  const { colors: c } = useTheme();
  const label = removed
    ? t('global.source_removed')
    : classOnly
      ? t('global.source_class_only')
      : documentTitle
        ? `📄 ${documentTitle} · ${pageLabel(source.page_start, source.page_end).replace('📄 ', '')}`
        : pageLabel(source.page_start, source.page_end);
  const disabled = removed || classOnly;
  const open = () =>
    router.push({
      pathname: '/subjects/[subjectId]/document/[documentId]',
      params: {
        subjectId: subjectId ?? '_',
        documentId: source.document_id,
        page: String(source.page_start),
        ...(source.cited_text ? { cite: source.cited_text.slice(0, 300) } : {}),
      },
    });
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={disabled ? label : `Abrir página ${source.page_start} do material${documentTitle ? ` ${documentTitle}` : ''}`}
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : open}
      hitSlop={8}
      style={({ pressed }) => [
        styles.page,
        { backgroundColor: c.surface2, borderColor: c.border, opacity: disabled ? 0.6 : pressed ? 0.7 : 1 },
      ]}
    >
      <Text variant="label" style={{ color: disabled ? c.textSecondary : c.primary }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PageChips({ sources, subjectId, max = 3 }: { sources: SourceRef[] | null | undefined; subjectId?: string | null; max?: number }) {
  if (!sources?.length) return null;
  return (
    <View style={styles.group}>
      {sources.slice(0, max).map((s, i) => (
        <PageChip key={`${s.document_id}-${s.page_start}-${i}`} source={s} subjectId={subjectId} />
      ))}
    </View>
  );
}

/** "Faltam 3 dias" / "É amanhã!" / "Hoje às 14:00" */
export function CountdownChip({ startsAt, hasTime = true, label }: { startsAt: string; hasTime?: boolean; label?: string }) {
  const { colors: c } = useTheme();
  const days = daysBetween(new Date(), parseDate(startsAt));
  const urgent = days <= 1;
  const text = countdown(startsAt, hasTime);
  return (
    <View style={[styles.countdown, { backgroundColor: urgent ? c.warningSoft : c.primarySoft }]}>
      <Ionicons name="calendar-outline" size={14} color={urgent ? c.warning : c.primary} />
      <Text variant="label" style={{ color: urgent ? c.warning : c.primary }} numberOfLines={1}>
        {label ? `${label} · ${text}` : text}
      </Text>
    </View>
  );
}

/** "Gerado por IA" metadata line (SP-10) — required on all AI content. */
export function AiBadge({ general }: { general?: boolean }) {
  const { colors: c } = useTheme();
  return (
    <View style={styles.ai}>
      <Ionicons name="sparkles-outline" size={14} color={general ? c.info : c.textSecondary} />
      <Text variant="bodySmall" style={{ color: general ? c.info : c.textSecondary }}>
        {general ? t('global.general_knowledge') : t('global.ai_generated')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 36,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  group: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  page: { borderRadius: radius.pill, borderWidth: 1, paddingHorizontal: space.md, minHeight: 32, justifyContent: 'center', alignSelf: 'flex-start' },
  countdown: { flexDirection: 'row', alignItems: 'center', gap: space.xs, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs, alignSelf: 'flex-start' },
  ai: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
