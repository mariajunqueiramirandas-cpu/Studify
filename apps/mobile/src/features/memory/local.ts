import { and, asc, eq, inArray, isNull, lte, notInArray } from 'drizzle-orm';
import { createEmptyCard, Rating, State, type Card } from 'ts-fsrs';
import type { OcclusionCardMedia } from '@studify/shared';
import type { AppDb } from '../../db/client';
import { currentUserId, schedulerFor } from '../../db/hooks/review';
import { cardOverrides, cards, cardStates, exams, examScopeNodes, profiles, subjects, subjectUserSettings } from '../../db/schema';

export interface ReviewCard {
  id: string;
  subjectId: string;
  nodeId: string;
  type: string;
  front: string;
  back: string;
  clozeIndex: number | null;
  /** Image-occlusion cards (MEM-03): image path, size, masks and the asked mask. */
  media: OcclusionCardMedia | null;
  sourcePages: { document_id: string; page_start: number; page_end: number }[];
  isNew: boolean;
  isLeech: boolean;
  /** "Reforço pra prova · Biologia em 3 dias" (MEM-02.5 exam overlay). */
  examTag: { subjectName: string; days: number } | null;
}

const DAY = 86_400_000;

/**
 * Builds the review queue from SQLite only (MEM-02, offline): due cards first (earliest due),
 * then new cards up to the user's new-per-day setting. Cards in scope of a test in the next
 * 7 days carry the exam tag and are pulled forward.
 */
export function buildLocalQueue(db: AppDb, opts: { subjectId?: string; limit?: number; now?: Date } = {}): ReviewCard[] {
  const now = opts.now ?? new Date();
  const userId = currentUserId(db);
  const settings = (db.select({ s: profiles.settings }).from(profiles).where(eq(profiles.id, userId)).get()?.s ?? {}) as { memory?: { new_per_day?: number; max_reviews_per_day?: number } };
  const limit = opts.limit ?? settings.memory?.max_reviews_per_day ?? 200;
  const newPerDay = settings.memory?.new_per_day ?? 20;

  const archivedIds = new Set(
    db
      .select({ id: subjectUserSettings.subjectId, archivedAt: subjectUserSettings.archivedAt })
      .from(subjectUserSettings)
      .where(eq(subjectUserSettings.userId, userId))
      .all()
      .filter((r) => r.archivedAt)
      .map((r) => r.id),
  );

  // Upcoming tests (≤ 7 days) and their scope nodes → exam overlay.
  const soon = new Date(now.getTime() + 7 * DAY);
  const examRows = db.select({ id: exams.id, subjectId: exams.subjectId, startsAt: exams.startsAt, status: exams.status }).from(exams).where(and(isNull(exams.deletedAt))).all();
  const upcoming = examRows.filter((e) => e.startsAt && e.startsAt.getTime() >= now.getTime() && e.startsAt.getTime() <= soon.getTime() && e.status !== 'cancelled');
  const scopeRows = upcoming.length ? db.select({ examId: examScopeNodes.examId, nodeId: examScopeNodes.nodeId }).from(examScopeNodes).where(inArray(examScopeNodes.examId, upcoming.map((e) => e.id))).all() : [];
  const nodeExam = new Map<string, (typeof upcoming)[number]>();
  for (const s of scopeRows) {
    const e = upcoming.find((x) => x.id === s.examId);
    if (e && (!nodeExam.has(s.nodeId) || e.startsAt!.getTime() < nodeExam.get(s.nodeId)!.startsAt!.getTime())) nodeExam.set(s.nodeId, e);
  }
  const subjectNames = new Map(db.select({ id: subjects.id, name: subjects.name }).from(subjects).all().map((s) => [s.id, s.name]));
  const examTagFor = (nodeId: string, subjectId: string) => {
    const e = nodeExam.get(nodeId) ?? upcoming.find((x) => x.subjectId === subjectId && !scopeRows.some((s) => s.examId === x.id));
    if (!e?.startsAt) return null;
    return { subjectName: subjectNames.get(e.subjectId ?? '') ?? '', days: Math.max(0, Math.ceil((e.startsAt.getTime() - now.getTime()) / DAY)) };
  };

  const subjectFilter = opts.subjectId ? [eq(cards.subjectId, opts.subjectId)] : [];
  const dueRows = db
    .select({ card: cards, state: cardStates })
    .from(cardStates)
    .innerJoin(cards, eq(cards.id, cardStates.cardId))
    .where(
      and(
        eq(cardStates.userId, userId),
        eq(cardStates.suspended, false),
        eq(cardStates.hidden, false),
        isNull(cards.deletedAt),
        isNull(cards.hiddenReason),
        eq(cards.status, 'active'),
        ...subjectFilter,
      ),
    )
    .orderBy(asc(cardStates.due))
    .all()
    .filter((r) => !archivedIds.has(r.card.subjectId))
    .filter((r) => r.state.state !== State.New && (r.state.due.getTime() <= now.getTime() || (examTagFor(r.card.nodeId, r.card.subjectId) && r.state.due.getTime() <= soon.getTime() && r.state.due.getTime() - now.getTime() < 2 * DAY)));

  const knownIds = db.select({ id: cardStates.cardId }).from(cardStates).where(eq(cardStates.userId, userId)).all().map((r) => r.id);
  const newStateIds = db
    .select({ id: cardStates.cardId })
    .from(cardStates)
    .where(and(eq(cardStates.userId, userId), eq(cardStates.state, State.New), eq(cardStates.suspended, false), eq(cardStates.hidden, false)))
    .all()
    .map((r) => r.id);
  const newCandidates = db
    .select()
    .from(cards)
    .where(and(isNull(cards.deletedAt), isNull(cards.hiddenReason), eq(cards.status, 'active'), ...subjectFilter, knownIds.length ? notInArray(cards.id, knownIds) : undefined))
    .orderBy(asc(cards.createdAt))
    .limit(newPerDay * 3)
    .all();
  const newFromStates = newStateIds.length ? db.select().from(cards).where(and(inArray(cards.id, newStateIds), ...subjectFilter)).all() : [];
  const newCards = [...newFromStates, ...newCandidates]
    .filter((c) => !archivedIds.has(c.subjectId) && (!c.personalForUserId || c.personalForUserId === userId))
    // Exam-scoped new cards first (MEM-02.5).
    .sort((a, b) => Number(!!examTagFor(b.nodeId, b.subjectId)) - Number(!!examTagFor(a.nodeId, a.subjectId)))
    .slice(0, newPerDay);

  const overrides = new Map(db.select().from(cardOverrides).where(eq(cardOverrides.userId, userId)).all().map((o) => [o.cardId, o]));
  const toReview = (c: typeof cards.$inferSelect, isNew: boolean, isLeech = false): ReviewCard => {
    const o = overrides.get(c.id);
    return {
      id: c.id,
      subjectId: c.subjectId,
      nodeId: c.nodeId,
      type: c.type,
      front: o?.front ?? c.front,
      back: o?.back ?? c.back,
      clozeIndex: c.clozeIndex,
      media: c.type === 'image_occlusion' ? (((o?.media as unknown) ?? c.media) as OcclusionCardMedia | null) : null,
      sourcePages: c.sourcePages ?? [],
      isNew,
      isLeech,
      examTag: examTagFor(c.nodeId, c.subjectId),
    };
  };
  const seenSiblings = new Set<string>();
  const out: ReviewCard[] = [];
  for (const r of dueRows) {
    // Bury siblings (cloze/reverse) within one session.
    if (r.card.siblingGroupId) {
      if (seenSiblings.has(r.card.siblingGroupId)) continue;
      seenSiblings.add(r.card.siblingGroupId);
    }
    out.push(toReview(r.card, false, r.state.isLeech));
  }
  for (const c of newCards) {
    if (c.siblingGroupId) {
      if (seenSiblings.has(c.siblingGroupId)) continue;
      seenSiblings.add(c.siblingGroupId);
    }
    out.push(toReview(c, true));
  }
  return out.slice(0, limit);
}

/** Next interval (ms) per rating for the rating buttons (ux §5.1). */
export function previewIntervals(db: AppDb, cardId: string, now = new Date()): Record<1 | 2 | 3 | 4, number> {
  const userId = currentUserId(db);
  const settings = db.select({ s: profiles.settings }).from(profiles).where(eq(profiles.id, userId)).get()?.s;
  const scheduler = schedulerFor(settings);
  const row = db.select().from(cardStates).where(and(eq(cardStates.userId, userId), eq(cardStates.cardId, cardId))).get();
  const card: Card = row
    ? {
        due: row.due,
        stability: row.stability,
        difficulty: row.difficulty,
        elapsed_days: row.elapsedDays,
        scheduled_days: row.scheduledDays,
        learning_steps: row.learningSteps,
        reps: row.reps,
        lapses: row.lapses,
        state: row.state as State,
        last_review: row.lastReview ?? undefined,
      }
    : createEmptyCard(now);
  const rec = scheduler.repeat(card, now);
  const ms = (r: Rating) => rec[r as Exclude<Rating, Rating.Manual>].card.due.getTime() - now.getTime();
  return { 1: ms(Rating.Again), 2: ms(Rating.Hard), 3: ms(Rating.Good), 4: ms(Rating.Easy) };
}

export function dueCount(db: AppDb, now = new Date()): number {
  try {
    return buildLocalQueue(db, { now, limit: 1000 }).length;
  } catch {
    return 0;
  }
}
