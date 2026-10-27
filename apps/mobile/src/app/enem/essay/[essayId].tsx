import { router, useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { AiBadge, Banner, Button, Card, ErrorState, Row, Screen, SkeletonList, Text } from '../../../components';
import { gradeEssay } from '../../../features/camera/api';
import { useEnemEssay, useEnemEssays } from '../../../features/enem/api';
import { PropostaChecklist, RepertorioChecks } from '../../../features/enem/components';
import { t } from '../../../i18n';
import { space, useTheme } from '../../../theme';

const ZERO_KEYS = new Set(['fuga_tema', 'tipo_textual', 'em_branco', 'texto_insuficiente', 'anulacao', 'parte_desconectada', 'identificacao', 'lingua_estrangeira', 'ilegivel']);

/**
 * S-ENEM Redação result (ENM-05.2–05.7): "Nota estimada", zero reasons first, C1–C5 with level, justification,
 * quotes and fixes, the proposta checklist, repertório checks, rewrites of the weakest paragraphs and progress.
 */
export default function EnemEssayResult() {
  const { essayId } = useLocalSearchParams<{ essayId: string }>();
  const essay = useEnemEssay(essayId);
  const history = useEnemEssays();
  const { colors: c } = useTheme();
  const e = essay.data;

  if (essay.isError) return <Screen title={t('red.title')}><ErrorState onRetry={essay.refetch} /></Screen>;
  if (!e) return <Screen title={t('red.title')}><SkeletonList rows={4} /></Screen>;
  if (e.status === 'grading' || e.status === 'draft') {
    return (
      <Screen title={t('red.title')} closeIcon onBack={() => router.replace('/enem')}>
        <Text tone="secondary">{t('red.grading')}</Text>
        <SkeletonList rows={3} />
      </Screen>
    );
  }
  if (e.status === 'failed') {
    return (
      <Screen title={t('red.title')} closeIcon onBack={() => router.back()}>
        <Banner kind="danger" message={t('error.generation')} action={{ label: t('global.retry'), onPress: () => void gradeEssay(e.id).then(() => essay.refetch()) }} />
      </Screen>
    );
  }

  // Progress: the competência that improved most against the previous graded essay (ENM-05.7).
  const graded = (history.data ?? []).filter((x) => x.status === 'graded' && !x.is_zero && x.competencias);
  const idx = graded.findIndex((x) => x.id === e.id);
  const prev = idx >= 0 ? graded[idx + 1] : undefined;
  let improved: number | null = null;
  if (prev && e.competencias && prev.competencias) {
    let best = 0;
    for (let n = 1; n <= 5; n++) {
      const d = (e.competencias[`c${n}`]?.score ?? 0) - (prev.competencias[`c${n}`]?.score ?? 0);
      if (d > best) {
        best = d;
        improved = n;
      }
    }
  }

  return (
    <Screen title={t('red.title')} closeIcon onBack={() => router.replace('/enem')}>
      <Card>
        <Row>
          <View style={{ flex: 1 }}>
            <Text variant="caption" tone="secondary">
              {t('red.score.label')}
            </Text>
            <Text variant="display">{t('red.total', { n: e.total ?? 0 })}</Text>
          </View>
          <AiBadge />
        </Row>
        {e.prompt?.theme ? <Text variant="bodySmall">{e.prompt.theme}</Text> : null}
        {e.feedback?.calibration === 'pending' ? <Text variant="caption" tone="secondary">{t('red.calibration_pending')}</Text> : null}
        {e.feedback?.too_long ? <Text variant="caption" tone="warning">{t('red.too_long')}</Text> : null}
        {improved ? <Text variant="bodySmall" tone="success">{t('red.most_improved', { n: improved })}</Text> : null}
      </Card>

      {e.is_zero ? (
        <Card>
          <Text variant="heading" tone="danger">
            {t('red.zero.title')}
          </Text>
          {(e.zero_reasons ?? []).map((r) => (
            <Text key={r}>• {ZERO_KEYS.has(r) ? t(`red.zero.${r}`) : r}</Text>
          ))}
          {e.feedback?.zero_evidence ? <Text variant="bodySmall" tone="secondary">“{e.feedback.zero_evidence}”</Text> : null}
        </Card>
      ) : null}

      {e.feedback?.top_actions?.length ? (
        <Card tone="soft">
          <Text variant="heading">{t('red.top_actions')}</Text>
          {e.feedback.top_actions.map((a, i) => (
            <Text key={i}>
              {i + 1}. {a}
            </Text>
          ))}
        </Card>
      ) : null}

      {!e.is_zero && e.competencias
        ? [1, 2, 3, 4, 5].map((n) => {
            const comp = e.competencias![`c${n}`];
            if (!comp) return null;
            return (
              <Card key={n}>
                <Row>
                  <Text variant="label" style={{ flex: 1 }}>
                    {t('red.competencia', { n })} · {t(`red.comp.${n}`)}
                  </Text>
                  <Text variant="heading">{comp.score}</Text>
                </Row>
                <View style={{ height: 6, borderRadius: 3, backgroundColor: c.surface2 }}>
                  <View style={{ width: `${(comp.score / 200) * 100}%`, height: 6, borderRadius: 3, backgroundColor: comp.score >= 160 ? c.success : comp.score >= 120 ? c.warning : c.danger }} />
                </View>
                <Text variant="bodySmall" tone="secondary">
                  {comp.level_text}
                </Text>
                <Text variant="bodySmall">{comp.justification}</Text>
                {comp.evidence.slice(0, 2).map((ev, i) => (
                  <Text key={i} variant="caption" tone="secondary">
                    {ev.line ? `L${ev.line}: ` : ''}“{ev.quote}”
                  </Text>
                ))}
                {comp.issues.length ? <Text variant="label">{t('red.issues')}</Text> : null}
                {comp.issues.map((iss, i) => (
                  <View key={i} style={{ gap: 2 }}>
                    <Text variant="bodySmall">
                      {iss.line ? `L${iss.line}: ` : ''}“{iss.quote}”
                    </Text>
                    <Text variant="bodySmall" tone="success">
                      → {iss.fix}
                    </Text>
                  </View>
                ))}
                {comp.strengths.length ? <Text variant="label">{t('red.strengths')}</Text> : null}
                {comp.strengths.map((s, i) => (
                  <Text key={i} variant="bodySmall">
                    ✓ {s}
                  </Text>
                ))}
              </Card>
            );
          })
        : null}

      {e.proposta && !e.is_zero ? <PropostaChecklist proposta={e.proposta} /> : null}
      {e.repertorio ? <RepertorioChecks items={e.repertorio} /> : null}

      {e.rewrites?.length ? (
        <Card>
          <Text variant="heading">{t('red.rewrites')}</Text>
          {e.rewrites.map((r) => (
            <View key={r.paragraph} style={{ gap: space.xs }}>
              <Text variant="caption" tone="secondary">
                § {r.paragraph}
              </Text>
              <Text variant="bodySmall" style={{ textDecorationLine: 'line-through' }} tone="secondary">
                {r.original}
              </Text>
              <Text variant="bodySmall">{r.suggested}</Text>
              <Text variant="caption" tone="accent">
                {t('red.why_better')}: {r.why}
              </Text>
            </View>
          ))}
        </Card>
      ) : null}

      <Text variant="caption" tone="secondary">
        {t('sim.score.footnote')}
      </Text>
      <Button variant="tonal" icon="refresh" label={t('red.new_version')} onPress={() => router.push({ pathname: '/enem/essay/new', params: { ...(e.theme_id ? { themeId: e.theme_id } : {}), text: e.text } })} />
    </Screen>
  );
}
