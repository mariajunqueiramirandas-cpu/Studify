import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Button, Card, EmptyState, ErrorState, IconButton, Meta, Row, Screen, Section, SkeletonList, SubjectBadge, Text } from '../../../components';
import { countdown, daysBetween, parseDate } from '../../../features/common/format';
import { useUpcomingExams } from '../../../features/goals/api';
import { colorKeyFromHex, useSubjects } from '../../../features/subjects/api';
import { Notebook } from '../../../features/subjects/Notebook';
import { t } from '../../../i18n';
import { radius, space, subjectColor, useTheme } from '../../../theme';

/** S-MAT-01 Matérias — a shelf of notebooks: personal + Turma subjects (badge), archived collapsed. */
export default function SubjectsScreen() {
  const { data, isLoading, isError, refetch, isRefetching } = useSubjects();
  const { scheme, colors } = useTheme();
  const exams = useUpcomingExams();
  const [showArchived, setShowArchived] = useState(false);
  // The nearest test per subject, written on the notebook's label.
  const nextExam = useMemo(() => {
    const out = new Map<string, string>();
    for (const e of exams.data ?? []) if (e.subject_id && !out.has(e.subject_id)) out.set(e.subject_id, e.local_date);
    return out;
  }, [exams.data]);
  const active = (data ?? []).filter((s) => !s.settings?.archived_at).sort((a, b) => Number(!!b.settings?.pinned) - Number(!!a.settings?.pinned) || (a.settings?.sort_order ?? 0) - (b.settings?.sort_order ?? 0));
  const archived = (data ?? []).filter((s) => s.settings?.archived_at);

  return (
    <Screen
      title={t('subjects.title')}
      root
      largeTitle
      onRefresh={refetch}
      refreshing={isRefetching}
      actions={<IconButton icon="add" label={t('subjects.new')} onPress={() => router.push('/subjects/new')} />}
    >
      {isLoading ? <SkeletonList rows={4} height={72} /> : null}
      {isError ? <ErrorState onRetry={refetch} /> : null}
      {data && active.length === 0 ? (
        <EmptyState icon="book-outline" message={t('subjects.empty')} action={{ label: t('subjects.new'), icon: 'add', onPress: () => router.push('/subjects/new') }} />
      ) : null}
      {active.length ? (
        <View style={styles.shelf}>
          {active.map((s) => {
            const tint = subjectColor(colorKeyFromHex(s.color), scheme);
            const exam = nextExam.get(s.id);
            const soon = exam ? daysBetween(new Date(), parseDate(exam)) <= 2 : false;
            const examLine = exam ? countdown(exam, false) : null;
            return (
              <Notebook
                key={s.id}
                name={s.name}
                tint={tint}
                icon={s.icon}
                onPress={() => router.push(`/subjects/${s.id}`)}
                accessibilityLabel={examLine ? `${s.name}. ${examLine}` : s.name}
                corner={s.settings?.pinned ? <Ionicons name="pin" size={16} color={colors.textSecondary} /> : null}
                style={styles.book}
              >
                {examLine ? <Meta icon="calendar-outline" text={examLine} color={soon ? colors.warning : undefined} /> : null}
                {s.owner_class_group_id ? <Meta icon="people-outline" text={t('subjects.class_badge')} /> : null}
              </Notebook>
            );
          })}
          <Pressable
            onPress={() => router.push('/subjects/new')}
            accessibilityRole="button"
            accessibilityLabel={t('subjects.new')}
            style={({ pressed }) => [styles.book, styles.slot, { borderColor: colors.border, backgroundColor: pressed ? colors.surface2 : 'transparent' }]}
          >
            <Ionicons name="add" size={28} color={colors.primary} />
            <Text variant="label" tone="accent" align="center">
              {t('subjects.new')}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {archived.length ? (
        <Section title={t('subjects.archived')}>
          <Button variant="text" label={showArchived ? t('global.close') : `${t('global.see_all')} (${archived.length})`} onPress={() => setShowArchived((v) => !v)} />
          {showArchived
            ? archived.map((s) => (
                <Card key={s.id} tone="outline" onPress={() => router.push(`/subjects/${s.id}`)}>
                  <Row>
                    <SubjectBadge color={colorKeyFromHex(s.color)} icon={s.icon} size={32} />
                    <Text tone="secondary">{s.name}</Text>
                  </Row>
                </Card>
              ))
            : null}
        </Section>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  shelf: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: space.md },
  book: { width: '48.3%' },
  // An empty place on the shelf for the next notebook.
  slot: { minHeight: 148, borderWidth: 2, borderStyle: 'dashed', borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', gap: space.xs },
});
