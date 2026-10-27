import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Button, Screen, useOverlay } from '../../../components';
import { useCreateSubject, useSubjects } from '../../../features/subjects/api';
import { SubjectForm, type SubjectDraft } from '../../../features/subjects/SubjectForm';
import { t } from '../../../i18n';

/** S-MAT-02 Nova matéria (PLT-03). */
export default function NewSubject() {
  // then=upload: came from the share sheet, so the shared PDF goes straight into the new subject.
  const { then } = useLocalSearchParams<{ then?: string }>();
  const [draft, setDraft] = useState<SubjectDraft>({ name: '', color: 'indigo', icon: 'book-outline' });
  const create = useCreateSubject();
  const subjects = useSubjects();
  const overlay = useOverlay();

  const save = async () => {
    const dup = subjects.data?.some((s) => s.name.trim().toLowerCase() === draft.name.trim().toLowerCase());
    if (dup && !(await overlay.confirm({ title: 'Já existe uma matéria com esse nome. Criar mesmo assim?' }))) return;
    try {
      const id = await create.mutateAsync(draft);
      if (then === 'upload') router.replace({ pathname: '/subjects/[subjectId]/upload', params: { subjectId: id, shared: '1' } });
      else router.replace(`/subjects/${id}`);
    } catch {
      overlay.snack(t('error.generic'));
    }
  };

  return (
    <Screen
      title={t('subjects.new')}
      footer={
        <ActionBar>
          <Button label={t('global.save')} disabled={!draft.name.trim()} loading={create.isPending} onPress={save} />
        </ActionBar>
      }
    >
      <SubjectForm value={draft} onChange={setDraft} />
    </Screen>
  );
}
