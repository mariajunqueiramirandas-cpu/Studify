import { describe, expect, it } from 'vitest';
import {
  applyRetryOutcome,
  mistakeEntryAction,
  newRetrySchedule,
  nextRetry,
  rePracticeFor,
  retriesDue,
  suggestCause,
  type AnswerFacts,
} from '../../src/learning/index.ts';

const facts = (over: Partial<AnswerFacts> = {}): AnswerFacts => ({
  stemHasQualifier: false,
  pickedOptionIsTrueStatement: false,
  pickedMisconceptionConceptId: null,
  confidence: 2,
  timeSeconds: 30,
  medianTimeSeconds: 30,
  skipped: false,
  ...over,
});

describe('suggested cause (§7.1, spec 05 §8.5)', () => {
  it('a qualifier in the stem with a true-statement pick is a misreading', () => {
    expect(suggestCause(facts({ stemHasQualifier: true, pickedOptionIsTrueStatement: true, confidence: 4 }))).toBe('misread');
  });

  it('a misconception option is confusion, before any timing rule', () => {
    expect(suggestCause(facts({ pickedMisconceptionConceptId: 'mc-1', confidence: 4, timeSeconds: 1 }))).toBe('confused');
  });

  it('confident and fast (under 40% of the median) is careless', () => {
    expect(suggestCause(facts({ confidence: 4, timeSeconds: 3, medianTimeSeconds: 10 }))).toBe('careless');
  });

  it('without a median, under 15 s and confident is careless', () => {
    expect(suggestCause(facts({ confidence: 3, timeSeconds: 12, medianTimeSeconds: null }))).toBe('careless');
    expect(suggestCause(facts({ confidence: 3, timeSeconds: 20, medianTimeSeconds: null }))).toBe('didnt_know');
  });

  it('confident but not fast enough is still a knowledge gap', () => {
    expect(suggestCause(facts({ confidence: 4, timeSeconds: 9, medianTimeSeconds: 10 }))).toBe('didnt_know');
  });

  it('low confidence, skipped, or more than twice the median time is didnt_know', () => {
    expect(suggestCause(facts({ confidence: 2, timeSeconds: 1 }))).toBe('didnt_know');
    expect(suggestCause(facts({ skipped: true, confidence: 2, timeSeconds: 1 }))).toBe('didnt_know');
    // Confident and fast wins over skipped: the careless rule is checked first (§7.1 order).
    expect(suggestCause(facts({ skipped: true, confidence: 4, timeSeconds: 1 }))).toBe('careless');
    expect(suggestCause(facts({ confidence: 4, timeSeconds: 25, medianTimeSeconds: 10 }))).toBe('didnt_know');
  });
});

describe('re-practice by cause (§7.2)', () => {
  it('maps each cause to its drill', () => {
    expect(rePracticeFor('didnt_know')).toEqual(['concept_notes', 'remediation_card', 'variant_question']);
    expect(rePracticeFor('confused')).toEqual(['contrast_drill', 'variant_question']);
    expect(rePracticeFor('careless')).toEqual(['same_question_slow_mode', 'tip']);
    expect(rePracticeFor('misread')).toEqual(['same_question_qualifiers_highlighted', 'qualifier_question']);
  });

  it('creates an entry for wrong or partial-below-half answers and offers one for a correct "Chutando"', () => {
    expect(mistakeEntryAction(0, 4)).toBe('create');
    expect(mistakeEntryAction(0.4, 2)).toBe('create');
    expect(mistakeEntryAction(1, 1)).toBe('offer');
    expect(mistakeEntryAction(1, 4)).toBe('none');
  });
});

describe('retry schedule (§7.3)', () => {
  const mistakeDay = '2026-10-26';

  it('first retry is one study day later, then +3, and two correct days resolve the entry', () => {
    let s = newRetrySchedule(mistakeDay);
    expect(nextRetry(s)).toBe('2026-10-27');
    s = applyRetryOutcome(s, 'correct', '2026-10-27');
    expect(nextRetry(s)).toBe('2026-10-29');
    s = applyRetryOutcome(s, 'correct', '2026-10-29');
    expect(s.resolved).toBe(true);
    expect(nextRetry(s)).toBe('resolved');
  });

  it('a wrong retry restarts the schedule at +1 study day and clears the correct days', () => {
    let s = newRetrySchedule(mistakeDay);
    s = applyRetryOutcome(s, 'correct', '2026-10-27');
    s = applyRetryOutcome(s, 'wrong', '2026-10-29');
    expect(s.correctDays).toEqual([]);
    expect(nextRetry(s)).toBe('2026-10-30');
  });

  it('two correct answers on the same study day count as one', () => {
    let s = newRetrySchedule(mistakeDay);
    s = applyRetryOutcome(s, 'correct', '2026-10-27');
    s = applyRetryOutcome(s, 'correct', '2026-10-27');
    expect(s.resolved).toBe(false);
  });

  it('nextRetry with an outcome advances the schedule', () => {
    const s = newRetrySchedule(mistakeDay);
    expect(nextRetry(s, 'correct', '2026-10-27')).toBe('2026-10-29');
  });

  it('retries due today or earlier are listed for Hoje and the Feed', () => {
    const entries = [
      { id: 'due', schedule: newRetrySchedule('2026-10-26') },
      { id: 'later', schedule: newRetrySchedule('2026-10-27') },
      { id: 'done', schedule: { ...newRetrySchedule('2026-10-20'), resolved: true } },
    ];
    expect(retriesDue(entries, '2026-10-27').map((e) => e.id)).toEqual(['due']);
  });
});
