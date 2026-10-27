import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActionBar, Banner, Button, CausePicker, FeedbackPanel, PageChips, RichText, Screen, Section, SkeletonList, Text, TextField, useOverlay } from '../../../../components';
import { relativeDay } from '../../../../features/common/format';
import { createQuiz, updateMistake, useMistakes } from '../../../../features/practice/api';
import type { MistakeCause, QuestionResponse } from '../../../../features/practice/types';
import { t } from '../../../../i18n';

/** S-PRA-10 Erro: entry detail, cause, "O que eu aprendi", retry (PRA-04). */
export default function MistakeDetail() {
  const { mistakeId } = useLocalSearchParams<{ mistakeId: string }>();
  const mistakes = useMistakes('all');
  const overlay = useOverlay();
  const m = mistakes.data?.find((x) => x.id === mistakeId);
  const [note, setNote] = useState('');
  const [cause, setCause] = useState<MistakeCause | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (m) {
      setNote(m.user_note ?? '');
      setCause(m.cause);
    }
  }, [m]);

  if (!m) return <Screen title={t('mistakes.entry')}><SkeletonList rows={3} /></Screen>;
  const q = m.question;
  const hint = cause === 'careless' ? t('mistakes.slow') : cause === 'misread' ? t('mistakes.misread') : null;

  return (
    <Screen
      title={t('mistakes.entry')}
      footer={
        !m.resolved_at && q ? (
          <ActionBar>
            <Button
              label={t('mistakes.retry_now')}
              loading={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  const res = await createQuiz({ kind: 'mistake_retry', scope: { node_ids: [m.node_id], subject_id: m.subject_id }, count: 1, mode: 'practice' });
                  router.push({ pathname: '/quiz/[quizId]', params: { quizId: res.quiz_id, attemptId: res.attempt_id } });
                } catch {
                  overlay.snack(t('error.generation'));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </ActionBar>
        ) : undefined
      }
    >
      {m.resolved_at ? <Banner kind="success" message={t('mistakes.resolved')} /> : <Text tone="secondary">{t('mistakes.next_retry', { when: relativeDay(m.next_retry_at) })}</Text>}
      {hint ? <RichText>{hint}</RichText> : null}
      {q ? <FeedbackPanel question={q} response={null as QuestionResponse | null} result={{ correct: false, score: 0, typo: null, pending: false }} /> : null}
      {q ? <PageChips sources={q.source_pages} subjectId={q.subject_id} /> : null}
      <CausePicker
        value={cause}
        suggested={m.suggested_cause}
        onChange={async (c) => {
          setCause(c);
          await updateMistake(m.id, { cause: c }).catch(() => overlay.snack(t('offline.queued')));
        }}
      />
      <Section title={t('mistakes.learned')}>
        <TextField value={note} onChangeText={setNote} multiline placeholder={t('mistakes.learned_placeholder')} accessibilityLabel={t('mistakes.learned')} />
        <Button
          compact
          variant="tonal"
          label={t('global.save')}
          disabled={note === (m.user_note ?? '')}
          onPress={async () => {
            await updateMistake(m.id, { user_note: note }).catch(() => undefined);
            overlay.snack(t('global.done'));
            void mistakes.refetch();
          }}
        />
      </Section>
    </Screen>
  );
}
