import { describe, expect, it } from 'vitest';
import {
  THETA_GRID,
  coherenceLevel,
  currentEstimates,
  detectParamScale,
  difficultyBand,
  eapEstimate,
  enemScore,
  pCorrect,
  personFit,
  quartiles,
  roundUpTo,
  scoreArea,
  sisuScore,
  sisuTargets,
  toStdParams,
  type SimuladoItemResponse,
  type TriParams,
} from '../../src/enem/index.ts';

const item = (b: number, a = 1.5, c = 0.2): TriParams => ({ a, b, c });

/** 45 items with b spread from −2 to 2.4. */
const bank: TriParams[] = Array.from({ length: 45 }, (_, i) => item(-2 + i * 0.1, 1 + (i % 3) * 0.4, 0.15 + (i % 4) * 0.03));

describe('3PL and EAP (spec 09 §8.3)', () => {
  it('uses an 81-point grid from −4 to 4', () => {
    expect(THETA_GRID).toHaveLength(81);
    expect(THETA_GRID[0]).toBe(-4);
    expect(THETA_GRID[80]).toBe(4);
    expect(THETA_GRID[40]).toBeCloseTo(0, 12);
  });

  it('P(θ) is c at −∞, (1 + c)/2 at θ = b, → 1 at +∞', () => {
    const p = item(0.5, 1.2, 0.2);
    expect(pCorrect(-50, p)).toBeCloseTo(0.2, 6);
    expect(pCorrect(0.5, p)).toBeCloseTo(0.6, 12);
    expect(pCorrect(50, p)).toBeCloseTo(1, 6);
    expect(pCorrect(0.5 + 0.1, { ...p, d: 1.7 })).toBeGreaterThan(pCorrect(0.5 + 0.1, p));
  });

  it('with no responses returns the prior (θ 0, se ≈ 1)', () => {
    const e = eapEstimate([]);
    expect(e.theta).toBeCloseTo(0, 10);
    expect(e.se).toBeCloseTo(1, 2);
  });

  it('matches a brute-force posterior on a fine grid', () => {
    const responses = bank.map((p, i) => ({ params: p, correct: i % 3 !== 0 && p.b < 1 }));
    const e = eapEstimate(responses);
    let num = 0;
    let den = 0;
    for (let t = -4; t <= 4.0000001; t += 0.001) {
      let l = Math.exp(-0.5 * t * t);
      for (const r of responses) {
        const p = pCorrect(t, r.params);
        l *= r.correct ? p : 1 - p;
      }
      num += l * t;
      den += l;
    }
    expect(e.theta).toBeCloseTo(num / den, 2);
  });

  it('more correct answers on harder items give a higher θ; the score is 500 + 100θ', () => {
    const low = eapEstimate(bank.map((p) => ({ params: p, correct: p.b < -1 })));
    const high = eapEstimate(bank.map((p) => ({ params: p, correct: p.b < 1.5 })));
    expect(high.theta).toBeGreaterThan(low.theta);
    expect(enemScore(high.theta)).toBe(Math.round(500 + 100 * high.theta));
    expect(high.se).toBeGreaterThan(0);
    expect(high.se).toBeLessThan(1);
  });

  it('a 15-item mini has a wider interval than a 45-item test at the same level', () => {
    const resp = (ps: TriParams[]) => ps.map((p) => ({ params: p, correct: p.b < 0.3 }));
    const mini = eapEstimate(resp(bank.filter((_, i) => i % 3 === 0)));
    const full = eapEstimate(resp(bank));
    expect(mini.se).toBeGreaterThan(full.se);
  });
});

describe('scoreArea (ENM-04.5, ENM-04.7)', () => {
  const items = (responses: (string | null)[]): SimuladoItemResponse[] =>
    bank.map((p, i) => ({ id: `i${i}`, params: p, answerKey: 'C', response: responses[i] ?? null }));

  it('counts blanks as incorrect: blank and wrong give the same estimate', () => {
    const blank = scoreArea(items(bank.map((p) => (p.b < 0 ? 'C' : null))));
    const wrong = scoreArea(items(bank.map((p) => (p.b < 0 ? 'C' : 'A'))));
    expect(blank.score).toBe(wrong.score);
    expect(blank.n_blank).toBe(bank.filter((p) => p.b >= 0).length);
    expect(wrong.n_blank).toBe(0);
  });

  it('skips annulled items and items without parameters or key', () => {
    const base = items(bank.map((p) => (p.b < 0 ? 'C' : 'A')));
    base[0] = { ...base[0]!, annulled: true };
    base[1] = { ...base[1]!, params: null };
    base[2] = { ...base[2]!, answerKey: null };
    const r = scoreArea(base);
    expect(r.n_items).toBe(42);
  });

  it('reports the 80% interval as 500 + 100·(θ ± 1.2816·se), rounded', () => {
    const r = scoreArea(items(bank.map((p) => (p.b < 0.5 ? 'C' : 'B'))));
    expect(r.ci80_low).toBe(Math.round(500 + 100 * (r.theta - 1.2816 * r.se)));
    expect(r.ci80_high).toBe(Math.round(500 + 100 * (r.theta + 1.2816 * r.se)));
    expect(r.ci80_low).toBeLessThan(r.score);
    expect(r.ci80_high).toBeGreaterThan(r.score);
  });

  it('flags easy misses (P ≥ 0.70) and lucky hits (P ≤ 0.35) on a synthetic pattern', () => {
    // Coherent pattern around b = 0.5, then: miss the 3 easiest, hit the 2 hardest.
    const answers = bank.map((p) => (p.b < 0.5 ? 'C' : 'A'));
    answers[0] = 'A';
    answers[1] = 'A';
    answers[2] = 'A';
    answers[44] = 'C';
    answers[43] = 'C';
    const r = scoreArea(items(answers));
    expect(r.coherence.easy_miss_ids).toEqual(expect.arrayContaining(['i0', 'i1', 'i2']));
    expect(r.coherence.lucky_hit_ids).toEqual(expect.arrayContaining(['i44', 'i43']));
    for (const id of r.coherence.easy_miss_ids) expect(pCorrect(r.theta, bank[Number(id.slice(1))]!)).toBeGreaterThanOrEqual(0.7);
  });

  it('l_z: a Guttman-like pattern is "alta", a reversed pattern is "baixa"', () => {
    const coherent = bank.map((p) => ({ params: p, correct: p.b < 0.2 }));
    const reversed = bank.map((p) => ({ params: p, correct: p.b >= 0.2 }));
    const fitC = personFit(coherent, eapEstimate(coherent).theta)!;
    const fitR = personFit(reversed, eapEstimate(reversed).theta)!;
    expect(fitC.level).toBe('alta');
    expect(fitR.level).toBe('baixa');
    expect(fitR.lz).toBeLessThan(fitC.lz);
    expect(personFit([], 0)).toBeNull();
  });

  it('coherence levels follow the −1 / −1.64 thresholds', () => {
    expect(coherenceLevel(-1)).toBe('alta');
    expect(coherenceLevel(-1.2)).toBe('media');
    expect(coherenceLevel(-1.64)).toBe('media');
    expect(coherenceLevel(-1.65)).toBe('baixa');
  });
});

describe('parameter scale (spec 09 §8.1) and difficulty bands (ENM-02.3)', () => {
  it('detects the 500/100 scale from the median b and converts it', () => {
    expect(detectParamScale([480, 520, 610, 700])).toBe('enem');
    expect(detectParamScale([-1, 0.2, 1.4])).toBe('std');
    expect(detectParamScale([])).toBe('std');
    expect(toStdParams({ a: 0.015, b: 620, c: 0.2, scale: 'enem' })).toEqual({ a: 1.5, b: 1.2, c: 0.2, d: 1 });
    expect(toStdParams({ a: 1.5, b: 1.2, c: 0.2, scale: 'std', logistic_d: 1.7 })).toEqual({ a: 1.5, b: 1.2, c: 0.2, d: 1.7 });
  });

  it('bands by quartiles of b', () => {
    const q = quartiles([-2, -1, 0, 1, 2]);
    expect(q).toEqual([-1, 0, 1]);
    expect(difficultyBand(-1.5, q)).toBe('facil');
    expect(difficultyBand(-0.5, q)).toBe('media');
    expect(difficultyBand(0.5, q)).toBe('dificil');
    expect(difficultyBand(1, q)).toBe('muito_dificil');
  });
});

describe('Meta SISU (spec 09 §8.4)', () => {
  const weights = { LC: 1, CH: 1, CN: 2, MT: 3, RED: 2 };
  const estimates = { LC: 650, CH: 700, CN: 600, MT: 620, RED: 760 };

  it('reproduces the worked example exactly', () => {
    expect(sisuScore(weights, estimates)).toBeCloseTo(5930 / 9, 10);
    const r = sisuTargets({ weights, estimates, cutoff: 720, margin: 15 });
    expect(r.status).toBe('ok');
    expect(r.required).toBe(735);
    expect(r.current).toBeCloseTo(658.9, 1);
    expect(r.targets.LC).toBeCloseTo(720.6, 1);
    expect(r.targets.CH).toBeCloseTo(753.0, 1);
    expect(r.targets.CN).toBeCloseTo(688.3, 1);
    expect(r.targets.MT).toBeCloseTo(701.2, 1);
    expect(r.targets.RED).toBeCloseTo(830.6, 1);
    // Σ w·t = T·Σw.
    const total = 1 * r.targets.LC + 1 * r.targets.CH + 2 * r.targets.CN + 3 * r.targets.MT + 2 * r.targets.RED;
    expect(total).toBeCloseTo(6615, 6);
    expect(r.display).toEqual({ LC: 725, CH: 755, CN: 690, MT: 705, RED: 840 });
  });

  it('says the student is above the cut-off when G ≤ 0', () => {
    const r = sisuTargets({ weights, estimates, cutoff: 600 });
    expect(r.status).toBe('above');
    expect(r.gap).toBe(0);
    expect(r.targets).toEqual(estimates);
  });

  it('pins a target over its cap and redistributes to the others', () => {
    const r = sisuTargets({ weights: { LC: 1, CH: 1, CN: 1, MT: 1, RED: 1 }, estimates: { LC: 840, CH: 600, CN: 600, MT: 600, RED: 600 }, cutoff: 700, margin: 0, caps: { LC: 845 } });
    expect(r.targets.LC).toBeLessThanOrEqual(845 + 1e-9);
    const sum = Object.values(r.targets).reduce((s, x) => s + x, 0);
    expect(sum).toBeCloseTo(3500, 6);
    expect(r.status).toBe('ok');
  });

  it('respects institution minimum scores', () => {
    const r = sisuTargets({ weights, estimates: { ...estimates, RED: 500 }, cutoff: 650, margin: 15, minScores: { RED: 600 } });
    expect(r.targets.RED).toBeGreaterThanOrEqual(600);
    for (const k of ['LC', 'CH', 'CN', 'MT'] as const) expect(r.targets[k]).toBeGreaterThanOrEqual(estimates[k] - 1e-9);
  });

  it('a minimum below the estimate still holds when the student is above the cut-off', () => {
    const r = sisuTargets({ weights, estimates: { ...estimates, MT: 450 }, cutoff: 500, minScores: { MT: 500 } });
    expect(r.targets.MT).toBe(500);
    expect(r.status).toBe('ok');
  });

  it('reports an impossible target when the caps cannot absorb the gap', () => {
    const r = sisuTargets({ weights, estimates, cutoff: 990 });
    expect(r.status).toBe('impossible');
  });

  it('rounds objective targets up to 5 and redação up to 20, tolerant to floating noise', () => {
    expect(roundUpTo(753.0000000001, 5)).toBe(755);
    expect(roundUpTo(755.0000000001, 5)).toBe(755);
    expect(roundUpTo(821, 20)).toBe(840);
  });

  it('current estimates: last 2 simulados per area, last 3 essays', () => {
    const est = currentEstimates(
      [
        { area: 'MT', score: 600, at: '2026-08-01T00:00:00Z' },
        { area: 'MT', score: 640, at: '2026-09-01T00:00:00Z' },
        { area: 'MT', score: 700, at: '2026-10-01T00:00:00Z' },
        { area: 'LC', score: 580, at: '2026-10-01T00:00:00Z' },
      ],
      [
        { total: 600, at: '2026-07-01T00:00:00Z' },
        { total: 700, at: '2026-08-01T00:00:00Z' },
        { total: 760, at: '2026-09-01T00:00:00Z' },
        { total: 820, at: '2026-10-01T00:00:00Z' },
      ],
    );
    expect(est).toEqual({ MT: 670, LC: 580, RED: (700 + 760 + 820) / 3 });
  });
});
