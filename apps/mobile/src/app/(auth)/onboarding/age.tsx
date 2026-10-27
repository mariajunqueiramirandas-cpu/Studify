import { router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { ActionBar, Banner, Button, Chip, Screen, Stepper, Text } from '../../../components';
import { useOnboarding } from '../../../features/auth/onboarding';
import { ageFrom, useSession } from '../../../features/auth/session';
import { options, t } from '../../../i18n';
import { space } from '../../../theme';

const MIN_AGE = 12; // D-03 default
const GUARDIAN_UNDER = 16; // SP-03
const GUARDIAN_STEP_ENABLED = true; // Phase 2 (D-04: mandatory before Turma features)

/** S-AUTH-04 Sua idade — month + year only. Under 12: blocked, nothing stored (SP-01). */
export default function AgeStep() {
  const { birthMonth, birthYear, set } = useOnboarding();
  const { signOut } = useSession();
  const [blocked, setBlocked] = useState(false);
  const now = new Date();
  const years = Array.from({ length: 70 }, (_, i) => now.getFullYear() - 8 - i);
  const months = options('months');

  const next = async () => {
    if (birthMonth == null || birthYear == null) return;
    const age = ageFrom(birthYear, birthMonth, now);
    if (age < MIN_AGE) {
      setBlocked(true);
      useOnboarding.getState().reset();
      return;
    }
    router.push(GUARDIAN_STEP_ENABLED && age < GUARDIAN_UNDER ? '/onboarding/guardian' : '/onboarding/profile');
  };

  if (blocked) {
    return (
      <Screen
        title=""
        footer={
          <ActionBar>
            <Button label={t('global.close')} onPress={() => void signOut()} />
          </ActionBar>
        }
      >
        <Text variant="title">{t('onb.age.under12')}</Text>
      </Screen>
    );
  }

  return (
    <Screen
      title=""
      footer={
        <ActionBar>
          <Button label={t('global.continue')} disabled={birthMonth == null || birthYear == null} onPress={next} />
        </ActionBar>
      }
    >
      <Stepper step={2} total={5} />
      <Text variant="title">{t('onb.age.title')}</Text>
      <Text variant="label">{t('onb.age.month')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {months.map((m, i) => (
          <Chip key={m} label={m.slice(0, 3)} accessibilityLabel={m} selected={birthMonth === i + 1} onPress={() => set({ birthMonth: i + 1 })} />
        ))}
      </View>
      <Text variant="label">{t('onb.age.year')}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
        {years.map((y) => (
          <Chip key={y} label={String(y)} selected={birthYear === y} onPress={() => set({ birthYear: y })} />
        ))}
      </ScrollView>
      <Banner kind="neutral" message={t('onb.age.why')} />
    </Screen>
  );
}
