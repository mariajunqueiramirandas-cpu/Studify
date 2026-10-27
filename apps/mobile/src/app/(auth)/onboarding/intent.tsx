import { router, useLocalSearchParams } from 'expo-router';
import { ActionBar, Banner, Button, RadioList, Screen, Stepper, Text } from '../../../components';
import { useOnboarding, type Intent } from '../../../features/auth/onboarding';
import { t } from '../../../i18n';
import { saveIntent } from '../../../features/profile/api';

/** S-AUTH-07 — only sets which call to action Hoje shows; nothing is created (GOL-01). */
export default function IntentStep() {
  const { joined, pending } = useLocalSearchParams<{ joined?: string; pending?: string }>();
  const intent = useOnboarding((s) => s.intent);
  const set = useOnboarding((s) => s.set);
  return (
    <Screen
      title=""
      root
      footer={
        <ActionBar>
          <Button
            label={t('global.continue')}
            disabled={!intent}
            onPress={async () => {
              if (intent) await saveIntent(intent).catch(() => undefined);
              router.replace('/onboarding/first-subject');
            }}
          />
        </ActionBar>
      }
    >
      <Stepper step={5} total={5} />
      {joined ? <Banner kind={pending ? 'info' : 'success'} message={pending ? t('class.join_pending') : `${t('class.title')}: ${joined}`} /> : null}
      <Text variant="title">{t('onb.intent.title')}</Text>
      <RadioList<Intent>
        value={intent}
        onChange={(v) => set({ intent: v })}
        options={[
          { value: 'exam_week', label: t('onb.intent.exam_week'), hint: t('onb.intent.exam_week_hint') },
          // ENEM shows "Em breve" until Phase 4 (UF-01 step 8).
          { value: 'enem', label: `${t('onb.intent.enem')} · ${t('global.coming_soon')}`, hint: t('onb.intent.enem_hint') },
          { value: 'one_subject', label: t('onb.intent.one_subject'), hint: t('onb.intent.one_subject_hint') },
        ]}
      />
    </Screen>
  );
}
