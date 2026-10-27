// Stable non-cryptographic hashing for cache keys (podcast reuse, INT-01.6). Pure JavaScript so the same
// key is computed on device (Hermes), in the API (Bun) and in the worker. Not for secrets or integrity.

/** 32-bit FNV-1a over the UTF-16 code units of `text`, starting from `seed`. */
function fnv1a32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Final avalanche (murmur3 fmix32) so short inputs still spread over all bits.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** 128-bit hex digest built from four seeded FNV-1a lanes (32 lowercase hex characters). */
export function stableHashHex(text: string): string {
  const seeds = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x7f4a7c15];
  return seeds.map((seed, lane) => fnv1a32(`${lane}:${text}`, seed).toString(16).padStart(8, '0')).join('');
}
