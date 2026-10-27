import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, Card, Chip, ChipGroup, DateField, ListItem, RadioList, Screen, Stepper, Text, TextField, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { addDays, daysBetween, parseDate, toLocalDate, weekdayDate } from '../../features/common/format';
import { createGoal, recomputePlan, saveExam, saveStudyPreferences, useGoalExams, useInvalidateGoal } from '../../features/goals/api';
import { ExamSheet } from '../../features/goals/ExamSheet';
import { TimeEditor, type WeekMinutes } from '../../features/goals/TimeEditor';
import { useCreateSubject, useSubjects } from '../../features/subjects/api';
import { t } from '../../i18n';
import { space } from '../../theme';

type Step = 'mode' | 'name' | 'subjects' | 'exams' | 'scope' | 'time' | 'grades';
const ORDER: Step[] = ['name', 'subjects', 'exams', 'scope', 'time', 'grades'];

function bimestreDefault(now = new Date()) {
  return t('goal.wizard.name_default', { n: Math.min(4, Math.floor(now.getMonth() / 3) + 1) });
}

/** S-OBJ-01…08 + S-OBJ-14 entry: the Semana de Provas wizard (GOL-01.2). The plan exists after 1 test. */
export default function NewGoal() {
  const { userId } = useSession();
  const overlay = useOverlay();
  const subjects = useSubjects();
  const createSubject = useCreateSubject();
  const invalidate = useInvalidateGoal();
  const [step, setStep] = useState<Step>('mode');
  const [mode, setMode] = useState<'exam_week' | 'enem' | null>(null);
  const [name, setName] = useState(bimestreDefault());
  const [start, setStart] = useState<Date | null>(new Date());
  const [end, setEnd] = useState<Date | null>(addDays(new Date(), 14));
  const [goalId, setGoalId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [newSubject, setNewSubject] = useState('');
  const [examSheet, setExamSheet] = useState(false);
  const [week, setWeek] = useState<WeekMinutes>([60, 60, 60, 60, 60, 90, 30]);
  const [busy, setBusy] = useState(false);
  const exams = useGoalExams(goalId ?? undefined);

  const index = ORDER.indexOf(step);
  const next = () => setStep(ORDER[index + 1] ?? 'grades');

  const finish = async (configureGrades: boolean) => {
    setBusy(true);
    try {
      await saveStudyPreferences(userId!, { minutes_by_weekday: week });
      await recomputePlan('goal_created', goalId!).catch(() => undefined);
      invalidate(goalId!);
      const soon = (exams.data ?? []).some((e) => {
        const d = daysBetween(new Date(), parseDate(e.local_date));
        return d >= 0 && d <= 6;
      });
      router.replace(configureGrades ? { pathname: '/goal/[goalId]/rules', params: { goalId: goalId!, then: 'plan' } } : soon ? { pathname: '/goal/[goalId]/desperate', params: { goalId: goalId!, offer: '1' } } : { pathname: '/goal/[goalId]/plan', params: { goalId: goalId!, ready: '1' } });
    } catch {
      overlay.snack(t('goal.wizard.offline_plan'));
    } finally {
      setBusy(false);
    }
  };

  const footer = (() => {
    switch (step) {
      case 'mode':
        return <Button label={t('global.continue')} disabled={mode !== 'exam_week'} onPress={() => setStep('name')} />;
      case 'name':
        return (
          <Button
            label={t('global.continue')}
            loading={busy}
            disabled={!name.trim() || !start || !end || end < start}
            onPress={async () => {
              setBusy(true);
              try {
                const id = goalId ?? (await createGoal(userId!, { name, start_date: toLocalDate(start!), end_date: toLocalDate(end!), term_index: Math.min(4, Math.floor(start!.getMonth() / 3) + 1) }));
                setGoalId(id);
                next();
              } catch {
                overlay.snack(t('error.generic'));
              } finally {
                setBusy(false);
              }
            }}
          />
        );
      case 'subjects':
        return <Button label={t('global.continue')} disabled={!picked.length} onPress={next} />;
      case 'exams':
        return <Button label={t('global.continue')} disabled={!(exams.data ?? []).length} onPress={next} />;
      case 'scope':
        return (
          <>
            <Button label={t('global.continue')} onPress={next} />
          </>
        );
      case 'time':
        return <Button label={t('global.continue')} onPress={next} />;
      case 'grades':
        return (
          <>
            <Button label={t('goal.wizard.grades_yes')} loading={busy} onPress={() => finish(true)} />
            <Button variant="text" label={t('goal.wizard.build_plan')} loading={busy} onPress={() => finish(false)} />
          </>
        );
    }
  })();

  const pickedSubjects = (subjects.data ?? []).filter((s) => picked.includes(s.id));

  return (
    <Screen
      title={step === 'mode' ? t('goal.new.title') : t('onb.intent.exam_week')}
      onBack={() => (index > 0 ? setStep(ORDER[index - 1]!) : step === 'name' ? setStep('mode') : router.back())}
      footer={<ActionBar>{footer}</ActionBar>}
    >
      {step !== 'mode' ? <Stepper step={index + 1} total={ORDER.length} /> : null}
      {step === 'mode' ? (
        <>
          <RadioList
            value={mode}
            onChange={setMode}
            options={[
              { value: 'exam_week', label: t('onb.intent.exam_week'), hint: t('onb.intent.exam_week_hint') },
              { value: 'enem', label: `${t('onb.intent.enem')} · ${t('global.coming_soon')}`, hint: t('goal.enem_soon') },
            ]}
          />
        </>
      ) : null}
      {step === 'name' ? (
        <>
          <Text variant="title">{t('goal.wizard.name_title')}</Text>
          <TextField label={t('goal.wizard.name_label')} value={name} onChangeText={setName} maxLength={80} />
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <DateField label={t('goal.wizard.start')} value={start} onChange={setStart} />
            <DateField label={t('goal.wizard.end')} value={end} onChange={setEnd} minimumDate={start ?? undefined} />
          </View>
        </>
      ) : null}
      {step === 'subjects' ? (
        <>
          <Text variant="title">{t('goal.wizard.subjects_title')}</Text>
          <Text tone="secondary">{t('goal.wizard.subjects_hint')}</Text>
          <ChipGroup>
            {(subjects.data ?? []).filter((s) => !s.settings?.archived_at).map((s) => (
              <Chip key={s.id} label={s.name} selected={picked.includes(s.id)} onPress={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))} />
            ))}
          </ChipGroup>
          <View style={{ flexDirection: 'row', gap: space.sm, alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}>
              <TextField label={t('subjects.new')} value={newSubject} onChangeText={setNewSubject} placeholder="Ex.: Química" />
            </View>
            <Button
              compact
              variant="tonal"
              label="+"
              accessibilityLabel={t('subjects.new')}
              disabled={!newSubject.trim()}
              onPress={async () => {
                const id = await createSubject.mutateAsync({ name: newSubject, color: 'teal', icon: 'book-outline' });
                setPicked((p) => [...p, id]);
                setNewSubject('');
              }}
            />
          </View>
        </>
      ) : null}
      {step === 'exams' ? (
        <>
          <Text variant="title">{t('goal.wizard.exams.title')}</Text>
          <Text tone="secondary">{t('goal.wizard.exams_hint')}</Text>
          {(exams.data ?? []).map((e) => (
            <Card key={e.id}>
              <ListItem title={e.title} subtitle={`${weekdayDate(e.local_date)}${e.starts_at ? ` · ${new Date(e.starts_at).toTimeString().slice(0, 5)}` : ` · ${t('exam.time_tbd')}`}`} />
            </Card>
          ))}
          <Button variant="secondary" icon="add" label={t('exam.add')} onPress={() => setExamSheet(true)} />
          <Button variant="text" icon="camera-outline" label={t('schedule_import.title')} onPress={() => router.push({ pathname: '/goal/[goalId]/import-schedule', params: { goalId: goalId! } })} />
          <ExamSheet
            visible={examSheet}
            onClose={() => setExamSheet(false)}
            subjects={pickedSubjects}
            onSave={async (input) => {
              await saveExam(userId!, goalId!, input);
              void exams.refetch();
            }}
          />
        </>
      ) : null}
      {step === 'scope' ? (
        <>
          <Text variant="title">{t('scope.title')}</Text>
          <Text tone="secondary">{t('scope.hint')}</Text>
          {(exams.data ?? []).map((e) => (
            <Card key={e.id}>
              <ListItem
                title={e.title}
                subtitle={e.scope_status === 'confirmed' ? t('scope.saved') : e.scope_status === 'pending_review' ? t('scope.review_title') : t('scope.default_all')}
                onPress={() => router.push({ pathname: '/goal/[goalId]/scope/[examId]', params: { goalId: goalId!, examId: e.id } })}
              />
            </Card>
          ))}
          <Banner kind="neutral" message={t('scope.default_all')} />
          <Button variant="text" label={t('global.skip_for_now')} onPress={next} />
        </>
      ) : null}
      {step === 'time' ? (
        <>
          <Text variant="title">{t('time.title')}</Text>
          <TimeEditor value={week} onChange={setWeek} />
        </>
      ) : null}
      {step === 'grades' ? (
        <>
          <Text variant="title">{t('goal.wizard.grades_title')}</Text>
          <Text tone="secondary">{t('goal.wizard.grades_body')}</Text>
        </>
      ) : null}
    </Screen>
  );
}
