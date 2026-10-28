import type { SchoolEssayFeedback } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { AiBadge, Banner, Button, Card, Chip, ErrorState, PageChips, RichContent, Row, Screen, SkeletonList, Text } from '../../components';
import { gradeEssay, useEssay } from '../../features/camera/api';
import { formatGrade } from '../../features/common/format';
import { ReadAloudButton } from '../../features/voice/VoiceButtons';
import { causeLabel } from '../../components/Practice';
import { t } from '../../i18n';
import { space, useTheme } from '../../theme';

/**
 * S-PRA-07 result (PRA-07.5–07.9): points per criterion with the grader's reason, what was right, what was
 * missing with 📄 pages, a model answer close to the student's words, and the change since the last version.
 * ENEM redações (kind enem_redacao) are graded by the worker; this screen waits for them.
 */
export default function EssayResult() {
  const { essayId } = useLocalSearchParams<{ essayId: string }>();
  const essay = useEssay(essayId);
  const { colors: c } = useTheme();
  const e = essay.data;

  if (essay.isError) return <Screen title={t('essay.title')}><ErrorState onRetry={essay.refetch} /></Screen>;
  if (!e) return <Screen title={t('essay.title')}><SkeletonList rows={4} /></Screen>;
  if (e.status === 'grading' || e.status === 'draft') {
    return (
      <Screen title={t('essay.title')} closeIcon onBack={() => router.back()}>
        <Text tone="secondary">{t('essay.grading')}</Text>
        <SkeletonList rows={3} />
      </Screen>
    );
  }
  if (e.status === 'failed') {
    return (
      <Screen title={t('essay.title')} closeIcon onBack={() => router.back()}>
        <Banner kind="danger" message={t('error.generation')} action={{ label: t('global.retry'), onPress: () => void gradeEssay(e.id).then(() => essay.refetch()) }} />
      </Screen>
    );
  }
  if (e.kind === 'enem_redacao') {
    return (
      <Screen title={t('essay.title')} closeIcon onBack={() => router.back()}>
        <Button label={t('essay.open_enem')} onPress={() => router.replace({ pathname: '/enem/essay/[essayId]', params: { essayId: e.id } })} />
      </Screen>
    );
  }

  const f = e.feedback as SchoolEssayFeedback;
  const question = e.prompt?.question_text;
  return (
    <Screen title={t('essay.title')} closeIcon onBack={() => router.back()}>
      <Card>
        <Row>
          <View style={{ flex: 1 }}>
            <Text variant="display">{t('essay.points', { n: formatGrade(f.points_awarded), max: formatGrade(f.points_max) })}</Text>
            {f.delta_points !== null ? (
              <Text tone={f.delta_points >= 0 ? 'success' : 'warning'}>{t('essay.delta', { n: `${f.delta_points >= 0 ? '+' : ''}${formatGrade(f.delta_points)}` })}</Text>
            ) : null}
          </View>
          <AiBadge />
        </Row>
        {f.grader_confidence === 'low' ? <Banner kind="info" message={t('essay.low_confidence')} /> : null}
        {f.heavily_edited ? <Text variant="bodySmall" tone="secondary">{t('cam.transcription.edited')}</Text> : null}
        {f.illegible_segments > 0 ? <Text variant="bodySmall" tone="secondary">{t('cam.legibility', { n: f.illegible_segments })}</Text> : null}
        {f.built_rubric ? <Text variant="bodySmall" tone="secondary">{t('essay.built_rubric')}</Text> : null}
      </Card>
      {question ? (
        <Card tone="soft">
          <Text variant="label">{t('essay.question_label')}</Text>
          <RichContent text={question} variant="bodySmall" />
        </Card>
      ) : null}
      <Card>
        <Text variant="heading">{t('essay.criteria')}</Text>
        {f.criteria.map((cr) => (
          <View key={cr.id} style={{ gap: 2, borderLeftWidth: 3, borderColor: cr.verdict === 'full' ? c.success : cr.verdict === 'partial' ? c.warning : c.danger, paddingLeft: space.sm }}>
            <Row>
              <Text variant="label" style={{ flex: 1 }}>
                {cr.verdict === 'full' ? '✓ ' : cr.verdict === 'partial' ? '◐ ' : '✗ '}
                {cr.criterion}
              </Text>
              <Text variant="label">{formatGrade(cr.points)}/{formatGrade(cr.max_points)}</Text>
            </Row>
            <Text variant="bodySmall" tone="secondary">{cr.comment}</Text>
          </View>
        ))}
      </Card>
      {f.strengths.length ? (
        <Card>
          <Text variant="heading">{t('essay.strengths')}</Text>
          {f.strengths.map((s) => (
            <Text key={s}>✓ {s}</Text>
          ))}
        </Card>
      ) : null}
      {f.missing.length ? (
        <Card>
          <Text variant="heading">{t('essay.missing')}</Text>
          {f.missing.map((m) => (
            <View key={m.text} style={{ gap: space.xs }}>
              <Text>• {m.text}</Text>
              <PageChips sources={m.source_pages} subjectId={e.prompt?.subject_id ?? null} />
            </View>
          ))}
        </Card>
      ) : null}
      {f.misconceptions.length ? (
        <Card>
          <Text variant="heading">{t('essay.misconceptions')}</Text>
          {f.misconceptions.map((m) => (
            <Text key={m}>• {m}</Text>
          ))}
          {f.suggested_cause ? <Chip label={causeLabel(f.suggested_cause)} /> : null}
        </Card>
      ) : null}
      <Card>
        <Row>
          <Text variant="heading" style={{ flex: 1 }}>
            {t('essay.model_answer')}
          </Text>
          <ReadAloudButton id={`essay:${e.id}`} text={f.model_answer} />
        </Row>
        <RichContent variant="reading" text={f.model_answer} />
      </Card>
      <Button
        variant="tonal"
        icon="refresh"
        label={t('essay.rewrite')}
        onPress={() =>
          router.push({
            pathname: '/essay/new',
            params: { parentEssayId: e.id, text: e.text, ...(question ? { question, maxPoints: String(f.points_max) } : {}), ...(e.question_id ? { questionId: e.question_id } : {}), ...(e.prompt?.subject_id ? { subjectId: e.prompt.subject_id } : {}) },
          })
        }
      />
    </Screen>
  );
}
