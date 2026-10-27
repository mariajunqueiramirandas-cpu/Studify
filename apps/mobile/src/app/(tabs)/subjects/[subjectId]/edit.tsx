import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActionBar, Button, Screen, SkeletonList, useOverlay } from '../../../../components';
import { colorKeyFromHex, useSubject, useUpdateSubject } from '../../../../features/subjects/api';
import { SubjectForm, type SubjectDraft } from '../../../../features/subjects/SubjectForm';
import { t } from '../../../../i18n';

/** S-MAT-02 Editar matéria. */
export default function EditSubject() {
  const { subjectId } = useLocalSearchParams<{ subjectId: string }>();
  const subject = useSubject(subjectId);
  const update = useUpdateSubject(subjectId);
  const overlay = useOverlay();
  const [draft, setDraft] = useState<SubjectDraft | null>(null);

  useEffect(() => {
    if (subject.data && !draft) setDraft({ name: subject.data.name, color: colorKeyFromHex(subject.data.color), icon: subject.data.icon });
  }, [subject.data, draft]);

  return (
    <Screen
      title={t('subjects.edit')}
      footer={
        <ActionBar>
          <Button
            label={t('global.save')}
            disabled={!draft?.name.trim()}
            loading={update.isPending}
            onPress={async () => {
              if (!draft) return;
              try {
                await update.mutateAsync(draft);
                router.back();
              } catch {
                overlay.snack(t('error.generic'));
              }
            }}
          />
        </ActionBar>
      }
    >
      {draft ? <SubjectForm value={draft} onChange={setDraft} suggestions={false} /> : <SkeletonList rows={3} />}
    </Screen>
  );
}
