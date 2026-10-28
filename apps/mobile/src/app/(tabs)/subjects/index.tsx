import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Card, EmptyState, ErrorState, IconButton, Meta, Row, Screen, Section, SkeletonList, SubjectBadge, Tactile, Text, type IconName } from '../../../components';
import { colorKeyFromHex, useSubjects } from '../../../features/subjects/api';
import { t } from '../../../i18n';
import { depth, radius, space, subjectColor, useTheme } from '../../../theme';

/** S-MAT-01 Matérias — a shelf of notebooks: personal + Turma subjects (badge), archived collapsed. */
export default function SubjectsScreen() {
  const { data, isLoading, isError, refetch, isRefetching } = useSubjects();
  const { scheme, colors } = useTheme();
  const [showArchived, setShowArchived] = useState(false);
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
            return (
              <Tactile
                key={s.id}
                onPress={() => router.push(`/subjects/${s.id}`)}
                accessibilityLabel={s.name}
                color={`${tint}${scheme === 'dark' ? '2E' : '1F'}`}
                ledge={tint}
                depth={depth.md}
                style={[styles.cover, { borderLeftColor: tint }]}
              >
                <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Ionicons name={(s.icon ?? 'book-outline') as IconName} size={26} color={tint} />
                  {s.settings?.pinned ? <Ionicons name="pin" size={16} color={colors.textSecondary} /> : null}
                </Row>
                <View style={{ gap: space.xs }}>
                  <Text variant="heading" numberOfLines={3}>
                    {s.name}
                  </Text>
                  {s.owner_class_group_id ? <Meta icon="people-outline" text={t('subjects.class_badge')} /> : null}
                </View>
              </Tactile>
            );
          })}
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
  // A notebook: a stiff binding on the left, soft corners on the opening side.
  cover: {
    width: '48.3%',
    minHeight: 148,
    padding: space.md,
    paddingLeft: space.md + 2,
    borderLeftWidth: 7,
    borderTopLeftRadius: radius.xs,
    borderBottomLeftRadius: radius.xs,
    borderTopRightRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
    justifyContent: 'space-between',
  },
});
