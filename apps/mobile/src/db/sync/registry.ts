// Pull registry: every mirrored table, in pull order (parents before children), with its primary
// key, its server-side scope, the local rows to remove when it is tombstoned, and which pending
// outbox kinds overlay its rows until they are acknowledged.
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { PLAN_WINDOW_DAYS } from './constants';
import type { PullFilter } from './transport';
import type { OutboxKind } from '../outbox';
import * as s from '../schema';

export interface PullContext {
  /** Non-archived subject ids, read from the local database (call after the subjects table pulled). */
  activeSubjectIds: () => string[];
  /** Local-date window for plan items (YYYY-MM-DD, inclusive). */
  planWindow: { from: string; to: string };
}

export interface PullTableDef {
  /** Server table name. Also the key of `sync_cursors`. */
  name: string;
  table: SQLiteTable;
  /** JS keys of the primary key. The last key is the entity id used by the outbox. */
  pk: string[];
  /** Server-side scope. `null` skips the table for this round (nothing in scope). */
  filters?: (ctx: PullContext) => PullFilter[] | null;
  /** Local rows removed when a row of this table is tombstoned: child table + JS column holding this row's id. */
  cascade?: { child: SQLiteTable; column: string }[];
}

const subjectScope = (ctx: PullContext): PullFilter[] | null => {
  const ids = ctx.activeSubjectIds();
  return ids.length > 0 ? [{ column: 'subject_id', op: 'in', value: ids }] : null;
};

const planScope = (ctx: PullContext): PullFilter[] => [
  { column: 'local_date', op: 'gte', value: ctx.planWindow.from },
  { column: 'local_date', op: 'lte', value: ctx.planWindow.to },
];

export const PULL_TABLES: readonly PullTableDef[] = [
  { name: 'profiles', table: s.profiles, pk: ['id'] },
  { name: 'study_preferences', table: s.studyPreferences, pk: ['userId'] },
  {
    name: 'subjects',
    table: s.subjects,
    pk: ['id'],
    // System subjects (ENEM bank, Atualidades) are read online, never mirrored (thousands of global rows).
    filters: () => [{ column: 'system_kind', op: 'is_null' }],
    cascade: [
      { child: s.knowledgeNodes, column: 'subjectId' },
      { child: s.cards, column: 'subjectId' },
      { child: s.notes, column: 'subjectId' },
      { child: s.glossaryTerms, column: 'subjectId' },
      { child: s.questions, column: 'subjectId' },
      { child: s.feedItems, column: 'subjectId' },
      { child: s.subjectUserSettings, column: 'subjectId' },
      { child: s.cardStates, column: 'subjectId' },
      { child: s.planItems, column: 'subjectId' },
    ],
  },
  { name: 'subject_user_settings', table: s.subjectUserSettings, pk: ['userId', 'subjectId'] },
  {
    name: 'knowledge_nodes',
    table: s.knowledgeNodes,
    pk: ['id'],
    filters: subjectScope,
    cascade: [
      { child: s.cards, column: 'nodeId' },
      { child: s.notes, column: 'nodeId' },
      { child: s.glossaryTerms, column: 'nodeId' },
      { child: s.nodeUserSettings, column: 'nodeId' },
      { child: s.feedItems, column: 'nodeId' },
      { child: s.examScopeNodes, column: 'nodeId' },
    ],
  },
  { name: 'node_sources', table: s.nodeSources, pk: ['id'] },
  { name: 'node_user_settings', table: s.nodeUserSettings, pk: ['userId', 'nodeId'] },
  { name: 'glossary_terms', table: s.glossaryTerms, pk: ['id'], filters: subjectScope },
  {
    name: 'notes',
    table: s.notes,
    pk: ['id'],
    filters: subjectScope,
    cascade: [{ child: s.noteHighlights, column: 'noteId' }],
  },
  { name: 'note_highlights', table: s.noteHighlights, pk: ['id'] },
  {
    name: 'cards',
    table: s.cards,
    pk: ['id'],
    filters: subjectScope,
    cascade: [
      { child: s.cardStates, column: 'cardId' },
      { child: s.cardOverrides, column: 'cardId' },
      { child: s.queueCache, column: 'cardId' },
    ],
  },
  { name: 'card_overrides', table: s.cardOverrides, pk: ['userId', 'cardId'] },
  { name: 'card_states', table: s.cardStates, pk: ['userId', 'cardId'], filters: subjectScope },
  {
    name: 'goals',
    table: s.goals,
    pk: ['id'],
    cascade: [
      { child: s.exams, column: 'goalId' },
      { child: s.planItems, column: 'goalId' },
    ],
  },
  {
    name: 'exams',
    table: s.exams,
    pk: ['id'],
    cascade: [{ child: s.examScopeNodes, column: 'examId' }],
  },
  { name: 'exam_scope_nodes', table: s.examScopeNodes, pk: ['examId', 'nodeId'] },
  { name: 'plan_items', table: s.planItems, pk: ['id'], filters: planScope },
  { name: 'mistakes', table: s.mistakes, pk: ['id'] },
  { name: 'questions', table: s.questions, pk: ['id'], filters: subjectScope },
  {
    name: 'quizzes',
    table: s.quizzes,
    pk: ['id'],
    cascade: [{ child: s.quizAttempts, column: 'quizId' }],
  },
  {
    name: 'quiz_attempts',
    table: s.quizAttempts,
    pk: ['id'],
    cascade: [{ child: s.attemptAnswers, column: 'attemptId' }],
  },
  { name: 'attempt_answers', table: s.attemptAnswers, pk: ['id'] },
  { name: 'feed_items', table: s.feedItems, pk: ['id'], filters: subjectScope },
  { name: 'mastery', table: s.mastery, pk: ['userId', 'nodeId'] },
  { name: 'daily_activity', table: s.dailyActivity, pk: ['userId', 'localDate'] },
  { name: 'streaks', table: s.streaks, pk: ['userId'] },
  { name: 'achievements', table: s.achievements, pk: ['userId', 'code'] },
];

/**
 * Pending edits of these kinds overlay the pulled row until acknowledged, so a pull that races a
 * local edit does not make the edit flicker back (mobile-app.md §4.3 rule 4).
 */
export const OVERLAY_TABLE_BY_KIND: Partial<Record<OutboxKind, string>> = {
  card_override: 'card_overrides',
  card_state_flag: 'card_states',
  node_user_setting: 'node_user_settings',
  subject_user_setting: 'subject_user_settings',
  mistake_update: 'mistakes',
  plan_item_status: 'plan_items',
  note_highlight: 'note_highlights',
  study_preferences: 'study_preferences',
  quiz_attempt: 'quiz_attempts',
  attempt_answer: 'attempt_answers',
};

export function pullTableByName(name: string): PullTableDef | undefined {
  return PULL_TABLES.find((t) => t.name === name);
}

export function planWindowAround(localDate: string): { from: string; to: string } {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  const day = 24 * 60 * 60 * 1000;
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: fmt(base - PLAN_WINDOW_DAYS * day), to: fmt(base + PLAN_WINDOW_DAYS * day) };
}
