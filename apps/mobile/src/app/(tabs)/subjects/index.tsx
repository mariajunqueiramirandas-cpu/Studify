import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { Button, Card, EmptyState, ErrorState, IconButton, Pill, Row, Screen, Section, SkeletonList, SubjectBadge, Text } from '../../../components';
import { colorKeyFromHex, useSubjects } from '../../../features/subjects/api';
import { t } from '../../../i18n';
import { subjectColor, useTheme } from '../../../theme';

/** S-MAT-01 Matérias — personal + Turma subjects (badge), archived collapsed. */
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
      {active.map((s) => (
        <Card key={s.id} accent={subjectColor(colorKeyFromHex(s.color), scheme)} onPress={() => router.push(`/subjects/${s.id}`)} accessibilityLabel={s.name}>
          <Row gap={12}>
            <SubjectBadge color={colorKeyFromHex(s.color)} icon={s.icon} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text variant="heading" numberOfLines={2}>
                {s.name}
              </Text>
              {s.owner_class_group_id ? <Pill icon="people-outline" text={t('subjects.class_badge')} /> : null}
            </View>
            {s.settings?.pinned ? <Ionicons name="pin" size={18} color={colors.textSecondary} /> : null}
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </Row>
        </Card>
      ))}
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
