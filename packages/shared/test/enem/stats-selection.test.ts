import { describe, expect, it } from 'vitest';
import {
  editionsByArea,
  enemTopicMastery,
  examOrder,
  selectMisto,
  selectProvavel,
  selectReplica,
  topicPriorities,
  topicStats,
  topicTrends,
  type PoolItem,
  type StatItem,
} from '../../src/enem/index.ts';

/** 12 editions (2013–2024) of MT with 3 topics: T-up grows, T-down shrinks, T-flat stays. */
function mtBank(): StatItem[] {
  const items: StatItem[] = [];
  for (let y = 2013; y <= 2024; y++) {
    const recent = y >= 2020;
    const counts: Record<string, number> = { 'T-up': recent ? 8 : 2, 'T-down': recent ? 2 : 8, 'T-flat': 5 };
    let n = 0;
    for (const [topic, c] of Object.entries(counts)) {
      for (let i = 0; i < c; i++) items.push({ id: `${y}-${n++}`, edition_year: y, area: 'MT', application: 'regular', annulled: false, enem_topic_ids: [topic] });
    }
    // Untagged items fill the 45.
    while (n < 45) items.push({ id: `${y}-${n++}`, edition_year: y, area: 'MT', application: 'regular', annulled: false, enem_topic_ids: [] });
  }
  // Excluded from statistics: an annulled item and a PPL item.
  items.push({ id: 'annulled', edition_year: 2024, area: 'MT', application: 'regular', annulled: true, enem_topic_ids: ['T-flat'] });
  items.push({ id: 'ppl', edition_year: 2024, area: 'MT', application: 'ppl', annulled: false, enem_topic_ids: ['T-flat'] });
  return items;
}

describe('ENEM topic statistics and trends (spec 08 §8.4)', () => {
  const bank = mtBank();
  const stats = topicStats(bank);
  const editions = editionsByArea(bank);
  const area = new Map([
    ['T-up', 'MT' as const],
    ['T-down', 'MT' as const],
    ['T-flat', 'MT' as const],
    ['T-never', 'MT' as const],
  ]);
  const trends = topicTrends(stats, editions, area);
  const byId = new Map(trends.map((t) => [t.enem_topic_id, t]));

  it('shares are items / area items per edition, excluding annulled and PPL items', () => {
    const flat2024 = stats.find((s) => s.enem_topic_id === 'T-flat' && s.edition_year === 2024)!;
    expect(flat2024).toMatchObject({ item_count: 5, area_item_count: 45 });
    expect(flat2024.share).toBeCloseTo(5 / 45, 10);
    expect(editions.MT).toHaveLength(12);
    expect(editions.MT[0]).toBe(2024);
  });

  it('labels up / down / flat with the 1.25 and 0.75 ratios', () => {
    expect(byId.get('T-up')!.trend).toBe('up');
    expect(byId.get('T-down')!.trend).toBe('down');
    expect(byId.get('T-flat')!.trend).toBe('flat');
    expect(byId.get('T-never')!.trend).toBe('flat');
  });

  it('predicted share = 0.7·recent5 + 0.3·last10, renormalized per area', () => {
    const sum = trends.reduce((s, t) => s + t.predicted_share, 0);
    expect(sum).toBeCloseTo(1, 10);
    const up = byId.get('T-up')!;
    // Recent 5 = 2020–2024 (8/45 each); last 10 = 2015–2024 (5 × 8/45 + 5 × 2/45).
    expect(up.share_recent5).toBeCloseTo(8 / 45, 10);
    expect(up.share_last10).toBeCloseTo((5 * 8 + 5 * 2) / 450, 10);
    expect(up.appeared_last10).toBe(10);
    expect(byId.get('T-never')!.predicted_share).toBe(0);
  });

  it('needs ≥ 2 items before calling a trend', () => {
    const sparse: StatItem[] = [];
    for (let y = 2015; y <= 2024; y++) {
      sparse.push({ id: `s${y}`, edition_year: y, area: 'CN', application: 'regular', annulled: false, enem_topic_ids: y === 2024 ? ['rare'] : [] });
    }
    const t = topicTrends(topicStats(sparse), editionsByArea(sparse), new Map([['rare', 'CN' as const]]));
    expect(t[0]!.trend).toBe('flat');
  });

  it('is reproducible', () => {
    expect(topicTrends(topicStats(mtBank()), editionsByArea(mtBank()), area)).toEqual(trends);
  });

  it('personal priority = predicted × (1 − mastery) × w/max(w); unknown mastery counts as 0.3', () => {
    const mastery = enemTopicMastery(
      [
        { node_id: 'n1', enem_topic_id: 'T-up', confidence: 1 },
        { node_id: 'n2', enem_topic_id: 'T-up', confidence: 0.5 },
        { node_id: 'n3', enem_topic_id: 'T-down', confidence: 0.8 },
      ],
      new Map([
        ['n1', 0.9],
        ['n2', 0.3],
        ['n3', null],
      ]),
    );
    expect(mastery.get('T-up')).toBeCloseTo((0.9 + 0.15) / 1.5, 10);
    expect(mastery.has('T-down')).toBe(false);
    const p = topicPriorities(trends, mastery, { MT: 3, LC: 1 });
    const flat = p.find((x) => x.enem_topic_id === 'T-flat')!;
    expect(flat.priority).toBeCloseTo(byId.get('T-flat')!.predicted_share * 0.7 * 1, 10);
    expect(flat.mastery).toBeNull();
    expect(p[p.length - 1]!.enem_topic_id).toBe('T-never');
  });
});

/** Pool: 4 editions × 45 LC items (5 en + 5 es language items, 35 others) and 45 MT items. */
function pool(): PoolItem[] {
  const out: PoolItem[] = [];
  for (const y of [2021, 2022, 2023, 2024]) {
    for (let i = 1; i <= 5; i++) out.push({ id: `LC-${y}-en${i}`, question_id: `q-LC-${y}-en${i}`, edition_year: y, application: 'regular', area: 'LC', position: i, language: 'en', annulled: false, b: -1 + i * 0.2, enem_topic_ids: ['lang'] });
    for (let i = 1; i <= 5; i++) out.push({ id: `LC-${y}-es${i}`, question_id: `q-LC-${y}-es${i}`, edition_year: y, application: 'regular', area: 'LC', position: i, language: 'es', annulled: false, b: -1 + i * 0.2, enem_topic_ids: ['lang'] });
    for (let i = 6; i <= 45; i++) {
      out.push({ id: `LC-${y}-${i}`, question_id: `q-LC-${y}-${i}`, edition_year: y, application: 'regular', area: 'LC', position: i, language: null, annulled: i === 7, b: -2 + (i % 20) * 0.2, enem_topic_ids: [i % 2 ? 'interp' : 'lit'] });
    }
    for (let i = 1; i <= 45; i++) {
      out.push({ id: `MT-${y}-${i}`, question_id: `q-MT-${y}-${i}`, edition_year: y, application: 'regular', area: 'MT', position: i, language: null, annulled: false, b: i === 3 ? null : -2 + (i % 15) * 0.3, enem_topic_ids: [i % 3 === 0 ? 'geo' : i % 3 === 1 ? 'func' : 'stat'] });
    }
  }
  return out;
}

describe('Simulado item selection (spec 08 §8.5, ENM-04.2)', () => {
  const items = pool();
  const byId = new Map(items.map((i) => [i.id, i]));

  it('Réplica: one edition as applied, without annulled or parameterless items, in exam order', () => {
    const s = selectReplica(items, { areas: ['LC', 'MT'], edition: 2023, language: 'es' });
    const lc = s.byArea.LC!;
    expect(lc.slice(0, 5)).toEqual(['LC-2023-es1', 'LC-2023-es2', 'LC-2023-es3', 'LC-2023-es4', 'LC-2023-es5']);
    expect(lc).not.toContain('LC-2023-7');
    expect(lc.some((id) => id.includes('en'))).toBe(false);
    expect(s.byArea.MT).not.toContain('MT-2023-3');
    expect(s.shortfall).toEqual({ LC: 1, MT: 1 });
    expect(s.item_ids.indexOf('MT-2023-1')).toBeGreaterThan(s.item_ids.indexOf('LC-2023-45'));
  });

  it('Provável: quotas follow the predicted shares, the language set is one edition of the chosen language', () => {
    const shares = new Map([
      ['interp', 0.6],
      ['lit', 0.4],
    ]);
    const s = selectProvavel(items, { areas: ['LC'], size: 45, language: 'en', seed: 'u1', predictedShares: shares });
    const lc = s.byArea.LC!.map((id) => byId.get(id)!);
    expect(lc).toHaveLength(45);
    const lang = lc.filter((i) => i.language !== null);
    expect(lang).toHaveLength(5);
    expect(new Set(lang.map((i) => i.edition_year)).size).toBe(1);
    expect(lang.every((i) => i.language === 'en')).toBe(true);
    expect(lc.filter((i) => i.enem_topic_ids.includes('interp'))).toHaveLength(24);
    expect(lc.filter((i) => i.enem_topic_ids.includes('lit'))).toHaveLength(16);
    expect(lc.every((i) => !i.annulled && i.b !== null)).toBe(true);
    expect(new Set(s.item_ids).size).toBe(45);
  });

  it('is deterministic per seed and avoids answered items when possible', () => {
    const shares = new Map([
      ['geo', 0.5],
      ['func', 0.3],
      ['stat', 0.2],
    ]);
    const answered = new Set(items.filter((i) => i.area === 'MT' && i.edition_year === 2024).map((i) => i.question_id));
    const a = selectProvavel(items, { areas: ['MT'], size: 45, language: 'en', seed: 's', predictedShares: shares, answered });
    const b = selectProvavel(items, { areas: ['MT'], size: 45, language: 'en', seed: 's', predictedShares: shares, answered });
    expect(a).toEqual(b);
    expect(a.byArea.MT!.some((id) => id.startsWith('MT-2024'))).toBe(false);
    const c = selectProvavel(items, { areas: ['MT'], size: 45, language: 'en', seed: 'other', predictedShares: shares, answered });
    expect(c.item_ids).not.toEqual(a.item_ids);
  });

  it('redistributes a quota the pool cannot fill', () => {
    const shares = new Map([
      ['missing', 0.5],
      ['geo', 0.5],
    ]);
    const s = selectProvavel(items, { areas: ['MT'], size: 45, language: 'en', seed: 'x', predictedShares: shares });
    expect(s.byArea.MT).toHaveLength(45);
    expect(s.shortfall).toEqual({});
  });

  it('Misto keeps the difficulty mix near the reference quartiles', () => {
    const s = selectMisto(items, { areas: ['MT'], size: 40, language: 'en', seed: 'm', referenceEdition: 2022 });
    const bs = s.byArea.MT!.map((id) => byId.get(id)!.b!);
    const ref = items.filter((i) => i.area === 'MT' && i.edition_year === 2022 && i.b !== null).map((i) => i.b!).sort((x, y) => x - y);
    const q1 = ref[Math.floor(ref.length / 4)]!;
    const below = bs.filter((b) => b < q1).length;
    expect(below).toBeGreaterThanOrEqual(6);
    expect(below).toBeLessThanOrEqual(14);
    expect(new Set(s.byArea.MT!.map((id) => byId.get(id)!.edition_year)).size).toBeGreaterThan(1);
  });

  it('orders LC language items first, then by position', () => {
    const ordered = examOrder([byId.get('MT-2022-1')!, byId.get('LC-2022-10')!, byId.get('LC-2021-en2')!]);
    expect(ordered.map((i) => i.id)).toEqual(['LC-2021-en2', 'LC-2022-10', 'MT-2022-1']);
  });
});
