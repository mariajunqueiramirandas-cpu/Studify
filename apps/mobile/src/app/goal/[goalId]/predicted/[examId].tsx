import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, EmptyState, Screen, Section, Text, useOnline, useOverlay } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { useExam } from '../../../../features/goals/api';
import { generatePredicted, saveExamOutcome, usePredictedQuiz, useTeacherProfiles } from '../../../../features/prova/api';
import { useOutline } from '../../../../features/subjects/outline';
import { t } from '../../../../i18n';

/** S-OBJ-12 Prova Provável (PRA-09) and "O que caiu?" (PRA-09.11). */
export default function Predicted() {
  const { examId, outcome } = useLocalSearchParams<{ goalId: string; examId: string; outcome?: string }>();
  const { userId } = useSession();
  const exam = useExam(examId);
  const subjectId = exam.data?.subject_id ?? undefined;
  const teachers = useTeacherProfiles(subjectId);
  const quiz = usePredictedQuiz(examId);
  const outline = useOutline(subjectId);
  const online = useOnline();
  const overlay = useOverlay();
  const [busy, setBusy] = useState(false);
  const [fell, setFell] = useState<Set<string>>(new Set());
  const teacher = teachers.data?.find((tp) => !exam.data?.teacher_name || tp.teacher_display === exam.data.teacher_name) ?? teachers.data?.[0];

  if (outcome) {
    return (
      <Screen
        title={t('pp.what_fell')}
        footer={
          <ActionBar>
            <Button
              label={t('global.save')}
              disabled={!fell.size}
              onPress={async () => {
                await saveExamOutcome(userId!, examId, [...fell]).catch(() => undefined);
                overlay.snack(t('pp.what_fell_saved'));
                router.back();
              }}
            />
            <Button variant="text" label={t('global.skip_for_now')} onPress={() => router.back()} />
          </ActionBar>
        }
      >
        <Text tone="secondary">{t('pp.what_fell_body')}</Text>
        <ChipGroup>
          {(outline.data?.topics ?? []).map((tp) => (
            <Chip key={tp.id} label={tp.title} selected={fell.has(tp.id)} onPress={() => setFell((s) => { const n = new Set(s); if (n.has(tp.id)) n.delete(tp.id); else n.add(tp.id); return n; })} />
          ))}
        </ChipGroup>
      </Screen>
    );
  }

  return (
    <Screen
      title={t('pp.title')}
      footer={
        <ActionBar>
          {quiz.data ? (
            <Button label={t('pp.take')} onPress={() => router.push({ pathname: '/quiz/[quizId]', params: { quizId: quiz.data!.id } })} />
          ) : (
            <Button
              label={t('pp.generate')}
              loading={busy}
              disabled={!online || !teacher}
              onPress={async () => {
                setBusy(true);
                try {
                  await generatePredicted(examId);
                  overlay.snack(t('pp.generating'));
                  void quiz.refetch();
                } catch {
                  overlay.snack(t('error.generation'));
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}
        </ActionBar>
      }
    >
      {!teacher && teachers.isFetched ? (
        <EmptyState icon="newspaper-outline" message={t('pp.need_tests')} action={subjectId ? { label: t('past_tests.upload'), onPress: () => router.push(`/subjects/${subjectId}/past-tests`) } : undefined} />
      ) : null}
      {teacher ? (
        <>
          <Banner kind="neutral" message={t('pp.disclaimer', { n: teacher.n_tests, teacher: teacher.teacher_display ?? 'professor(a)' })} />
          {teacher.profile.hot_topics?.length ? (
            <Section title={t('past_tests.hot_topics')}>
              {teacher.profile.hot_topics.slice(0, 8).map((h) => (
                <Card key={h.title}>
                  <Text>{`${h.title} · ${Math.round(h.weight * 100)}%`}</Text>
                </Card>
              ))}
            </Section>
          ) : null}
        </>
      ) : null}
      {busy || (quiz.isFetched && !quiz.data && teacher) ? <Text tone="secondary">{t('pp.generating')}</Text> : null}
    </Screen>
  );
}
