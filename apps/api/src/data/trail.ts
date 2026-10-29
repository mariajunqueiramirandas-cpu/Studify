// Data endpoints of apps/mobile/src/features/trail (define.ts explains the contract). The Trilha's own calls
// (trail-open, trail-answer, ...) are API functions; these are its plain reads, prefixed `trail-data-`.
import { z } from 'zod';
import { dataRoute, maybe, type DataRoute } from './define.ts';

const Id = z.string().uuid();

export const routes: DataRoute[] = [
  dataRoute({
    name: 'trail-data-summary',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    // RLS shows the student only their own trails (one per subject).
    run: ({ db, input }) => maybe(db.from('trails').select('status, chapter_index, plan').eq('subject_id', input.subject_id).maybeSingle()),
  }),
];
