// Data endpoints of apps/mobile/src/features/podcast (define.ts explains the contract). podcast-create and podcast-ask
// are API functions of their own; these are the table reads.
import { z } from 'zod';
import { dataRoute, maybe, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();

const LIST_COLUMNS = 'id, subject_id, node_ids, style, length_minutes, owner_user_id, title, duration_ms, status, error_code, superseded_by, created_at, audio_path';

export const routes: DataRoute[] = [
  dataRoute({
    name: 'podcast-data-episodes',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: ({ db, input }) =>
      rows(
        db.from('podcast_episodes').select(LIST_COLUMNS).eq('subject_id', input.subject_id).neq('status', 'failed').order('created_at', { ascending: false }).limit(30),
        'podcast_episodes',
      ),
  }),

  dataRoute({
    name: 'podcast-data-episode',
    write: false,
    input: z.object({ episode_id: Id }),
    example: (seed) => ({ episode_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('podcast_episodes').select('*').eq('id', input.episode_id).maybeSingle(), 'podcast_episodes.get'),
  }),

  dataRoute({
    name: 'podcast-data-interactions',
    write: false,
    input: z.object({ episode_id: Id }),
    example: (seed) => ({ episode_id: seed.missingId }),
    run: ({ db, user, input }) =>
      rows(db.from('podcast_interactions').select('*').eq('episode_id', input.episode_id).eq('user_id', user.userId).order('created_at'), 'podcast_interactions'),
  }),

  dataRoute({
    // Where the student stopped last time (podcast_plays), or null.
    name: 'podcast-data-resume',
    write: false,
    input: z.object({ episode_id: Id }),
    example: (seed) => ({ episode_id: seed.missingId }),
    run: ({ db, user, input }) =>
      maybe(db.from('podcast_plays').select('position_ms, completed_at').eq('user_id', user.userId).eq('episode_id', input.episode_id).maybeSingle(), 'podcast_plays'),
  }),

  // app/podcast/new.tsx: "Ouvir revisão desta prova" (INT-01.1) preselects the exam's scope topics.
  dataRoute({
    name: 'podcast-data-exam-scope',
    write: false,
    input: z.object({ exam_id: Id }),
    example: (seed) => ({ exam_id: seed.examId }),
    run: async ({ db, input }) => {
      const scope = await rows<{ node_id: string }>(db.from('exam_scope_nodes').select('node_id').eq('exam_id', input.exam_id), 'exam_scope_nodes');
      return { node_ids: scope.map((r) => r.node_id) };
    },
  }),
];
