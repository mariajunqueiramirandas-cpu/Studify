// GOL-07 Modo Véspera — the evening-before session (spec 07 §7.2 and GOL-07.1–07.7). Selection only;
// the cheat sheet text comes from the AI task `vespera.cheatsheet` and is not computed here.
import { addDays, EPS, hhmmToMin, largestRemainder, minToHHMM } from './util.ts';
import { vesperaMinutesForTests } from './planner.ts';

export interface VesperaExam {
  id: string;
  title: string;
  localDate: string;
  /** Local start time 'HH:mm', null = horário a definir (treated as 07:30 for sleep, GOL-07.6). */
  startTime: string | null;
  /** W_e. */
  weight: number;
  /** readiness_e in [0, 1]. */
  readiness: number;
}

export interface VesperaScopeTopic {
  topicId: string;
  examId: string;
  title: string;
  /** ω_{e,n} within the test. */
  weight: number;
  studied: boolean;
  mastery: number | null;
}

export interface VesperaInput {
  today: string;
  exams: VesperaExam[];
  scope: VesperaScopeTopic[];
  /** Cards rated "Errei" in the last 7 days, per test (GOL-07.2 item 3). */
  errorCardIds: Record<string, string[]>;
  /** Unresolved Caderno de Erros entries, per test (GOL-07.2 item 4). */
  unresolvedMistakeIds: Record<string, string[]>;
  checklist?: string[];
  /** Default 19:00 (GOL-07.1). */
  vesperaTime?: string;
  /** Quiet hours (default 22:00–07:00). */
  quietStart?: string;
  quietEnd?: string;
}

export type VesperaPart =
  | {
      kind: 'cheatsheet';
      topics: Array<{ topicId: string; title: string; examId: string; notStudied: boolean }>;
    }
  | { kind: 'revisao_relampago'; topicIds: string[]; questionCount: number }
  | { kind: 'error_cards'; cardIds: string[] }
  | { kind: 'mistakes'; mistakeIds: string[] }
  | { kind: 'checklist'; items: string[] }
  | { kind: 'sleep'; stopAt: string };

export interface VesperaSession {
  /** The test date this véspera prepares for (one session per date, GOL-07.4). */
  testDate: string;
  examIds: string[];
  totalMinutes: number;
  minutesByExam: Record<string, number>;
  notifyAt: string;
  sleepStopAt: string;
  /** The six parts of GOL-07.2, in order. */
  parts: VesperaPart[];
}

const DEFAULT_CHECKLIST = ['Calculadora', 'Lápis e borracha'];

/**
 * Sleep stop time: 8.5 h before the test start, snapped down to 15 min (GOL-07.6 says 8–9 h).
 * Unknown time → treated as 07:30 (learning-engine edge case); no time at all → 22:00.
 */
export function sleepStopTime(startTime: string | null): string {
  if (startTime === null) return '22:00';
  const start = hhmmToMin(startTime);
  const raw = start - 510;
  const wrapped = ((raw % 1440) + 1440) % 1440;
  return minToHHMM(Math.floor(wrapped / 15) * 15);
}

/** Notification time, moved to 21:00 when it falls inside quiet hours (GOL-07.1). */
export function notifyTime(time: string, quietStart = '22:00', quietEnd = '07:00'): string {
  const t = hhmmToMin(time);
  const qs = hhmmToMin(quietStart);
  const qe = hhmmToMin(quietEnd);
  const inQuiet = qs > qe ? t >= qs || t < qe : t >= qs && t < qe;
  return inQuiet ? minToHHMM(qs - 60) : time;
}

/**
 * Builds the véspera for the tests whose D − 1 is `today`. Returns null when none. Parts follow
 * GOL-07.2: cheat sheet → revisão relâmpago → "Errei" cards → Caderno entries → checklist → sleep.
 * No new material is introduced (GOL-07.3): only studied topics are listed as reviewable, and
 * unstudied ones are flagged "não deu tempo de estudar — foca no básico".
 */
export function buildVespera(input: VesperaInput): VesperaSession | null {
  const testDate = addDays(input.today, 1);
  const exams = input.exams
    .filter((e) => e.localDate === testDate)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (exams.length === 0) return null;
  const examIds = exams.map((e) => e.id);

  // GOL-07.4: time split by weight × (1 − readiness); the total grows with the number of tests.
  const total = vesperaMinutesForTests(exams.length);
  const shares = exams.map((e) => Math.max(0, e.weight) * Math.max(0, 1 - e.readiness));
  const alloc = largestRemainder(
    total,
    shares.some((s) => s > EPS) ? shares : exams.map(() => 1),
  );
  const minutesByExam: Record<string, number> = {};
  exams.forEach((e, i) => {
    minutesByExam[e.id] = alloc[i] ?? 0;
  });

  const scope = input.scope.filter((t) => examIds.includes(t.examId));
  // Priority: weight × (1 − mastery) (GOL-07.2 item 1, spec 07 §7.2 "ordered by weight × (1 − mastery)").
  const priority = (t: VesperaScopeTopic) => t.weight * (1 - (t.mastery ?? 0));
  const cheatTopics = scope
    .slice()
    .sort((a, b) => priority(b) - priority(a) || (a.topicId < b.topicId ? -1 : 1))
    .slice(0, 10)
    .map((t) => ({ topicId: t.topicId, title: t.title, examId: t.examId, notStudied: !t.studied }));

  // Revisão relâmpago: 10–20 quick items on the weakest studied high-weight concepts (GOL-07.2 item 2).
  const weak = scope
    .filter((t) => t.studied && (t.mastery ?? 0) < 0.8)
    .sort((a, b) => priority(b) - priority(a) || (a.topicId < b.topicId ? -1 : 1));
  const questionCount = weak.length === 0 ? 0 : Math.min(20, Math.max(10, 2 * weak.length));

  const errorCardIds = examIds.flatMap((id) => input.errorCardIds[id] ?? []).sort();
  const mistakeIds = examIds.flatMap((id) => input.unresolvedMistakeIds[id] ?? []).sort();

  // The earliest known start drives the sleep suggestion (GOL-07.6).
  const starts = exams.map((e) => e.startTime).filter((t): t is string => t !== null).sort();
  const sleepStopAt = sleepStopTime(starts[0] ?? null);
  const parts: VesperaPart[] = [
    { kind: 'cheatsheet', topics: cheatTopics },
    { kind: 'revisao_relampago', topicIds: weak.slice(0, questionCount).map((t) => t.topicId), questionCount },
    { kind: 'error_cards', cardIds: errorCardIds },
    { kind: 'mistakes', mistakeIds },
    { kind: 'checklist', items: input.checklist ?? DEFAULT_CHECKLIST },
    { kind: 'sleep', stopAt: sleepStopAt },
  ];

  return {
    testDate,
    examIds,
    totalMinutes: total,
    minutesByExam,
    notifyAt: notifyTime(input.vesperaTime ?? '19:00', input.quietStart, input.quietEnd),
    sleepStopAt,
    parts,
  };
}
