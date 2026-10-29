// Data endpoints of apps/mobile/src/features/learn (define.ts explains the contract): notes, glossary, the subject's
// cards with the student's state and overrides, user cards (typed and image occlusion), card flags, topic reads
// and explanation feedback.
import { z } from 'zod';
import { count, dataRoute, done, maybe, rows, type DataRoute } from './define.ts';

const Id = z.string().uuid();
const CardText = z.string().max(4000);
const SourcePages = z.array(z.object({}).passthrough()).max(50);
const NoteDepth = z.enum(['tldr', 'study', 'deep', 'class_summary']);

const OcclusionMask = z.object({
  id: z.string().min(1).max(40),
  label: z.string().max(200),
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});
const OcclusionMedia = z.object({
  path: z.string().min(1).max(400),
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
  mode: z.enum(['hide_one', 'hide_all']),
  masks: z.array(OcclusionMask).max(100),
  target_mask_id: z.string().min(1).max(40),
});

const hasMath = (text: string) => /\$[^$]+\$/.test(text);

export const routes: DataRoute[] = [
  dataRoute({
    name: 'learn-notes',
    write: false,
    input: z.object({ node_id: Id }),
    example: (seed) => ({ node_id: seed.nodeId }),
    run: ({ db, input }) =>
      rows(db.from('notes').select('*').eq('node_id', input.node_id).in('status', ['pending', 'generating', 'ready', 'failed']).is('deleted_at', null)),
  }),

  dataRoute({
    name: 'learn-note',
    write: false,
    input: z.object({ note_id: Id }),
    example: (seed) => ({ note_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('notes').select('*').eq('id', input.note_id).maybeSingle()),
  }),

  dataRoute({
    name: 'learn-explanation-feedback',
    write: true,
    input: z.object({ id: Id, explanation_id: Id, helpful: z.boolean() }),
    example: (seed) => ({ id: crypto.randomUUID(), explanation_id: seed.missingId, helpful: true }),
    run: async ({ db, user, input }) => {
      await done(db.from('explanation_feedback').insert({ id: input.id, user_id: user.userId, explanation_id: input.explanation_id, helpful: input.helpful }));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'learn-glossary',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: async ({ db, user, input }) => {
      const [terms, overrides] = await Promise.all([
        rows(db.from('glossary_terms').select('*').eq('subject_id', input.subject_id).is('deleted_at', null).is('hidden_reason', null).order('normalized_term')),
        rows(db.from('glossary_term_overrides').select('term_id,definition').eq('user_id', user.userId)),
      ]);
      return { terms, overrides };
    },
  }),

  dataRoute({
    name: 'learn-subject-cards',
    write: false,
    input: z.object({ subject_id: Id }),
    example: (seed) => ({ subject_id: seed.subjectId }),
    run: async ({ db, user, input }) => {
      const [cards, states, overrides] = await Promise.all([
        rows(db.from('cards').select('*').eq('subject_id', input.subject_id).is('deleted_at', null).eq('status', 'active')),
        rows(db.from('card_states').select('card_id,due,state,suspended,hidden,is_leech').eq('user_id', user.userId).eq('subject_id', input.subject_id)),
        rows(db.from('card_overrides').select('card_id,front,back').eq('user_id', user.userId)),
      ]);
      return { cards, states, overrides };
    },
  }),

  dataRoute({
    name: 'learn-node-counts',
    write: false,
    input: z.object({ node_id: Id }),
    example: (seed) => ({ node_id: seed.nodeId }),
    run: async ({ db, input }) => {
      const [cards, questions] = await Promise.all([
        count(db.from('cards').select('id', { count: 'exact', head: true }).eq('node_id', input.node_id).is('deleted_at', null)),
        count(db.from('questions').select('id', { count: 'exact', head: true }).eq('node_id', input.node_id).is('deleted_at', null).eq('status', 'active')),
      ]);
      return { cards, questions };
    },
  }),

  dataRoute({
    name: 'learn-card-create',
    write: true,
    input: z.object({
      id: Id,
      subject_id: Id,
      node_id: Id,
      type: z.enum(['basic', 'cloze', 'reverse']),
      front: CardText,
      back: CardText,
      source_pages: SourcePages.optional(),
      origin: z.enum(['user', 'from_mistake', 'from_tutor']).optional(),
      /** In a shared subject the card is private to its creator (R8). */
      personal: z.boolean(),
    }),
    example: (seed) => ({ id: crypto.randomUUID(), subject_id: seed.subjectId, node_id: seed.nodeId, type: 'basic' as const, front: 'Velocidade', back: 'Δs/Δt', personal: false }),
    run: async ({ db, user, input }) => {
      await done(
        db.from('cards').insert({
          id: input.id,
          subject_id: input.subject_id,
          node_id: input.node_id,
          type: input.type,
          front: input.front,
          back: input.back,
          has_math: hasMath(input.front + input.back),
          source_pages: input.source_pages ?? [],
          origin: input.origin ?? 'user',
          created_by: user.userId,
          personal_for_user_id: input.personal ? user.userId : null,
        }),
      );
      return { id: input.id };
    },
  }),

  dataRoute({
    // Edits to shared cards become per-user overrides, never silent changes for everyone (architecture §3.2).
    name: 'learn-card-edit',
    write: true,
    input: z.object({ card_id: Id, front: CardText, back: CardText }),
    example: (seed) => ({ card_id: seed.missingId, front: 'Velocidade', back: 'Δs/Δt' }),
    run: async ({ db, user, input }) => {
      const card = await maybe<{ origin: string; personal_for_user_id: string | null }>(
        db.from('cards').select('origin,personal_for_user_id').eq('id', input.card_id).maybeSingle(),
      );
      const own = !!card && card.origin === 'user' && (card.personal_for_user_id === user.userId || card.personal_for_user_id == null);
      if (own) {
        const res = await db.from('cards').update({ front: input.front, back: input.back, has_math: hasMath(input.front + input.back) }).eq('id', input.card_id);
        if (!res.error) return { result: 'updated' as const };
      }
      // updated_at is kept by the table's trigger (and is not a column the student may write).
      await done(db.from('card_overrides').upsert({ user_id: user.userId, card_id: input.card_id, front: input.front, back: input.back }, { onConflict: 'user_id,card_id' }));
      return { result: 'override' as const };
    },
  }),

  dataRoute({
    name: 'learn-card-flag',
    write: true,
    input: z.object({ card_id: Id, suspended: z.boolean().optional(), hidden: z.boolean().optional() }),
    example: (seed) => ({ card_id: seed.missingId, suspended: true }),
    run: async ({ db, user, input }) => {
      const patch: Record<string, boolean> = {};
      if (input.suspended !== undefined) patch.suspended = input.suspended;
      if (input.hidden !== undefined) patch.hidden = input.hidden;
      if (Object.keys(patch).length > 0) await done(db.from('card_states').update(patch).eq('user_id', user.userId).eq('card_id', input.card_id));
      return { ok: true };
    },
  }),

  dataRoute({
    // MEM-03.4: one card per labeled mask of an uploaded image, all in one sibling group.
    name: 'learn-occlusion-cards',
    write: true,
    input: z.object({
      subject_id: Id,
      node_id: Id,
      sibling_group_id: Id,
      personal: z.boolean(),
      cards: z.array(z.object({ id: Id, front: CardText, back: CardText, media: OcclusionMedia })).min(1).max(100),
    }),
    example: (seed) => ({
      subject_id: seed.subjectId,
      node_id: seed.nodeId,
      sibling_group_id: crypto.randomUUID(),
      personal: true,
      cards: [
        {
          id: crypto.randomUUID(),
          front: 'O que está escondido na área destacada?',
          back: 'Núcleo',
          media: {
            path: `media/${seed.subjectId}/occlusion/${crypto.randomUUID()}.jpg`,
            width: 800,
            height: 600,
            mode: 'hide_all' as const,
            masks: [{ id: 'm1', label: 'Núcleo', x: 0.1, y: 0.1, w: 0.2, h: 0.1 }],
            target_mask_id: 'm1',
          },
        },
      ],
    }),
    run: async ({ db, user, input }) => {
      await done(
        db.from('cards').insert(
          input.cards.map((c) => ({
            id: c.id,
            subject_id: input.subject_id,
            node_id: input.node_id,
            type: 'image_occlusion',
            front: c.front,
            back: c.back,
            media: c.media,
            has_math: false,
            sibling_group_id: input.sibling_group_id,
            source_pages: [],
            origin: 'user',
            created_by: user.userId,
            personal_for_user_id: input.personal ? user.userId : null,
          })),
        ),
      );
      return { count: input.cards.length };
    },
  }),

  dataRoute({
    name: 'learn-topic-read',
    write: true,
    input: z.object({ id: Id, node_id: Id, depth: NoteDepth, seconds: z.number().int().min(0).max(86_400) }),
    // topic_reads is append-only (the seeded student could not be deleted), so the example names no topic.
    example: (seed) => ({ id: crypto.randomUUID(), node_id: seed.missingId, depth: 'study' as const, seconds: 30 }),
    run: async ({ db, user, input, now }) => {
      await done(db.from('topic_reads').insert({ id: input.id, user_id: user.userId, node_id: input.node_id, depth: input.depth, read_at: now.toISOString(), seconds: input.seconds }));
      return { ok: true };
    },
  }),
];
