import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Banner, Button, Card, ErrorState, RichContent, Screen, SkeletonList, Text } from '../../components';
import { analyzeCapture, discardCapture, useCapture } from '../../features/camera/api';
import { AddToSubjectPanel, ExplainPanel, SolvePanel, TranscriptionReview } from '../../features/camera/CapturePanels';
import { t } from '../../i18n';
import { space } from '../../theme';

const MODEL_ISSUES = ['blur', 'glare', 'partial', 'dark', 'handwriting', 'multiple_questions'] as const;

/**
 * S-CAM-02 capture result (CAM-01…03): reads the photo once (capture-analyze; a repeat returns the stored
 * analysis), then explains, walks the hint ladder, adds the photos to a subject, or reviews the transcription
 * before grading. A photo without study content is deleted by the server and offers a retake.
 */
export default function CaptureResult() {
  const { captureId, questionId } = useLocalSearchParams<{ captureId: string; questionId?: string }>();
  const capture = useCapture(captureId);
  const [analysis, setAnalysis] = useState<{ issues: string[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showText, setShowText] = useState(false);
  const started = useRef(false);

  const run = async () => {
    setFailure(null);
    try {
      const res = await analyzeCapture(captureId);
      setAnalysis({ issues: res.quality.issues });
      await capture.refetch();
    } catch (e) {
      setFailure((e as { code?: string }).code ?? 'error');
    }
  };

  useEffect(() => {
    if (!capture.data || started.current) return;
    started.current = true;
    if (capture.data.status === 'ready' && capture.data.content_type) setAnalysis({ issues: ((capture.data.quality_flags.model as string[] | undefined) ?? []) });
    else void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture.data?.id]);

  const leave = async () => {
    if (capture.data && !capture.data.saved && capture.data.intent !== 'add_to_subject') await discardCapture(capture.data.id).catch(() => undefined);
    router.back();
  };

  if (capture.isError) return <Screen title={t('cam.title')}><ErrorState onRetry={capture.refetch} /></Screen>;
  const c = capture.data;

  if (failure) {
    const unreadable = failure === 'photo_unreadable';
    return (
      <Screen title={t('cam.title')} closeIcon onBack={() => router.back()}>
        <Banner kind={unreadable ? 'warning' : 'danger'} message={unreadable ? t('cam.no_content') : failure === 'budget_exhausted' || failure === 'rate_limited' ? t('budget.user_daily') : failure === 'offline' ? t('cam.offline') : t('error.generation')} />
        {unreadable ? (
          <Button label={t('cam.retake')} icon="camera" onPress={() => router.replace({ pathname: '/camera', params: c ? { intent: c.intent } : {} })} />
        ) : (
          <Button label={t('global.retry')} onPress={() => void run()} />
        )}
      </Screen>
    );
  }

  if (!c || !analysis || c.status !== 'ready') {
    return (
      <Screen title={t('cam.title')} closeIcon onBack={() => router.back()}>
        <Text tone="secondary">{c?.intent === 'grade_answer' || c?.intent === 'grade_essay' ? t('cam.reading_handwriting') : t('cam.reading')}</Text>
        <SkeletonList rows={3} height={72} />
      </Screen>
    );
  }

  const issues = analysis.issues.filter((i): i is (typeof MODEL_ISSUES)[number] => (MODEL_ISSUES as readonly string[]).includes(i) && i !== 'multiple_questions');
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
        {grading ? (
          <TranscriptionReview
            capture={c}
            questionId={questionId}
            onGraded={(essayId) => router.replace({ pathname: '/essay/[essayId]', params: { essayId } })}
          />
        ) : null}
      </View>
    </Screen>
  );
}
