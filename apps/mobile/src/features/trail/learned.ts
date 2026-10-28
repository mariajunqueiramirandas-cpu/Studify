// Concepts the student cleared in the Trilha (TRL-01.15). Kept on the device so the review queue, which is built
// offline from SQLite, can put the cards of what was just learned first among the new cards: the Trilha's
// "understood" turns into spaced reviews instead of being forgotten by the next chapter.
import { getKv } from '../../lib/kv';

const KEY = 'trail_learned_concepts';
const MAX = 2000;

export function learnedConcepts(): Set<string> {
  try {
    const raw = getKv().getString(KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Adds concepts (most recent last); returns the ones that were new. */
export function rememberLearned(conceptIds: readonly string[]): string[] {
  const known = learnedConcepts();
  const fresh = conceptIds.filter((id) => !known.has(id));
  if (fresh.length === 0) return [];
  const list = [...known, ...fresh].slice(-MAX);
  getKv().set(KEY, JSON.stringify(list));
  return fresh;
}
