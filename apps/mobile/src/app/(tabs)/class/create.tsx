import { router } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Banner, Button, Chip, ChipGroup, Screen, TextField, useOverlay } from '../../../components';
import { isMinor, useSession } from '../../../features/auth/session';
import { createClassGroup } from '../../../features/class/api';
import { options, t } from '../../../i18n';
import { messageFor } from '../../../api/messages';

/** S-TUR-02 Criar turma (SOC-01.1). Caller becomes the owner; first invite valid 7 days. */
export default function CreateClass() {
  const overlay = useOverlay();
  const { profile } = useSession();
  const [name, setName] = useState('');
  const [school, setSchool] = useState('');
  const [year, setYear] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const years = options('onb.school_years');
  const guardianPending = isMinor(profile) && (profile?.settings as { guardian_status?: string } | undefined)?.guardian_status === 'pending';
  return (
    <Screen
      title={t('class.create')}
      footer={
        <ActionBar>
          <Button
            label={t('class.create')}
            loading={busy}
            disabled={name.trim().length < 2}
            onPress={async () => {
              setBusy(true);
              try {
                const res = await createClassGroup(name.trim(), school.trim(), year ?? undefined);
                router.replace({ pathname: '/class/[classGroupId]/invite', params: { classGroupId: res.class_group_id } });
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
      {guardianPending ? <Banner kind="warning" message={t('class.guardian_required')} /> : null}
      <TextField label={t('class.name')} placeholder={t('class.name_placeholder')} value={name} onChangeText={setName} maxLength={60} />
      <TextField label={t('class.school')} value={school} onChangeText={setSchool} />
      <ChipGroup>
        {years.map((y) => (
          <Chip key={y} label={y} selected={year === y} onPress={() => setYear(y)} />
        ))}
      </ChipGroup>
    </Screen>
  );
}
