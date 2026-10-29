import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { ActionBar, Banner, Button, DateField, RadioList, Screen, SegmentedControl, Stepper, Text, useOverlay } from '../../components';
import { useSession } from '../../features/auth/session';
import { parseDate, toLocalDate, weekdayDate } from '../../features/common/format';
import { useEditions } from '../../features/enem/api';
import { createGoal, recomputePlan, saveStudyPreferences, useInvalidateGoal } from '../../features/goals/api';
import { TimeEditor, type WeekMinutes } from '../../features/goals/TimeEditor';
import { data } from '../../api/data';
import { studyDateOf } from '../../lib/dates';
import { t } from '../../i18n';
import { space } from '../../theme';

type Step = 'edition' | 'language' | 'time';
const ORDER: Step[] = ['edition', 'language', 'time'];

/** ENM-01.1: ENEM goal — edition (or a provisional date), foreign language, availability; the plan follows. */
export default function NewEnemGoal() {
  const { userId } = useSession();
  const overlay = useOverlay();
  const editions = useEditions();
  const invalidate = useInvalidateGoal();
  // The study day is fixed for the life of the screen (rolls over at 04:00).
  const [today] = useState(() => studyDateOf(Date.now()));
  const thisYear = new Date().getFullYear();
  const [step, setStep] = useState<Step>('edition');
  const [year, setYear] = useState<number>(() => (new Date().getMonth() >= 10 ? thisYear + 1 : thisYear));
  const [provisional, setProvisional] = useState<Date | null>(null);
  const [language, setLanguage] = useState<'en' | 'es' | null>(null);
  const [week, setWeek] = useState<WeekMinutes>([60, 60, 60, 60, 60, 120, 60]);
  const [busy, setBusy] = useState(false);

  const edition = (editions.data ?? []).find((e) => e.year === year) ?? null;
  const day1 = edition?.day1_date ?? (provisional ? toLocalDate(provisional) : null);
  const day2 = edition?.day2_date ?? (day1 ? toLocalDate(new Date(parseDate(day1).getTime() + 7 * 86_400_000)) : null);
  const index = ORDER.indexOf(step);

  const create = async () => {
    if (!userId || !day1 || !language) return;
    setBusy(true);
    try {
      await data('enem-set-language', { language });
      const goalId = await createGoal(userId, {
        name: t('enem.wizard.name', { ano: year }),
        start_date: today,
        end_date: day2 ?? day1,
        mode: 'enem',
        settings: { enem_edition: year, language, ...(edition?.day1_date ? {} : { enem_date_override: day1 }) },
      });
      await saveStudyPreferences(userId, { minutes_by_weekday: week });
      await recomputePlan('goal_created', goalId).catch(() => undefined);
      invalidate(goalId);
      router.replace('/enem');
    } catch {
      overlay.snack(t('goal.wizard.offline_plan'));
    } finally {
      setBusy(false);
    }
  };

  const footer =
    step === 'edition' ? (
      <Button label={t('global.continue')} disabled={!day1 || day1 <= today} onPress={() => setStep('language')} />
    ) : step === 'language' ? (
      <Button label={t('global.continue')} disabled={!language} onPress={() => setStep('time')} />
    ) : (
      <Button label={t('enem.wizard.create')} loading={busy} onPress={() => void create()} />
    );

  return (
    <Screen title={t('enem.wizard.title')} onBack={() => (index > 0 ? setStep(ORDER[index - 1]!) : router.back())} footer={<ActionBar>{footer}</ActionBar>}>
      <Stepper step={index + 1} total={ORDER.length} />
      {step === 'edition' ? (
        <View style={{ gap: space.md }}>
          <Text variant="title">{t('enem.wizard.edition')}</Text>
          <Text tone="secondary">{t('enem.wizard.edition_hint')}</Text>
          <SegmentedControl
            options={[thisYear, thisYear + 1].map((y) => ({ value: String(y), label: `ENEM ${y}` }))}
            value={String(year)}
            onChange={(v) => setYear(Number(v))}
          />
          {edition?.day1_date ? (
            <Text>
              {t('enem.dates.day1', { date: weekdayDate(edition.day1_date) })}
              {edition.day2_date ? ` · ${t('enem.dates.day2', { date: weekdayDate(edition.day2_date) })}` : ''}
            </Text>
          ) : (
            <>
              <Banner kind="info" message={t('enem.wizard.provisional')} />
              <DateField label={t('enem.wizard.date')} value={provisional} onChange={setProvisional} minimumDate={new Date()} />
            </>
          )}
          {edition && edition.dates_status !== 'official' && edition.day1_date ? <Banner kind="neutral" message={t('enem.dates.provisional', { data: weekdayDate(edition.day1_date) })} /> : null}
        </View>
      ) : null}
      {step === 'language' ? (
        <View style={{ gap: space.md }}>
          <Text variant="title">{t('enem.language')}</Text>
          <RadioList
            value={language}
            onChange={setLanguage}
            options={[
              { value: 'en', label: t('enem.lang.en') },
              { value: 'es', label: t('enem.lang.es') },
            ]}
          />
        </View>
      ) : null}
      {step === 'time' ? (
        <View style={{ gap: space.md }}>
          <Text variant="title">{t('enem.wizard.time')}</Text>
          <TimeEditor value={week} onChange={setWeek} />
        </View>
      ) : null}
    </Screen>
  );
}
