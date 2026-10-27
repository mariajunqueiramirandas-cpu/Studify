// ENEM topic statistics, trends, predicted shares and personal priorities (spec 08 §8.4, ENM-08.1–08.3).
// Global statistics are deterministic: the same bank always yields the same rows.
import type { EnemApplication, EnemArea, TopicTrend } from '../core/enums.ts';

export const TREND_UP_RATIO = 1.25;
export const TREND_DOWN_RATIO = 0.75;
export const TREND_MIN_ITEMS = 2;
export const PREDICT_RECENT_WEIGHT = 0.7;
/** Unknown mastery for priorities: not zero, so ranking is not pure frequency. */
export const UNKNOWN_TOPIC_MASTERY = 0.3;

export interface StatItem {
  id: string;
  edition_year: number;
  area: EnemArea;
  application: EnemApplication;
  annulled: boolean;
  enem_topic_ids: readonly string[];
}

export interface TopicStatRow {
  enem_topic_id: string;
  edition_year: number;
  area: EnemArea;
  item_count: number;
  area_item_count: number;
  share: number;
}

/**
 * Per-edition topic counts and shares (§8.4): regular application only (unless `includeOther`), annulled items
 * excluded, each item counted once per topic. Rows only for topics with at least one item that edition.
 */
export function topicStats(items: readonly StatItem[], opts: { includeOther?: boolean } = {}): TopicStatRow[] {
  const universe = items.filter((i) => !i.annulled && (opts.includeOther || i.application === 'regular'));
  const areaCount = new Map<string, number>();
  const topicCount = new Map<string, { topic: string; year: number; area: EnemArea; n: number }>();
  const seen = new Set<string>();
  for (const item of universe) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const ak = `${item.area}|${item.edition_year}`;
    areaCount.set(ak, (areaCount.get(ak) ?? 0) + 1);
    for (const topic of new Set(item.enem_topic_ids)) {
      const tk = `${topic}|${item.edition_year}`;
      const row = topicCount.get(tk) ?? { topic, year: item.edition_year, area: item.area, n: 0 };
      row.n += 1;
      topicCount.set(tk, row);
    }
  }
  const rows: TopicStatRow[] = [];
  for (const r of topicCount.values()) {
    const total = areaCount.get(`${r.area}|${r.year}`) ?? 0;
    rows.push({ enem_topic_id: r.topic, edition_year: r.year, area: r.area, item_count: r.n, area_item_count: total, share: total > 0 ? r.n / total : 0 });
  }
  return rows.sort((a, b) => a.enem_topic_id.localeCompare(b.enem_topic_id) || a.edition_year - b.edition_year);
}

/** Imported editions per area (newest first), from the stat universe. */
export function editionsByArea(items: readonly StatItem[], opts: { includeOther?: boolean } = {}): Record<EnemArea, number[]> {
  const out: Record<EnemArea, Set<number>> = { LC: new Set(), CH: new Set(), CN: new Set(), MT: new Set() };
  for (const i of items) if (!i.annulled && (opts.includeOther || i.application === 'regular')) out[i.area].add(i.edition_year);
  const sorted = (s: Set<number>) => [...s].sort((a, b) => b - a);
  return { LC: sorted(out.LC), CH: sorted(out.CH), CN: sorted(out.CN), MT: sorted(out.MT) };
}

export interface TopicTrendRow {
  enem_topic_id: string;
  area: EnemArea;
  share_last10: number;
  share_recent5: number;
  share_prev5: number;
  trend: TopicTrend;
  predicted_share: number;
  /** Editions (of the last 10) where the topic appeared: the "apareceu em 9 das últimas 10 edições" evidence. */
  appeared_last10: number;
  editions_last10: number;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/**
 * Trends and predicted shares (§8.4). Shares of editions where a topic has no item count as 0. `up` needs
 * recent5 ≥ 1.25 × prev5 and ≥ 2 items in the recent window; `down` needs recent5 ≤ 0.75 × prev5 and ≥ 2 items
 * in the previous window; with no previous window the trend is flat. predicted = 0.7·recent5 + 0.3·last10,
 * renormalized per area.
 */
export function topicTrends(stats: readonly TopicStatRow[], editions: Record<EnemArea, readonly number[]>, topicArea: ReadonlyMap<string, EnemArea>): TopicTrendRow[] {
  const byTopic = new Map<string, Map<number, TopicStatRow>>();
  for (const r of stats) {
    const m = byTopic.get(r.enem_topic_id) ?? new Map<number, TopicStatRow>();
    m.set(r.edition_year, r);
    byTopic.set(r.enem_topic_id, m);
  }
  const rows: TopicTrendRow[] = [];
  for (const [topic, area] of [...topicArea.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const years = [...(editions[area] ?? [])].sort((a, b) => b - a);
    const last10 = years.slice(0, 10);
    const recent5 = years.slice(0, 5);
    const prev5 = years.slice(5, 10);
    const m = byTopic.get(topic) ?? new Map<number, TopicStatRow>();
    const shareOf = (y: number) => m.get(y)?.share ?? 0;
    const countIn = (ys: readonly number[]) => ys.reduce((s, y) => s + (m.get(y)?.item_count ?? 0), 0);
    const sLast10 = mean(last10.map(shareOf));
    const sRecent = mean(recent5.map(shareOf));
    const sPrev = mean(prev5.map(shareOf));
    let trend: TopicTrend = 'flat';
    if (prev5.length > 0) {
      if (sRecent >= TREND_UP_RATIO * sPrev && countIn(recent5) >= TREND_MIN_ITEMS && sRecent > sPrev) trend = 'up';
      else if (sRecent <= TREND_DOWN_RATIO * sPrev && countIn(prev5) >= TREND_MIN_ITEMS && sRecent < sPrev) trend = 'down';
    }
    rows.push({
      enem_topic_id: topic,
      area,
      share_last10: sLast10,
      share_recent5: sRecent,
      share_prev5: sPrev,
      trend,
      predicted_share: PREDICT_RECENT_WEIGHT * sRecent + (1 - PREDICT_RECENT_WEIGHT) * sLast10,
      appeared_last10: last10.filter((y) => (m.get(y)?.item_count ?? 0) > 0).length,
      editions_last10: last10.length,
    });
  }
  // Renormalize per area.
  for (const area of ['LC', 'CH', 'CN', 'MT'] as const) {
    const inArea = rows.filter((r) => r.area === area);
    const total = inArea.reduce((s, r) => s + r.predicted_share, 0);
    for (const r of inArea) r.predicted_share = total > 0 ? r.predicted_share / total : 0;
  }
  return rows;
}

export interface TopicLink {
  node_id: string;
  enem_topic_id: string;
  confidence: number;
}

/**
 * Student mastery per ENEM topic: the confidence-weighted mean of the mastery of the student's nodes linked to it
 * (knowledge_node_enem_topics). Topics with no linked node that has evidence are absent (unknown).
 */
export function enemTopicMastery(links: readonly TopicLink[], nodeMastery: ReadonlyMap<string, number | null | undefined>): Map<string, number> {
  const acc = new Map<string, { w: number; m: number }>();
  for (const l of links) {
    const m = nodeMastery.get(l.node_id);
    if (m === null || m === undefined || l.confidence <= 0) continue;
    const a = acc.get(l.enem_topic_id) ?? { w: 0, m: 0 };
    a.w += l.confidence;
    a.m += l.confidence * m;
    acc.set(l.enem_topic_id, a);
  }
  const out = new Map<string, number>();
  for (const [t, a] of acc) out.set(t, a.m / a.w);
  return out;
}

export interface TopicPriority {
  enem_topic_id: string;
  area: EnemArea;
  priority: number;
  predicted_share: number;
  mastery: number | null;
}

/**
 * ENM-08.3: priority_t = predicted_share_t × (1 − mastery_t) × w_a / max(w). Unknown mastery counts as 0.3.
 * Area weights default to 1 (no Meta SISU). Sorted by priority, then topic id.
 */
export function topicPriorities(
  trends: ReadonlyArray<Pick<TopicTrendRow, 'enem_topic_id' | 'area' | 'predicted_share'>>,
  mastery: ReadonlyMap<string, number>,
  areaWeights: Partial<Record<EnemArea, number>> = {},
): TopicPriority[] {
  const w = (a: EnemArea) => areaWeights[a] ?? 1;
  const maxW = Math.max(...(['LC', 'CH', 'CN', 'MT'] as const).map(w), 1e-9);
  return trends
    .map((t) => {
      const m = mastery.get(t.enem_topic_id);
      const known = m === undefined ? null : Math.min(1, Math.max(0, m));
      return {
        enem_topic_id: t.enem_topic_id,
        area: t.area,
        predicted_share: t.predicted_share,
        mastery: known,
        priority: t.predicted_share * (1 - (known ?? UNKNOWN_TOPIC_MASTERY)) * (w(t.area) / maxW),
      };
    })
    .sort((a, b) => b.priority - a.priority || a.enem_topic_id.localeCompare(b.enem_topic_id));
}
