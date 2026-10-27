CREATE TABLE `achievements` (
	`user_id` text NOT NULL,
	`code` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`unlocked_at` integer,
	`show_in_turma` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer,
	PRIMARY KEY(`user_id`, `code`)
);
--> statement-breakpoint
CREATE TABLE `attempt_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`attempt_id` text NOT NULL,
	`user_id` text NOT NULL,
	`question_id` text NOT NULL,
	`question_version` integer,
	`response` text,
	`correct` integer,
	`score` real,
	`points_awarded` real,
	`points_max` real,
	`grading_status` text DEFAULT 'graded' NOT NULL,
	`grader_confidence` text,
	`confidence` integer,
	`time_spent_ms` integer DEFAULT 0 NOT NULL,
	`hints_used` integer DEFAULT 0 NOT NULL,
	`solution_viewed` integer DEFAULT false NOT NULL,
	`marked_for_review` integer DEFAULT false NOT NULL,
	`self_override` integer DEFAULT false NOT NULL,
	`assisted` integer DEFAULT false NOT NULL,
	`input_mode` text DEFAULT 'typed' NOT NULL,
	`essay_id` text,
	`answered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `attempt_answers_attempt` ON `attempt_answers` (`attempt_id`);--> statement-breakpoint
CREATE TABLE `calendar_events` (
	`plan_item_id` text PRIMARY KEY NOT NULL,
	`calendar_id` text NOT NULL,
	`event_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `card_overrides` (
	`user_id` text NOT NULL,
	`card_id` text NOT NULL,
	`front` text,
	`back` text,
	`media` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer,
	PRIMARY KEY(`user_id`, `card_id`)
);
--> statement-breakpoint
CREATE TABLE `card_states` (
	`user_id` text NOT NULL,
	`card_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`due` integer NOT NULL,
	`stability` real DEFAULT 0 NOT NULL,
	`difficulty` real DEFAULT 0 NOT NULL,
	`elapsed_days` integer DEFAULT 0 NOT NULL,
	`scheduled_days` integer DEFAULT 0 NOT NULL,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`state` integer DEFAULT 0 NOT NULL,
	`learning_steps` integer DEFAULT 0 NOT NULL,
	`last_review` integer,
	`suspended` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`is_leech` integer DEFAULT false NOT NULL,
	`introduced_at` integer,
	`last_log_id` text,
	`updated_at` integer NOT NULL,
	`_pulled_at` integer,
	PRIMARY KEY(`user_id`, `card_id`)
);
--> statement-breakpoint
CREATE INDEX `card_states_due` ON `card_states` (`due`);--> statement-breakpoint
CREATE INDEX `card_states_subject` ON `card_states` (`subject_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`node_id` text NOT NULL,
	`concept_id` text,
	`type` text NOT NULL,
	`front` text NOT NULL,
	`back` text NOT NULL,
	`media` text,
	`has_math` integer,
	`sibling_group_id` text,
	`cloze_index` integer,
	`source_pages` text,
	`origin` text NOT NULL,
	`created_by` text,
	`personal_for_user_id` text,
	`status` text NOT NULL,
	`hidden_reason` text,
	`version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `cards_node` ON `cards` (`node_id`);--> statement-breakpoint
CREATE INDEX `cards_subject` ON `cards` (`subject_id`);--> statement-breakpoint
CREATE TABLE `daily_activity` (
	`user_id` text NOT NULL,
	`local_date` text NOT NULL,
	`active_minutes` integer DEFAULT 0 NOT NULL,
	`reviews` integer DEFAULT 0 NOT NULL,
	`questions` integer DEFAULT 0 NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	`goal_minutes` integer,
	`goal_met` integer,
	`counted` integer,
	`shield_used` integer,
	`rest_day` integer,
	`late_night_minutes` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer,
	PRIMARY KEY(`user_id`, `local_date`)
);
--> statement-breakpoint
CREATE TABLE `exam_scope_nodes` (
	`exam_id` text NOT NULL,
	`node_id` text NOT NULL,
	`scope_item_id` text,
	`source` text,
	`confidence` real,
	`confirmed` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer,
	PRIMARY KEY(`exam_id`, `node_id`)
);
--> statement-breakpoint
CREATE TABLE `exams` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`user_id` text NOT NULL,
	`subject_id` text,
	`title` text NOT NULL,
	`local_date` text NOT NULL,
	`starts_at` integer,
	`duration_min` integer,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`parent_exam_id` text,
	`teacher_name` text,
	`weight` real,
	`scope_status` text NOT NULL,
	`grade` real,
	`grade_max` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `exams_goal` ON `exams` (`goal_id`,`local_date`);--> statement-breakpoint
CREATE TABLE `feed_items` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`node_id` text NOT NULL,
	`concept_id` text,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`media_path` text,
	`source_pages` text,
	`external_knowledge` integer,
	`personal_for_user_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `feed_items_subject` ON `feed_items` (`subject_id`);--> statement-breakpoint
CREATE TABLE `file_cache` (
	`path` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`last_access` integer NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `focus_blocklist` (
	`package_name` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `glossary_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`node_id` text,
	`term` text NOT NULL,
	`normalized_term` text NOT NULL,
	`aliases` text,
	`definition` text,
	`example` text,
	`source_pages` text,
	`version` integer,
	`hidden_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `glossary_terms_subject` ON `glossary_terms` (`subject_id`);--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`mode` text NOT NULL,
	`name` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text NOT NULL,
	`term_index` integer,
	`school_year` integer,
	`settings` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE TABLE `knowledge_nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`parent_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`position` integer DEFAULT 0 NOT NULL,
	`learning_objectives` text,
	`key_terms` text,
	`formulas` text,
	`enem_skill_codes` text,
	`is_placeholder` integer,
	`est_learn_minutes` integer,
	`edited_by_user` integer,
	`origin_document_id` text,
	`content_status` text,
	`version` integer,
	`hidden_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `knowledge_nodes_tree` ON `knowledge_nodes` (`subject_id`,`parent_id`,`position`);--> statement-breakpoint
CREATE TABLE `mastery` (
	`user_id` text NOT NULL,
	`node_id` text NOT NULL,
	`subject_id` text,
	`mastery` real DEFAULT 0 NOT NULL,
	`retrievability` real,
	`evidence_count` integer DEFAULT 0 NOT NULL,
	`last_evidence_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer,
	PRIMARY KEY(`user_id`, `node_id`)
);
--> statement-breakpoint
CREATE TABLE `mistakes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`question_id` text NOT NULL,
	`attempt_answer_id` text,
	`subject_id` text,
	`node_id` text,
	`cause` text,
	`suggested_cause` text,
	`cause_source` text,
	`user_note` text,
	`next_retry_at` text,
	`retry_step` integer DEFAULT 0 NOT NULL,
	`success_days` integer DEFAULT 0 NOT NULL,
	`remediation_card_id` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `mistakes_open` ON `mistakes` (`user_id`,`resolved_at`);--> statement-breakpoint
CREATE TABLE `node_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`document_id` text NOT NULL,
	`page_start` integer NOT NULL,
	`page_end` integer NOT NULL,
	`origin` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `node_sources_node` ON `node_sources` (`node_id`);--> statement-breakpoint
CREATE TABLE `node_user_settings` (
	`user_id` text NOT NULL,
	`node_id` text NOT NULL,
	`excluded` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer,
	PRIMARY KEY(`user_id`, `node_id`)
);
--> statement-breakpoint
CREATE TABLE `note_highlights` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`note_id` text NOT NULL,
	`start` integer NOT NULL,
	`end` integer NOT NULL,
	`quote` text,
	`color` text,
	`orphaned` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `note_highlights_note` ON `note_highlights` (`note_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`node_id` text,
	`scope_kind` text NOT NULL,
	`depth` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`citations` text,
	`language` text,
	`word_count` integer,
	`has_math` integer,
	`status` text NOT NULL,
	`supersedes_note_id` text,
	`low_citation_coverage` integer,
	`contributors` text,
	`created_by` text,
	`version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `notes_node_depth` ON `notes` (`node_id`,`depth`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`entity_id` text,
	`payload` text NOT NULL,
	`schema_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `outbox_created` ON `outbox` (`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_entity` ON `outbox` (`entity_id`);--> statement-breakpoint
CREATE TABLE `plan_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`goal_id` text,
	`plan_run_id` text NOT NULL,
	`local_date` text NOT NULL,
	`subject_id` text,
	`exam_id` text,
	`node_ids` text,
	`unit_type` text NOT NULL,
	`minutes` integer NOT NULL,
	`deadline` text,
	`priority` real,
	`order_in_day` integer,
	`demanding` integer,
	`pinned` integer,
	`status` text NOT NULL,
	`reason_key` text,
	`reason_params` text,
	`completed_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `plan_items_day` ON `plan_items` (`local_date`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`display_name_status` text,
	`avatar_preset` text,
	`school_year` text,
	`timezone` text DEFAULT 'America/Sao_Paulo' NOT NULL,
	`foreign_language` text,
	`app_role` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`onboarding_completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`node_id` text NOT NULL,
	`concept_ids` text,
	`type` text NOT NULL,
	`stem` text NOT NULL,
	`stimulus` text,
	`texto_base` text,
	`payload` text NOT NULL,
	`explanation` text,
	`bloom_level` text,
	`difficulty` integer,
	`has_math` integer,
	`source_pages` text,
	`origin` text NOT NULL,
	`variant_of` text,
	`source_document_id` text,
	`personal_for_user_id` text,
	`review_status` text,
	`status` text NOT NULL,
	`hidden_reason` text,
	`version` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `questions_node` ON `questions` (`node_id`);--> statement-breakpoint
CREATE TABLE `queue_cache` (
	`card_id` text PRIMARY KEY NOT NULL,
	`effective_due` integer NOT NULL,
	`priority` real DEFAULT 0 NOT NULL,
	`boost_exam_id` text
);
--> statement-breakpoint
CREATE INDEX `queue_cache_due` ON `queue_cache` (`effective_due`);--> statement-breakpoint
CREATE TABLE `quiz_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`quiz_id` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`paused_seconds` integer DEFAULT 0 NOT NULL,
	`device_id` text,
	`score` real,
	`grade` real,
	`area_results` text,
	`essay_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE INDEX `quiz_attempts_quiz` ON `quiz_attempts` (`quiz_id`);--> statement-breakpoint
CREATE TABLE `quizzes` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`subject_id` text,
	`goal_id` text,
	`exam_id` text,
	`class_group_id` text,
	`kind` text NOT NULL,
	`mode` text NOT NULL,
	`title` text,
	`question_ids` text NOT NULL,
	`time_limit_s` integer,
	`scope` text,
	`config` text,
	`seed` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE TABLE `review_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`card_id` text NOT NULL,
	`rating` integer NOT NULL,
	`reviewed_at` integer NOT NULL,
	`client_reviewed_at` integer NOT NULL,
	`elapsed_days` integer,
	`scheduled_days` integer,
	`state_before` integer,
	`duration_ms` integer,
	`source` text DEFAULT 'session' NOT NULL,
	`reason` text DEFAULT 'scheduled' NOT NULL,
	`hint_used` integer DEFAULT false NOT NULL,
	`undoes_log_id` text,
	`device_id` text,
	`clock_skew` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `review_logs_card` ON `review_logs` (`card_id`,`reviewed_at`);--> statement-breakpoint
CREATE TABLE `streaks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`current_length` integer DEFAULT 0 NOT NULL,
	`longest_length` integer DEFAULT 0 NOT NULL,
	`last_counted_date` text,
	`shields_available` integer DEFAULT 0 NOT NULL,
	`days_since_last_shield_earned` integer,
	`rest_weekday` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE TABLE `study_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`minutes_by_weekday` text,
	`window_start` text,
	`window_end` text,
	`min_block_min` integer,
	`max_block_min` integer,
	`max_subjects_per_day` integer,
	`quiet_start` text,
	`quiet_end` text,
	`vespera_time` text,
	`day_rollover_hour` integer,
	`enem_min_share` real,
	`review_seconds_estimate` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE TABLE `subject_user_settings` (
	`user_id` text NOT NULL,
	`subject_id` text NOT NULL,
	`pinned` integer,
	`sort_order` integer,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer,
	PRIMARY KEY(`user_id`, `subject_id`)
);
--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_profile_id` text,
	`owner_class_group_id` text,
	`created_by` text,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`icon` text NOT NULL,
	`content_language` text,
	`is_language_subject` integer,
	`enem_area` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`_pulled_at` integer
);
--> statement-breakpoint
CREATE TABLE `sync_cursors` (
	`table_name` text PRIMARY KEY NOT NULL,
	`updated_at` text,
	`last_id` text,
	`filter_sig` text
);
--> statement-breakpoint
CREATE TABLE `wellbeing_checkins` (
	`week_start` text PRIMARY KEY NOT NULL,
	`answers` text NOT NULL
);
