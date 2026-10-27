// Simulado item selection (spec 09 ENM-04.2, spec 08 §8.5): Réplica (a past edition as applied), Misto (several
// editions matched to a real edition's difficulty mix) and Provável (topic quotas from predicted shares).
// Only official, non-annulled items with TRI parameters are used. Deterministic per seed.
import type { EnemArea, EnemLanguage } from '../core/enums.ts';
import { largestRemainder } from '../planning/util.ts';
import { seededRandom, seededShuffle } from '../learning/rng.ts';
import { ENEM_LANGUAGE_ITEMS } from './skills.ts';

export interface PoolItem {
  /** enem_items.id */
  id: string;
  question_id: string;
  edition_year: number;
  application: 'regular' | 'ppl' | 'other';
  area: EnemArea;
  /** Position of the item inside its area test (1–45; language items are 1–5 of LC). */
  position: number;
  language: EnemLanguage | null;
  annulled: boolean;
  /** b on the standardized scale; null = no TRI parameters (not usable in a simulado). */
  b: number | null;
  enem_topic_ids: readonly string[];
}

export interface Selection {
  item_ids: string[];
  question_ids: string[];
  /** Items per area in exam order. */
  byArea: Partial<Record<EnemArea, string[]>>;
  /** Quotas that could not be filled from the pool (shortfall per area). */
  shortfall: Partial<Record<EnemArea, number>>;
}

const AREA_ORDER: readonly EnemArea[] = ['LC', 'CH', 'CN', 'MT'];

function usable(item: PoolItem, language: EnemLanguage): boolean {
  return !item.annulled && item.b !== null && item.application === 'regular' && (item.language === null || item.language === language);
}

/** ENEM order: area (LC, CH, CN, MT), language items first in LC, then position, then edition (newest first). */
export function examOrder(items: readonly PoolItem[]): PoolItem[] {
  return [...items].sort(
    (a, b) =>
      AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area) ||
      Number(b.language !== null) - Number(a.language !== null) ||
      a.position - b.position ||
      b.edition_year - a.edition_year ||
      a.id.localeCompare(b.id),
  );
}

function finish(chosen: Map<EnemArea, PoolItem[]>, shortfall: Partial<Record<EnemArea, number>>): Selection {
  const ordered = examOrder([...chosen.values()].flat());
  const byArea: Partial<Record<EnemArea, string[]>> = {};
  for (const i of ordered) (byArea[i.area] ??= []).push(i.id);
  return { item_ids: ordered.map((i) => i.id), question_ids: ordered.map((i) => i.question_id), byArea, shortfall };
}

/** Réplica: every usable item of one edition for the areas, exactly as applied. */
export function selectReplica(pool: readonly PoolItem[], input: { areas: readonly EnemArea[]; edition: number; language: EnemLanguage }): Selection {
  const chosen = new Map<EnemArea, PoolItem[]>();
  const shortfall: Partial<Record<EnemArea, number>> = {};
  for (const area of input.areas) {
    const items = pool.filter((i) => i.area === area && i.edition_year === input.edition && usable(i, input.language));
    chosen.set(area, items);
    if (items.length < 45) shortfall[area] = 45 - items.length;
  }
  return finish(chosen, shortfall);
}

type Band = 0 | 1 | 2 | 3;

function bandOf(b: number, q: readonly [number, number, number]): Band {
  if (b < q[0]) return 0;
  if (b < q[1]) return 1;
  if (b < q[2]) return 2;
  return 3;
}

function quartilesOf(values: readonly number[]): [number, number, number] {
  const s = [...values].sort((x, y) => x - y);
  if (s.length === 0) return [0, 0, 0];
  const at = (q: number) => {
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  };
  return [at(0.25), at(0.5), at(0.75)];
}

interface Picker {
  take(candidates: readonly PoolItem[], n: number): PoolItem[];
}

/**
 * Picks items keeping the band mix close to the reference (each quartile of the reference edition's `b` gets a
 * quarter of the slots). Candidates come in preference order: not answered first, newer editions first, then a
 * seeded shuffle.
 */
function bandPicker(reference: readonly [number, number, number], size: number, used: Set<string>): Picker {
  const target = largestRemainder(size, [1, 1, 1, 1]);
  const taken = [0, 0, 0, 0];
  return {
    take(candidates, n) {
      const out: PoolItem[] = [];
      const free = candidates.filter((c) => !used.has(c.id));
      while (out.length < n && free.length > 0) {
        let best = 0;
        let bestDeficit = -Infinity;
        for (let i = 0; i < free.length; i++) {
          const band = bandOf(free[i]!.b!, reference);
          const deficit = (target[band] ?? 0) - (taken[band] ?? 0);
          // Earlier candidates win ties: preference order is kept.
          if (deficit > bestDeficit) {
            best = i;
            bestDeficit = deficit;
          }
        }
        const item = free.splice(best, 1)[0]!;
        taken[bandOf(item.b!, reference)]! += 1;
        used.add(item.id);
        out.push(item);
      }
      return out;
    },
  };
}

function preferenceOrder(items: readonly PoolItem[], answered: ReadonlySet<string>, seed: string): PoolItem[] {
  const shuffled = seededShuffle(
    [...items].sort((a, b) => a.id.localeCompare(b.id)),
    seededRandom('simulado', seed),
  );
  const rank = new Map(shuffled.map((it, i) => [it.id, i] as const));
  return shuffled.sort(
    (a, b) =>
      Number(answered.has(a.question_id)) - Number(answered.has(b.question_id)) ||
      b.edition_year - a.edition_year ||
      rank.get(a.id)! - rank.get(b.id)!,
  );
}

/** Foreign-language set for LC: the 5 items of one edition in the chosen language, preferring unanswered and recent. */
function languageSet(pool: readonly PoolItem[], language: EnemLanguage, answered: ReadonlySet<string>): PoolItem[] {
  const byEdition = new Map<number, PoolItem[]>();
  for (const i of pool) if (i.area === 'LC' && i.language === language && usable(i, language)) byEdition.set(i.edition_year, [...(byEdition.get(i.edition_year) ?? []), i]);
  const sets = [...byEdition.entries()]
    .filter(([, items]) => items.length >= ENEM_LANGUAGE_ITEMS)
    .sort((a, b) => {
      const ua = a[1].filter((i) => answered.has(i.question_id)).length;
      const ub = b[1].filter((i) => answered.has(i.question_id)).length;
      return ua - ub || b[0] - a[0];
    });
  return sets.length ? [...sets[0]![1]].sort((a, b) => a.position - b.position).slice(0, ENEM_LANGUAGE_ITEMS) : [];
}

/** Reference quartiles: the given edition's `b` values in the area, else every usable item of the area. */
function referenceQuartiles(pool: readonly PoolItem[], area: EnemArea, edition: number | undefined, language: EnemLanguage): [number, number, number] {
  const inArea = pool.filter((i) => i.area === area && usable(i, language));
  const ref = edition !== undefined ? inArea.filter((i) => i.edition_year === edition) : [];
  return quartilesOf((ref.length >= 10 ? ref : inArea).map((i) => i.b!));
}

export interface MixInput {
  areas: readonly EnemArea[];
  /** Items per area (45 for Área/Dia, 15/30 for Mini). */
  size: number;
  language: EnemLanguage;
  seed: string;
  /** question ids the student already answered (avoided when possible). */
  answered?: ReadonlySet<string>;
  /** Edition whose difficulty distribution is the target (default: the whole pool of the area). */
  referenceEdition?: number;
}

/** Misto: items from several editions, matched to a real edition's difficulty mix. */
export function selectMisto(pool: readonly PoolItem[], input: MixInput): Selection {
  return selectByQuotas(pool, input, null);
}

/** Provável (§8.5): topic quotas = largest-remainder of size × predicted_share; unfilled quotas go to the next topics. */
export function selectProvavel(pool: readonly PoolItem[], input: MixInput & { predictedShares: ReadonlyMap<string, number> }): Selection {
  return selectByQuotas(pool, input, input.predictedShares);
}

function selectByQuotas(pool: readonly PoolItem[], input: MixInput, shares: ReadonlyMap<string, number> | null): Selection {
  const answered = input.answered ?? new Set<string>();
  const chosen = new Map<EnemArea, PoolItem[]>();
  const shortfall: Partial<Record<EnemArea, number>> = {};
  const used = new Set<string>();
  for (const area of input.areas) {
    const picked: PoolItem[] = [];
    let size = input.size;
    // The 45-item LC test always carries the 5 items of the chosen language, from one edition.
    if (area === 'LC' && input.size >= 45) {
      const lang = languageSet(pool, input.language, answered);
      for (const i of lang) used.add(i.id);
      picked.push(...lang);
      size -= lang.length;
    }
    const candidates = preferenceOrder(
      pool.filter((i) => i.area === area && usable(i, input.language) && !used.has(i.id) && (area !== 'LC' || input.size < 45 || i.language === null)),
      answered,
      `${input.seed}|${area}`,
    );
    const picker = bandPicker(referenceQuartiles(pool, area, input.referenceEdition, input.language), size, used);
    if (shares) {
      const topics = [...shares.entries()]
        .filter(([topic, s]) => s > 0 && candidates.some((c) => c.enem_topic_ids.includes(topic)))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const quotas = largestRemainder(
        size,
        topics.map(([, s]) => s),
      );
      let carry = 0;
      for (let t = 0; t < topics.length; t++) {
        const [topic] = topics[t]!;
        const want = quotas[t]! + carry;
        const got = picker.take(
          candidates.filter((c) => c.enem_topic_ids.includes(topic)),
          want,
        );
        picked.push(...got);
        carry = want - got.length;
      }
    }
    // Misto, and anything a Provável quota left open: fill from the whole area.
    if (picked.length < input.size) picked.push(...picker.take(candidates, input.size - picked.length));
    chosen.set(area, picked);
    if (picked.length < input.size) shortfall[area] = input.size - picked.length;
  }
  return finish(chosen, shortfall);
}
