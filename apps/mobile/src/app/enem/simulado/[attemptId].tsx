import { sisuScore, targetPaceMin, type SisuScores } from '@studify/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { View } from 'react-native';
import { Banner, Button, Card, ErrorState, Row, Screen, SkeletonList, Text } from '../../../components';
import { useAttemptResult } from '../../../features/practice/api';
import { useEnemGoal, useEstimates, useSisuTargets } from '../../../features/enem/api';
import { EstimateFootnote, ScoreBar, areaName } from '../../../features/enem/components';
import { areaRows } from '../../../features/enem/format';
import type { EnemAreaResults } from '@studify/shared';
import { t } from '../../../i18n';
import { space } from '../../../theme';

/**
 * S-ENEM Simulado result (ENM-04.5–04.8): per-area "Nota estimada (TRI)" with the 80% interval, correct count,
 * blanks, coherence (easy misses, lucky hits), time coaching, and the SISU estimate with a target. No single
 * total score, as ENEM.
 */
export default function SimuladoResult() {
  const { attemptId } = useLocalSearchParams<{ attemptId: string }>();
  const result = useAttemptResult(attemptId);
  const { goal } = useEnemGoal();
  const targets = useSisuTargets(goal?.id);
  const { estimates } = useEstimates();
  const attempt = result.data?.attempt as (NonNullable<typeof result.data>['attempt'] & { area_results?: EnemAreaResults | null; paused_seconds?: number }) | undefined;
  const rows = useMemo(() => areaRows(attempt?.area_results), [attempt?.area_results]);
  const primary = targets.data?.find((x) => x.priority === 1);
  const weights = (primary?.manual?.weights ?? null) as SisuScores | null;

  if (result.isError) return <Screen title={t('sim.tri_result.title')}><ErrorState onRetry={result.refetch} /></Screen>;
  if (!attempt || attempt.status !== 'submitted' || !attempt.area_results) {
    return (
      <Screen title={t('sim.tri_result.title')} closeIcon onBack={() => router.back()}>
        <Text tone="secondary">{t('sim.tri_result.waiting')}</Text>
        <SkeletonList rows={4} />
      </Screen>
    );
  }

  // SISU estimate when the student has every area (this attempt + latest estimates for the rest).
  const merged = { ...estimates, ...Object.fromEntries(rows.map((r) => [r.area, r.score])) } as Partial<SisuScores>;
  const sisu = weights && (['LC', 'CH', 'CN', 'MT', 'RED'] as const).every((k) => merged[k] !== undefined) ? Math.round(sisuScore(weights, merged as SisuScores) * 10) / 10 : null;
  const wrongIds = (result.data?.answers ?? []).filter((a) => a.correct === false || a.response === null).map((a) => a.question_id);

  return (
    <Screen title={t('sim.tri_result.title')} closeIcon onBack={() => router.replace('/enem')}>
      {attempt.area_results.paused ? <Banner kind="neutral" message={t('sim.paused')} /> : null}
      {rows.map((r) => {
        const pace = targetPaceMin({ mode: rows.length > 1 ? (r.area === 'LC' || r.area === 'CH' ? 'day1' : 'day2') : 'area' });
        const blocks = attempt.area_results!.areas[r.area]!.time.blocks ?? [];
        return (
          <Card key={r.area}>
            <Row>
              <Text variant="label" style={{ flex: 1 }}>
                {areaName(r.area)}
              </Text>
              <Text variant="display">{r.score}</Text>
            </Row>
            <Text variant="caption" tone="secondary">
              {t('sim.score.label')} · {t('sim.tri_result.interval', { low: r.low, high: r.high })}
            </Text>
            <ScoreBar score={r.score} low={r.low} high={r.high} target={primary?.targets?.display?.[r.area] ?? null} />
            <Text>{t('sim.tri_result.correct', { k: r.correct, n: r.items })}</Text>
            {r.blank > 0 ? <Banner kind="warning" message={`${t('sim.blanks', { n: r.blank })} ${t('sim.blank')}`} /> : null}
            {r.easyMisses > 0 ? <Text variant="bodySmall">{t('sim.easy_misses', { n: r.easyMisses })}</Text> : null}
            {r.luckyHits > 0 ? <Text variant="bodySmall">{t('sim.lucky_hits', { n: r.luckyHits })}</Text> : null}
            {r.level ? (
              <Text variant="bodySmall" tone="secondary">
                {t('sim.coherence.label')}: {t(`sim.coherence.${r.level}`)} — {t('sim.coherence.hint')}
              </Text>
            ) : null}
            {r.stuck > 0 ? <Text variant="bodySmall">{t('sim.stuck_count', { n: r.stuck, min: Math.round(pace * 2) })}</Text> : null}
            <Text variant="caption" tone="secondary">
              {t('sim.pace', { min: pace.toFixed(1).replace('.', ',') })}
            </Text>
            {blocks.length > 1 ? (
              <View style={{ gap: 2 }}>
                <Text variant="caption">{t('sim.blocks')}</Text>
                {blocks.map((b) => (
                  <Text key={b.from} variant="caption" tone="secondary">
                    {t('sim.block', { from: b.from, to: b.to, pct: Math.round(b.accuracy * 100) })}
                  </Text>
                ))}
              </View>
            ) : null}
          </Card>
        );
      })}
      {sisu !== null ? (
        <Card tone="soft">
          <Text variant="heading">{t('sim.sisu', { n: String(sisu).replace('.', ',') })}</Text>
          {primary ? <Text variant="bodySmall">{t('sisu.cutoff.note')}</Text> : null}
        </Card>
      ) : null}
      <EstimateFootnote />
      <View style={{ gap: space.sm }}>
        {wrongIds.length > 0 ? (
          <Button
            icon="refresh"
            label={t('sim.review_errors')}
            onPress={() => router.push({ pathname: '/practice/result/[attemptId]', params: { attemptId, k: String(rows.reduce((s, r) => s + r.correct, 0)), n: String(rows.reduce((s, r) => s + r.items, 0)) } })}
          />
        ) : null}
        <Button variant="text" label={t('global.back')} onPress={() => router.replace('/enem')} />
      </View>
    </Screen>
  );
}
