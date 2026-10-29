import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { ActionBar, Banner, Button, Card, GenerationStatus, Row, Screen, Text, TextField, useOnline, useOverlay } from '../../components';
import { messageFor } from '../../api/messages';
import { useSession } from '../../features/auth/session';
import { createTypedEssay, gradeEssay } from '../../features/camera/api';
import { MicButton } from '../../features/voice/VoiceButtons';
import { appendTranscript } from '../../features/voice/speech-text';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';

/**
 * S-PRA-07 "Tenho uma questão da professora" (PRA-07.1–07.4): the student types (or speaks, WEL-04.9) the
 * question and the answer, or photographs a handwritten answer (CAM-03). A rewrite of an earlier answer keeps
 * the link (PRA-07.8) so the result shows the change in points.
 */
export default function NewEssay() {
  const params = useLocalSearchParams<{ questionId?: string; question?: string; maxPoints?: string; subjectId?: string; parentEssayId?: string; text?: string }>();
  const { userId } = useSession();
  const online = useOnline();
  const overlay = useOverlay();
  const { colors: c, type } = useTheme();
  const [question, setQuestion] = useState(params.question ?? '');
  const [maxPoints, setMaxPoints] = useState(params.maxPoints ?? '10');
  const [text, setText] = useState(params.text ?? '');
  const [busy, setBusy] = useState(false);
  const bankQuestion = !!params.questionId;

  const grade = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      const essayId = await createTypedEssay(userId, {
        text,
        questionId: params.questionId ?? null,
        questionText: bankQuestion ? null : question.trim(),
        maxPoints: Number(maxPoints.replace(',', '.')) || 10,
        subjectId: params.subjectId ?? null,
        parentEssayId: params.parentEssayId ?? null,
      });
      await gradeEssay(essayId);
      router.replace({ pathname: '/essay/[essayId]', params: { essayId } });
    } catch (e) {
      overlay.snack(messageFor(e, t('error.generation')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen
      title={t('essay.title')}
      closeIcon
      onBack={() => router.back()}
      footer={
        <ActionBar>
          {busy ? <GenerationStatus compact title={t('essay.grading_title')} detail={t('essay.grading_detail')} slowAfterS={45} /> : null}
          <Button label={t('essay.grade')} loading={busy} disabled={!online || !text.trim() || (!bankQuestion && !question.trim())} disabledReason={online ? undefined : t('offline.ai_disabled')} onPress={() => void grade()} />
        </ActionBar>
      }
    >
      {!bankQuestion ? (
        <Card tone="outline">
          <TextField label={t('essay.question_label')} value={question} onChangeText={setQuestion} multiline placeholder={t('essay.question_placeholder')} />
          <TextField label={t('essay.max_points')} value={maxPoints} onChangeText={setMaxPoints} keyboardType="decimal-pad" />
        </Card>
      ) : (
        <Banner kind="neutral" message={params.question ?? ''} />
      )}
      <View style={{ gap: space.sm }}>
        <Row>
          <Text variant="label" style={{ flex: 1 }}>
            {t('essay.answer_label')}
          </Text>
          <MicButton onText={(said) => setText((v) => appendTranscript(v, said))} />
        </Row>
        <TextInput
          multiline
          value={text}
          onChangeText={setText}
          maxLength={20000}
          placeholder={t('quiz.short_placeholder')}
          placeholderTextColor={c.textSecondary}
          accessibilityLabel={t('essay.answer_label')}
          style={[type('body'), { borderWidth: 1.5, borderColor: c.primary, borderRadius: radius.md, padding: space.md, minHeight: 220, textAlignVertical: 'top', color: c.textPrimary }]}
        />
      </View>
      <Button
        variant="tonal"
        icon="camera-outline"
        label={t('essay.photo_instead')}
        onPress={() => router.push({ pathname: '/camera', params: { intent: 'grade_answer', ...(params.subjectId ? { subjectId: params.subjectId } : {}), ...(params.questionId ? { questionId: params.questionId } : {}) } })}
      />
    </Screen>
  );
}
