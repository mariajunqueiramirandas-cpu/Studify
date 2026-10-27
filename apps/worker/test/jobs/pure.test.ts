import { describe, expect, it } from 'vitest';
import { buildZip, crc32, toCsv } from '../../src/lib/zip.ts';
import { largestRemainder, predictedBlueprint, seededRandom, teacherStatistics, teacherTopicWeights } from '../../src/lib/prova.ts';
import { questionPayloadFor } from '../../src/lib/prova-questions.ts';
import { inQuietHours, quietEndInstant } from '../../src/lib/time.ts';
import { decideDelivery, channelEnabled, DAILY_CAP } from '../../src/lib/notify-policy.ts';
import { fillTemplate, notifyEntry } from '../../src/lib/notify-catalog.ts';
import { aggregateInsights, battleStep, scoreBattleAnswer } from '../../src/lib/social.ts';
import { scoreFromCriteria, createsMistake } from '../../src/lib/grading.ts';
import { carryOverDone, plannerTriggerOf, storedTriggerOf, type PlanItemRow } from '../../src/lib/plan-data.ts';
import { daysInRange, weekdayMon0, dailyActivityFor, rollStreak } from '../../src/lib/streaks.ts';
import { validReviewLogs } from '../../src/jobs/learning.ts';
import { fixPatch, reasonLabel, ITEM_SPECS } from '../../src/jobs/trust.ts';
import { initialStreakState } from '@studify/shared';

describe('zip writer', () => {
  it('matches the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a store-only archive that a minimal reader can read back', () => {
    const enc = new TextEncoder();
    const zip = buildZip([
      { name: 'a.json', data: enc.encode('[1,2]') },
      { name: 'pasta/b.csv', data: enc.encode('x,y\r\n1,2\r\n') },
    ]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    const count = view.getUint16(eocd + 10, true);
    expect(count).toBe(2);
    let pos = view.getUint32(eocd + 16, true);
    const names: string[] = [];
    for (let i = 0; i < count; i++) {
      expect(view.getUint32(pos, true)).toBe(0x02014b50);
      const size = view.getUint32(pos + 20, true);
      const nameLen = view.getUint16(pos + 28, true);
      const localOffset = view.getUint32(pos + 42, true);
      names.push(new TextDecoder().decode(zip.subarray(pos + 46, pos + 46 + nameLen)));
      const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true);
      expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
      expect(zip.subarray(dataStart, dataStart + size).length).toBe(size);
      pos += 46 + nameLen;
    }
    expect(names).toEqual(['a.json', 'pasta/b.csv']);
  });

  it('quotes CSV values that need it', () => {
    expect(toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }, { a: null, b: 3 }])).toBe('a,b\r\n"x,y","say ""hi"""\r\n,3\r\n');
  });
});

describe('quiet hours (PLT-05.3)', () => {
  it('wraps midnight and reports the end of the window in UTC', () => {
    const late = new Date('2026-10-28T02:30:00.000Z'); // 23:30 on 27 Oct in São Paulo
    expect(inQuietHours(late, 'America/Sao_Paulo', '22:00', '07:00')).toBe(true);
    expect(inQuietHours(new Date('2026-10-27T15:00:00.000Z'), 'America/Sao_Paulo', '22:00', '07:00')).toBe(false);
    expect(quietEndInstant(late, 'America/Sao_Paulo', '07:00').toISOString()).toBe('2026-10-28T10:00:00.000Z');
  });
});

describe('notification policy (PLT-05)', () => {
  const base = { delivery: 'push' as const, channel: 'class' as const, countsTowardCap: true, channelEnabled: true, hasToken: true, sentToday: 0, inQuiet: false };
  it('sends, defers in quiet hours, drops on cap, no token, disabled channel and local-only types', () => {
    expect(decideDelivery(base)).toEqual({ action: 'send' });
    expect(decideDelivery({ ...base, inQuiet: true })).toEqual({ action: 'defer' });
    expect(decideDelivery({ ...base, sentToday: DAILY_CAP })).toEqual({ action: 'drop', reason: 'daily_cap' });
    expect(decideDelivery({ ...base, countsTowardCap: false, sentToday: DAILY_CAP })).toEqual({ action: 'send' });
    expect(decideDelivery({ ...base, hasToken: false })).toEqual({ action: 'drop', reason: 'no_token' });
    expect(decideDelivery({ ...base, channelEnabled: false })).toEqual({ action: 'drop', reason: 'disabled' });
    expect(decideDelivery({ ...base, delivery: 'local' })).toEqual({ action: 'drop', reason: 'local_only' });
  });

  it('reads channel toggles and defaults missing keys to on', () => {
    expect(channelEnabled({ notifications: { class: false } }, 'class')).toBe(false);
    expect(channelEnabled({ notifications: { class: false } }, 'plan')).toBe(true);
    expect(channelEnabled(null, 'plan')).toBe(true);
  });

  it('fills templates and knows the catalog', () => {
    expect(fillTemplate('studify://subjects/{subject_id}', { subject_id: 'abc' })).toBe('studify://subjects/abc');
    expect(notifyEntry('reviews_due')?.delivery).toBe('local');
    expect(notifyEntry('nope')).toBeNull();
  });
});

describe('Prova Provável math (learning-engine §9)', () => {
  it('reproduces the §9.1 fixture: ω ≈ {0.468, 0.241, 0.291}', () => {
    const scope = ['t1', 't2', 't3'];
    const w = teacherTopicWeights(scope, { t1: 0.4, t2: 0.35, t3: 0.25 }, { t1: 0.5, t2: 0.1, t3: 0.3 }, 2);
    expect(w.t1).toBeCloseTo(0.468, 3);
    expect(w.t2).toBeCloseTo(0.241, 3);
    expect(w.t3).toBeCloseTo(0.291, 3);
  });

  it('largest remainder allocates exactly the total', () => {
    expect(largestRemainder(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(largestRemainder(7, [0.5, 0.5])).toEqual([4, 3]);
  });

  it('blueprint is deterministic per seed, has Q slots and covers heavy topics', () => {
    const input = {
      questionsPerTest: 10,
      typeMix: { mcq_single: 0.7, short_answer: 0.3 },
      bloomMix: { understand: 0.5, apply: 0.5 },
      difficultyMean: 3,
      weights: { a: 0.6, b: 0.3, c: 0.1 },
      seed: 'u|e|0',
    };
    const first = predictedBlueprint(input);
    expect(first).toEqual(predictedBlueprint(input));
    expect(first).toHaveLength(10);
    expect(new Set(first.map((s) => s.topicKey)).has('a')).toBe(true);
    expect(first.filter((s) => s.type === 'mcq_single')).toHaveLength(7);
    expect(seededRandom('x')()).toBe(seededRandom('x')());
  });

  it('teacher statistics count types, bloom and per-topic point shares', () => {
    const stats = teacherStatistics([
      { testId: 't1', totalPoints: 10, questions: [
        { type: 'mcq_single', bloom: 'apply', difficulty: 3, points: 5, nodeId: 'a' },
        { type: 'short_answer', bloom: 'understand', difficulty: 4, points: 5, nodeId: 'b' },
      ] },
    ]);
    expect(stats.typeMix).toEqual({ mcq_single: 0.5, short_answer: 0.5 });
    expect(stats.questionsPerTest).toBe(2);
    expect(stats.pointsShare).toEqual({ a: 0.5, b: 0.5 });
  });
});

describe('extracted question payloads (spec 05 §8.1)', () => {
  it('builds a valid mcq payload only when the answer key matches an option', () => {
    const alternatives = [1, 2, 3, 4].map((i) => ({ label: String.fromCharCode(64 + i), text_md: `opção ${i}` }));
    const ok = questionPayloadFor({ type: 'mcq_single', statement_md: 'Qual?', alternatives, answer: { value: 'b', source: 'printed' }, solution_md: 'Porque sim.', points: null });
    expect(ok).toMatchObject({ ok: true, type: 'mcq_single' });
    const missing = questionPayloadFor({ type: 'mcq_single', statement_md: 'Qual?', alternatives, answer: { value: 'Z', source: 'printed' }, solution_md: null, points: null });
    expect(missing).toEqual({ ok: false, reason: 'no_answer_key' });
  });

  it('maps true/false words and skips unsupported types', () => {
    const tf = questionPayloadFor({ type: 'true_false', statement_md: 'x', alternatives: null, answer: { value: 'falso', source: 'printed' }, solution_md: null, points: null });
    expect(tf).toMatchObject({ ok: true, payload: { correct: false } });
    expect(questionPayloadFor({ type: 'problem', statement_md: 'x', alternatives: null, answer: null, solution_md: null, points: null })).toEqual({ ok: false, reason: 'unsupported_type' });
  });
});

describe('grading arithmetic (PRA-01.6, PRA-01.8)', () => {
  const rubric = [
    { id: 'c1', criterion: 'definição', points: 2 },
    { id: 'c2', criterion: 'exemplo', points: 2 },
  ];
  it('computes the score from verdicts and rejects unknown or inflated criteria', () => {
    const good = scoreFromCriteria(rubric, [{ id: 'c1', verdict: 'full', points: 2, justification: 'ok' }], 4);
    expect(good).toMatchObject({ ok: true, score: 0.5, partial: true, correct: false });
    expect(scoreFromCriteria(rubric, [{ id: 'zz', verdict: 'full', points: 2, justification: 'x' }], 4)).toEqual({ ok: false, reason: 'unknown_criterion:zz' });
    expect(scoreFromCriteria(rubric, [{ id: 'c1', verdict: 'full', points: 9, justification: 'x' }], 4)).toEqual({ ok: false, reason: 'points_out_of_range:c1' });
    expect(createsMistake(0.4)).toBe(true);
    expect(createsMistake(0.5)).toBe(false);
  });
});

describe('fix validation (TRU-02.9)', () => {
  it('accepts editable fields and validates question payloads', () => {
    expect(fixPatch(ITEM_SPECS.card, [{ name: 'back', value: 'nova' }])).toEqual({ back: 'nova' });
    expect(fixPatch(ITEM_SPECS.card, [{ name: 'version', value: '9' }])).toBeNull();
    expect(fixPatch(ITEM_SPECS.question, [{ name: 'payload', value: '{"nope":1}' }], 'mcq_single')).toBeNull();
    expect(fixPatch(ITEM_SPECS.feed_item, [{ name: 'content', value: 'not json' }])).toBeNull();
  });

  it('maps reporter reasons to the PT-BR labels of the triage prompt', () => {
    expect(reasonLabel('wrong_answer')).toBe('Gabarito errado');
    expect(reasonLabel('Confuso')).toBe('Confuso');
    expect(reasonLabel('???')).toBe('Outro');
  });
});

describe('social scoring (SOC-03, SOC-04)', () => {
  it('battle.tick steps only from the status the battle is in', () => {
    expect(battleStep({ status: 'question_open', current_index: 1 }, 1, 3)).toEqual({ kind: 'close' });
    expect(battleStep({ status: 'question_reveal', current_index: 1 }, 1, 3)).toEqual({ kind: 'advance', nextIndex: 2 });
    expect(battleStep({ status: 'question_reveal', current_index: 2 }, 2, 3)).toEqual({ kind: 'podium' });
    expect(battleStep({ status: 'question_open', current_index: 2 }, 1, 3)).toEqual({ kind: 'noop' });
  });

  it('streak adds up for consecutive correct answers and resets on a miss or a late answer', () => {
    const opens = Date.parse('2026-10-27T15:00:00Z');
    const closes = opens + 20_000;
    const fast = scoreBattleAnswer({ correct: true, receivedAtMs: opens + 3000 }, 0, opens, closes, 20);
    expect(fast).toMatchObject({ nextStreak: 1, timedOut: false });
    const second = scoreBattleAnswer({ correct: true, receivedAtMs: opens + 3000 }, fast.nextStreak, opens, closes, 20);
    expect(second.points - fast.points).toBe(50);
    expect(scoreBattleAnswer({ correct: false, receivedAtMs: opens + 3000 }, 4, opens, closes, 20)).toEqual({ points: 0, nextStreak: 0, timedOut: false });
    expect(scoreBattleAnswer({ correct: true, receivedAtMs: closes + 2000 }, 4, opens, closes, 20)).toEqual({ points: 0, nextStreak: 0, timedOut: true });
  });

  it('insights drop opted-out members and anything below k = 5 answerers', () => {
    const rows = [1, 2, 3, 4, 5].map((i) => ({
      user_id: `u${i}`,
      question_id: 'q1',
      correct: i > 2,
      response: { choice: i <= 2 ? 'B' : 'A' },
      answered_at: `2026-10-27T10:0${i}:00Z`,
    }));
    expect(aggregateInsights(rows.slice(0, 4), new Set(), 5)).toEqual([]);
    const agg = aggregateInsights(rows, new Set(['u5']), 5);
    expect(agg).toEqual([]);
    const full = aggregateInsights(rows, new Set(), 5);
    expect(full).toEqual([expect.objectContaining({ questionId: 'q1', answerers: 5, wrong: 2, topWrongOptionCount: 2 })]);
  });
});

describe('review logs for the optimizer (MEM-02.14)', () => {
  it('drops undone pairs and early reviews within 10 minutes of the card’s previous review', () => {
    const rows = [
      { id: 'l1', card_id: 'c', rating: 3, reviewed_at: '2026-10-01T10:00:00Z', reason: 'due', undoes_log_id: null },
      { id: 'l2', card_id: 'c', rating: 2, reviewed_at: '2026-10-01T10:05:00Z', reason: 'early', undoes_log_id: null },
      { id: 'l3', card_id: 'c', rating: 4, reviewed_at: '2026-10-02T10:00:00Z', reason: 'due', undoes_log_id: null },
      { id: 'l4', card_id: 'd', rating: 1, reviewed_at: '2026-10-02T10:00:00Z', reason: 'due', undoes_log_id: null },
      { id: 'l5', card_id: 'd', rating: 1, reviewed_at: '2026-10-02T10:01:00Z', reason: 'due', undoes_log_id: 'l4' },
    ];
    expect(validReviewLogs(rows).map((r) => r.id)).toEqual(['l1', 'l3']);
  });
});

describe('plan data mapping (GOL-04, data-model §5.5)', () => {
  it('maps planner triggers to stored ones and back for the ones with a stored value', () => {
    expect(storedTriggerOf('material_ready')).toBe('material_added');
    expect(plannerTriggerOf('material_added')).toBe('material_ready');
    expect(plannerTriggerOf('desperate_on')).toBe('exam_changed');
    expect(storedTriggerOf('mastery_shift')).toBe('user_rebalance');
  });

  it('carries done items that the new run dropped into the new run, unchanged', () => {
    const done: PlanItemRow = {
      id: 'row-1', user_id: 'u', goal_id: null, plan_run_id: 'old', local_date: '2026-10-26', subject_id: null, exam_id: null,
      node_ids: [], unit_type: 'learn', minutes: 20, deadline: null, priority: 1, order_in_day: 0, demanding: false, pinned: false,
      status: 'done', reason_key: null, reason_params: { blockId: 'b1' },
    };
    const run = { items: [], inputHash: 'h' } as unknown as Parameters<typeof carryOverDone>[1];
    const carried = carryOverDone([done], run, 'new');
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ plan_run_id: 'new', status: 'done', minutes: 20 });
    expect((carried[0] as Record<string, unknown>).id).toBeUndefined();
  });
});

describe('streak helpers (MOT-01)', () => {
  it('uses Monday = 0 and rolls a counted day into the length', () => {
    expect(weekdayMon0('2026-10-27')).toBe(1);
    expect(daysInRange('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    const days = dailyActivityFor(['2026-10-27'], {
      facts: new Map([['2026-10-27', { activeMinutes: 12, reviews: 0, questions: 0, sessions: 0, xp: 0 }]]),
      examDays: new Set(),
      goals: [],
      restWeekday: null,
    });
    const next = rollStreak(initialStreakState(), days);
    expect(next.length).toBe(1);
    expect(next.lastEvaluated).toBe('2026-10-27');
  });
});
