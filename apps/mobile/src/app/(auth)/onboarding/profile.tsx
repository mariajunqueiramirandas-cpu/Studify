import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking } from 'react-native';
import { ApiError, callFunction } from '../../../api/functions';
import { ActionBar, Banner, Button, Chip, ChipGroup, Screen, Stepper, SwitchRow, Text, TextField } from '../../../components';
import { useOnboarding } from '../../../features/auth/onboarding';
import { PRIVACY_NOTICE_VERSION, SCHOOL_YEARS, useSession } from '../../../features/auth/session';
import { sitePage } from '../../../features/common/links';
import { options, t } from '../../../i18n';

interface SignupCompleteRes {
  profile_id: string;
  guardian_required: boolean;
  class_group?: { id: string; name: string; status: 'active' | 'pending' };
}

/** S-AUTH-06 Seu perfil → `signup-complete` (PLT-02.2–7). */
export default function ProfileStep() {
  const draft = useOnboarding();
  const { userId } = useSession();
  const qc = useQueryClient();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const yearLabels = options('onb.school_years');

  const submit = async () => {
    if (!draft.birthMonth || !draft.birthYear || !draft.schoolYear) return;
    setBusy(true);
    setError(null);
    try {
      const res = await callFunction<Record<string, unknown>, SignupCompleteRes>('signup-complete', {
        invite_code: draft.inviteCode,
        birth_month: draft.birthMonth,
        birth_year: draft.birthYear,
        display_name: draft.displayName.trim(),
        school_year: draft.schoolYear,
        privacy_notice_version: PRIVACY_NOTICE_VERSION,
      });
      if (draft.guardianEmail.trim()) {
        await callFunction('guardian-link', { guardian_email: draft.guardianEmail.trim() }).catch(() => undefined);
      }
      await qc.invalidateQueries({ queryKey: ['profile', userId] });
      router.replace(res.class_group ? { pathname: '/onboarding/intent', params: { joined: res.class_group.name, pending: res.class_group.status === 'pending' ? '1' : '' } } : '/onboarding/intent');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      if (code === 'display_name_rejected') setError(t('onb.profile.name_rejected'));
      else if (code.startsWith('invite_')) {
        setError(t('onb.invite.invalid'));
      } else if (code === 'under_age') setError(t('onb.age.under12'));
      else setError(t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const nameOk = draft.displayName.trim().length >= 2 && draft.displayName.trim().length <= 30;
  return (
    <Screen
      title=""
      footer={
        <ActionBar>
          <Button label={t('global.continue')} disabled={!nameOk || !draft.schoolYear || !accepted} loading={busy} onPress={submit} />
        </ActionBar>
      }
    >
      <Stepper step={4} total={5} />
      <Text variant="title">{t('onb.profile.title')}</Text>
      {error ? <Banner kind="danger" message={error} action={error === t('onb.invite.invalid') ? { label: t('global.back'), onPress: () => router.navigate('/onboarding/invite') } : undefined} /> : null}
      <TextField label={t('onb.profile.name')} placeholder={t('onb.profile.name_placeholder')} value={draft.displayName} onChangeText={(v) => draft.set({ displayName: v })} maxLength={30} autoCapitalize="words" />
      <Text variant="label">{t('onb.profile.school_year')}</Text>
      <ChipGroup>
        {SCHOOL_YEARS.map((y, i) => (
          <Chip key={y} label={yearLabels[i] ?? y} selected={draft.schoolYear === y} onPress={() => draft.set({ schoolYear: y })} />
        ))}
      </ChipGroup>
      <Button variant="text" icon="document-text-outline" label={t('onb.profile.privacy_open')} onPress={() => void Linking.openURL(sitePage('privacidade'))} />
      <SwitchRow label={t('onb.profile.privacy')} value={accepted} onChange={setAccepted} />
    </Screen>
  );
}
