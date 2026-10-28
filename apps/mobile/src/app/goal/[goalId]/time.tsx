import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActionBar, Button, DateField, ListItem, NumberStepper, Screen, Section, useOverlay } from '../../../components';
import { useSession } from '../../../features/auth/session';
import { toLocalDate, weekdayDate } from '../../../features/common/format';
import { recomputePlan, saveAvailabilityException, saveStudyPreferences, useAvailabilityExceptions, useInvalidateGoal, useStudyPreferences } from '../../../features/goals/api';
import { TimeEditor, type WeekMinutes } from '../../../features/goals/TimeEditor';
import { t } from '../../../i18n';
import { messageFor } from '../../../api/messages';

/** S-OBJ-08 Seu tempo: minutes per weekday + exceptions (GOL-04.3). */
export default function TimeScreen() {
  const { goalId } = useLocalSearchParams<{ goalId: string }>();
  const { userId } = useSession();
  const prefs = useStudyPreferences();
  const exceptions = useAvailabilityExceptions();
  const invalidate = useInvalidateGoal();
  const overlay = useOverlay();
  const [week, setWeek] = useState<WeekMinutes>([60, 60, 60, 60, 60, 90, 30]);
  const [day, setDay] = useState<Date | null>(null);
  const [mins, setMins] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (prefs.data?.minutes_by_weekday?.length === 7) setWeek(prefs.data.minutes_by_weekday);
  }, [prefs.data]);

  return (
    <Screen
      title={t('time.title')}
      footer={
        <ActionBar>
          <Button
            label={t('global.save')}
            loading={busy}
            onPress={async () => {
              setBusy(true);
              try {
                await saveStudyPreferences(userId!, { minutes_by_weekday: week });
                await recomputePlan('availability_changed', goalId).catch(() => undefined);
                invalidate(goalId);
                router.back();
              } catch (e) {
                overlay.snack(messageFor(e));
              } finally {
                setBusy(false);
              }
            }}
          />
        </ActionBar>
      }
    >
      <TimeEditor value={week} onChange={setWeek} />
      <Section title={t('time.exceptions')}>
        {(exceptions.data ?? []).filter((e) => e.local_date >= toLocalDate(new Date())).map((e) => (
          <ListItem key={e.local_date} title={weekdayDate(e.local_date)} subtitle={e.minutes === 0 ? t('time.exception_none') : `${e.minutes} min`} />
        ))}
        <DateField label={t('time.add_exception')} value={day} onChange={setDay} minimumDate={new Date()} placeholder={t('time.exception_hint')} />
        {day ? (
          <>
            <NumberStepper label={weekdayDate(day)} value={mins} onChange={setMins} min={0} max={240} step={15} format={(v) => (v === 0 ? t('time.exception_none') : `${v} min`)} />
            <Button
              variant="tonal"
              label={t('time.add_exception')}
              onPress={async () => {
                await saveAvailabilityException(userId!, toLocalDate(day), mins).catch((e: unknown) => overlay.snack(messageFor(e)));
                setDay(null);
                void exceptions.refetch();
              }}
            />
          </>
        ) : null}
      </Section>
    </Screen>
  );
}
