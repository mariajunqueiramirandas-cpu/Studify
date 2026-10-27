import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Chip, ChipGroup, NumberStepper, RadioList, Screen, SegmentedControl, Text, useOnline, useOverlay } from '../../../../components';
import { createQuiz, type QuizKind, type QuizMode } from '../../../../features/practice/api';
import type { QuestionType } from '../../../../features/practice/types';
import { useSubjects } from '../../../../features/subjects/api';
import { useOutline } from '../../../../features/subjects/outline';
import { useUiStore } from '../../../../stores/ui';
import { t } from '../../../../i18n';
import { space } from '../../../../theme';

const TYPES: QuestionType[] = ['mcq_single', 'multi_select', 'true_false', 'fill_blank', 'matching', 'ordering', 'short_answer'];

/** S-PRA-03 Configurar quiz / simulado (PRA-01, PRA-03, PRA-04 retry). */
export default function QuizBuilder() {
  const params = useLocalSearchParams<{ subjectId?: string; kind?: QuizKind; examId?: string; nodeIds?: string }>();
  const subjects = useSubjects();
  const online = useOnline();
  const overlay = useOverlay();
  const extraTime = useUiStore((s) => s.extraTime);
  const [kind, setKind] = useState<QuizKind>(params.kind ?? 'practice');
  const [subjectId, setSubjectId] = useState<string | null>(params.subjectId ?? null);
  const [nodeIds, setNodeIds] = useState<string[]>(params.nodeIds ? params.nodeIds.split(',') : []);
  const [types, setTypes] = useState<QuestionType[]>([]);
  const [count, setCount] = useState(kind === 'mock_exam' ? 20 : 10);
  const [mode, setMode] = useState<QuizMode>(kind === 'mock_exam' ? 'exam_conditions' : 'practice');
  const [minutes, setMinutes] = useState(40);
  const [busy, setBusy] = useState(false);
  const outline = useOutline(subjectId ?? undefined);
  const isMock = kind === 'mock_exam';
  const isRetry = kind === 'mistake_retry';

  const start = async () => {
    setBusy(true);
    try {
      const limit = isMock && mode === 'exam_conditions' ? Math.round(minutes * 60 * (extraTime ? 1.5 : 1)) : undefined;
      const res = await createQuiz({
        kind,
        scope: { ...(subjectId ? { subject_id: subjectId } : {}), ...(nodeIds.length ? { node_ids: nodeIds } : {}), ...(params.examId ? { exam_id: params.examId } : {}) },
        ...(types.length ? { types } : {}),
        count,
        mode,
        ...(limit ? { time_limit_s: limit } : {}),
      });
      router.replace({ pathname: '/quiz/[quizId]', params: { quizId: res.quiz_id, attemptId: res.attempt_id } });
    } catch (e) {
      const code = (e as { code?: string }).code;
      overlay.snack(code === 'budget_exhausted' ? t('budget.user_daily') : t('error.generation'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={isMock ? t('quiz.builder.kind_mock') : isRetry ? t('mistakes.retry') : t('quiz.builder.title')}
      footer={
        <ActionBar>
          <Button label={isMock ? t('sim.start') : t('quiz.builder.start')} loading={busy} disabled={!online || (!subjectId && !isRetry && !params.examId)} disabledReason={t('offline.ai_disabled')} onPress={start} />
        </ActionBar>
      }
    >
      {!online ? <Banner kind="warning" message={t('offline.ai_disabled')} /> : null}
      {!params.kind ? (
        <SegmentedControl<QuizKind>
          value={kind}
          onChange={(k) => {
            setKind(k);
            setCount(k === 'mock_exam' ? 20 : 10);
            setMode(k === 'mock_exam' ? 'exam_conditions' : 'practice');
          }}
          options={[
            { value: 'practice', label: t('quiz.builder.kind_practice') },
            { value: 'mock_exam', label: t('quiz.builder.kind_mock') },
          ]}
        />
      ) : null}
      {!isRetry ? (
        <>
          <Text variant="label">{t('quiz.builder.subject')}</Text>
          <ChipGroup>
            {(subjects.data ?? []).filter((s) => !s.settings?.archived_at).map((s) => (
              <Chip key={s.id} label={s.name} selected={subjectId === s.id} onPress={() => (setSubjectId(s.id), setNodeIds([]))} />
            ))}
          </ChipGroup>
          {subjectId && outline.data ? (
            <View style={{ gap: space.sm }}>
              <Text variant="label">{t('quiz.builder.topics')}</Text>
              <ChipGroup>
                <Chip label={t('quiz.builder.whole_subject')} selected={nodeIds.length === 0} onPress={() => setNodeIds([])} />
                {outline.data.topics.filter((n) => !n.excluded).map((n) => (
                  <Chip key={n.id} label={n.title} selected={nodeIds.includes(n.id)} onPress={() => setNodeIds((ids) => (ids.includes(n.id) ? ids.filter((x) => x !== n.id) : [...ids, n.id]))} />
                ))}
              </ChipGroup>
            </View>
          ) : null}
        </>
      ) : null}
      <NumberStepper label={t('quiz.builder.count')} value={count} onChange={setCount} min={3} max={isMock ? 90 : 30} step={isMock ? 5 : 1} />
      {!isRetry ? (
        <View style={{ gap: space.sm }}>
          <Text variant="label">{t('quiz.builder.types')}</Text>
          <ChipGroup>
            <Chip label={t('quiz.builder.types_all')} selected={types.length === 0} onPress={() => setTypes([])} />
            {TYPES.map((ty) => (
              <Chip key={ty} label={t(`quiz.builder.type_names.${ty === 'fill_blank' ? 'fill_in' : ty}`)} selected={types.includes(ty)} onPress={() => setTypes((x) => (x.includes(ty) ? x.filter((y) => y !== ty) : [...x, ty]))} />
            ))}
          </ChipGroup>
        </View>
      ) : null}
      {isMock ? (
        <>
          <RadioList<QuizMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'exam_conditions', label: t('sim.mode.exam'), hint: t('sim.mode_exam_hint') },
              { value: 'relaxed', label: t('sim.mode.relaxed'), hint: t('sim.mode_relaxed_hint') },
            ]}
          />
          {mode === 'exam_conditions' ? <NumberStepper label={t('quiz.builder.timer')} value={minutes} onChange={setMinutes} min={10} max={300} step={5} format={(v) => `${v} min`} /> : null}
          {extraTime && mode === 'exam_conditions' ? <Text variant="bodySmall" tone="secondary">{t('sim.extra_time')}</Text> : null}
        </>
      ) : null}
    </Screen>
  );
}
