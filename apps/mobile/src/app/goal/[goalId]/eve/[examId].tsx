import { sleepStopTime } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, ListItem, MarkdownView, ProgressBar, Screen, Skeleton, Text } from '../../../../components';
import { prepareVespera, useExam, useStudyPreferences } from '../../../../features/goals/api';
import { useNote } from '../../../../features/learn/api';
import { useMistakes } from '../../../../features/practice/api';
import { options, t } from '../../../../i18n';
import { space } from '../../../../theme';

const STEPS = 5;

/** S-OBJ-15 Modo Véspera (GOL-07): calm style, no XP/streak prompts, no new material. */
export default function Vespera() {
  const { goalId, examId } = useLocalSearchParams<{ goalId: string; examId: string }>();
  const exam = useExam(examId);
  const prefs = useStudyPreferences();
  const mistakes = useMistakes('open');
  const [step, setStep] = useState(0);
  const [sheet, setSheet] = useState<{ noteId: string | null; preparing: boolean }>({ noteId: null, preparing: true });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const note = useNote(sheet.noteId ?? undefined);
  const stepLabels = options('vespera.steps');
  const checklist = options('vespera.checklist_items');
  const subjectId = exam.data?.subject_id ?? undefined;

  useEffect(() => {
    void prepareVespera(examId)
      .then((r) => setSheet(r.status === 'ready' ? { noteId: r.sheet_note_id, preparing: false } : { noteId: null, preparing: true }))
      .catch(() => setSheet({ noteId: null, preparing: false }));
  }, [examId]);

  const stop = sleepStopTime(exam.data?.starts_at ? new Date(exam.data.starts_at).toTimeString().slice(0, 5) : null);
  const inScope = (mistakes.data ?? []).filter((m) => m.subject_id === subjectId);

  return (
    <Screen
      title={t('vespera.title')}
      calm
      footer={
        <ActionBar>
          {step < STEPS ? <Button label={step === 0 ? t('vespera.start') : t('global.next')} onPress={() => setStep((s) => s + 1)} /> : <Button label={t('vespera.finish')} onPress={() => router.replace('/today')} />}
        </ActionBar>
      }
    >
      <ProgressBar value={step / STEPS} label={t('vespera.step_of', { i: step, n: STEPS })} />
      {step === 0 ? (
        <>
          <Text variant="title">{exam.data?.title}</Text>
          <Text tone="secondary">{t('vespera.intro')}</Text>
          {stepLabels.map((s, i) => (
            <Text key={s}>{`${i + 1}. ${s}`}</Text>
          ))}
        </>
      ) : null}
      {step === 1 ? (
        <>
          <Text variant="heading">{stepLabels[0]}</Text>
          {sheet.preparing && !note.data ? <Skeleton height={240} /> : note.data ? <MarkdownView markdown={note.data.body} /> : <Banner kind="neutral" message={t('vespera.not_studied')} />}
        </>
      ) : null}
      {step === 2 || step === 3 ? (
        <Card>
          <Text variant="heading">{stepLabels[step - 1]}</Text>
          <Button variant="tonal" icon="flash-outline" label={t('review.start')} onPress={() => router.push({ pathname: '/review', params: { subjectId: subjectId ?? '', source: 'vespera' } })} />
        </Card>
      ) : null}
      {step === 4 ? (
        <>
          <Text variant="heading">{stepLabels[3]}</Text>
          {inScope.length === 0 ? <Text tone="secondary">{t('vespera.nothing')}</Text> : null}
          {inScope.slice(0, 10).map((m) => (
            <ListItem key={m.id} title={(m.question?.stem ?? '').replace(/[*_$`#]/g, '').slice(0, 120)} onPress={() => router.push(`/practice/mistakes/${m.id}`)} />
          ))}
        </>
      ) : null}
      {step === 5 ? (
        <>
          <Text variant="heading">{stepLabels[4]}</Text>
          <ChipGroup>
            {checklist.map((c) => (
              <Chip key={c} label={c} selected={checked.has(c)} onPress={() => setChecked((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; })} />
            ))}
          </ChipGroup>
          <View style={{ height: space.lg }} />
          <Banner kind="info" icon="moon-outline" message={t('vespera.sleep', { time: stop ?? '22:00' })} />
          <Text variant="heading" align="center">
            {t('exam.good_luck')}
          </Text>
        </>
      ) : null}
      {void prefs}
      {void goalId}
    </Screen>
  );
}
