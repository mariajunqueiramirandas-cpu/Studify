import { describe, expect, it } from 'vitest';
import {
  ENEM_COMPETENCIES,
  aggregateCorrections,
  allSkillCodes,
  competencyOf,
  discrepant,
  estimateHandwrittenLines,
  parseSkillCode,
  redacaoLineCheck,
  redacaoTotal,
  simuladoShape,
  skillCodeFromMicrodata,
  snapToGrid,
  targetPaceMin,
  timeAnalysis,
  transcriptionLineCount,
} from '../../src/enem/index.ts';

describe('Matriz skill codes (spec 09 §8.2)', () => {
  it('has 120 codes and the competência counts of each area', () => {
    expect(allSkillCodes()).toHaveLength(120);
    expect(ENEM_COMPETENCIES.LC).toHaveLength(9);
    expect(ENEM_COMPETENCIES.MT).toHaveLength(7);
    expect(ENEM_COMPETENCIES.CN).toHaveLength(8);
    expect(ENEM_COMPETENCIES.CH).toHaveLength(6);
    for (const ranges of Object.values(ENEM_COMPETENCIES)) {
      // Contiguous H1–H30.
      expect(ranges[0]![0]).toBe(1);
      expect(ranges[ranges.length - 1]![1]).toBe(30);
      for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1);
    }
  });

  it('maps skills to competências as the SQL seed does', () => {
    expect(competencyOf('MT', 21)).toBe(5);
    expect(competencyOf('LC', 7)).toBe(2);
    expect(competencyOf('CH', 30)).toBe(6);
    expect(competencyOf('CN', 17)).toBe(5);
    expect(parseSkillCode('CN-H17')).toEqual({ code: 'CN-H17', area: 'CN', skill: 17, competency: 5 });
    expect(parseSkillCode('MT-H31')).toBeNull();
    expect(parseSkillCode('XX-H1')).toBeNull();
    expect(skillCodeFromMicrodata('MT', '21')).toBe('MT-H21');
    expect(skillCodeFromMicrodata('MT', 0)).toBeNull();
    expect(skillCodeFromMicrodata('MT', null)).toBeNull();
  });
});

describe('Redação rules (spec 09 §8.6)', () => {
  const para = (n: number) => 'a'.repeat(n);

  it('estimates handwritten lines per paragraph with 75 characters per line', () => {
    expect(estimateHandwrittenLines(`${para(150)}\n\n${para(76)}\n${para(10)}`)).toBe(2 + 2 + 1);
    expect(estimateHandwrittenLines('   \n\n')).toBe(0);
    expect(transcriptionLineCount('linha 1\n\nlinha 2\r\nlinha 3\n')).toBe(3);
  });

  it('≤ 7 lines is zero before any model call; > 30 lines is a warning', () => {
    expect(redacaoLineCheck(para(7 * 75), 'typed')).toMatchObject({ lines: 7, tooShort: true });
    expect(redacaoLineCheck(para(7 * 75 + 1), 'typed')).toMatchObject({ lines: 8, tooShort: false });
    expect(redacaoLineCheck(Array.from({ length: 31 }, () => 'x').join('\n'), 'photo')).toMatchObject({ lines: 31, tooLong: true, tooShort: false });
    expect(redacaoLineCheck('', 'typed')).toMatchObject({ blank: true, tooShort: true });
  });

  it('sums the five grid scores; a human-rights violation zeroes only C5', () => {
    const competencias = [1, 2, 3, 4, 5].map((id) => ({ id, score: 160 }));
    expect(redacaoTotal({ competencias, zeroReasons: [], humanRightsOk: true }).total).toBe(800);
    const hr = redacaoTotal({ competencias, zeroReasons: [], humanRightsOk: false });
    expect(hr.total).toBe(640);
    expect(hr.scores).toEqual({ c1: 160, c2: 160, c3: 160, c4: 160, c5: 0 });
  });

  it('any zero condition makes the total 0 and hides the per-competência scores', () => {
    const r = redacaoTotal({ competencias: [1, 2, 3, 4, 5].map((id) => ({ id, score: 200 })), zeroReasons: ['fuga_tema', 'fuga_tema'], humanRightsOk: true });
    expect(r).toEqual({ total: 0, isZero: true, zeroReasons: ['fuga_tema'], scores: {}, snapped: [] });
  });

  it('every score lands on the 40-point grid', () => {
    const r = redacaoTotal({ competencias: [{ id: 1, score: 150 }, { id: 2, score: 210 }, { id: 3, score: 0 }, { id: 4, score: 79 }, { id: 5, score: 120 }], zeroReasons: [], humanRightsOk: true });
    for (const v of Object.values(r.scores)) expect(v % 40).toBe(0);
    expect(r.snapped).toEqual([1, 2, 4]);
    expect(snapToGrid(-10)).toBe(0);
    expect(snapToGrid(999)).toBe(200);
    expect(() => redacaoTotal({ competencias: [{ id: 1, score: 40 }], zeroReasons: [], humanRightsOk: true })).toThrow();
  });

  it('dual correction: discrepancy rules and the mean of the two closest', () => {
    const a = [160, 160, 160, 160, 160];
    const b = [160, 160, 120, 160, 160];
    expect(discrepant(a, b)).toBe(false);
    expect(aggregateCorrections([a, b])).toEqual({ status: 'final', scores: [160, 160, 140, 160, 160], total: 780 });
    const far = [80, 160, 160, 160, 160];
    const c = [200, 160, 160, 160, 160];
    expect(discrepant(far, c)).toBe(true); // a competência differs by 120
    expect(aggregateCorrections([far, c])).toEqual({ status: 'needs_third' });
    const third = [200, 160, 160, 160, 120];
    const r = aggregateCorrections([far, c, third]);
    expect(r).toEqual({ status: 'final', scores: [200, 160, 160, 160, 140], total: 820 });
  });
});

describe('Simulado shapes and time coaching (ENM-04.1, §8.5)', () => {
  it('shapes the four modes', () => {
    expect(simuladoShape({ mode: 'day1' })).toEqual({ areas: ['LC', 'CH'], itemCount: 90, timeLimitMin: 330, includesEssay: true });
    expect(simuladoShape({ mode: 'day2', day2Min: 300 })).toMatchObject({ areas: ['CN', 'MT'], itemCount: 90, timeLimitMin: 300 });
    expect(simuladoShape({ mode: 'area', area: 'MT' })).toMatchObject({ itemCount: 45, timeLimitMin: 135 });
    expect(simuladoShape({ mode: 'mini', area: 'CN', miniSize: 30 })).toMatchObject({ itemCount: 30, timeLimitMin: 90 });
    expect(() => simuladoShape({ mode: 'area' })).toThrow();
  });

  it('targets ≈ 3.0 min/item on Day 2 and ≈ 2.5 on Day 1', () => {
    expect(targetPaceMin({ mode: 'day2', durationMin: 300 })).toBeCloseTo(3.0, 10);
    expect(targetPaceMin({ mode: 'day1', durationMin: 330 })).toBeCloseTo(2.5, 10);
    expect(targetPaceMin({ mode: 'area' })).toBe(3);
  });

  it('flags items over 2 × target and shows accuracy by blocks of 15', () => {
    const answers = Array.from({ length: 45 }, (_, i) => ({ id: `q${i + 1}`, position: i + 1, seconds: i === 9 ? 400 : 150, correct: i < 30 }));
    const t = timeAnalysis(answers, 3);
    expect(t.stuck_ids).toEqual(['q10']);
    expect(t.total_s).toBe(44 * 150 + 400);
    expect(t.blocks.map((b) => b.accuracy)).toEqual([1, 1, 0]);
    expect(t.blocks[2]).toMatchObject({ from: 31, to: 45, n: 15, correct: 0 });
  });
});
