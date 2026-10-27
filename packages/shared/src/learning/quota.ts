// New-card quota (learning-engine §4; spec 04 §8.4 merged with spec 07 §8.3, reconciliation L1).
import { QUOTA } from './params.ts';
import { daysBetween } from './time.ts';
import type { LocalDate } from './types.ts';
import { compareStrings, largestRemainder } from './util.ts';

export interface QuotaExam {
  examId: string;
  localDate: LocalDate;
  /** N_E: never-introduced, non-excluded, non-suspended cards in the scope. The caller counts a card for its earliest exam only. */
  newCardsInScope: number;
}

export interface NewCardQuotaInput {
  /** Study day being planned. */
  date: LocalDate;
  hasActivePlan: boolean;
  /** settings.new_per_day, used without an active plan. Defaults to 20 (MEM-02.3). */
  settingsNewPerDay?: number;
  exams: readonly QuotaExam[];
  /** Planned learn minutes for `date` (from the planner, §11). */
  learnMinutes: number;
  /** Learn minutes per subject, for `bySubject` pro-rating. */
  subjectLearnMinutes?: Readonly<Record<string, number>>;
  /** True while the user is in Modo recuperação (§2.4): forces total = 0. */
  recoveryMode?: boolean;
  /**
   * Future-load protection (§4, §11.6): minutes already forecast for the next 7 days (index 0 =
   * tomorrow) and the available minutes A(d) for the same days.
   */
  futureLoad?: { forecastMinutes: readonly number[]; availableMinutes: readonly number[] };
  /** Seconds per review, to convert a new card's expected reviews into minutes. */
  reviewSeconds?: number;
  /** Override of the global cap (default 50). */
  cap?: number;
}

export type QuotaBlock = 'none' | 'recovery' | 'eve' | 'future_load';

export interface NewCardQuota {
  total: number;
  /** Sum over exams of ceil(N_E / days_E). */
  required: number;
  /** Time-driven amount from planned learn minutes. */
  planned: number;
  capped: boolean;
  bySubject: Record<string, number>;
  blockedBy: QuotaBlock;
}

/**
 * Canonical per-day new-card quota (§4):
 *   required = Σ_E ceil(N_E / max(1, days_until(E) − 1))            for exams within 30 days
 *   planned  = floor(0.25 × learnMinutes × 60 / 20)
 *   total    = min(50, max(planned, required)), then future-load protection,
 *              then 0 on the eve (D_e − 1) and the exam day (D_e), and 0 in recovery mode.
 */
export function newCardQuota(input: NewCardQuotaInput): NewCardQuota {
  const cap = input.cap ?? QUOTA.cap;
  const date = input.date;

  if (!input.hasActivePlan) {
    const total = input.recoveryMode ? 0 : (input.settingsNewPerDay ?? 20);
    return {
      total,
      required: 0,
      planned: total,
      capped: false,
      bySubject: {},
      blockedBy: input.recoveryMode ? 'recovery' : 'none',
    };
  }

  if (input.recoveryMode) {
    return { total: 0, required: 0, planned: 0, capped: false, bySubject: {}, blockedBy: 'recovery' };
  }

  let required = 0;
  let eve = false;
  for (const exam of input.exams) {
    const daysUntilExam = daysBetween(date, exam.localDate);
    if (daysUntilExam === 0 || daysUntilExam === 1) eve = true;
    if (daysUntilExam < 0 || daysUntilExam > QUOTA.requiredHorizonDays) continue;
    const daysAllowed = Math.max(1, daysUntilExam - 1);
    required += Math.ceil(exam.newCardsInScope / daysAllowed);
  }

  const planned = Math.floor((QUOTA.learnShare * input.learnMinutes * 60) / QUOTA.secondsPerNewCard);
  let total = Math.min(cap, Math.max(planned, required));
  let blockedBy: QuotaBlock = 'none';

  const reviewMinutes = (input.reviewSeconds ?? 10) / 60;
  if (input.futureLoad) {
    const { forecastMinutes, availableMinutes } = input.futureLoad;
    // A new card adds one expected review on each of days +1, +3, +7 (spec 07 §8.3.3).
    const offsets = [0, 2, 6];
    const violates = (n: number): boolean => {
      for (let i = 0; i < QUOTA.futureLoadDays; i++) {
        const added = offsets.includes(i) ? n * reviewMinutes : 0;
        const load = (forecastMinutes[i] ?? 0) + added;
        const available = availableMinutes[i] ?? 0;
        if (load > QUOTA.futureLoadShare * available) return true;
      }
      return false;
    };
    const before = total;
    while (total > 0 && violates(total)) total -= 1;
    if (total < before) blockedBy = 'future_load';
  }

  if (eve) {
    total = 0;
    blockedBy = 'eve';
  }

  return {
    total,
    required,
    planned,
    capped: required > total,
    bySubject: proRataBySubject(total, input.subjectLearnMinutes ?? {}),
    blockedBy,
  };
}

/** Splits `total` across subjects by learn minutes (largest remainder). */
function proRataBySubject(total: number, minutes: Readonly<Record<string, number>>): Record<string, number> {
  const subjects = Object.keys(minutes).sort(compareStrings);
  if (subjects.length === 0) return {};
  const shares = largestRemainder(
    subjects.map((s) => minutes[s] ?? 0),
    total,
  );
  const out: Record<string, number> = {};
  subjects.forEach((s, i) => {
    out[s] = shares[i] ?? 0;
  });
  return out;
}
