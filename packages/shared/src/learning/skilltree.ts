// Skill tree and Chefões (MOT-02; learning-engine §16.2, spec 13 §8.6). Pure functions: the mobile Mapa renders
// the layout, quiz-create picks boss questions, quiz-submit grades the boss.
import { seededRandom, weightedSampleWithoutReplacement } from './rng.ts';
import { compareStrings } from './util.ts';

export type SkillNodeState = 'recommended_later' | 'available' | 'in_progress' | 'mastered' | 'cooling';

export const SKILL_TREE = {
  /** A prerequisite below this mastery makes a node "recomendado depois". */
  prerequisiteMin: 0.5,
  masteredMin: 0.8,
  /** Retrievability below this turns a mastered node into "esfriando". */
  coolingBelow: 0.7,
  bossPass: 0.7,
  bossSmallUnitTopics: 4,
  bossSmallCount: 10,
  bossLargeCount: 15,
} as const;

export interface SkillNodeInput {
  id: string;
  /** null = no evidence (the skill tree treats it as 0, learning-engine §5.4). */
  mastery: number | null;
  retrievability: number | null;
  prerequisiteIds: readonly string[];
}

export interface SkillNodeView {
  id: string;
  state: SkillNodeState;
  /** For "Recomendado depois de: {tópico}": the weakest prerequisite. Never a lock (MOT-02.2). */
  recommendedAfter: string | null;
}

/**
 * State of one node (spec 13 §8.6). A node the student already works on keeps its progress state even when a
 * prerequisite is weak; only untouched nodes become "recomendado depois". Nothing is ever locked.
 */
export function skillNodeState(node: SkillNodeInput, masteryOf: (id: string) => number | null): SkillNodeView {
  const m = node.mastery ?? 0;
  if (m >= SKILL_TREE.masteredMin) {
    const cooling = node.retrievability !== null && node.retrievability < SKILL_TREE.coolingBelow;
    return { id: node.id, state: cooling ? 'cooling' : 'mastered', recommendedAfter: null };
  }
  if (m > 0) return { id: node.id, state: 'in_progress', recommendedAfter: null };
  let weakest: { id: string; m: number } | null = null;
  for (const p of [...node.prerequisiteIds].sort(compareStrings)) {
    const pm = masteryOf(p) ?? 0;
    if (pm < SKILL_TREE.prerequisiteMin && (weakest === null || pm < weakest.m)) weakest = { id: p, m: pm };
  }
  if (weakest) return { id: node.id, state: 'recommended_later', recommendedAfter: weakest.id };
  return { id: node.id, state: 'available', recommendedAfter: null };
}

export interface SkillTreeUnit {
  id: string;
  title: string;
  order: number;
}

export interface SkillTreeTopic {
  id: string;
  unitId: string;
  title: string;
  order: number;
}

export interface SkillTreeLayout {
  /** Grid coordinates: col within the unit row band, row from the top. */
  nodes: Array<{ id: string; unitId: string; col: number; row: number }>;
  /** One band per unit (MOT-02.1 "regions"), with the boss at its end. */
  regions: Array<{ unitId: string; title: string; firstRow: number; rows: number; boss: { col: number; row: number } }>;
  /** Prerequisite paths between topics present in the tree. */
  edges: Array<{ from: string; to: string }>;
  cols: number;
  rows: number;
}

/**
 * Deterministic layout (MOT-02.1): units are horizontal bands in outline order; inside a unit, a topic's column is
 * its prerequisite depth within the unit, and topics sharing a depth stack into rows by outline order. The same
 * input always gives the same picture, so the Mapa is stable between visits.
 */
export function skillTreeLayout(
  units: readonly SkillTreeUnit[],
  topics: readonly SkillTreeTopic[],
  prerequisites: ReadonlyArray<{ nodeId: string; prerequisiteId: string }>,
  maxCols = 4,
): SkillTreeLayout {
  const byOrder = <T extends { order: number; id: string }>(a: T, b: T) => a.order - b.order || compareStrings(a.id, b.id);
  const topicIds = new Set(topics.map((t) => t.id));
  const edges = prerequisites
    .filter((e) => topicIds.has(e.nodeId) && topicIds.has(e.prerequisiteId) && e.nodeId !== e.prerequisiteId)
    .map((e) => ({ from: e.prerequisiteId, to: e.nodeId }))
    .sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.to, b.to));
  const prereqsOf = new Map<string, string[]>();
  for (const e of edges) prereqsOf.set(e.to, [...(prereqsOf.get(e.to) ?? []), e.from]);

  const nodes: SkillTreeLayout['nodes'] = [];
  const regions: SkillTreeLayout['regions'] = [];
  let row = 0;
  let cols = 1;
  for (const unit of [...units].sort(byOrder)) {
    const inUnit = topics.filter((t) => t.unitId === unit.id).sort(byOrder);
    const ids = new Set(inUnit.map((t) => t.id));
    const depth = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (id: string): number => {
      const known = depth.get(id);
      if (known !== undefined) return known;
      if (visiting.has(id)) return 0; // a prerequisite cycle: break it at the repeated node
      visiting.add(id);
      const ps = (prereqsOf.get(id) ?? []).filter((p) => ids.has(p));
      const d = ps.length ? Math.min(maxCols - 1, 1 + Math.max(...ps.map(depthOf))) : 0;
      visiting.delete(id);
      depth.set(id, d);
      return d;
    };
    const perCol = new Map<number, number>();
    for (const t of inUnit) {
      const col = depthOf(t.id);
      const r = perCol.get(col) ?? 0;
      perCol.set(col, r + 1);
      nodes.push({ id: t.id, unitId: unit.id, col, row: row + r });
      cols = Math.max(cols, col + 1);
    }
    const rows = Math.max(1, ...perCol.values());
    const bossCol = Math.min(maxCols - 1, Math.max(0, ...[...perCol.keys()]) + 1);
    cols = Math.max(cols, bossCol + 1);
    regions.push({ unitId: unit.id, title: unit.title, firstRow: row, rows, boss: { col: bossCol, row: row + Math.floor((rows - 1) / 2) } });
    row += rows + 1; // one spacer row between regions
  }
  return { nodes, regions, edges, cols, rows: Math.max(0, row - 1) };
}

/** MOT-02.4: 10 questions for units with ≤ 4 topics, 15 above. */
export function bossQuestionCount(topicCount: number): number {
  return topicCount <= SKILL_TREE.bossSmallUnitTopics ? SKILL_TREE.bossSmallCount : SKILL_TREE.bossLargeCount;
}

export interface BossCandidate {
  id: string;
  nodeId: string;
}

/**
 * Boss questions (spec 13 §8.6): every topic gets one question first (lowest mastery first), then the rest are
 * drawn with weight `1.2 − mastery`, so weaker topics show up more. Questions seen in earlier attempts are used
 * only when the unseen ones run out, so retries get different questions (MOT-02.4). Deterministic per seed.
 */
export function selectBossQuestions(
  candidates: readonly BossCandidate[],
  masteryOf: (nodeId: string) => number | null,
  count: number,
  seed: string,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const rng = seededRandom('boss', seed);
  const sorted = [...candidates].sort((a, b) => compareStrings(a.id, b.id));
  const weight = (c: BossCandidate) => 1.2 - Math.min(1, Math.max(0, masteryOf(c.nodeId) ?? 0));
  const picked: string[] = [];
  const used = new Set<string>();
  // One question per topic (weakest topics first), then weighted draws; unseen questions are used up first.
  const pickFrom = (pool: readonly BossCandidate[]) => {
    const topics = [...new Set(pool.map((c) => c.nodeId))].sort((a, b) => (masteryOf(a) ?? 0) - (masteryOf(b) ?? 0) || compareStrings(a, b));
    const covered = new Set(picked.map((id) => candidates.find((c) => c.id === id)?.nodeId));
    for (const topic of topics) {
      if (picked.length >= count || covered.has(topic)) continue;
      const options = pool.filter((c) => c.nodeId === topic && !used.has(c.id));
      if (!options.length) continue;
      const choice = options[Math.floor(rng() * options.length)]!;
      picked.push(choice.id);
      used.add(choice.id);
    }
    const rest = pool.filter((c) => !used.has(c.id));
    for (const c of weightedSampleWithoutReplacement(rest, rest.map(weight), count - picked.length, rng)) {
      picked.push(c.id);
      used.add(c.id);
    }
  };
  pickFrom(sorted.filter((c) => !seen.has(c.id)));
  if (picked.length < count) pickFrom(sorted.filter((c) => seen.has(c.id)));
  return picked;
}

/** The "vida" bar (MOT-02.4): full at the start, empty once the correct answers reach the pass mark. */
export function bossHealth(correct: number, total: number): number {
  if (total <= 0) return 1;
  const needed = Math.ceil(SKILL_TREE.bossPass * total);
  return Math.max(0, 1 - correct / needed);
}

export function bossPassed(score: number): boolean {
  return score >= SKILL_TREE.bossPass - 1e-9;
}
