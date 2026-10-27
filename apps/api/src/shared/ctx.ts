// Budget context for one AI call (security-privacy §7): the subject decides who pays. A shared subject
// charges its Turma's month; a personal one charges the student's day (ai-pipeline §9.1).
import type { BudgetContext } from '@studify/ai';
import type { SubjectRow } from './access.ts';

export function budgetCtxFor(
  subject: Pick<SubjectRow, 'owner_class_group_id' | 'id'> | null,
  userId: string,
  feature: string,
  budgetClass: 'content' | 'user' | 'system',
  extra: { nodeId?: string | null; documentId?: string | null } = {},
): BudgetContext {
  return {
    userId,
    classGroupId: subject?.owner_class_group_id ?? null,
    subjectId: subject?.id ?? null,
    nodeId: extra.nodeId ?? null,
    documentId: extra.documentId ?? null,
    feature,
    budgetClass,
  };
}
