// Test data builders for local rows (Drizzle insert values). Test-only.
import type { TestDb } from './test-db';
import { cards, knowledgeNodes, profiles, subjects } from '../schema';

export const USER_ID = 'user-1';
export const SUBJECT_ID = 'subject-1';
export const NODE_ID = 'node-1';

export function seedProfile(db: TestDb, userId = USER_ID): void {
  const now = new Date('2026-10-27T12:00:00.000Z');
  db.insert(profiles)
    .values({
      id: userId,
      displayName: 'Ana',
      displayNameStatus: 'approved',
      avatarPreset: null,
      schoolYear: 'em2',
      timezone: 'America/Sao_Paulo',
      foreignLanguage: null,
      appRole: 'user',
      settings: { memory: { desired_retention: 0.9 } },
      onboardingCompletedAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      pulledAt: now,
    })
    .run();
}

export function seedSubject(db: TestDb, id = SUBJECT_ID): void {
  const now = new Date('2026-10-27T12:00:00.000Z');
  db.insert(subjects)
    .values({
      id,
      ownerProfileId: USER_ID,
      ownerClassGroupId: null,
      createdBy: USER_ID,
      name: 'Biologia',
      color: '#3366FF',
      icon: 'leaf',
      contentLanguage: 'pt-BR',
      isLanguageSubject: false,
      enemArea: 'CN',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      pulledAt: now,
    })
    .run();
  db.insert(knowledgeNodes)
    .values({
      id: NODE_ID,
      subjectId: id,
      parentId: null,
      kind: 'unit',
      title: 'Células',
      summary: null,
      position: 0,
      learningObjectives: [],
      keyTerms: [],
      formulas: [],
      enemSkillCodes: [],
      isPlaceholder: false,
      estLearnMinutes: null,
      editedByUser: false,
      originDocumentId: null,
      contentStatus: 'ready',
      version: 1,
      hiddenReason: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      pulledAt: now,
    })
    .run();
}

/** Inserts `count` cards with ids `${prefix}-${i}` under the seeded node. */
export function seedCards(db: TestDb, count: number, prefix = 'card', subjectId = SUBJECT_ID, nodeId = NODE_ID): string[] {
  const now = new Date('2026-10-27T12:00:00.000Z');
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    ids.push(id);
    db.insert(cards)
      .values({
        id,
        subjectId,
        nodeId,
        conceptId: null,
        type: 'basic',
        front: `Frente ${i}`,
        back: `Verso ${i}`,
        media: null,
        hasMath: false,
        siblingGroupId: null,
        clozeIndex: null,
        sourcePages: [],
        origin: 'generated',
        createdBy: null,
        personalForUserId: null,
        status: 'active',
        hiddenReason: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        pulledAt: now,
      })
      .run();
  }
  return ids;
}

/** Server-side row shapes (snake_case, as PostgREST returns them). */
export function serverCard(id: string, subjectId = SUBJECT_ID, nodeId = NODE_ID, front = `Frente ${id}`) {
  return {
    id,
    subject_id: subjectId,
    node_id: nodeId,
    concept_id: null,
    type: 'basic',
    front,
    back: `Verso ${id}`,
    media: null,
    has_math: false,
    sibling_group_id: null,
    cloze_index: null,
    source_pages: [],
    origin: 'generated',
    created_by: null,
    personal_for_user_id: null,
    status: 'active',
    hidden_reason: null,
    version: 1,
    created_at: '2026-10-27T10:00:00.000000+00:00',
    deleted_at: null,
  };
}

export function serverSubject(id = SUBJECT_ID) {
  return {
    id,
    owner_profile_id: USER_ID,
    owner_class_group_id: null,
    created_by: USER_ID,
    name: 'Biologia',
    color: '#3366FF',
    icon: 'leaf',
    content_language: 'pt-BR',
    is_language_subject: false,
    enem_area: 'CN',
    created_at: '2026-10-27T10:00:00.000000+00:00',
    deleted_at: null,
  };
}

export function serverProfile(userId = USER_ID) {
  return {
    id: userId,
    display_name: 'Ana',
    display_name_status: 'approved',
    avatar_preset: null,
    school_year: 'em2',
    timezone: 'America/Sao_Paulo',
    foreign_language: null,
    app_role: 'user',
    settings: { memory: { desired_retention: 0.9 } },
    onboarding_completed_at: '2026-10-27T10:00:00.000000+00:00',
    created_at: '2026-10-27T10:00:00.000000+00:00',
    deleted_at: null,
  };
}

export function serverNode(id = NODE_ID, subjectId = SUBJECT_ID) {
  return {
    id,
    subject_id: subjectId,
    parent_id: null,
    kind: 'unit',
    title: 'Células',
    summary: null,
    position: 0,
    learning_objectives: [],
    key_terms: [],
    formulas: [],
    enem_skill_codes: [],
    is_placeholder: false,
    est_learn_minutes: null,
    edited_by_user: false,
    origin_document_id: null,
    content_status: 'ready',
    version: 1,
    hidden_reason: null,
    created_at: '2026-10-27T10:00:00.000000+00:00',
    deleted_at: null,
  };
}
