// Shared seed data: one student with a Biology test in seven days, two topics under one unit.
import { EXAM, FakeDatabase, GOAL, SUBJECT, TOPIC, TOPIC_B, UNIT, USER } from './fakes.ts';

export function seedStudent(db: FakeDatabase, opts: { examDate?: string; withDefaults?: boolean } = {}): void {
  db.seed('profiles', [{ id: USER, timezone: 'America/Sao_Paulo', settings: {}, deleted_at: null }]);
  db.seed('study_preferences', [
    {
      user_id: USER,
      minutes_by_weekday: [60, 60, 60, 60, 60, 90, 90],
      window_start: '08:00:00',
      window_end: '22:00:00',
      min_block_min: 10,
      max_block_min: 30,
      max_subjects_per_day: 3,
      quiet_start: '22:00:00',
      quiet_end: '07:00:00',
      vespera_time: '19:00:00',
      day_rollover_hour: 4,
      review_seconds_estimate: 8,
    },
  ]);
  db.seed('goals', [{ id: GOAL, user_id: USER, mode: 'exam_week', name: 'Semestre', status: 'active', start_date: '2026-10-01', end_date: '2026-12-15', deleted_at: null }]);
  db.seed('subjects', [
    { id: SUBJECT, owner_profile_id: USER, owner_class_group_id: null, created_by: USER, name: 'Biologia', color: '#336699', icon: 'leaf', content_language: 'pt-BR', is_language_subject: false, deleted_at: null },
  ]);
  db.seed('exams', [
    {
      id: EXAM,
      goal_id: GOAL,
      user_id: USER,
      subject_id: SUBJECT,
      title: 'Bio P1',
      local_date: opts.examDate ?? '2026-11-03',
      starts_at: null,
      kind: 'regular',
      status: 'scheduled',
      weight: 1,
      deleted_at: null,
    },
  ]);
  db.seed('knowledge_nodes', [
    { id: UNIT, subject_id: SUBJECT, parent_id: null, kind: 'unit', title: 'Célula', position: 0, is_placeholder: false, deleted_at: null, summary: null },
    { id: TOPIC, subject_id: SUBJECT, parent_id: UNIT, kind: 'topic', title: 'Membrana', position: 0, is_placeholder: false, deleted_at: null, summary: 'Transporte' },
    { id: TOPIC_B, subject_id: SUBJECT, parent_id: UNIT, kind: 'topic', title: 'Mitocôndria', position: 1, is_placeholder: false, deleted_at: null, summary: null },
  ]);
  if (opts.withDefaults !== false) db.seed('exam_scope_nodes', []);
}
