import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { ActionBar, BottomSheet, Button, Card, CountdownChip, ListItem, PctRing, Row, Screen, Section, Text, TextField, useOverlay } from '../../../../components';
import { useSession } from '../../../../features/auth/session';
import { formatGrade, weekdayDate } from '../../../../features/common/format';
import { cancelExam, logExamGrade, saveExam, useExam, useInvalidateGoal, useReadiness, useScope } from '../../../../features/goals/api';
import { ExamSheet } from '../../../../features/goals/ExamSheet';
import { useSubjects } from '../../../../features/subjects/api';
import { useMastery, useOutline } from '../../../../features/subjects/outline';
import { masteryLabel } from '../../../../theme';
import { t } from '../../../../i18n';

/** S-OBJ-11 {Prova}: scope, mastery, readiness, predicted grade, actions (GOL-08.2, GOL-11). */
export default function ExamDetail() {
  const { goalId, examId } = useLocalSearchParams<{ goalId: string; examId: string }>();
  const { userId } = useSession();
  const exam = useExam(examId);
  const scope = useScope(examId);
  const subjects = useSubjects();
  const e = exam.data;
  const outline = useOutline(e?.subject_id ?? undefined);
  const mastery = useMastery(e?.subject_id ?? undefined);
  const readiness = useReadiness(examId ? [examId] : []);
  const overlay = useOverlay();
  const invalidate = useInvalidateGoal();
  const [edit, setEdit] = useState(false);
  const [gradeSheet, setGradeSheet] = useState(false);
  const [grade, setGrade] = useState('');
  const subjectName = subjects.data?.find((s) => s.id === e?.subject_id)?.name;
  const r = readiness.data?.get(examId);
  const isPast = e ? new Date(`${e.local_date}T23:59:59`) < new Date() : false;

  const scopeTopics = useMemo(() => {
    const ids = (scope.data?.nodes ?? []).filter((n) => n.confirmed || n.source === 'default_all').map((n) => n.node_id);
    const topics = outline.data?.topics ?? [];
    return ids.length ? topics.filter((tp) => ids.includes(tp.id)) : topics.filter((tp) => !tp.excluded);
  }, [scope.data, outline.data]);

  if (!e) return <Screen title="" />;
  return (
    <Screen
      title={subjectName ?? e.title}
      context={<CountdownChip startsAt={e.starts_at ?? e.local_date} hasTime={!!e.starts_at} />}
      actions={<Button compact variant="text" label={t('global.edit')} onPress={() => setEdit(true)} />}
      footer={
        <ActionBar>
          {isPast ? (
            <Button label={t('exam.log_grade')} onPress={() => setGradeSheet(true)} />
          ) : (
            <Button label={t('exam.practice_exam')} onPress={() => router.push({ pathname: '/practice/quiz/new', params: { kind: 'mock_exam', subjectId: e.subject_id ?? '', examId } })} />
          )}
        </ActionBar>
      }
    >
      <Text tone="secondary">{weekdayDate(e.local_date)}</Text>
      <Card>
        <Row>
          <PctRing value={r?.readiness ?? null} size={64} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text variant="label">{t('readiness.if_today')}</Text>
            {r?.pred_low != null && r.pred_high != null ? <Text>{t('predict.range', { low: formatGrade(r.pred_low), high: formatGrade(r.pred_high) })}</Text> : <Text tone="secondary">{t('predict.not_enough')}</Text>}
            <Text variant="bodySmall" tone="secondary">
              {t('predict.label')}
            </Text>
          </View>
        </Row>
      </Card>
      {e.grade != null ? <Text variant="heading">{`${t('exam.grade_label')}: ${formatGrade(e.grade, e.grade_max ?? 10)}`}</Text> : null}
      <Section title={t('exam.scope')} action={<Button compact variant="text" label={t('exam.scope_edit')} onPress={() => router.push({ pathname: '/goal/[goalId]/scope/[examId]', params: { goalId, examId } })} />}>
        {e.scope_status !== 'confirmed' ? <Text tone="secondary">{t('scope.default_all')}</Text> : null}
        {scopeTopics.slice(0, 30).map((tp) => {
          const m = mastery.data?.get(tp.id)?.mastery;
          return <ListItem key={tp.id} title={tp.title} subtitle={masteryLabel(m)} onPress={e.subject_id ? () => router.push(`/subjects/${e.subject_id}/topic/${tp.id}`) : undefined} />;
        })}
      </Section>
      <Section title={t('exam.actions')}>
        <Card>
          <ListItem icon="moon-outline" title={t('exam.vespera')} onPress={() => router.push(`/goal/${goalId}/eve/${examId}`)} />
          <ListItem icon="sparkles-outline" title={t('exam.predicted')} onPress={() => router.push(`/goal/${goalId}/predicted/${examId}`)} />
          {e.subject_id ? <ListItem icon="headset-outline" title={t('podcast.exam_review')} onPress={() => router.push({ pathname: '/podcast/new', params: { subjectId: e.subject_id!, examId, style: 'exam_review' } })} /> : null}
          {isPast ? <ListItem icon="checkbox-outline" title={t('pp.what_fell')} onPress={() => router.push({ pathname: '/goal/[goalId]/predicted/[examId]', params: { goalId, examId, outcome: '1' } })} /> : null}
          <ListItem
            icon="refresh-outline"
            title={t('exam.create_recovery')}
            onPress={async () => {
              await saveExam(userId!, goalId, { subject_id: e.subject_id, title: `Recuperação de ${subjectName ?? ''}`, local_date: e.local_date, starts_at: null, kind: 'recuperacao', weight: e.weight, parent_exam_id: e.id });
              invalidate(goalId);
              overlay.snack(t('global.done'));
            }}
          />
          <ListItem
            icon="close-circle-outline"
            destructive
            title={t('exam.cancel')}
            onPress={async () => {
              if (await overlay.confirm({ title: t('exam.cancel_confirm'), destructive: true })) {
                await cancelExam(examId);
                invalidate(goalId);
                router.back();
              }
            }}
          />
        </Card>
      </Section>
      <ExamSheet
        visible={edit}
        onClose={() => setEdit(false)}
        initial={e}
        subjects={(subjects.data ?? []).filter((s) => !s.settings?.archived_at)}
        onSave={async (input) => {
          await saveExam(userId!, goalId, input, examId);
          void exam.refetch();
          invalidate(goalId);
        }}
      />
      <BottomSheet
        visible={gradeSheet}
        onClose={() => setGradeSheet(false)}
        title={t('grade.ask', { subject: subjectName ?? '' })}
        footer={
          <Button
            label={t('global.save')}
            disabled={!grade.trim() || Number.isNaN(Number(grade.replace(',', '.')))}
            onPress={async () => {
              try {
                await logExamGrade(examId, Number(grade.replace(',', '.')), e.grade_max ?? 10);
                setGradeSheet(false);
                router.push(`/goal/${goalId}/grades`);
              } catch {
                overlay.snack(t('error.generic'));
              }
            }}
          />
        }
      >
        <TextField label={`${t('exam.grade_label')} (${t('exam.grade_of', { max: e.grade_max ?? 10 })})`} value={grade} onChangeText={setGrade} keyboardType="decimal-pad" autoFocus />
        <Button variant="text" label={t('grade.not_yet')} onPress={() => setGradeSheet(false)} />
      </BottomSheet>
    </Screen>
  );
}
