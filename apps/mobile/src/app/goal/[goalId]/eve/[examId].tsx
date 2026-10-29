import { sleepStopTime } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, GenerationStatus, ListItem, MarkdownView, ProgressBar, Screen, Text } from '../../../../components';
import { prepareVespera, useExam, useStudyPreferences, useVesperaSheet, type VesperaSheet } from '../../../../features/goals/api';
import { useElapsed } from '../../../../features/progress/time';
import { messageFor } from '../../../../api/messages';
import { useMistakes } from '../../../../features/practice/api';
import { options, t } from '../../../../i18n';
import { space } from '../../../../theme';

const STEPS = 5;
/** How long the sheet is waited for: it is usually written ahead (D−1 04:00) or within a minute of the request. */
const SHEET_WAIT_S = 150;

/** The sheet as one page of Markdown: a section per topic, its formula, and what to watch out for. */
function sheetMarkdown(sheet: VesperaSheet): string {
  const sections = sheet.sections.map((s) => [`## ${s.heading}`, ...s.bullets.map((b) => `- ${b.text}`), s.formula ? `\n$$${s.formula}$$` : ''].filter(Boolean).join('\n'));
  const watch = sheet.watch_out.length ? [`## ${t('vespera.watch_out')}`, ...sheet.watch_out.map((w) => `- ${w.text}`)].join('\n') : '';
  return [`# ${sheet.title}`, ...sections, watch].filter(Boolean).join('\n\n');
}

/** S-OBJ-15 Modo Véspera (GOL-07): calm style, no XP/streak prompts, no new material. */
export default function Vespera() {
  const { goalId, examId } = useLocalSearchParams<{ goalId: string; examId: string }>();
  const exam = useExam(examId);
  const prefs = useStudyPreferences();
  const mistakes = useMistakes('open');
  const [step, setStep] = useState(0);
  const [requestError, setRequestError] = useState<unknown>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const waited = useElapsed();
  const waiting = !requestError && waited < SHEET_WAIT_S;
  const sheet = useVesperaSheet(examId, waiting);
  const stepLabels = options('vespera.steps');
  const checklist = options('vespera.checklist_items');
  const subjectId = exam.data?.subject_id ?? undefined;

  // The sheet is written in the background (usually it already is); the screen follows it until it exists.
  useEffect(() => {
    void prepareVespera(examId).catch((e: unknown) => setRequestError(e));
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
          {sheet.data ? (
            <MarkdownView markdown={sheetMarkdown(sheet.data)} />
          ) : requestError ? (
            <Banner kind="neutral" message={messageFor(requestError, t('vespera.not_studied'))} />
          ) : waiting ? (
            <GenerationStatus title={t('vespera.preparing')} detail={t('vespera.preparing_detail')} slowAfterS={45} />
          ) : (
            <Banner kind="neutral" message={t('vespera.not_studied')} />
          )}
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
