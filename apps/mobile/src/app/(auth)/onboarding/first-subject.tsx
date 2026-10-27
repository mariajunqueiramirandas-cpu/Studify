import { router } from 'expo-router';
import { useState } from 'react';
import { ActionBar, Button, Screen, Text, useOverlay } from '../../../components';
import { useOnboarding } from '../../../features/auth/onboarding';
import { useCreateSubject } from '../../../features/subjects/api';
import { SubjectForm, type SubjectDraft } from '../../../features/subjects/SubjectForm';
import { t } from '../../../i18n';

/** S-AUTH-08 Sua primeira matéria → upload (UF-01 step 9, target < 2 min to first session). */
export default function FirstSubject() {
  const [draft, setDraft] = useState<SubjectDraft>({ name: '', color: 'indigo', icon: 'book-outline' });
  const create = useCreateSubject();
  const overlay = useOverlay();
  const intent = useOnboarding((s) => s.intent);
  const finish = () => {
    useOnboarding.getState().reset();
  };
  return (
    <Screen
      title=""
      root
      footer={
        <ActionBar>
          <Button
            label={t('onb.first_subject.pick_pdf')}
            icon="document-outline"
            disabled={!draft.name.trim()}
            loading={create.isPending}
            onPress={async () => {
              try {
                const id = await create.mutateAsync(draft);
                finish();
                router.replace('/today');
                router.push(`/subjects/${id}/upload`);
              } catch {
                overlay.snack(t('error.generic'));
              }
            }}
          />
          <Button
            variant="text"
            label={t('onb.first_subject.later')}
            onPress={() => {
              finish();
              router.replace(intent === 'exam_week' ? '/goal/new' : '/today');
            }}
          />
        </ActionBar>
      }
    >
      <Text variant="title">{t('onb.first_subject.title')}</Text>
      <SubjectForm value={draft} onChange={setDraft} />
    </Screen>
  );
}
