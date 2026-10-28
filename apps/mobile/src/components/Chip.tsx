import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { t } from '../i18n';
import { countdown, pageLabel, parseDate, daysBetween } from '../features/common/format';
import { depth, FONTS, radius, shade, space, useTheme } from '../theme';
import type { IconName } from './Button';
import { Tactile } from './Tactile';
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

/**
 * Filter / scope / status chip (ux §6). A chip you can tap is a squared key that inks in when chosen; a chip that
 * only states something (a risk, a rubric score) is plain inline text with an icon, never a capsule.
 */
export function Chip({ label, selected, onPress, icon, disabled, accessibilityLabel, tone = 'default', testID }: ChipProps) {
  const { colors: c } = useTheme();
  const toneColor = { default: c.textPrimary, success: c.success, warning: c.warning, danger: c.danger, info: c.info }[tone];
  if (!onPress && !selected) return <Meta icon={icon} text={label} color={tone === 'default' ? c.textSecondary : toneColor} accessibilityLabel={accessibilityLabel} />;
  // Chosen keys turn the tone's colour: tinted face, coloured rim and ledge (default tone = primary).
  const ink = tone === 'default' ? c.primary : toneColor;
  const soft = { default: c.primarySoft, success: c.successSoft, warning: c.warningSoft, danger: c.dangerSoft, info: c.infoSoft }[tone];
  const fg = selected ? ink : c.textPrimary;
  return (
    <Tactile
      testID={testID}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityState={{ selected: !!selected, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={disabled ? undefined : onPress}
      hitSlop={4}
      color={selected ? soft : c.surface1}
      borderColor={selected ? ink : c.border}
      ledge={selected ? shade(ink, 0.15) : shade(c.border, 0.12)}
      borderWidth={2}
      radius={radius.md}
      depth={depth.sm}
      style={[styles.chip, disabled && { opacity: 0.45 }]}
    >
      {selected ? <Ionicons name="checkmark" size={16} color={fg} /> : icon ? <Ionicons name={icon} size={16} color={c.textSecondary} /> : null}
      <Text variant="label" weight={selected ? 'bold' : undefined} style={{ color: fg }} numberOfLines={1}>
        {label}
      </Text>
    </Tactile>
  );
}

export function ChipGroup({ children }: { children: React.ReactNode }) {
  return <View style={styles.group}>{children}</View>;
}

/** A line of metadata: optional icon, then text in a quiet color. Replaces status pills and badges. */
export function Meta({ icon, text, color, accessibilityLabel }: { icon?: IconName; text: string; color?: string; accessibilityLabel?: string }) {
  const { colors: c } = useTheme();
  const tint = color ?? c.textSecondary;
  return (
    <View style={styles.meta} accessible accessibilityLabel={accessibilityLabel ?? text}>
      {icon ? <Ionicons name={icon} size={15} color={tint} /> : <View style={[styles.metaDot, { backgroundColor: tint }]} />}
      <Text variant="bodySmall" style={{ color: tint }} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
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

/** A footnote-style link: p. 12 → opens the citation view at that page with the passage highlighted (ING-08, TRU-01). */
export function PageChip({ source, subjectId, documentTitle, removed, classOnly }: PageChipProps) {
  const { colors: c } = useTheme();
  const page = pageLabel(source.page_start, source.page_end);
  const label = removed ? t('global.source_removed') : classOnly ? t('global.source_class_only') : documentTitle ? `${documentTitle}, ${page}` : page;
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
  const tint = disabled ? c.textSecondary : c.primary;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={disabled ? label : `Abrir página ${source.page_start} do material${documentTitle ? ` ${documentTitle}` : ''}`}
      accessibilityState={{ disabled: !!disabled }}
      onPress={disabled ? undefined : open}
      hitSlop={10}
      style={({ pressed }) => [styles.page, { opacity: disabled ? 0.7 : pressed ? 0.55 : 1 }]}
    >
      <Ionicons name={disabled ? 'document-outline' : 'document-text-outline'} size={15} color={tint} />
      <Text variant="label" style={{ color: tint }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PageChips({ sources, subjectId, max = 3 }: { sources: SourceRef[] | null | undefined; subjectId?: string | null; max?: number }) {
  if (!sources?.length) return null;
  return (
    <View style={styles.pages}>
      {sources.slice(0, max).map((s, i) => (
        <PageChip key={`${s.document_id}-${s.page_start}-${i}`} source={s} subjectId={subjectId} />
      ))}
    </View>
  );
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** A tear-off calendar leaf with the day, then "Faltam 3 dias" / "É amanhã!" / "Hoje às 14:00" beside it. */
export function CountdownChip({ startsAt, hasTime = true, label }: { startsAt: string; hasTime?: boolean; label?: string }) {
  const { colors: c, easyReading } = useTheme();
  const date = parseDate(startsAt);
  const days = daysBetween(new Date(), date);
  const urgent = days <= 1;
  const text = countdown(startsAt, hasTime);
  const tint = urgent ? c.warning : c.primary;
  return (
    <View style={styles.countdown} accessible accessibilityLabel={label ? `${label}. ${text}` : text}>
      <View style={[styles.leaf, { backgroundColor: c.surface1, borderColor: c.border }]}>
        <View style={[styles.leafTop, { backgroundColor: tint }]} />
        <Text style={[styles.leafDay, { color: c.textPrimary }, !easyReading && { fontFamily: FONTS.display }]}>{date.getDate()}</Text>
        <Text variant="bodySmall" style={[styles.leafMonth, { color: c.textSecondary }]}>
          {MONTHS[date.getMonth()]}
        </Text>
      </View>
      <View style={{ flexShrink: 1 }}>
        {label ? (
          <Text variant="label" numberOfLines={1}>
            {label}
          </Text>
        ) : null}
        <Text variant="bodySmall" style={{ color: urgent ? c.warning : c.textSecondary }} numberOfLines={1}>
          {text}
        </Text>
      </View>
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
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, minHeight: 44, paddingHorizontal: space.md },
  group: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  metaDot: { width: 6, height: 6, borderRadius: 1.5, transform: [{ rotate: '45deg' }] },
  pages: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.lg, rowGap: space.xs },
  page: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 32, alignSelf: 'flex-start' },
  countdown: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  leaf: { width: 48, borderRadius: radius.sm, borderWidth: 1, alignItems: 'center', paddingBottom: 3, overflow: 'hidden' },
  leafTop: { alignSelf: 'stretch', height: 5, marginBottom: 2 },
  leafDay: { fontSize: 20, lineHeight: 23 },
  leafMonth: { lineHeight: 16 },
  ai: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
