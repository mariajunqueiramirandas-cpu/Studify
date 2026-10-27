// Text for on-device speech (WEL-04.8 read-aloud, TUT-06.4 voice tutor, INT-02 Lucas aloud, INT-01.11 ✋
// fallback): Markdown and LaTeX turned into plain PT-BR sentences ("x ao quadrado mais 3"). Pure functions;
// the app hands the sentences to expo-speech one by one so the current sentence can be highlighted.

const SYMBOLS: Readonly<Record<string, string>> = {
  '\\cdot': 'vezes',
  '\\times': 'vezes',
  '\\div': 'dividido por',
  '\\pm': 'mais ou menos',
  '\\mp': 'menos ou mais',
  '\\neq': 'diferente de',
  '\\ne': 'diferente de',
  '\\leq': 'menor ou igual a',
  '\\le': 'menor ou igual a',
  '\\geq': 'maior ou igual a',
  '\\ge': 'maior ou igual a',
  '\\approx': 'aproximadamente',
  '\\equiv': 'equivalente a',
  '\\infty': 'infinito',
  '\\rightarrow': 'resulta em',
  '\\to': 'tende a',
  '\\Rightarrow': 'implica',
  '\\leftrightarrow': 'equivale a',
  '\\Leftrightarrow': 'se e somente se',
  '\\in': 'pertence a',
  '\\notin': 'não pertence a',
  '\\subset': 'contido em',
  '\\cup': 'união',
  '\\cap': 'interseção',
  '\\forall': 'para todo',
  '\\exists': 'existe',
  '\\sum': 'somatório de',
  '\\int': 'integral de',
  '\\lim': 'limite de',
  '\\sin': 'seno de',
  '\\cos': 'cosseno de',
  '\\tan': 'tangente de',
  '\\log': 'log de',
  '\\ln': 'logaritmo natural de',
  '\\%': 'por cento',
  '\\circ': 'graus',
  '\\degree': 'graus',
  '\\alpha': 'alfa',
  '\\beta': 'beta',
  '\\gamma': 'gama',
  '\\Gamma': 'gama',
  '\\delta': 'delta',
  '\\Delta': 'delta',
  '\\epsilon': 'épsilon',
  '\\varepsilon': 'épsilon',
  '\\theta': 'teta',
  '\\lambda': 'lambda',
  '\\mu': 'mi',
  '\\pi': 'pi',
  '\\rho': 'rô',
  '\\sigma': 'sigma',
  '\\Sigma': 'sigma',
  '\\phi': 'fi',
  '\\varphi': 'fi',
  '\\omega': 'ômega',
  '\\Omega': 'ômega',
};

const OPERATORS: Readonly<Record<string, string>> = {
  '+': 'mais',
  '-': 'menos',
  '=': 'igual a',
  '<': 'menor que',
  '>': 'maior que',
  '*': 'vezes',
  '/': 'sobre',
  '%': 'por cento',
  '!': 'fatorial',
};

/** Ignored LaTeX commands (layout only). */
const LAYOUT = new Set(['\\left', '\\right', '\\,', '\\;', '\\:', '\\!', '\\quad', '\\qquad', '\\displaystyle', '\\text', '\\mathrm', '\\mathbf', '\\mathit', '\\operatorname']);

class LatexReader {
  private i = 0;
  constructor(private readonly src: string) {}

  done(): boolean {
    return this.i >= this.src.length;
  }

  private skipSpaces(): void {
    while (this.i < this.src.length && /\s/.test(this.src[this.i]!)) this.i++;
  }

  /** Reads one argument: a {group}, a \command or one character. */
  arg(): string {
    this.skipSpaces();
    const ch = this.src[this.i];
    if (ch === undefined) return '';
    if (ch === '{') {
      let depth = 0;
      const start = this.i + 1;
      for (; this.i < this.src.length; this.i++) {
        if (this.src[this.i] === '{') depth++;
        else if (this.src[this.i] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      const inner = this.src.slice(start, this.i);
      this.i++;
      return spokenLatex(inner);
    }
    if (ch === '\\') return this.command();
    this.i++;
    return spokenChar(ch);
  }

  private optional(): string | null {
    this.skipSpaces();
    if (this.src[this.i] !== '[') return null;
    const end = this.src.indexOf(']', this.i);
    if (end < 0) return null;
    const value = this.src.slice(this.i + 1, end);
    this.i = end + 1;
    return value.trim();
  }

  command(): string {
    const match = /^\\([a-zA-Z]+|.)/.exec(this.src.slice(this.i));
    if (!match) {
      this.i++;
      return '';
    }
    const name = `\\${match[1]}`;
    this.i += match[0].length;
    if (name === '\\frac' || name === '\\dfrac' || name === '\\tfrac') {
      const num = this.arg();
      const den = this.arg();
      return `${num} sobre ${den}`;
    }
    if (name === '\\sqrt') {
      const index = this.optional();
      const body = this.arg();
      if (!index || index === '2') return `raiz quadrada de ${body}`;
      if (index === '3') return `raiz cúbica de ${body}`;
      return `raiz de índice ${spokenLatex(index)} de ${body}`;
    }
    if (name === '\\vec') return `vetor ${this.arg()}`;
    if (name === '\\overline' || name === '\\bar') return `${this.arg()} barra`;
    if (name === '\\text' || name === '\\mathrm' || name === '\\mathbf' || name === '\\mathit' || name === '\\operatorname') return this.arg();
    if (LAYOUT.has(name)) return '';
    return SYMBOLS[name] ?? name.slice(1);
  }

  /** The whole expression with ^ and _ applied to the previous piece. */
  read(): string {
    const parts: string[] = [];
    while (!this.done()) {
      this.skipSpaces();
      const ch = this.src[this.i];
      if (ch === undefined) break;
      if (ch === '^') {
        this.i++;
        parts.push(exponent(this.arg()));
      } else if (ch === '_') {
        this.i++;
        parts.push(this.arg());
      } else if (ch === '{' || ch === '\\') {
        parts.push(this.arg());
      } else {
        // Runs of digits stay one number ("12", "3,5").
        const num = /^[0-9]+(?:[.,][0-9]+)?/.exec(this.src.slice(this.i));
        if (num) {
          parts.push(num[0]);
          this.i += num[0].length;
        } else {
          parts.push(spokenChar(ch));
          this.i++;
        }
      }
    }
    return parts.filter(Boolean).join(' ');
  }
}

function spokenChar(ch: string): string {
  if (OPERATORS[ch]) return OPERATORS[ch]!;
  if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}') return '';
  return ch;
}

function exponent(value: string): string {
  const v = value.trim();
  if (v === '2') return 'ao quadrado';
  if (v === '3') return 'ao cubo';
  if (v === 'graus') return 'graus';
  return `elevado a ${v}`;
}

/** LaTeX to spoken PT-BR, e.g. `x^2 + 3` → "x ao quadrado mais 3", `\frac{a}{b}` → "a sobre b". */
export function spokenLatex(latex: string): string {
  return new LatexReader(latex).read().replace(/\s+/g, ' ').trim();
}

/** Markdown (with `$…$` / `$$…$$` math) to speakable plain text. Tables are read row by row. */
export function speakableText(markdown: string): string {
  let text = markdown
    .replace(/\[\[APOIO\]\]/g, '')
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => ` ${spokenLatex(tex)}. `)
    .replace(/\$([^$\n]+?)\$/g, (_m, tex: string) => spokenLatex(tex))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
  const lines = text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (/^\|?\s*:?-{3,}/.test(trimmed)) return '';
    if (trimmed.startsWith('|')) {
      return `${trimmed.split('|').map((c) => c.trim()).filter(Boolean).join(', ')}.`;
    }
    return trimmed
      .replace(/^#{1,6}\s+(.*)$/, '$1.')
      .replace(/^>\s?/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^(\d+)[.)]\s+/, '$1. ');
  });
  text = lines.filter((l) => l.length > 0).join('\n');
  return text
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\.{2,}(?!\.)/g, '.')
    .trim();
}

/** Splits speakable text into sentences for TTS chunks and the highlighted sentence. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    const parts = paragraph.match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? [];
    let buffer = '';
    for (const part of parts) {
      buffer += part;
      // Keep decimal numbers and abbreviations ("p. 12", "Sr.") with the next piece.
      if (/(\b[A-Za-z]{1,3}|\d)\.$/.test(buffer.trim()) && !/[!?…]$/.test(buffer.trim())) continue;
      const sentence = buffer.trim();
      if (sentence) out.push(sentence);
      buffer = '';
    }
    if (buffer.trim()) out.push(buffer.trim());
  }
  return out;
}
