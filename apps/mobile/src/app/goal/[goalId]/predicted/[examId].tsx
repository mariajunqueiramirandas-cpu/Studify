import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, EmptyState, GenerationStatus, Screen, Section, Text, useOnline, useOverlay } from '../../../../components';
import { messageFor } from '../../../../api/messages';
import { jobView, useLatestJob } from '../../../../features/progress/jobs';
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
  // The generation runs on the server (ADR 0011): the screen follows its job, also when reopened midway.
  const job = jobView(useLatestJob(subjectId, 'pp.generate'));
  const quiz = usePredictedQuiz(examId, !!job?.active);
  const outline = useOutline(subjectId);
  const online = useOnline();
  const overlay = useOverlay();
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [fell, setFell] = useState<Set<string>>(new Set());
  // The quiz is read once more when its job ends, so "Fazer a prova" appears the moment it is ready.
  const jobDone = job ? !job.active : false;
  useEffect(() => {
    if (jobDone) void quiz.refetch();
  }, [jobDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    setBusy(true);
    setRequestError(null);
    try {
      await generatePredicted(examId);
    } catch (e) {
      setRequestError(messageFor(e, t('error.generation')));
    } finally {
      setBusy(false);
    }
  };
  const generating = busy || !!job?.active;
  const failure = requestError ?? (!quiz.data && job?.failed ? job.error : !quiz.data && job?.succeeded && quiz.isFetched ? t('pp.not_generated') : null);
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
          ) : generating ? null : (
            <Button label={t('pp.generate')} disabled={!online || !teacher} onPress={() => void generate()} />
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
      {!quiz.data && generating ? (
        <GenerationStatus title={t('pp.generating')} detail={job?.detail} fraction={job?.fraction} startedAt={job?.startedAt} queued={job?.queued} slowAfterS={150} canLeave />
      ) : null}
      {!quiz.data && !generating && failure ? <GenerationStatus title={t('pp.title')} error={failure} onRetry={online && teacher ? () => void generate() : undefined} /> : null}
    </Screen>
  );
}
