// Seeded randomness only (learning-engine §0.3). No Math.random anywhere in the engine.
// Not part of the public API.

/** 32-bit string hash: FNV-1a followed by the murmur3 finaliser. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32: returns a generator of floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `mulberry32(hash32(seedParts.join("|")))` as specified in §0.3. */
export function seededRandom(...parts: Array<string | number>): () => number {
  return mulberry32(hash32(parts.join('|')));
}

export function seededShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j] as T;
    out[j] = tmp as T;
  }
  return out;
}

/**
 * Weighted sampling without replacement (Efraimidis–Spirakis): each item gets key ln(u)/w,
 * and the k largest keys win. Deterministic for a given rng sequence.
 */
export function weightedSampleWithoutReplacement<T>(
  items: readonly T[],
  weights: readonly number[],
  k: number,
  rng: () => number,
): T[] {
  const keyed = items.map((item, i) => {
    const w = Math.max(weights[i] ?? 0, 1e-9);
    const u = Math.max(rng(), 1e-12);
    return { item, i, key: Math.log(u) / w };
  });
  keyed.sort((a, b) => b.key - a.key || a.i - b.i);
  return keyed.slice(0, Math.max(0, k)).map((x) => x.item);
}

/** Uniform value in [0, 1) derived from the parts only (no RNG state). */
export function unitHash(...parts: Array<string | number>): number {
  return hash32(parts.join('|')) / 4294967296;
}
