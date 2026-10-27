// GOL-12 Modo Desespero — eligibility, diagnostic composition, plano de ataque and coverage
// (spec 07 §8.10, learning-engine §11.13). The planner applies the resulting groups.
import type { AttackGroup } from './types.ts';
import { dayDiff } from './util.ts';

// ---------------------------------------------------------------- eligibility (GOL-12.1, §8.10.1)

export interface DesperateEligibilityInput {
  examLocalDate: string;
  today: string;
  scheduled: boolean;
  /** Scope coverage: studied in-scope topics ÷ in-scope topics (0–1). */
  coverage: number;
  /** Readiness now (0–1, §13.1). */
  readiness: number;
  /** Study sessions that touched this test's scope. */
  sessions: number;
}

export interface DesperateEligibility {
  eligible: boolean;
  daysLeft: number;
  /** Why the offer appears: any of 'low_coverage' | 'low_readiness' | 'no_sessions'. */
  reasons: Array<'low_coverage' | 'low_readiness' | 'no_sessions'>;
}

/** Offer only when the test is ≤ 6 days away (today included) and preparation is low. Never forces the mode. */
export function desperateEligibility(input: DesperateEligibilityInput): DesperateEligibility {
  const daysLeft = dayDiff(input.today, input.examLocalDate);
  const reasons: DesperateEligibility['reasons'] = [];
  if (input.coverage < 0.5) reasons.push('low_coverage');
  if (input.readiness < 0.4) reasons.push('low_readiness');
  if (input.sessions === 0) reasons.push('no_sessions');
  const inWindow = input.scheduled && daysLeft >= 0 && daysLeft <= 6;
  return { eligible: inWindow && reasons.length > 0, daysLeft, reasons };
}

// ---------------------------------------------------------------- diagnostic composition (GOL-12.3)

/**
 * Topics for the 5-minute check, highest `W'·ω` first (ties: knowledge-map order), at most 12
 * (6 when the test is today or tomorrow). The caller maps each topic to one objective question.
 * Pass only in-scope, non-placeholder topics; `weight` is the aggregated `W'_e · ω_{e,n}` across covered tests.
 */
export function diagnosticTopics(
  scope: Array<{ topicId: string; order: number; weight: number }>,
  daysUntilTest: number,
): string[] {
  const max = daysUntilTest <= 1 ? 6 : 12;
  return scope
    .slice()
    .sort((a, b) => b.weight - a.weight || a.order - b.order || (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0))
    .slice(0, max)
    .map((s) => s.topicId);
}

// ---------------------------------------------------------------- plano de ataque (GOL-12.5, §8.10.2)

export interface AttackTopic {
  id: string;
  /** Knowledge-map order, used for ties. */
  order: number;
  /** Full learn minutes (est_learn_minutes × κ). learn_light is half of this. */
  learnMin: number;
  /** Share of the points still missing: Σ_e W'_e · ω_{e,n} · (1 − m_n). */
  gain: number;
}

export interface AttackPlan {
  groups: Record<string, AttackGroup>;
  /** Minutes committed to Foco total (light + 10 per topic). */
  focusMin: number;
  /** Minutes committed to Só o básico (light only). */
  basicMin: number;
}

/**
 * Greedy triage of §8.10.2. `yield = gain / (light + 10)`. Foco total takes topics in yield order
 * while the budget 0.7 × capacity holds (stops at the first topic that does not fit); Só o básico
 * then takes the next topics while their light minutes fit in the remaining capacity; the rest is
 * "Fica de fora". Topics in `userMoves` keep their group and consume budget first.
 */
export function planAttack(
  topics: AttackTopic[],
  capacityMin: number,
  userMoves: Record<string, AttackGroup> = {},
): AttackPlan {
  const light = (t: AttackTopic): number => 0.5 * t.learnMin;
  const yieldOf = (t: AttackTopic): number => t.gain / (light(t) + 10);
  const ordered = topics
    .slice()
    .sort(
      (a, b) =>
        yieldOf(b) - yieldOf(a) || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const groups: Record<string, AttackGroup> = {};
  for (const t of ordered) {
    const fixed = userMoves[t.id];
    if (fixed !== undefined) groups[t.id] = fixed;
  }

  let focusMin = 0;
  for (const t of ordered) if (groups[t.id] === 'focus') focusMin += light(t) + 10;
  const focusBudget = 0.7 * capacityMin;
  let stopped = false;
  for (const t of ordered) {
    if (groups[t.id] !== undefined) continue;
    const cost = light(t) + 10;
    if (!stopped && focusMin + cost <= focusBudget + 1e-9) {
      groups[t.id] = 'focus';
      focusMin += cost;
    } else {
      stopped = true;
    }
  }

  let basicMin = 0;
  for (const t of ordered) if (groups[t.id] === 'basic') basicMin += light(t);
  const remaining = capacityMin - focusMin;
  stopped = false;
  for (const t of ordered) {
    if (groups[t.id] !== undefined) continue;
    if (!stopped && basicMin + light(t) <= remaining + 1e-9) {
      groups[t.id] = 'basic';
      basicMin += light(t);
    } else {
      stopped = true;
    }
  }
  for (const t of ordered) if (groups[t.id] === undefined) groups[t.id] = 'out';
  return { groups, focusMin, basicMin };
}

/**
 * coverage_pct(e) = 100 · (Σ_Foco ω + 0.5 · Σ_Básico ω), rounded to 5% (spec 07 §8.10.2).
 * `omegaByExam[examId][topicId]` is the topic's share inside that test (Σ = 1 per test).
 */
export function attackCoverage(
  groups: Record<string, AttackGroup>,
  omegaByExam: Record<string, Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const examId of Object.keys(omegaByExam).sort()) {
    const omega = omegaByExam[examId] ?? {};
    let sum = 0;
    for (const topicId of Object.keys(omega).sort()) {
      const g = groups[topicId];
      const w = omega[topicId] ?? 0;
      if (g === 'focus') sum += w;
      else if (g === 'basic') sum += 0.5 * w;
    }
    out[examId] = Math.round((100 * sum) / 5) * 5;
  }
  return out;
}
