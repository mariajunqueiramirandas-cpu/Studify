import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Button, Card, EmptyState, ListItem, Screen, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { timeHM, weekdayDate } from '../../../features/common/format';
import { recomputePlan, saveExam, useGoalExams, useInvalidateGoal } from '../../../features/goals/api';
import { ExamSheet } from '../../../features/goals/ExamSheet';
import { useSubjects } from '../../../features/subjects/api';
import { t } from '../../../i18n';
import { messageFor } from '../../../api/messages';

/** S-OBJ-04 Quando são suas provas? (GOL-02). */
export default function Exams() {
  const { goalId } = useLocalSearchParams<{ goalId: string }>();
  const { userId } = useSession();
  const exams = useGoalExams(goalId);
  const subjects = useSubjects();
  const invalidate = useInvalidateGoal();
  const overlay = useOverlay();
  const [sheet, setSheet] = useState(false);
  return (
    <Screen
      title={t('goal.wizard.exams.title')}
      footer={
        <ActionBar>
          <Button icon="add" label={t('exam.add')} onPress={() => setSheet(true)} />
          <Button variant="text" icon="camera-outline" label={t('schedule_import.title')} onPress={() => router.push({ pathname: '/goal/[goalId]/import-schedule', params: { goalId } })} />
        </ActionBar>
      }
    >
      {exams.isFetched && !exams.data?.length ? <EmptyState icon="calendar-outline" message={t('goal.wizard.exams_hint')} /> : null}
      {(exams.data ?? []).map((e) => (
        <Card key={e.id}>
          <ListItem
            title={e.title}
            subtitle={`${weekdayDate(e.local_date)} · ${e.starts_at ? timeHM(e.starts_at) : t('exam.time_tbd')}${e.status === 'draft' ? ' · rascunho' : ''}`}
            onPress={() => router.push(`/goal/${goalId}/exam/${e.id}`)}
          />
        </Card>
      ))}
      <ExamSheet
        visible={sheet}
        onClose={() => setSheet(false)}
        subjects={(subjects.data ?? []).filter((s) => !s.settings?.archived_at)}
        onSave={async (input) => {
          try {
            await saveExam(userId!, goalId, input);
            void exams.refetch();
            void recomputePlan('exam_changed', goalId).catch(() => undefined);
            invalidate(goalId);
          } catch (e) {
            overlay.snack(messageFor(e));
          }
        }}
      />
    </Screen>
  );
}
