// Deterministic math expressions for `problem` items (PRA-08.4, spec 05 §8.9): a small recursive-descent
// parser and evaluator (no eval, no dependencies), so expression answers are graded on device, in the API and
// in the worker with the same code. Equivalence is tested numerically at seeded random points, which is a
// mechanical check of the student's expression against the item's own, not a symbolic proof.
//
// Grammar (PT-BR friendly): numbers with "." or "," decimals, + − × ÷ * / ^ (also ** ), implicit
// multiplication ("2x", "3(x+1)", "x y"), unary ±, parentheses, constants pi/π and e, and the functions
// sqrt/raiz, sin/sen, cos, tan/tg, asin, acos, atan, log (base 10), ln, exp, abs.

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'neg'; arg: ExprNode }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/' | '^'; left: ExprNode; right: ExprNode }
  | { kind: 'call'; fn: string; arg: ExprNode };

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

const FUNCTIONS: Readonly<Record<string, (x: number) => number>> = {
  sqrt: Math.sqrt,
  raiz: Math.sqrt,
  sin: Math.sin,
  sen: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  tg: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  log: Math.log10,
  ln: Math.log,
  exp: Math.exp,
  abs: Math.abs,
};

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, 'π': Math.PI, e: Math.E };

/** Longest input accepted (a student answer or a generated check expression). */
export const MAX_EXPRESSION_LENGTH = 300;

type Token =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: '+' | '-' | '*' | '/' | '^' }
  | { t: '(' }
  | { t: ')' };

function normalize(source: string): string {
  return source
    .replace(/[−–]/g, '-')
    .replace(/[×·]/g, '*')
    .replace(/÷/g, '/')
    .replace(/\*\*/g, '^')
    .replace(/[{[]/g, '(')
    .replace(/[}\]]/g, ')')
    .replace(/√/g, ' sqrt ');
}

function tokenize(source: string, names: ReadonlySet<string>): Token[] {
  const text = normalize(source);
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch) || ((ch === '.' || ch === ',') && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i;
      let seenSep = false;
      while (j < text.length) {
        const c = text[j]!;
        if (/[0-9]/.test(c)) j++;
        else if ((c === '.' || c === ',') && !seenSep && /[0-9]/.test(text[j + 1] ?? '')) {
          seenSep = true;
          j++;
        } else break;
      }
      let raw = text.slice(i, j).replace(',', '.');
      // Scientific notation: 1.5e3, 2E-4 (the "e" is consumed only when digits follow).
      const exp = /^[eE][+-]?[0-9]+/.exec(text.slice(j));
      if (exp && !/[a-zA-Z]/.test(text[j + exp[0].length] ?? '')) {
        raw += exp[0];
        j += exp[0].length;
      }
      tokens.push({ t: 'num', v: Number(raw) });
      i = j;
      continue;
    }
    if (/[a-zA-Zπ_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[a-zA-Zπ_0-9]/.test(text[j]!)) j++;
      tokens.push(...splitIdentifier(text.slice(i, j), names));
      i = j;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^') {
      tokens.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ t: ch });
      i++;
      continue;
    }
    throw new ExpressionError(`unexpected character "${ch}"`);
  }
  return tokens;
}

/**
 * "2xy" style products: an identifier that is not a function or constant is split into single-letter
 * variables followed by digits (x2 → x·2 is not allowed; x_1 stays one variable). A name the caller binds
 * (`names`, e.g. the `given` of a generated problem: v0, massa) is one variable.
 */
function splitIdentifier(id: string, names: ReadonlySet<string>): Token[] {
  const lower = id.toLowerCase();
  if (names.has(id)) return [{ t: 'id', v: id }];
  if (FUNCTIONS[lower] || CONSTANTS[lower] !== undefined || id.includes('_') || id.length === 1) {
    return [{ t: 'id', v: FUNCTIONS[lower] || CONSTANTS[lower] !== undefined ? lower : id }];
  }
  // A known function as a prefix ("sqrtx" → sqrt x) or a run of single-letter variables ("xy" → x y).
  for (const fn of Object.keys(FUNCTIONS).sort((a, b) => b.length - a.length)) {
    if (lower.startsWith(fn) && lower.length > fn.length) {
      const rest = id.slice(fn.length);
      return [{ t: 'id', v: fn }, ...(/^[0-9]+$/.test(rest) ? [{ t: 'num', v: Number(rest) } as Token] : splitIdentifier(rest, names))];
    }
  }
  const out: Token[] = [];
  for (const part of id.match(/[a-zA-Zπ][0-9]*/g) ?? []) {
    const letter = part[0]!;
    out.push({ t: 'id', v: CONSTANTS[letter.toLowerCase()] !== undefined && letter !== 'e' ? letter.toLowerCase() : letter });
    if (part.length > 1) out.push({ t: 'num', v: Number(part.slice(1)) });
  }
  return out;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): ExprNode {
    if (this.tokens.length === 0) throw new ExpressionError('empty expression');
    const node = this.expr();
    if (this.pos < this.tokens.length) throw new ExpressionError('unexpected input after the expression');
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expr(): ExprNode {
    let left = this.term();
    for (;;) {
      const tok = this.peek();
      if (tok?.t === 'op' && (tok.v === '+' || tok.v === '-')) {
        this.pos++;
        left = { kind: 'bin', op: tok.v, left, right: this.term() };
      } else return left;
    }
  }

  private term(): ExprNode {
    let left = this.unary();
    for (;;) {
      const tok = this.peek();
      if (tok?.t === 'op' && (tok.v === '*' || tok.v === '/')) {
        this.pos++;
        left = { kind: 'bin', op: tok.v, left, right: this.unary() };
      } else if (tok && (tok.t === 'num' || tok.t === 'id' || tok.t === '(')) {
        // Implicit multiplication binds like "*": 2x, 3(x+1), (a)(b), x y.
        left = { kind: 'bin', op: '*', left, right: this.power() };
      } else return left;
    }
  }

  private unary(): ExprNode {
    const tok = this.peek();
    if (tok?.t === 'op' && (tok.v === '-' || tok.v === '+')) {
      this.pos++;
      const arg = this.unary();
      return tok.v === '-' ? { kind: 'neg', arg } : arg;
    }
    return this.power();
  }

  /** Right-associative: 2^3^2 = 2^9. A unary minus in the exponent is allowed (x^-1). */
  private power(): ExprNode {
    const base = this.atom();
    const tok = this.peek();
    if (tok?.t === 'op' && tok.v === '^') {
      this.pos++;
      return { kind: 'bin', op: '^', left: base, right: this.unary() };
    }
    return base;
  }

  private atom(): ExprNode {
    const tok = this.peek();
    if (!tok) throw new ExpressionError('unexpected end of expression');
    this.pos++;
    if (tok.t === 'num') return { kind: 'num', value: tok.v };
    if (tok.t === '(') {
      const inner = this.expr();
      if (this.peek()?.t !== ')') throw new ExpressionError('missing ")"');
      this.pos++;
      return inner;
    }
    if (tok.t === 'id') {
      if (FUNCTIONS[tok.v]) {
        // sqrt(x), sqrt x, sen 30: a function applies to the next power-level operand.
        return { kind: 'call', fn: tok.v, arg: this.power() };
      }
      if (CONSTANTS[tok.v] !== undefined && tok.v !== 'e') return { kind: 'num', value: CONSTANTS[tok.v]! };
      return { kind: 'var', name: tok.v };
    }
    throw new ExpressionError('unexpected token');
  }
}

/** Parses an expression. Throws ExpressionError on invalid input. */
export function parseExpression(source: string, names: ReadonlySet<string> = new Set()): ExprNode {
  if (source.length > MAX_EXPRESSION_LENGTH) throw new ExpressionError('expression too long');
  return new Parser(tokenize(source, names)).parse();
}

/** Variable names used by an expression (the constant e counts as a variable only when bound). */
export function expressionVariables(node: ExprNode, out: Set<string> = new Set()): Set<string> {
  switch (node.kind) {
    case 'num':
      break;
    case 'var':
      out.add(node.name);
      break;
    case 'neg':
      expressionVariables(node.arg, out);
      break;
    case 'bin':
      expressionVariables(node.left, out);
      expressionVariables(node.right, out);
      break;
    case 'call':
      expressionVariables(node.arg, out);
      break;
  }
  return out;
}

/** Evaluates a parsed expression. Unbound variables throw; the bare name `e` is Euler's number. */
export function evaluateExpression(node: ExprNode, vars: Readonly<Record<string, number>> = {}): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'var': {
      const value = vars[node.name];
      if (value !== undefined) return value;
      if (node.name === 'e') return Math.E;
      throw new ExpressionError(`unknown variable "${node.name}"`);
    }
    case 'neg':
      return -evaluateExpression(node.arg, vars);
    case 'call':
      return FUNCTIONS[node.fn]!(evaluateExpression(node.arg, vars));
    case 'bin': {
      const a = evaluateExpression(node.left, vars);
      const b = evaluateExpression(node.right, vars);
      switch (node.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '^':
          return Math.pow(a, b);
      }
    }
  }
}

/** Parses and evaluates in one step. Returns null when the text is not a valid, finite expression. */
export function evaluateText(source: string, vars: Readonly<Record<string, number>> = {}): number | null {
  try {
    const value = evaluateExpression(parseExpression(source, new Set(Object.keys(vars))), vars);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Deterministic PRNG (mulberry32) so the sample points of an equivalence check are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function close(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-6 * scale;
}

export interface EquivalenceOptions {
  /** Points sampled (spec 05 §8.9 uses 5). */
  samples?: number;
  seed?: number;
  /** Fixed values for some variables (the item's `given`), the rest are sampled. */
  fixed?: Readonly<Record<string, number>>;
}

/**
 * True when both expressions agree at `samples` random points (values in [0.5, 3.5], away from common
 * singularities). Points where either side is undefined are skipped; at least 3 valid points are needed.
 * Invalid input (parse error, unknown function) is never equivalent.
 */
export function expressionsEquivalent(a: string, b: string, options: EquivalenceOptions = {}): boolean {
  let left: ExprNode;
  let right: ExprNode;
  try {
    left = parseExpression(a);
    right = parseExpression(b);
  } catch {
    return false;
  }
  const fixed = options.fixed ?? {};
  const free = [...new Set([...expressionVariables(left), ...expressionVariables(right)])].filter((v) => fixed[v] === undefined && v !== 'e').sort();
  const samples = Math.max(3, options.samples ?? 5);
  const random = mulberry32(options.seed ?? 0x5eed);
  let valid = 0;
  for (let attempt = 0; attempt < samples * 4 && valid < samples; attempt++) {
    const vars: Record<string, number> = { ...fixed };
    for (const name of free) vars[name] = 0.5 + random() * 3;
    let x: number;
    let y: number;
    try {
      x = evaluateExpression(left, vars);
      y = evaluateExpression(right, vars);
    } catch {
      return false;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!close(x, y)) return false;
    valid++;
  }
  return valid >= 3;
}

export interface ProblemConsistencyInput {
  given: Readonly<Record<string, number | string>>;
  final_answer: number | string;
  answer_format: 'numeric' | 'expression' | 'choice';
  tolerance?: number | null;
  check_expression?: string | null;
}

/**
 * Spec 05 §8.9 / PRA-08.6: the generator's own data must agree before an item is kept.
 * numeric: `check_expression` evaluated with `given` matches `final_answer` within `tolerance`.
 * expression: `final_answer` and `check_expression` are equivalent at random points.
 * choice: nothing to compute (kept).
 */
export function checkProblemConsistency(p: ProblemConsistencyInput): { ok: true } | { ok: false; reason: string } {
  if (p.answer_format === 'choice') return { ok: true };
  if (!p.check_expression) return { ok: false, reason: 'missing check_expression' };
  const numericGiven: Record<string, number> = {};
  for (const [key, value] of Object.entries(p.given)) {
    const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    if (Number.isFinite(n)) numericGiven[key] = n;
  }
  if (p.answer_format === 'expression') {
    return expressionsEquivalent(String(p.final_answer), p.check_expression, { fixed: {} })
      ? { ok: true }
      : { ok: false, reason: 'final_answer and check_expression differ' };
  }
  const computed = evaluateText(p.check_expression, numericGiven);
  if (computed === null) return { ok: false, reason: 'check_expression does not evaluate with given' };
  const expected = typeof p.final_answer === 'number' ? p.final_answer : evaluateText(String(p.final_answer));
  if (expected === null) return { ok: false, reason: 'final_answer is not a number' };
  const tolerance = Math.max(p.tolerance ?? 0, 1e-9 * Math.max(1, Math.abs(expected)));
  return Math.abs(computed - expected) <= tolerance
    ? { ok: true }
    : { ok: false, reason: `check_expression gives ${computed}, final_answer is ${expected}` };
}
