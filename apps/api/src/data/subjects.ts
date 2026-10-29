// Subjects, materials and their outline (apps/mobile/src/features/subjects, the document viewer and the concept map),
// plus the job rows the progress cards read.
import { z } from 'zod';
import { dataRoute, done, maybe, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();
const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const routes: DataRoute[] = [
  dataRoute({
    name: 'subjects-list',
    write: false,
    input: z.object({}),
    example: () => ({}),
    run: async ({ db, user }) => {
      const [subjects, settings] = await Promise.all([
        rows<{ id: string }>(db.from('subjects').select('*').is('deleted_at', null).is('system_kind', null).order('created_at')),
        rows<{ subject_id: string }>(db.from('subject_user_settings').select('*').eq('user_id', user.userId)),
      ]);
      const byId = new Map(settings.map((s) => [s.subject_id, s]));
      return subjects.map((s) => ({ ...s, settings: byId.get(s.id) ?? null }));
    },
  }),

  dataRoute({
    name: 'subjects-get',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: ({ db, input }) => maybe(db.from('subjects').select('*').eq('id', input.subject_id).maybeSingle()),
  }),

  dataRoute({
    name: 'subjects-create',
    write: true,
    input: z.object({ id: Id, name: z.string().trim().min(1).max(80), color: HexColor, icon: z.string().min(1).max(40) }),
    example: () => ({ id: crypto.randomUUID(), name: 'Química', color: '#4f46e5', icon: 'flask' }),
    run: async ({ db, user, input }) => {
      await done(db.from('subjects').insert({ id: input.id, name: input.name, color: input.color, icon: input.icon, owner_profile_id: user.userId, created_by: user.userId }));
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'subjects-update',
    write: true,
    input: z.object({ subject_id: Id, name: z.string().trim().min(1).max(80).optional(), color: HexColor.optional(), icon: z.string().min(1).max(40).optional() }),
    example: (seed) => ({ subject_id: seed.subjectId, name: 'Física 1' }),
    run: async ({ db, input }) => {
      const patch: Record<string, string> = {};
      if (input.name) patch.name = input.name;
      if (input.color) patch.color = input.color;
      if (input.icon) patch.icon = input.icon;
      if (Object.keys(patch).length > 0) await done(db.from('subjects').update(patch).eq('id', input.subject_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'subjects-archive',
    write: true,
    input: z.object({ subject_id: Id, archived: z.boolean() }),
    example: (seed) => ({ subject_id: seed.subjectId, archived: false }),
    run: async ({ db, user, input, now }) => {
      await done(
        db.from('subject_user_settings').upsert(
          { user_id: user.userId, subject_id: input.subject_id, archived_at: input.archived ? now.toISOString() : null },
          { onConflict: 'user_id,subject_id' },
        ),
      );
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'subjects-share',
    write: true,
    input: z.object({ subject_id: Id, class_group_id: Id }),
    example: (seed) => ({ subject_id: seed.missingId, class_group_id: seed.classGroupId }),
    run: async ({ db, input }) => {
      await done(db.rpc('share_subject', { p_subject_id: input.subject_id, p_class_group_id: input.class_group_id, p_copyright_ack: true }), 'share_subject');
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'subjects-documents',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: ({ db, input }) => rows(db.from('documents').select('*').eq('subject_id', input.subject_id).is('deleted_at', null).order('created_at')),
  }),

  dataRoute({
    name: 'subjects-jobs',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: ({ db, input }) =>
      rows(db.from('ai_jobs').select('*').eq('subject_id', input.subject_id).is('parent_job_id', null).order('created_at', { ascending: false }).limit(5)),
  }),

  dataRoute({
    name: 'documents-get',
    write: false,
    input: z.object({ document_id: Id }),
    example: (seed) => ({ document_id: seed.documentId }),
    run: ({ db, input }) => maybe(db.from('documents').select('*').eq('id', input.document_id).maybeSingle()),
  }),

  dataRoute({
    name: 'documents-page',
    write: false,
    input: z.object({ document_id: Id, page_number: z.number().int().min(1) }),
    example: (seed) => ({ document_id: seed.documentId, page_number: 1 }),
    run: ({ db, input }) =>
      maybe(
        db
          .from('document_pages')
          .select('page_number,text_source,image_path,text_items_path,text')
          .eq('document_id', input.document_id)
          .eq('page_number', input.page_number)
          .maybeSingle(),
      ),
  }),

  dataRoute({
    name: 'documents-rename',
    write: true,
    input: z.object({ document_id: Id, title: z.string().trim().min(1).max(200) }),
    example: (seed) => ({ document_id: seed.documentId, title: 'Apostila' }),
    run: async ({ db, input }) => {
      await done(db.from('documents').update({ title: input.title }).eq('id', input.document_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'documents-delete',
    write: true,
    input: z.object({ document_id: Id }),
    example: (seed) => ({ document_id: seed.missingId }),
    run: async ({ db, input, now }) => {
      await done(db.from('documents').update({ deleted_at: now.toISOString() }).eq('id', input.document_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'outline-get',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: async ({ db, user, input }) => {
      const nodes = await rows<{ id: string }>(db.from('knowledge_nodes').select('*').eq('subject_id', input.subject_id).is('deleted_at', null).order('position'));
      const ids = nodes.map((n) => n.id);
      if (ids.length === 0) return { nodes, sources: [], excluded: [] };
      const [sources, settings] = await Promise.all([
        rows(db.from('node_sources').select('node_id,document_id,page_start,page_end').in('node_id', ids)),
        rows<{ node_id: string; excluded: boolean }>(db.from('node_user_settings').select('node_id,excluded').eq('user_id', user.userId).in('node_id', ids)),
      ]);
      return { nodes, sources, excluded: settings.filter((s) => s.excluded).map((s) => s.node_id) };
    },
  }),

  dataRoute({
    name: 'outline-undo',
    write: true,
    input: z.object({ event_id: Id }),
    example: (seed) => ({ event_id: seed.missingId }),
    run: async ({ db, input }) => {
      await done(db.rpc('undo_outline_event', { p_event_id: input.event_id }), 'undo_outline_event');
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'nodes-set-excluded',
    write: true,
    input: z.object({ node_id: Id, excluded: z.boolean() }),
    example: (seed) => ({ node_id: seed.nodeId, excluded: false }),
    run: async ({ db, user, input, now }) => {
      await done(
        db.from('node_user_settings').upsert({ user_id: user.userId, node_id: input.node_id, excluded: input.excluded, updated_at: now.toISOString() }, { onConflict: 'user_id,node_id' }),
      );
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'subjects-group-role',
    write: false,
    input: z.object({ class_group_id: Id }),
    example: (seed) => ({ class_group_id: seed.classGroupId }),
    run: async ({ db, user, input }) => {
      const member = await maybe<{ role: string }>(db.from('class_group_members').select('role').eq('class_group_id', input.class_group_id).eq('user_id', user.userId).maybeSingle());
      return { role: member?.role ?? null };
    },
  }),

  dataRoute({
    name: 'subjects-mastery',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: ({ db, user, input }) =>
      rows(db.from('mastery').select('node_id,subject_id,mastery,retrievability,evidence_count,last_evidence_at').eq('user_id', user.userId).eq('subject_id', input.subject_id)),
  }),

  dataRoute({
    name: 'concept-map-edges',
    write: false,
    input: z.object({ subject_id: Id, topic_ids: z.array(Id).max(1000) }),
    example: (seed) => ({ subject_id: seed.subjectId, topic_ids: [seed.nodeId] }),
    run: async ({ db, input }) => {
      const [prereq, rel] = await Promise.all([
        input.topic_ids.length === 0 ? [] : rows(db.from('node_prerequisites').select('node_id,prerequisite_node_id').in('node_id', input.topic_ids)),
        rows(db.from('node_relations').select('from_node_id,to_node_id,kind,reason').eq('subject_id', input.subject_id)),
      ]);
      return { prereq, rel };
    },
  }),

  dataRoute({
    name: 'jobs-get',
    write: false,
    input: z.object({ job_id: Id }),
    example: (seed) => ({ job_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('ai_jobs').select('*').eq('id', input.job_id).maybeSingle()),
  }),

  dataRoute({
    name: 'jobs-latest',
    write: false,
    input: z.object({ type: z.string().min(1).max(80), since: z.string().datetime({ offset: true }) }),
    example: () => ({ type: 'podcast.generate', since: '2026-01-01T00:00:00Z' }),
    run: async ({ db, user, input }) => {
      const from = new Date(Date.parse(input.since) - 60_000).toISOString();
      const found = await rows<{ id: string }>(
        db.from('ai_jobs').select('id').eq('user_id', user.userId).eq('type', input.type).gte('created_at', from).order('created_at', { ascending: false }).limit(1),
      );
      return { id: found[0]?.id ?? null };
    },
  }),
];
