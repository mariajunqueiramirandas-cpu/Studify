import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, BottomSheet, Button, Card, EmptyState, ListItem, Screen, Section, Text } from '../../../../components';
import { shortDate } from '../../../../features/common/format';
import { useTeacherProfiles, type TeacherProfile } from '../../../../features/prova/api';
import { useDocuments } from '../../../../features/subjects/api';
import { options, t } from '../../../../i18n';

const CONF: Record<TeacherProfile['confidence'], number> = { low: 0, mid: 1, high: 2 };

/** S-MAT-18 Provas antigas + S-MAT-19 Perfil do professor (PRA-09.1–09.4). */
export default function PastTests() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const docs = useDocuments(subjectId);
  const teachers = useTeacherProfiles(subjectId);
  const [profile, setProfile] = useState<TeacherProfile | null>(null);
  const tests = (docs.data ?? []).filter((d) => d.kind === 'past_test');
  const levels = options('past_tests.confidence_levels');

  return (
    <Screen
      title={t('past_tests.title')}
      footer={
        <ActionBar>
          <Button icon="add" label={t('past_tests.upload')} onPress={() => router.push(`/subjects/${subjectId}/upload`)} />
        </ActionBar>
      }
    >
      {docs.isFetched && !tests.length ? <EmptyState icon="newspaper-outline" message={t('past_tests.empty')} /> : null}
      {(teachers.data ?? []).length ? (
        <Section title={t('past_tests.teacher_profile')}>
          {teachers.data!.map((tp) => (
            <Card key={tp.id}>
              <ListItem title={tp.teacher_display ?? t('past_tests.teacher')} subtitle={`${tp.n_tests} provas · ${t('past_tests.confidence', { level: levels[CONF[tp.confidence]] ?? '' })}`} onPress={() => setProfile(tp)} />
            </Card>
          ))}
        </Section>
      ) : null}
      {tests.length ? (
        <Section title={t('past_tests.title')}>
          {tests.map((d) => (
            <Card key={d.id}>
              <ListItem title={d.title} subtitle={[d.teacher_name, shortDate(d.created_at)].filter(Boolean).join(' · ')} onPress={() => router.push({ pathname: '/subjects/[subjectId]/document/[documentId]', params: { subjectId, documentId: d.id, page: '1' } })} />
            </Card>
          ))}
        </Section>
      ) : null}
      <BottomSheet visible={!!profile} onClose={() => setProfile(null)} title={profile?.teacher_display ?? t('past_tests.teacher_profile')}>
        {profile?.profile.structure ? (
          <Card>
            <Text variant="label">{t('past_tests.structure')}</Text>
            {profile.profile.structure.n_questions ? <Text>{`${profile.profile.structure.n_questions} questões`}</Text> : null}
            {profile.profile.structure.type_mix
              ? Object.entries(profile.profile.structure.type_mix).map(([k, v]) => <Text key={k} variant="bodySmall">{`${t(`quiz.builder.type_names.${k === 'fill_blank' ? 'fill_in' : k}`, { defaultValue: k })}: ${Math.round(v * 100)}%`}</Text>)
              : null}
          </Card>
        ) : null}
        {profile?.profile.hot_topics?.length ? (
          <Card>
            <Text variant="label">{t('past_tests.hot_topics')}</Text>
            {profile.profile.hot_topics.slice(0, 10).map((h) => (
              <Text key={h.title} variant="bodySmall">{`🔥 ${h.title}`}</Text>
            ))}
          </Card>
        ) : null}
        {profile?.profile.patterns?.length ? (
          <Card>
            <Text variant="label">{t('past_tests.patterns')}</Text>
            {profile.profile.patterns.map((p) => (
              <Text key={p} variant="bodySmall">{`• ${p}`}</Text>
            ))}
          </Card>
        ) : null}
      </BottomSheet>
    </Screen>
  );
}
