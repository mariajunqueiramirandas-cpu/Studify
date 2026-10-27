import { router } from 'expo-router';

export interface TutorScope {
  type: 'subject' | 'goal' | 'topic' | 'passage';
  subject_id?: string;
  goal_id?: string;
  node_id?: string;
  passage?: { source: 'note' | 'pdf'; document_id?: string; note_id?: string; page?: number; text: string };
}

/** The tutor is a modal (ux §2): entry points pass the preset scope (TUT-03). */
export function openTutor(scope: TutorScope, opts: { mode?: 'answer' | 'socratic' | 'quiz'; prefill?: string } = {}) {
  router.push({
    pathname: '/tutor/[threadId]',
    params: { threadId: 'new', scope: JSON.stringify(scope), ...(opts.mode ? { mode: opts.mode } : {}), ...(opts.prefill ? { prefill: opts.prefill } : {}) },
  });
}

export function openThread(threadId: string) {
  router.push({ pathname: '/tutor/[threadId]', params: { threadId } });
}
