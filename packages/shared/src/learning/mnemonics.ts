// Estúdio de Mnemônicos (MEM-06; spec 04 §8). Helpers to check the AI's options before they reach the student:
// an acrostic must really encode the list, palaces hold at most 20 loci, items map onto loci in order.

export const MNEMONICS = {
  optionsPerRound: 3,
  maxItems: 20,
  maxLoci: 20,
  minLoci: 2,
} as const;

function initialOf(word: string): string {
  const letter = word.normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[A-Za-z0-9]/);
  return letter ? letter[0]!.toUpperCase() : '';
}

/** Initials of the items: "Prófase, Metáfase, Anáfase, Telófase" → "PMAT". */
export function acronymOf(items: readonly string[]): string {
  return items.map((i) => initialOf(i.trim())).join('');
}

/** Short words a Frase may add between the encoding words ("de", "a", "o"…) are not counted. */
const FILLERS = new Set(['a', 'o', 'e', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'em', 'na', 'no', 'um', 'uma', 'que']);

/**
 * True when the text's word initials spell the items' initials in order (MEM-06.2 Acrônimo and Frase). For an
 * acronym the text is one word whose letters are the initials; for a phrase, filler words are skipped.
 */
export function encodesItems(type: 'acronym' | 'phrase', text: string, items: readonly string[]): boolean {
  const target = acronymOf(items);
  if (!target) return false;
  if (type === 'acronym') {
    const letters = text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return letters.startsWith(target) && letters.length <= target.length + 3;
  }
  const words = text.split(/\s+/).filter((w) => w && !FILLERS.has(w.toLowerCase()));
  return words.map(initialOf).join('').startsWith(target);
}

/** MEM-06.5: items in order onto the palace's loci. More items than loci is an error, never a wrap-around. */
export function placeOnLoci(items: readonly string[], loci: readonly string[]): Array<{ locus: string; item: string }> {
  if (items.length > loci.length) throw new Error('more items than loci');
  return items.map((item, i) => ({ locus: loci[i]!, item }));
}

/** A list worth a mnemonic (MEM-06.1 "listas dentro das notas"): 3–20 short items. */
export function isMnemonicList(items: readonly string[]): boolean {
  return items.length >= 3 && items.length <= MNEMONICS.maxItems && items.every((i) => i.trim().length > 0 && i.length <= 120);
}
