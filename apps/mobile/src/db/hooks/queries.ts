// Domain read hooks over the local database. Screens that work offline read only from here.
import { and, asc, desc, eq, isNull, lte } from 'drizzle-orm';
import type { AppDb } from '../client';
import { cards, cardStates, goals, exams, knowledgeNodes, notes, planItems, queueCache, subjects, subjectUserSettings, mistakes } from '../schema';
import { currentUserId } from './review';
import { useLive } from './use-live';

/** Non-archived, non-deleted subjects, ordered by name. */
export function readSubjects(db: AppDb) {
  return db
    .select({ id: subjects.id, name: subjects.name, color: subjects.color, icon: subjects.icon, enemArea: subjects.enemArea })
    .from(subjects)
    .leftJoin(subjectUserSettings, eq(subjectUserSettings.subjectId, subjects.id))
    .where(and(isNull(subjects.deletedAt), isNull(subjectUserSettings.archivedAt)))
    .orderBy(asc(subjects.name))
    .all();
}

export function useSubjects() {
  return useLive((db) => readSubjects(db), { tables: ['subjects', 'subject_user_settings'] });
}

/** Knowledge tree of one subject (units, topics, concepts), ordered for display. */
export function useKnowledgeNodes(subjectId: string) {
  return useLive(
    (db) =>
      db
        .select()
        .from(knowledgeNodes)
        .where(and(eq(knowledgeNodes.subjectId, subjectId), isNull(knowledgeNodes.deletedAt)))
        .orderBy(asc(knowledgeNodes.position), asc(knowledgeNodes.title))
        .all(),
    { tables: ['knowledge_nodes'], deps: [subjectId] },
  );
}

export function useCard(cardId: string) {
  return useLive(
    (db) => db.select().from(cards).where(eq(cards.id, cardId)).get() ?? null,
    { tables: ['cards'], deps: [cardId] },
  );
}

/** Cards of a topic, with the user's scheduling state (null = never reviewed). */
export function useCardsForNode(nodeId: string) {
  return useLive(
    (db) => {
      const userId = currentUserId(db);
      return db
        .select({ card: cards, state: cardStates })
        .from(cards)
        .leftJoin(cardStates, and(eq(cardStates.cardId, cards.id), eq(cardStates.userId, userId)))
        .where(and(eq(cards.nodeId, nodeId), isNull(cards.deletedAt)))
        .all();
    },
    { tables: ['cards', 'card_states'], deps: [nodeId] },
  );
}

/** Number of cards due now (the "12 cartões para revisar" count). */
export function useDueCount() {
  return useLive(
    (db) => {
      const userId = currentUserId(db);
      return db
        .select({ cardId: cardStates.cardId })
        .from(cardStates)
        .where(
          and(
            eq(cardStates.userId, userId),
            lte(cardStates.due, new Date()),
            eq(cardStates.suspended, false),
            eq(cardStates.hidden, false),
          ),
        )
        .all().length;
    },
    { tables: ['card_states'] },
  );
}

/** The widget/review queue (queue_cache joined with the card text), earliest due first. */
export function useReviewQueue(limit = 50) {
  return useLive(
    (db) =>
      db
        .select({ cardId: queueCache.cardId, effectiveDue: queueCache.effectiveDue, front: cards.front, back: cards.back, type: cards.type, nodeId: cards.nodeId })
        .from(queueCache)
        .innerJoin(cards, eq(cards.id, queueCache.cardId))
        .orderBy(asc(queueCache.effectiveDue))
        .limit(limit)
        .all(),
    { tables: ['queue_cache', 'cards'], deps: [limit] },
  );
}

export function useGoals() {
  return useLive(
    (db) =>
      db
        .select()
        .from(goals)
        .where(and(eq(goals.status, 'active'), isNull(goals.deletedAt)))
        .orderBy(asc(goals.endDate))
        .all(),
    { tables: ['goals'] },
  );
}

export function useExams(goalId: string) {
  return useLive(
    (db) =>
      db
        .select()
        .from(exams)
        .where(and(eq(exams.goalId, goalId), isNull(exams.deletedAt)))
        .orderBy(asc(exams.localDate))
        .all(),
    { tables: ['exams'], deps: [goalId] },
  );
}

/** Plan items of one local day (Hoje). */
export function usePlanItemsForDay(localDate: string) {
  return useLive(
    (db) =>
      db
        .select()
        .from(planItems)
        .where(and(eq(planItems.localDate, localDate), isNull(planItems.deletedAt)))
        .orderBy(asc(planItems.orderInDay))
        .all(),
    { tables: ['plan_items'], deps: [localDate] },
  );
}

/** Latest ready note of a topic at a depth (LRN-01). */
export function useNote(nodeId: string, depth: 'tldr' | 'study' | 'deep' | 'class_summary') {
  return useLive(
    (db) =>
      db
        .select()
        .from(notes)
        .where(and(eq(notes.nodeId, nodeId), eq(notes.depth, depth), eq(notes.status, 'ready'), isNull(notes.deletedAt)))
        .orderBy(desc(notes.updatedAt))
        .limit(1)
        .get() ?? null,
    { tables: ['notes'], deps: [nodeId, depth] },
  );
}

/** Open Caderno de Erros entries. */
export function useOpenMistakes() {
  return useLive(
    (db) =>
      db
        .select()
        .from(mistakes)
        .where(and(isNull(mistakes.resolvedAt), isNull(mistakes.deletedAt)))
        .orderBy(asc(mistakes.nextRetryAt))
        .all(),
    { tables: ['mistakes'] },
  );
}
