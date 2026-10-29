import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Banner, Button, Card, ErrorState, GenerationStatus, RichContent, Screen, Text, TextField, useOverlay } from '../../components';
import { analyzeCapture, discardCapture, useCapture } from '../../features/camera/api';
import { AddToSubjectPanel, ExplainPanel, SolvePanel, TranscriptionReview, errorMessage } from '../../features/camera/CapturePanels';
import { appendToContribution } from '../../features/class/turma5';
import { t } from '../../i18n';
import { space } from '../../theme';
import { messageFor } from '../../api/messages';

const MODEL_ISSUES = ['blur', 'glare', 'partial', 'dark', 'handwriting', 'multiple_questions'] as const;

/**
 * S-CAM-02 capture result (CAM-01…03): reads the photo once (capture-analyze; a repeat returns the stored
 * analysis), then explains, walks the hint ladder, adds the photos to a subject, or reviews the transcription
 * before grading. A photo without study content is deleted by the server and offers a retake.
 */
export default function CaptureResult() {
  const { captureId, questionId, themeId, purpose, contributionId } = useLocalSearchParams<{ captureId: string; questionId?: string; themeId?: string; purpose?: 'contribution'; contributionId?: string }>();
  const capture = useCapture(captureId);
  const [analysis, setAnalysis] = useState<{ issues: string[] } | null>(null);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [showText, setShowText] = useState(false);
  const started = useRef(false);

  const analyze = async () => {
    try {
      const res = await analyzeCapture(captureId);
      setAnalysis({ issues: res.quality.issues });
      await capture.refetch();
    } catch (e) {
      setFailure({ code: (e as { code?: string }).code ?? 'error', message: errorMessage(e) });
    }
  };

  const retry = () => {
    setFailure(null);
    void analyze();
  };

  // A capture analyzed before (reopened from history) shows its stored result without a new call.
  const analyzed = capture.data?.status === 'ready' && !!capture.data.content_type;
  useEffect(() => {
    if (!capture.data || started.current || analyzed) return;
    started.current = true;
    void analyze();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture.data?.id]);

  const leave = async () => {
    if (capture.data && !capture.data.saved && capture.data.intent !== 'add_to_subject') await discardCapture(capture.data.id).catch(() => undefined);
    router.back();
  };

  if (capture.isError) return <Screen title={t('cam.title')}><ErrorState onRetry={capture.refetch} /></Screen>;
  const c = capture.data;

  if (failure) {
    const unreadable = failure.code === 'photo_unreadable';
    return (
      <Screen title={t('cam.title')} closeIcon onBack={() => router.back()}>
        {unreadable ? (
          <>
            <Banner kind="warning" message={t('cam.no_content')} />
            <Button label={t('cam.retake')} icon="camera" onPress={() => router.replace({ pathname: '/camera', params: c ? { intent: c.intent, ...(themeId ? { themeId } : {}) } : {} })} />
          </>
        ) : (
          <GenerationStatus title={t('cam.reading_title')} error={failure.message} onRetry={retry} />
        )}
      </Screen>
    );
  }

  const result = analysis ?? (analyzed && c ? { issues: (c.quality_flags.model as string[] | undefined) ?? [] } : null);
  if (!c || !result || c.status !== 'ready') {
    return (
      <Screen title={t('cam.title')} closeIcon onBack={() => router.back()}>
        <GenerationStatus title={t('cam.reading_title')} detail={c?.intent === 'grade_answer' || c?.intent === 'grade_essay' ? t('cam.reading_handwriting') : t('cam.reading')} slowAfterS={20} />
      </Screen>
    );
  }

  const issues = result.issues.filter((i): i is (typeof MODEL_ISSUES)[number] => (MODEL_ISSUES as readonly string[]).includes(i) && i !== 'multiple_questions');
  const grading = c.intent === 'grade_answer' || c.intent === 'grade_essay';
  return (
    <Screen title={t('cam.title')} closeIcon onBack={() => void leave()}>
      {issues.map((i) => (
        <Banner key={i} kind="neutral" message={t(`cam.model_issue.${i}`)} />
      ))}
      {!grading && c.transcription ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showText }} onPress={() => setShowText((v) => !v)}>
          <Card tone="soft">
            <Text variant="label">{showText ? t('cam.hide_text') : t('cam.show_text')}</Text>
            {showText ? <RichContent text={c.transcription} variant="bodySmall" /> : null}
          </Card>
        </Pressable>
      ) : null}
      <View style={{ gap: space.md }}>
        {c.intent === 'explain' ? <ExplainPanel capture={c} /> : null}
        {c.intent === 'solve' ? <SolvePanel capture={c} /> : null}
        {c.intent === 'add_to_subject' ? <AddToSubjectPanel capture={c} /> : null}
        {purpose === 'contribution' && contributionId ? (
          // SOC-06.2: a handwritten summary page becomes text in the divisão draft; nothing is graded.
          <ContributionFromPhoto text={c.transcription ?? ''} contributionId={contributionId} />
        ) : grading ? (
          <TranscriptionReview
            capture={c}
            questionId={questionId}
            themeId={themeId}
            // ENEM redação (grade_essay) has its own result screen with C1–C5 (ENM-05.2).
            onGraded={(essayId) => router.replace({ pathname: c.intent === 'grade_essay' ? '/enem/essay/[essayId]' : '/essay/[essayId]', params: { essayId } })}
          />
        ) : null}
      </View>
    </Screen>
  );
}

function ContributionFromPhoto({ text, contributionId }: { text: string; contributionId: string }) {
  const overlay = useOverlay();
  const [value, setValue] = useState(text);
  return (
    <View style={{ gap: space.md }}>
      <Text variant="heading">{t('cam.transcription.title')}</Text>
      <Text tone="secondary">{t('divide.photo_hint')}</Text>
      <TextField label={t('divide.write')} value={value} onChangeText={setValue} multiline />
      <Button
        label={t('divide.use_text')}
        disabled={!value.trim()}
        onPress={() =>
          void appendToContribution(contributionId, value.trim())
            .then(() => router.back())
            .catch((e: unknown) => overlay.snack(messageFor(e)))
        }
      />
    </View>
  );
}
