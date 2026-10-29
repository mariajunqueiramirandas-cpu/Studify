// Data endpoints of apps/mobile/src/features/mnemonics (define.ts explains the contract): the Estúdio de Mnemônicos'
// owner writes (mnemonics, memory palaces) and the card text its header shows. The app mirrors each write into SQLite.
import { z } from 'zod';
import { dataRoute, done, maybe, type DataRoute } from './define.ts';

const Id = z.string().uuid();
const MnemonicType = z.enum(['acronym', 'phrase', 'rhyme', 'story', 'palace', 'keyword']);
/** mnemonics.content: {text, items?, how_to_use?, loci?} (MnemonicContentSchema); stored as the app sends it. */
const MnemonicContent = z.object({ text: z.string().max(4000) }).passthrough();
const PalaceName = z.string().min(1).max(60);
const Loci = z.array(z.string().max(200)).min(2).max(20);

export const routes: DataRoute[] = [
  dataRoute({
    // A card keeps one mnemonic per student: the previous one is replaced (MEM-06.4).
    name: 'mnemonics-save',
    write: true,
    input: z.object({
      id: Id,
      card_id: Id.optional(),
      node_id: Id.optional(),
      type: MnemonicType,
      title: z.string().min(1).max(120),
      content: MnemonicContent,
      palace_id: Id.nullable().optional(),
    }),
    example: (seed) => ({ id: crypto.randomUUID(), node_id: seed.nodeId, type: 'acronym' as const, title: 'MRUV', content: { text: 'Sorvete: S = S0 + V0t + at²/2' } }),
    run: async ({ db, user, input, now }) => {
      if (input.card_id) {
        await done(db.from('mnemonics').update({ deleted_at: now.toISOString() }).eq('user_id', user.userId).eq('card_id', input.card_id).is('deleted_at', null));
      }
      await done(
        db.from('mnemonics').insert({
          id: input.id,
          user_id: user.userId,
          card_id: input.card_id ?? null,
          node_id: input.node_id ?? null,
          type: input.type,
          title: input.title,
          content: input.content,
          palace_id: input.type === 'palace' ? (input.palace_id ?? null) : null,
        }),
      );
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'mnemonics-delete',
    write: true,
    input: z.object({ mnemonic_id: Id }),
    example: (seed) => ({ mnemonic_id: seed.missingId }),
    run: async ({ db, input, now }) => {
      await done(db.from('mnemonics').update({ deleted_at: now.toISOString() }).eq('id', input.mnemonic_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'mnemonics-palace-create',
    write: true,
    input: z.object({ id: Id, name: PalaceName, loci: Loci }),
    example: () => ({ id: crypto.randomUUID(), name: 'Minha casa', loci: ['Porta', 'Sala'] }),
    run: async ({ db, user, input }) => {
      await done(db.from('memory_palaces').insert({ id: input.id, user_id: user.userId, name: input.name, loci: input.loci }));
      return { id: input.id };
    },
  }),

  dataRoute({
    name: 'mnemonics-palace-update',
    write: true,
    input: z.object({ palace_id: Id, name: PalaceName, loci: Loci }),
    example: (seed) => ({ palace_id: seed.missingId, name: 'Minha casa', loci: ['Porta', 'Sala'] }),
    run: async ({ db, input }) => {
      await done(db.from('memory_palaces').update({ name: input.name, loci: input.loci }).eq('id', input.palace_id));
      return { ok: true };
    },
  }),

  dataRoute({
    name: 'mnemonics-palace-delete',
    write: true,
    input: z.object({ palace_id: Id }),
    example: (seed) => ({ palace_id: seed.missingId }),
    run: async ({ db, input, now }) => {
      await done(db.from('memory_palaces').update({ deleted_at: now.toISOString() }).eq('id', input.palace_id));
      return { ok: true };
    },
  }),

  dataRoute({
    // Card text for the studio header (online read; the studio needs the network anyway).
    name: 'mnemonics-card-text',
    write: false,
    input: z.object({ card_id: Id }),
    example: (seed) => ({ card_id: seed.missingId }),
    run: ({ db, input }) => maybe(db.from('cards').select('front,back,node_id,subject_id').eq('id', input.card_id).maybeSingle()),
  }),
];
