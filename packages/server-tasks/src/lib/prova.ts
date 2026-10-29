// Prova Provável math (PRA-09, learning-engine §9.1–9.2). The shared package does not export
// teacherTopicWeights or predictedTestBlueprint yet, so the worker implements them here with the
// same formulas. Everything is deterministic: a seed (user, exam, regeneration index) fixes the result.

export const EPSILON = 0.02;

export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 seeded PRNG (learning-engine §0.3). Returns a generator of floats in [0, 1). */
export function seededRandom(seed: string): () => number {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Largest-remainder allocation of `total` units over `weights` (ties: lower index first). */
export function largestRemainder(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
  if (sum <= 0 || total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (Math.max(0, w) / sum) * total);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left--;
  }
  return out;
}

/**
 * ω per in-scope topic (§9.1): base^(1−β) · (h + ε)^β, normalized over the scope.
 * `base` = est_learn_minutes share over the scope; `pointsShare` = h_n; β = min(0.7, 0.2 · n_tests).
 */
export function teacherTopicWeights(scope: readonly string[], base: Readonly<Record<string, number>>, pointsShare: Readonly<Record<string, number>>, nTests: number): Record<string, number> {
  if (scope.length === 0) return {};
  const beta = Math.min(0.7, 0.2 * nTests);
  const baseSum = scope.reduce((acc, id) => acc + (base[id] ?? 0), 0);
  const raw: Record<string, number> = {};
  for (const id of scope) {
    const b = baseSum > 0 ? (base[id] ?? 0) / baseSum : 1 / scope.length;
    const h = pointsShare[id] ?? 0;
    raw[id] = Math.pow(Math.max(b, 1e-12), 1 - beta) * Math.pow(h + EPSILON, beta);
  }
  const total = Object.values(raw).reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  for (const id of scope) out[id] = (raw[id] ?? 0) / total;
  return out;
}

export interface PastQuestionFact {
  type: string;
  bloom: string;
  difficulty: number | null;
  points: number | null;
  nodeId: string | null;
}

export interface PastTestFact {
  testId: string;
  totalPoints: number | null;
  questions: PastQuestionFact[];
}

export interface TeacherStatistics {
  tests: number;
  questionsPerTest: number;
  typeMix: Record<string, number>;
  bloomMix: Record<string, number>;
  difficultyMean: number;
  totalPointsMedian: number | null;
  /** Mean share of each test's points that falls on a topic (h_n before the sibling term). */
  pointsShare: Record<string, number>;
}

function shares(counts: Map<string, number>): Record<string, number> {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  for (const [k, v] of counts) out[k] = total > 0 ? v / total : 0;
  return out;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Deterministic statistics over past tests (spec 08 §8.1). The model only describes patterns. */
export function teacherStatistics(tests: readonly PastTestFact[]): TeacherStatistics {
  const typeCounts = new Map<string, number>();
  const bloomCounts = new Map<string, number>();
  const nodePoints = new Map<string, number>();
  const difficulties: number[] = [];
  const totals: number[] = [];
  let questions = 0;
  const pointsShareSums = new Map<string, number>();
  for (const test of tests) {
    for (const q of test.questions) {
      questions++;
      typeCounts.set(q.type, (typeCounts.get(q.type) ?? 0) + 1);
      bloomCounts.set(q.bloom, (bloomCounts.get(q.bloom) ?? 0) + 1);
      if (q.difficulty !== null) difficulties.push(q.difficulty);
    }
    const testTotal = test.questions.reduce((acc, q) => acc + (q.points ?? 1), 0);
    if (test.totalPoints !== null) totals.push(test.totalPoints);
    for (const q of test.questions) {
      if (!q.nodeId || testTotal <= 0) continue;
      nodePoints.set(q.nodeId, (nodePoints.get(q.nodeId) ?? 0) + (q.points ?? 1) / testTotal);
    }
  }
  for (const [k, v] of nodePoints) pointsShareSums.set(k, v / Math.max(1, tests.length));
  const difficultyMean = difficulties.length ? difficulties.reduce((a, b) => a + b, 0) / difficulties.length : 3;
  return {
    tests: tests.length,
    questionsPerTest: tests.length ? Math.round(questions / tests.length) : 0,
    typeMix: shares(typeCounts),
    bloomMix: shares(bloomCounts),
    difficultyMean: Math.round(difficultyMean * 100) / 100,
    totalPointsMedian: median(totals),
    pointsShare: Object.fromEntries(pointsShareSums),
  };
}

export interface BlueprintSlot {
  slotId: string;
  topicKey: string;
  type: string;
  bloom: string;
  difficulty: number;
}

export interface BlueprintInput {
  questionsPerTest: number;
  typeMix: Record<string, number>;
  bloomMix: Record<string, number>;
  difficultyMean: number;
  weights: Record<string, number>;
  seed: string;
}

/**
 * Blueprint (§9.2): Q slots; types and bloom levels by largest remainder; topics by systematic
 * sampling over ω, with at least one slot for every topic with ω ≥ 1/Q and at most ceil(ω·Q)+1.
 */
export function predictedBlueprint(input: BlueprintInput): BlueprintSlot[] {
  const Q = Math.max(1, input.questionsPerTest);
  const rng = seededRandom(input.seed);
  const topics = Object.keys(input.weights).sort();
  const weightOf = (t: string): number => input.weights[t] ?? 0;

  // Systematic sampling over the cumulative weights.
  const counts = new Map<string, number>(topics.map((t) => [t, 0]));
  const start = rng() / Q;
  const cumulative: Array<{ topic: string; end: number }> = [];
  let acc = 0;
  for (const t of topics) {
    acc += weightOf(t);
    cumulative.push({ topic: t, end: acc });
  }
  for (let k = 0; k < Q; k++) {
    const point = start + k / Q;
    const hit = cumulative.find((c) => point <= c.end + 1e-12) ?? cumulative[cumulative.length - 1];
    if (hit) counts.set(hit.topic, (counts.get(hit.topic) ?? 0) + 1);
  }
  // Floor: every topic with ω ≥ 1/Q gets a slot, taken from the most over-represented topic.
  for (const t of topics) {
    if (weightOf(t) < 1 / Q || (counts.get(t) ?? 0) > 0) continue;
    const donor = topics
      .filter((d) => (counts.get(d) ?? 0) > 1)
      .sort((a, b) => (counts.get(b) ?? 0) - weightOf(b) * Q - ((counts.get(a) ?? 0) - weightOf(a) * Q) || (a < b ? -1 : 1))[0];
    if (donor) {
      counts.set(donor, (counts.get(donor) ?? 0) - 1);
      counts.set(t, 1);
    }
  }
  // Cap: at most ceil(ω·Q) + 1 per topic; overflow goes to the topic with the largest deficit.
  for (const t of topics) {
    const cap = Math.ceil(weightOf(t) * Q) + 1;
    while ((counts.get(t) ?? 0) > cap) {
      const receiver = topics
        .filter((r) => r !== t && (counts.get(r) ?? 0) < Math.ceil(weightOf(r) * Q) + 1)
        .sort((a, b) => (weightOf(b) * Q - (counts.get(b) ?? 0)) - (weightOf(a) * Q - (counts.get(a) ?? 0)) || (a < b ? -1 : 1))[0];
      if (!receiver) break;
      counts.set(t, (counts.get(t) ?? 0) - 1);
      counts.set(receiver, (counts.get(receiver) ?? 0) + 1);
    }
  }

  const topicSlots: string[] = [];
  for (const t of topics) for (let i = 0; i < (counts.get(t) ?? 0); i++) topicSlots.push(t);
  while (topicSlots.length < Q && topics.length > 0) topicSlots.push(topics[topicSlots.length % topics.length] ?? topics[0] ?? '');
  topicSlots.length = Q;

  const typeKeys = Object.keys(input.typeMix).sort();
  const typeCounts = largestRemainder(Q, typeKeys.map((k) => input.typeMix[k] ?? 0));
  const types: string[] = [];
  typeKeys.forEach((k, i) => {
    for (let n = 0; n < (typeCounts[i] ?? 0); n++) types.push(k);
  });
  const bloomKeys = Object.keys(input.bloomMix).sort();
  const bloomCounts = largestRemainder(Q, bloomKeys.map((k) => input.bloomMix[k] ?? 0));
  const blooms: string[] = [];
  bloomKeys.forEach((k, i) => {
    for (let n = 0; n < (bloomCounts[i] ?? 0); n++) blooms.push(k);
  });

  const difficulty = Math.min(5, Math.max(1, Math.round(input.difficultyMean)));
  return topicSlots.map((topicKey, i) => ({
    slotId: `s${i + 1}`,
    topicKey,
    type: types[i] ?? typeKeys[0] ?? 'short_answer',
    bloom: blooms[i] ?? bloomKeys[0] ?? 'understand',
    difficulty,
  }));
}
