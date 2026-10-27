// Local SQLite mirror of the Supabase schema (docs/engineering/data-model.md §9).
//
// Conventions
// - Table and column names are the server names (snake_case in the DB, camelCase keys in JS).
// - Instants are epoch milliseconds (`mode: 'timestamp_ms'`, JS `Date`). The sync cursor keeps the
//   raw server string in `sync_cursors`, so server-side microsecond precision is never lost.
// - Calendar days (`local_date`, `next_retry_at`, ...) are `YYYY-MM-DD` text.
// - jsonb columns are JSON text (`mode: 'json'`). Their TS shapes live in packages/shared; here they
//   are typed loosely where the shared Zod types are not wired yet.
// - Server-only columns (prompt_version, gen_batch_id, raw_content, AI internals) are not mirrored.
// - `_pulled_at` is local-only bookkeeping on every mirrored table.
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// ---------- column helpers ----------

const instant = (name: string) => integer(name, { mode: 'timestamp_ms' });
const bool = (name: string) => integer(name, { mode: 'boolean' });
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

/** Standard mirrored columns (`updated_at` is the pull cursor, `deleted_at` is the tombstone). */
const syncCols = {
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
  deletedAt: instant('deleted_at'),
  pulledAt: instant('_pulled_at'),
};

/** Mirrored tables without an `id` column (composite keys). */
const syncColsNoId = syncCols;

// ---------- Phase 0–1 mirrored tables ----------

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  displayNameStatus: text('display_name_status'),
  avatarPreset: text('avatar_preset'),
  schoolYear: text('school_year'),
  timezone: text('timezone').notNull().default('America/Sao_Paulo'),
  foreignLanguage: text('foreign_language'),
  appRole: text('app_role'),
  settings: json<Record<string, unknown>>('settings').notNull().default(sql`'{}'`),
  onboardingCompletedAt: instant('onboarding_completed_at'),
  ...syncCols,
});

export const studyPreferences = sqliteTable('study_preferences', {
  userId: text('user_id').primaryKey(),
  minutesByWeekday: json<number[]>('minutes_by_weekday'),
  windowStart: text('window_start'),
  windowEnd: text('window_end'),
  minBlockMin: integer('min_block_min'),
  maxBlockMin: integer('max_block_min'),
  maxSubjectsPerDay: integer('max_subjects_per_day'),
  quietStart: text('quiet_start'),
  quietEnd: text('quiet_end'),
  vesperaTime: text('vespera_time'),
  dayRolloverHour: integer('day_rollover_hour'),
  enemMinShare: real('enem_min_share'),
  reviewSecondsEstimate: real('review_seconds_estimate'),
  ...syncColsNoId,
});

export const subjects = sqliteTable('subjects', {
  id: text('id').primaryKey(),
  ownerProfileId: text('owner_profile_id'),
  ownerClassGroupId: text('owner_class_group_id'),
  createdBy: text('created_by'),
  name: text('name').notNull(),
  color: text('color').notNull(),
  icon: text('icon').notNull(),
  contentLanguage: text('content_language'),
  isLanguageSubject: bool('is_language_subject'),
  enemArea: text('enem_area'),
  ...syncCols,
});

export const subjectUserSettings = sqliteTable(
  'subject_user_settings',
  {
    userId: text('user_id').notNull(),
    subjectId: text('subject_id').notNull(),
    pinned: bool('pinned'),
    sortOrder: integer('sort_order'),
    archivedAt: instant('archived_at'),
    ...syncColsNoId,
  },
  (t) => [primaryKey({ columns: [t.userId, t.subjectId] })],
);

export const knowledgeNodes = sqliteTable(
  'knowledge_nodes',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id').notNull(),
    parentId: text('parent_id'),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    summary: text('summary'),
    position: integer('position').notNull().default(0),
    learningObjectives: json<string[]>('learning_objectives'),
    keyTerms: json<string[]>('key_terms'),
    formulas: json<{ latex: string; description: string }[]>('formulas'),
    enemSkillCodes: json<string[]>('enem_skill_codes'),
    isPlaceholder: bool('is_placeholder'),
    estLearnMinutes: integer('est_learn_minutes'),
    editedByUser: bool('edited_by_user'),
    originDocumentId: text('origin_document_id'),
    contentStatus: text('content_status'),
    version: integer('version'),
    hiddenReason: text('hidden_reason'),
    ...syncCols,
  },
  (t) => [index('knowledge_nodes_tree').on(t.subjectId, t.parentId, t.position)],
);

export const nodeSources = sqliteTable(
  'node_sources',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id').notNull(),
    documentId: text('document_id').notNull(),
    pageStart: integer('page_start').notNull(),
    pageEnd: integer('page_end').notNull(),
    origin: text('origin'),
    ...syncCols,
  },
  (t) => [index('node_sources_node').on(t.nodeId)],
);

export const nodeUserSettings = sqliteTable(
  'node_user_settings',
  {
    userId: text('user_id').notNull(),
    nodeId: text('node_id').notNull(),
    excluded: bool('excluded'),
    ...syncColsNoId,
  },
  (t) => [primaryKey({ columns: [t.userId, t.nodeId] })],
);

export const glossaryTerms = sqliteTable(
  'glossary_terms',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id').notNull(),
    nodeId: text('node_id'),
    term: text('term').notNull(),
    normalizedTerm: text('normalized_term').notNull(),
    aliases: json<string[]>('aliases'),
    definition: text('definition'),
    example: text('example'),
    sourcePages: json<{ document_id: string; page_start: number; page_end: number }[]>('source_pages'),
    version: integer('version'),
    hiddenReason: text('hidden_reason'),
    ...syncCols,
  },
  (t) => [index('glossary_terms_subject').on(t.subjectId)],
);

export const notes = sqliteTable(
  'notes',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id').notNull(),
    nodeId: text('node_id'),
    scopeKind: text('scope_kind').notNull(),
    depth: text('depth').notNull(),
    body: text('body').notNull().default(''),
    citations: json<{ start: number; end: number; document_id: string; page_start: number; page_end: number; cited_text: string }[]>(
      'citations',
    ),
    language: text('language'),
    wordCount: integer('word_count'),
    hasMath: bool('has_math'),
    status: text('status').notNull(),
    supersedesNoteId: text('supersedes_note_id'),
    lowCitationCoverage: bool('low_citation_coverage'),
    contributors: json<string[]>('contributors'),
    createdBy: text('created_by'),
    version: integer('version'),
    ...syncCols,
  },
  (t) => [index('notes_node_depth').on(t.nodeId, t.depth)],
);

export const noteHighlights = sqliteTable(
  'note_highlights',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    noteId: text('note_id').notNull(),
    start: integer('start').notNull(),
    end: integer('end').notNull(),
    quote: text('quote'),
    color: text('color'),
    orphaned: bool('orphaned'),
    ...syncCols,
  },
  (t) => [index('note_highlights_note').on(t.noteId)],
);

export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id').notNull(),
    nodeId: text('node_id').notNull(),
    conceptId: text('concept_id'),
    type: text('type').notNull(),
    front: text('front').notNull(),
    back: text('back').notNull(),
    media: json<{ path: string; width: number; height: number; [k: string]: unknown }>('media'),
    hasMath: bool('has_math'),
    siblingGroupId: text('sibling_group_id'),
    clozeIndex: integer('cloze_index'),
    sourcePages: json<{ document_id: string; page_start: number; page_end: number }[]>('source_pages'),
    origin: text('origin').notNull(),
    createdBy: text('created_by'),
    personalForUserId: text('personal_for_user_id'),
    status: text('status').notNull(),
    hiddenReason: text('hidden_reason'),
    version: integer('version'),
    ...syncCols,
  },
  (t) => [index('cards_node').on(t.nodeId), index('cards_subject').on(t.subjectId)],
);

export const cardOverrides = sqliteTable(
  'card_overrides',
  {
    userId: text('user_id').notNull(),
    cardId: text('card_id').notNull(),
    front: text('front'),
    back: text('back'),
    media: json<Record<string, unknown>>('media'),
    ...syncColsNoId,
  },
  (t) => [primaryKey({ columns: [t.userId, t.cardId] })],
);

export const cardStates = sqliteTable(
  'card_states',
  {
    userId: text('user_id').notNull(),
    cardId: text('card_id').notNull(),
    subjectId: text('subject_id').notNull(),
    due: instant('due').notNull(),
    stability: real('stability').notNull().default(0),
    difficulty: real('difficulty').notNull().default(0),
    elapsedDays: integer('elapsed_days').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    state: integer('state').notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0),
    lastReview: instant('last_review'),
    suspended: bool('suspended').notNull().default(false),
    hidden: bool('hidden').notNull().default(false),
    isLeech: bool('is_leech').notNull().default(false),
    introducedAt: instant('introduced_at'),
    lastLogId: text('last_log_id'),
    updatedAt: instant('updated_at').notNull(),
    pulledAt: instant('_pulled_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.cardId] }),
    index('card_states_due').on(t.due),
    index('card_states_subject').on(t.subjectId),
  ],
);

/** [append] Local copy of the last 30 days plus the outbox source. Never pulled, never updated. */
export const reviewLogs = sqliteTable(
  'review_logs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    cardId: text('card_id').notNull(),
    rating: integer('rating').notNull(),
    reviewedAt: instant('reviewed_at').notNull(),
    clientReviewedAt: instant('client_reviewed_at').notNull(),
    elapsedDays: integer('elapsed_days'),
    scheduledDays: integer('scheduled_days'),
    stateBefore: integer('state_before'),
    durationMs: integer('duration_ms'),
    source: text('source').notNull().default('session'),
    reason: text('reason').notNull().default('scheduled'),
    hintUsed: bool('hint_used').notNull().default(false),
    undoesLogId: text('undoes_log_id'),
    deviceId: text('device_id'),
    clockSkew: bool('clock_skew').notNull().default(false),
    /** LOCAL ONLY: card_states snapshot before this review, used by undo. Not sent to the server. */
    prevCardState: json<Record<string, unknown>>('prev_card_state'),
    createdAt: instant('created_at').notNull(),
  },
  (t) => [index('review_logs_card').on(t.cardId, t.reviewedAt)],
);

export const goals = sqliteTable('goals', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  mode: text('mode').notNull(),
  name: text('name').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  status: text('status').notNull(),
  termIndex: integer('term_index'),
  schoolYear: integer('school_year'),
  settings: json<Record<string, unknown>>('settings'),
  ...syncCols,
});

export const exams = sqliteTable(
  'exams',
  {
    id: text('id').primaryKey(),
    goalId: text('goal_id').notNull(),
    userId: text('user_id').notNull(),
    subjectId: text('subject_id'),
    title: text('title').notNull(),
    localDate: text('local_date').notNull(),
    startsAt: instant('starts_at'),
    durationMin: integer('duration_min'),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    parentExamId: text('parent_exam_id'),
    teacherName: text('teacher_name'),
    weight: real('weight'),
    scopeStatus: text('scope_status').notNull(),
    grade: real('grade'),
    gradeMax: real('grade_max'),
    ...syncCols,
  },
  (t) => [index('exams_goal').on(t.goalId, t.localDate)],
);

export const examScopeNodes = sqliteTable(
  'exam_scope_nodes',
  {
    examId: text('exam_id').notNull(),
    nodeId: text('node_id').notNull(),
    scopeItemId: text('scope_item_id'),
    source: text('source'),
    confidence: real('confidence'),
    confirmed: bool('confirmed'),
    ...syncColsNoId,
  },
  (t) => [primaryKey({ columns: [t.examId, t.nodeId] })],
);

export const planItems = sqliteTable(
  'plan_items',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    goalId: text('goal_id'),
    planRunId: text('plan_run_id').notNull(),
    localDate: text('local_date').notNull(),
    subjectId: text('subject_id'),
    examId: text('exam_id'),
    nodeIds: json<string[]>('node_ids'),
    unitType: text('unit_type').notNull(),
    minutes: integer('minutes').notNull(),
    deadline: text('deadline'),
    priority: real('priority'),
    orderInDay: integer('order_in_day'),
    demanding: bool('demanding'),
    pinned: bool('pinned'),
    status: text('status').notNull(),
    reasonKey: text('reason_key'),
    reasonParams: json<Record<string, unknown>>('reason_params'),
    completedSessionId: text('completed_session_id'),
    ...syncCols,
  },
  (t) => [index('plan_items_day').on(t.localDate)],
);

export const mistakes = sqliteTable(
  'mistakes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    questionId: text('question_id').notNull(),
    attemptAnswerId: text('attempt_answer_id'),
    subjectId: text('subject_id'),
    nodeId: text('node_id'),
    cause: text('cause'),
    suggestedCause: text('suggested_cause'),
    causeSource: text('cause_source'),
    userNote: text('user_note'),
    nextRetryAt: text('next_retry_at'),
    retryStep: integer('retry_step').notNull().default(0),
    successDays: integer('success_days').notNull().default(0),
    remediationCardId: text('remediation_card_id'),
    resolvedAt: instant('resolved_at'),
    ...syncCols,
  },
  (t) => [index('mistakes_open').on(t.userId, t.resolvedAt)],
);

// ---------- Phase 2 mirrored tables ----------

export const questions = sqliteTable(
  'questions',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id').notNull(),
    nodeId: text('node_id').notNull(),
    conceptIds: json<string[]>('concept_ids'),
    type: text('type').notNull(),
    stem: text('stem').notNull(),
    stimulus: json<Record<string, unknown>>('stimulus'),
    textoBase: json<Record<string, unknown>>('texto_base'),
    payload: json<Record<string, unknown>>('payload').notNull(),
    explanation: text('explanation'),
    bloomLevel: text('bloom_level'),
    difficulty: integer('difficulty'),
    hasMath: bool('has_math'),
    sourcePages: json<unknown[]>('source_pages'),
    origin: text('origin').notNull(),
    variantOf: text('variant_of'),
    sourceDocumentId: text('source_document_id'),
    personalForUserId: text('personal_for_user_id'),
    reviewStatus: text('review_status'),
    status: text('status').notNull(),
    hiddenReason: text('hidden_reason'),
    version: integer('version'),
    ...syncCols,
  },
  (t) => [index('questions_node').on(t.nodeId)],
);

export const quizzes = sqliteTable('quizzes', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  subjectId: text('subject_id'),
  goalId: text('goal_id'),
  examId: text('exam_id'),
  classGroupId: text('class_group_id'),
  kind: text('kind').notNull(),
  mode: text('mode').notNull(),
  title: text('title'),
  questionIds: json<string[]>('question_ids').notNull(),
  timeLimitS: integer('time_limit_s'),
  scope: json<Record<string, unknown>>('scope'),
  config: json<Record<string, unknown>>('config'),
  seed: integer('seed'),
  ...syncCols,
});

export const quizAttempts = sqliteTable(
  'quiz_attempts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    quizId: text('quiz_id').notNull(),
    status: text('status').notNull(),
    startedAt: instant('started_at').notNull(),
    finishedAt: instant('finished_at'),
    pausedSeconds: integer('paused_seconds').notNull().default(0),
    deviceId: text('device_id'),
    score: real('score'),
    grade: real('grade'),
    areaResults: json<Record<string, unknown>>('area_results'),
    essayId: text('essay_id'),
    ...syncCols,
  },
  (t) => [index('quiz_attempts_quiz').on(t.quizId)],
);

export const attemptAnswers = sqliteTable(
  'attempt_answers',
  {
    id: text('id').primaryKey(),
    attemptId: text('attempt_id').notNull(),
    userId: text('user_id').notNull(),
    questionId: text('question_id').notNull(),
    questionVersion: integer('question_version'),
    response: json<unknown>('response'),
    correct: bool('correct'),
    score: real('score'),
    pointsAwarded: real('points_awarded'),
    pointsMax: real('points_max'),
    gradingStatus: text('grading_status').notNull().default('graded'),
    graderConfidence: text('grader_confidence'),
    confidence: integer('confidence'),
    timeSpentMs: integer('time_spent_ms').notNull().default(0),
    hintsUsed: integer('hints_used').notNull().default(0),
    solutionViewed: bool('solution_viewed').notNull().default(false),
    markedForReview: bool('marked_for_review').notNull().default(false),
    selfOverride: bool('self_override').notNull().default(false),
    assisted: bool('assisted').notNull().default(false),
    inputMode: text('input_mode').notNull().default('typed'),
    essayId: text('essay_id'),
    answeredAt: instant('answered_at'),
    ...syncCols,
  },
  (t) => [index('attempt_answers_attempt').on(t.attemptId)],
);

export const feedItems = sqliteTable(
  'feed_items',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id').notNull(),
    nodeId: text('node_id').notNull(),
    conceptId: text('concept_id'),
    type: text('type').notNull(),
    content: json<Record<string, unknown>>('content').notNull(),
    mediaPath: text('media_path'),
    sourcePages: json<unknown[]>('source_pages'),
    externalKnowledge: bool('external_knowledge'),
    personalForUserId: text('personal_for_user_id'),
    status: text('status').notNull(),
    ...syncCols,
  },
  (t) => [index('feed_items_subject').on(t.subjectId)],
);

export const mastery = sqliteTable(
  'mastery',
  {
    userId: text('user_id').notNull(),
    nodeId: text('node_id').notNull(),
    subjectId: text('subject_id'),
    mastery: real('mastery').notNull().default(0),
    retrievability: real('retrievability'),
    evidenceCount: integer('evidence_count').notNull().default(0),
    lastEvidenceAt: instant('last_evidence_at'),
    ...syncColsNoId,
  },
  (t) => [primaryKey({ columns: [t.userId, t.nodeId] })],
);

export const dailyActivity = sqliteTable(
  'daily_activity',
  {
    userId: text('user_id').notNull(),
    localDate: text('local_date').notNull(),
    activeMinutes: integer('active_minutes').notNull().default(0),
    reviews: integer('reviews').notNull().default(0),
    questions: integer('questions').notNull().default(0),
    sessions: integer('sessions').notNull().default(0),
    xp: integer('xp').notNull().default(0),
    goalMinutes: integer('goal_minutes'),
    goalMet: bool('goal_met'),
    counted: bool('counted'),
    shieldUsed: bool('shield_used'),
    restDay: bool('rest_day'),
    lateNightMinutes: integer('late_night_minutes'),
    ...syncColsNoId,
  },
  (t) => [primaryKey({ columns: [t.userId, t.localDate] })],
);

export const streaks = sqliteTable('streaks', {
  userId: text('user_id').primaryKey(),
  currentLength: integer('current_length').notNull().default(0),
  longestLength: integer('longest_length').notNull().default(0),
  lastCountedDate: text('last_counted_date'),
  shieldsAvailable: integer('shields_available').notNull().default(0),
  daysSinceLastShieldEarned: integer('days_since_last_shield_earned'),
  restWeekday: integer('rest_weekday'),
  ...syncColsNoId,
});

export const achievements = sqliteTable(
  'achievements',
  {
    userId: text('user_id').notNull(),
    code: text('code').notNull(),
    progress: integer('progress').notNull().default(0),
    unlockedAt: instant('unlocked_at'),
    showInTurma: bool('show_in_turma'),
    ...syncColsNoId,
  },
  (t) => [primaryKey({ columns: [t.userId, t.code] })],
);

// ---------- Local-only tables (mobile-app.md §4.2, data-model §9.2) ----------

/**
 * Pending mutations. `entity_id` is an addition to the §9.2 sketch: it lets a tombstone drop the
 * pending edits for the same row (the entity id is the row's last primary-key column).
 */
export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(), // client UUID v7, also the server row id where applicable
    kind: text('kind').notNull(),
    entityId: text('entity_id'),
    payload: json<unknown>('payload').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    createdAt: integer('created_at').notNull(), // epoch ms
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [index('outbox_created').on(t.createdAt), index('outbox_entity').on(t.entityId)],
);

/**
 * Per table: last server `updated_at` (raw string, microsecond precision kept), the primary-key
 * values of the last row (JSON array, tie-breaker), and the filter signature the cursor was taken
 * under (a changed scope resets the cursor so rows that newly enter the scope are not skipped).
 */
export const syncCursors = sqliteTable('sync_cursors', {
  tableName: text('table_name').primaryKey(),
  updatedAt: text('updated_at'),
  lastId: text('last_id'),
  filterSig: text('filter_sig'),
});

export const fileCache = sqliteTable('file_cache', {
  path: text('path').primaryKey(),
  kind: text('kind').notNull(),
  bytes: integer('bytes').notNull().default(0),
  lastAccess: integer('last_access').notNull(),
  pinned: integer('pinned').notNull().default(0),
});

/** Read by the home-screen widget (MEM-04). */
export const queueCache = sqliteTable(
  'queue_cache',
  {
    cardId: text('card_id').primaryKey(),
    effectiveDue: integer('effective_due').notNull(), // epoch ms
    priority: real('priority').notNull().default(0),
    boostExamId: text('boost_exam_id'),
  },
  (t) => [index('queue_cache_due').on(t.effectiveDue)],
);

export const calendarEvents = sqliteTable('calendar_events', {
  planItemId: text('plan_item_id').primaryKey(),
  calendarId: text('calendar_id').notNull(),
  eventId: text('event_id').notNull(),
});

export const focusBlocklist = sqliteTable('focus_blocklist', {
  packageName: text('package_name').primaryKey(),
  label: text('label').notNull(),
});

export const wellbeingCheckins = sqliteTable('wellbeing_checkins', {
  weekStart: text('week_start').primaryKey(),
  answers: json<Record<string, unknown>>('answers').notNull(),
});

/** Every mirrored table, in pull order (parents before children). */
export const mirroredTables = {
  profiles,
  study_preferences: studyPreferences,
  subjects,
  subject_user_settings: subjectUserSettings,
  knowledge_nodes: knowledgeNodes,
  node_sources: nodeSources,
  node_user_settings: nodeUserSettings,
  glossary_terms: glossaryTerms,
  notes,
  note_highlights: noteHighlights,
  cards,
  card_overrides: cardOverrides,
  card_states: cardStates,
  goals,
  exams,
  exam_scope_nodes: examScopeNodes,
  plan_items: planItems,
  mistakes,
  questions,
  quizzes,
  quiz_attempts: quizAttempts,
  attempt_answers: attemptAnswers,
  feed_items: feedItems,
  mastery,
  daily_activity: dailyActivity,
  streaks,
  achievements,
} as const;

export type MirroredTableName = keyof typeof mirroredTables;
