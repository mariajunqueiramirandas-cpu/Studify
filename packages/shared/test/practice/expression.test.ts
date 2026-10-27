import { describe, expect, it } from 'vitest';
import {
  checkProblemConsistency,
  evaluateText,
  expressionVariables,
  expressionsEquivalent,
  parseExpression,
} from '../../src/practice/index.ts';

describe('evaluateText (PRA-08.4 parser)', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2^3^2', 512],
    ['-2^2', -4],
    ['2 ** 3', 8],
    ['10 / 4', 2.5],
    ['3,5 + 1,5', 5],
    ['2 × 3 ÷ 4', 1.5],
    ['−3 + 5', 2],
    ['sqrt(16) + raiz 9', 7],
    ['√16', 4],
    ['abs(-2)', 2],
    ['log(1000)', 3],
    ['ln(e)', 1],
    ['sen(0) + cos(0)', 1],
    ['2pi', 2 * Math.PI],
    ['π', Math.PI],
    ['1.5e3', 1500],
    ['[2 + {3}]', 5],
  ])('%s = %d', (source, expected) => {
    expect(evaluateText(source)).toBeCloseTo(expected, 9);
  });

  it('supports variables and implicit multiplication', () => {
    expect(evaluateText('2x + 3', { x: 4 })).toBe(11);
    expect(evaluateText('3(x+1)', { x: 1 })).toBe(6);
    expect(evaluateText('xy', { x: 2, y: 5 })).toBe(10);
    expect(evaluateText('2x^2', { x: 3 })).toBe(18);
    expect(evaluateText('x^-1', { x: 4 })).toBe(0.25);
    expect(evaluateText('v_0 + a t', { v_0: 2, a: 3, t: 4 })).toBe(14);
  });

  it('returns null for invalid, unbound or non-finite expressions', () => {
    expect(evaluateText('')).toBeNull();
    expect(evaluateText('2 +')).toBeNull();
    expect(evaluateText('(1 + 2')).toBeNull();
    expect(evaluateText('x + 1')).toBeNull();
    expect(evaluateText('1 / 0')).toBeNull();
    expect(evaluateText('2 $ 3')).toBeNull();
    expect(evaluateText('1'.repeat(400))).toBeNull();
    expect(evaluateText('alert(1)')).toBeNull();
  });

  it('lists the variables of an expression', () => {
    expect([...expressionVariables(parseExpression('a x^2 + b x + c'))].sort()).toEqual(['a', 'b', 'c', 'x']);
  });
});

describe('expressionsEquivalent (spec 05 §8.9)', () => {
  it('accepts algebraically equal forms', () => {
    expect(expressionsEquivalent('(x+1)^2', 'x^2 + 2x + 1')).toBe(true);
    expect(expressionsEquivalent('2(a+b)', '2a + 2b')).toBe(true);
    expect(expressionsEquivalent('x/2', '0,5x')).toBe(true);
    expect(expressionsEquivalent('sqrt(x^2)', 'x')).toBe(true);
  });

  it('rejects different expressions and invalid input', () => {
    expect(expressionsEquivalent('(x+1)^2', 'x^2 + 1')).toBe(false);
    expect(expressionsEquivalent('x + y', 'x + 2y')).toBe(false);
    expect(expressionsEquivalent('x +', 'x')).toBe(false);
    expect(expressionsEquivalent('foo(x)', 'x')).toBe(false);
  });

  it('is deterministic for a given seed', () => {
    const a = expressionsEquivalent('x^3', 'x*x*x', { seed: 1 });
    const b = expressionsEquivalent('x^3', 'x*x*x', { seed: 1 });
    expect(a).toBe(b);
  });
});

describe('checkProblemConsistency (PRA-08.6)', () => {
  it('keeps a numeric problem whose check expression matches the answer', () => {
    expect(
      checkProblemConsistency({ given: { m: 2, a: 3 }, final_answer: 6, answer_format: 'numeric', tolerance: 0.01, check_expression: 'm*a' }),
    ).toEqual({ ok: true });
  });

  it('drops a numeric problem whose check expression disagrees with the final answer', () => {
    const result = checkProblemConsistency({ given: { m: 2, a: 3 }, final_answer: 7, answer_format: 'numeric', tolerance: 0.01, check_expression: 'm*a' });
    expect(result.ok).toBe(false);
  });

  it('drops a numeric problem without a usable check expression', () => {
    expect(checkProblemConsistency({ given: {}, final_answer: 1, answer_format: 'numeric', check_expression: null }).ok).toBe(false);
    expect(checkProblemConsistency({ given: {}, final_answer: 1, answer_format: 'numeric', check_expression: 'k + 1' }).ok).toBe(false);
  });

  it('checks expression problems by equivalence and keeps choice problems', () => {
    expect(checkProblemConsistency({ given: {}, final_answer: '2x + 2', answer_format: 'expression', check_expression: '2(x+1)' }).ok).toBe(true);
    expect(checkProblemConsistency({ given: {}, final_answer: '2x + 1', answer_format: 'expression', check_expression: '2(x+1)' }).ok).toBe(false);
    expect(checkProblemConsistency({ given: {}, final_answer: 'C', answer_format: 'choice' }).ok).toBe(true);
  });

  it('reads string givens with a decimal comma', () => {
    expect(checkProblemConsistency({ given: { v: '2,5', t: 4 }, final_answer: '10', answer_format: 'numeric', check_expression: 'v*t' }).ok).toBe(true);
  });
});
