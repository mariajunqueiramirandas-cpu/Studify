import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, { G, Line, Rect, Text as SvgText } from 'react-native-svg';
import { Banner, Card, EmptyState, Row, Screen, Section, Text } from '../../../components';
import { useCalibration } from '../../../features/practice/api';
import { formatNumber } from '../../../features/common/format';
import { options, t } from '../../../i18n';
import { space, useTheme } from '../../../theme';

// PRA-05 expected accuracy per confidence level (learning-engine §8, 5-option MCQ baseline).
const EXPECTED = [0.3, 0.6, 0.8, 0.95];

/** S-PRA-11 Medidor de Confiança: calibration chart + insights (PRA-05). */
export default function Calibration() {
  const data = useCalibration();
  const { colors } = useTheme();
  const levels = options('quiz.confidence.levels');

  const buckets = useMemo(() => {
    const out = [1, 2, 3, 4].map((c) => ({ c, n: 0, k: 0 }));
    for (const r of data.data ?? []) {
      const b = out[r.confidence - 1];
      if (b) {
        b.n += r.n;
        b.k += r.n_correct;
      }
    }
    return out;
  }, [data.data]);
  const total = buckets.reduce((s, b) => s + b.n, 0);
  // Brier score over buckets: mean (expected − outcome)².
  const brier = total
    ? buckets.reduce((s, b, i) => s + b.k * (EXPECTED[i]! - 1) ** 2 + (b.n - b.k) * EXPECTED[i]! ** 2, 0) / total
    : null;
  const gap = total ? buckets.reduce((s, b, i) => s + (b.n ? (EXPECTED[i]! - b.k / b.n) * b.n : 0), 0) / total : 0;
  const verdict = total < 12 ? null : Math.abs(gap) <= 0.1 ? t('calibration.well_calibrated') : gap > 0 ? t('calibration.overconfident') : t('calibration.underconfident');

  if (data.isFetched && total === 0) {
    return (
      <Screen title={t('calibration.title')}>
        <EmptyState icon="speedometer-outline" message={t('calibration.empty')} />
      </Screen>
    );
  }

  const W = 320;
  const H = 180;
  const bw = W / 4 - 16;
  return (
    <Screen title={t('calibration.title')}>
      {verdict ? <Banner kind="info" message={verdict} /> : null}
      <Card>
        <Text variant="label">{t('calibration.chart_title')}</Text>
        <Svg width="100%" height={H + 40} viewBox={`0 0 ${W} ${H + 40}`} accessibilityLabel={buckets.map((b, i) => `${levels[i]}: ${b.n ? Math.round((b.k / b.n) * 100) : 0}%`).join('. ')}>
          {buckets.map((b, i) => {
            const x = i * (W / 4) + 8;
            const acc = b.n ? b.k / b.n : 0;
            const exp = EXPECTED[i]!;
            return (
              <G key={b.c}>
                <Rect x={x} y={H - acc * H} width={bw} height={acc * H} fill={colors.primary} rx={4} />
                <Line x1={x - 2} x2={x + bw + 2} y1={H - exp * H} y2={H - exp * H} stroke={colors.textSecondary} strokeWidth={2} strokeDasharray="4 3" />
                <SvgText x={x + bw / 2} y={H + 16} fontSize={11} fill={colors.textSecondary} textAnchor="middle">
                  {(levels[i] ?? '').split(' ')[0]}
                </SvgText>
                <SvgText x={x + bw / 2} y={H + 32} fontSize={11} fill={colors.textPrimary} textAnchor="middle">
                  {b.n ? `${Math.round(acc * 100)}%` : '—'}
                </SvgText>
              </G>
            );
          })}
        </Svg>
        <Row>
          <View style={{ width: 14, height: 14, backgroundColor: colors.primary, borderRadius: 3 }} />
          <Text variant="bodySmall">{t('calibration.actual')}</Text>
          <View style={{ width: 18, height: 2, backgroundColor: colors.textSecondary, marginLeft: space.md }} />
          <Text variant="bodySmall">{t('calibration.expected')}</Text>
        </Row>
      </Card>
      {brier != null ? (
        <Section>
          <Text variant="heading">{t('calibration.brier', { score: formatNumber(brier, 2) })}</Text>
          <Text tone="secondary">{t('calibration.brier_hint')}</Text>
        </Section>
      ) : null}
    </Screen>
  );
}
