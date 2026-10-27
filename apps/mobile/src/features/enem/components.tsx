// ENEM UI pieces shared by the ENEM screens and the quiz runner: score bars with the 80% interval, the
// "Nota estimada" label (ENM-04.10), the skill grid (ENM-01.5), official item crops with the transcription toggle
// and attribution (ENM-02.2/02.7), the texto-base of ENEM-style questions (ENM-03.3) and the redação result parts.
import { useState } from 'react';
import { Image, Linking, Pressable, View } from 'react-native';
import type { EnemArea } from '@studify/shared';
import { Banner, Button, Card, RichContent, Row, Text } from '../../components';
import { t } from '../../i18n';
import { radius, space, useTheme } from '../../theme';
import { useCropUrls, type EnemEssayRow } from './api';
import { masteryTone, scalePos, type CompetencyGroup } from './format';

export function areaName(area: EnemArea | 'RED'): string {
  return t(`enem.area.${area}`);
}

/** "Nota estimada (TRI)" + the footnote: every TRI number carries it (ENM-04.10). */
export function EstimateFootnote() {
  return (
    <Text variant="caption" tone="secondary">
      {t('sim.score.footnote')}
    </Text>
  );
}

/** A score on the 300–900 scale with its 80% interval and an optional target marker. */
export function ScoreBar({ score, low, high, target }: { score: number; low?: number; high?: number; target?: number | null }) {
  const { colors: c } = useTheme();
  const pct = (v: number) => `${Math.round(scalePos(v) * 100)}%` as const;
  return (
    <View
      style={{ height: 14, borderRadius: radius.pill, backgroundColor: c.surface2, justifyContent: 'center' }}
      accessibilityRole="image"
      accessibilityLabel={t('enem.score_a11y', { score, low: low ?? score, high: high ?? score })}
    >
      {low !== undefined && high !== undefined ? (
        <View style={{ position: 'absolute', left: pct(low), width: `${Math.max(1, Math.round((scalePos(high) - scalePos(low)) * 100))}%`, top: 3, bottom: 3, borderRadius: radius.pill, backgroundColor: c.primarySoft }} />
      ) : null}
      <View style={{ position: 'absolute', left: pct(score), width: 4, marginLeft: -2, top: 0, bottom: 0, borderRadius: 2, backgroundColor: c.primary }} />
      {target ? <View style={{ position: 'absolute', left: pct(target), width: 2, top: -3, bottom: -3, backgroundColor: c.success }} /> : null}
    </View>
  );
}

export function AreaCard({ area, score, low, high, target, onPress }: { area: EnemArea | 'RED'; score: number | null; low?: number; high?: number; target?: number | null; onPress?: () => void }) {
  return (
    <Card onPress={onPress} accessibilityLabel={areaName(area)}>
      <Row>
        <Text variant="label" style={{ flex: 1 }}>
          {areaName(area)}
        </Text>
        <Text variant="heading">{score !== null ? Math.round(score) : '—'}</Text>
      </Row>
      {score !== null ? <ScoreBar score={score} low={low} high={high} target={target} /> : <Text variant="bodySmall" tone="secondary">{area === 'RED' ? t('enem.no_essay_yet') : t('enem.no_simulado_yet', { area: areaName(area) })}</Text>}
      {target ? (
        <Text variant="caption" tone="secondary">
          {t('enem.target', { n: target })}
        </Text>
      ) : null}
    </Card>
  );
}

/** ENM-01.5: H1–H30 grouped by competência, colored by the student's accuracy. */
export function SkillGrid({ groups, onPress }: { groups: CompetencyGroup[]; onPress: (code: string) => void }) {
  const { colors: c } = useTheme();
  const bg = { none: c.surface2, low: c.dangerSoft, mid: c.warningSoft, high: c.successSoft } as const;
  return (
    <View style={{ gap: space.sm }}>
      {groups.map((g) => (
        <View key={g.competency} style={{ gap: space.xs }}>
          <Text variant="caption" tone="secondary">
            {t('enem.competency', { n: g.competency })}
          </Text>
          <Row wrap>
            {g.skills.map((s) => (
              <Pressable
                key={s.code}
                onPress={() => onPress(s.code)}
                accessibilityRole="button"
                accessibilityLabel={s.accuracy === null ? t('enem.skill_a11y_none', { code: s.code }) : t('enem.skill_a11y', { code: s.code, pct: Math.round(s.accuracy * 100), n: s.answered })}
                style={{ width: 52, height: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: bg[masteryTone(s)] }}
              >
                <Text variant="label">H{s.skill}</Text>
                {s.accuracy !== null ? <Text variant="caption">{Math.round(s.accuracy * 100)}%</Text> : null}
              </Pressable>
            ))}
          </Row>
        </View>
      ))}
    </View>
  );
}

export interface EnemItemMeta {
  item_id: string;
  edition_year: number;
  day: number;
  position: number | null;
  annulled: boolean;
  crop_paths: string[];
  alt_text: string | null;
}

/** Official item: crops as printed, transcription toggle, annulled banner and the Inep attribution. */
export function EnemItemHeader({ meta, transcription }: { meta: EnemItemMeta; transcription: string }) {
  const crops = useCropUrls(meta.crop_paths);
  const [showText, setShowText] = useState(false);
  const { colors: c } = useTheme();
  return (
    <View style={{ gap: space.sm }}>
      {meta.annulled ? <Banner kind="warning" message={t('bank.annulled')} /> : null}
      {!showText && (crops.data ?? []).length > 0 ? (
        (crops.data ?? []).map((uri, i) => (
          <Image
            key={uri}
            source={{ uri }}
            accessible
            accessibilityLabel={meta.alt_text ?? t('bank.crop_a11y', { n: i + 1 })}
            style={{ width: '100%', aspectRatio: 0.9, resizeMode: 'contain', backgroundColor: c.surface1, borderRadius: radius.md }}
          />
        ))
      ) : (
        <RichContent text={transcription} />
      )}
      {meta.crop_paths.length > 0 ? <Button compact variant="text" label={showText ? t('bank.show_original') : t('bank.show_transcription')} onPress={() => setShowText((v) => !v)} /> : null}
      <Text variant="caption" tone="secondary">
        {t('bank.source', { ano: meta.edition_year, dia: meta.day, n: meta.position ?? '?' })}
      </Text>
    </View>
  );
}

export interface TextoBase {
  kind: 'excerpt' | 'written' | 'chart' | 'table';
  content_md: string;
  chart_data?: { type: 'bar' | 'line' | 'pie'; title: string; x_label: string | null; y_label: string | null; series: Array<{ name: string; points: Array<{ x: string; y: number }> }> } | null;
  label?: string | null;
}

/** ENM-03.3 texto-base: quoted material, a Studify-written context (labeled), a chart or a table. */
export function TextoBaseView({ value }: { value: TextoBase }) {
  const { colors: c } = useTheme();
  const series = value.chart_data?.series ?? [];
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => Math.abs(p.y))));
  return (
    <View style={{ backgroundColor: c.surface2, borderRadius: radius.md, padding: space.md, gap: space.sm }}>
      {value.kind === 'chart' && value.chart_data ? (
        <View style={{ gap: space.xs }} accessibilityRole="image" accessibilityLabel={value.chart_data.title}>
          <Text variant="label">{value.chart_data.title}</Text>
          {series.map((s) => (
            <View key={s.name} style={{ gap: 2 }}>
              {series.length > 1 ? <Text variant="caption">{s.name}</Text> : null}
              {s.points.map((p) => (
                <Row key={p.x}>
                  <Text variant="caption" style={{ width: 90 }}>
                    {p.x}
                  </Text>
                  <View style={{ flex: 1, height: 10, borderRadius: radius.pill, backgroundColor: c.surface1 }}>
                    <View style={{ width: `${Math.round((Math.abs(p.y) / max) * 100)}%`, height: 10, borderRadius: radius.pill, backgroundColor: c.primary }} />
                  </View>
                  <Text variant="caption" style={{ width: 48, textAlign: 'right' }}>
                    {String(p.y).replace('.', ',')}
                  </Text>
                </Row>
              ))}
            </View>
          ))}
          {value.chart_data.y_label ? <Text variant="caption" tone="secondary">{value.chart_data.y_label}</Text> : null}
        </View>
      ) : null}
      {value.kind !== 'chart' || !value.chart_data ? <RichContent text={value.content_md} variant="bodySmall" /> : null}
      {value.kind === 'written' ? (
        <Text variant="caption" tone="secondary">
          {t('gen.text.written')}
        </Text>
      ) : value.label ? (
        <Text variant="caption" tone="secondary">
          {value.label}
        </Text>
      ) : null}
    </View>
  );
}

const PROPOSTA_KEYS = ['agente', 'acao', 'meio', 'finalidade', 'detalhamento'] as const;

/** ENM-05.4: the five elements of the proposta, each ✅/❌ with the quote, and the human-rights check. */
export function PropostaChecklist({ proposta }: { proposta: NonNullable<EnemEssayRow['proposta']> }) {
  return (
    <Card>
      <Text variant="heading">{t('red.proposta.title')}</Text>
      {PROPOSTA_KEYS.map((k) => (
        <View key={k} style={{ gap: 2 }}>
          <Text variant="label">
            {proposta[k].present ? '✅' : '❌'} {t(`red.proposta.${k}`)}
          </Text>
          {proposta[k].quote ? (
            <Text variant="bodySmall" tone="secondary">
              “{proposta[k].quote}”
            </Text>
          ) : null}
        </View>
      ))}
      {!proposta.direitos_humanos_ok ? <Banner kind="danger" message={t('red.hr.zero')} /> : null}
      {proposta.note ? <Text variant="bodySmall">{proposta.note}</Text> : null}
    </Card>
  );
}

const REP_ICON = { confirmed: '✅', not_found: '⚠️', unverified: '⚠️', contradicted: '❌' } as const;

/** ENM-05.5: every factual reference with its verification status and source. */
export function RepertorioChecks({ items }: { items: NonNullable<EnemEssayRow['repertorio']> }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <Text variant="heading">{t('red.repertorio.title')}</Text>
      {items.map((r, i) => (
        <View key={`${i}-${r.text}`} style={{ gap: 2 }}>
          <Text variant="label">
            {REP_ICON[r.status]} {r.text}
          </Text>
          <Text variant="bodySmall" tone="secondary">
            {r.status === 'confirmed' ? t('red.repertorio.confirmed') : r.status === 'contradicted' ? t('red.repertorio.contradicted') : t('red.repertorio.unverified')}
            {r.note ? ` ${r.note}` : ''}
          </Text>
          {r.source_url ? <Button compact variant="text" label={r.source_name ?? r.source_url} onPress={() => void Linking.openURL(r.source_url!)} /> : null}
        </View>
      ))}
    </Card>
  );
}
