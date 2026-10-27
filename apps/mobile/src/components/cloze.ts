// Cloze rendering (MEM-01), pure so it can be unit-tested without native modules.

/** Turns "{{c1::mitocôndria}}" into a blank on the front and bold on the back (MEM-01 cloze). */
export function renderCloze(text: string, side: 'front' | 'back', index?: number | null): string {
  return text.replace(/\{\{c(\d+)::([^}]+?)(?:::([^}]+))?\}\}/g, (_, n: string, answer: string, hint?: string) => {
    const active = index == null || Number(n) === index;
    if (!active) return answer;
    if (side === 'front') return hint ? `[… ${hint}]` : '[…]';
    return `**${answer}**`;
  });
}
