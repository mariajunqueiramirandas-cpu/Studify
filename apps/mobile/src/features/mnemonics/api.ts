// Estúdio de Mnemônicos (MEM-06). Options come from mnemonic-suggest; saving and palaces are direct owner writes
// (RLS) mirrored into SQLite right away, so the card back shows the mnemonic offline (MEM-06.4).
import { useQuery } from '@tanstack/react-query';
import type { MnemonicOption, MnemonicSuggestReq, MnemonicSuggestRes } from '@studify/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { callFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import type { AppDb } from '../../db/client';
import { useLive } from '../../db/hooks/use-live';
import { memoryPalaces, mnemonics } from '../../db/schema';

export function suggestMnemonics(req: Partial<MnemonicSuggestReq>) {
  return callFunction<Partial<MnemonicSuggestReq>, MnemonicSuggestRes>('mnemonic-suggest', req, { idempotencyKey: uuidv7() });
}

export type MnemonicRow = typeof mnemonics.$inferSelect;
export type PalaceRow = typeof memoryPalaces.$inferSelect;

/** The student's mnemonic for a card (newest), from SQLite: works offline. */
export function useCardMnemonic(cardId: string | undefined) {
  return useLive((db) => (cardId ? (db.select().from(mnemonics).where(and(eq(mnemonics.cardId, cardId), isNull(mnemonics.deletedAt))).orderBy(desc(mnemonics.updatedAt)).limit(1).all()[0] ?? null) : null), {
    tables: ['mnemonics'],
    deps: [cardId],
  });
}

export function useNodeMnemonics(nodeId: string | undefined) {
  return useLive((db) => (nodeId ? db.select().from(mnemonics).where(and(eq(mnemonics.nodeId, nodeId), isNull(mnemonics.deletedAt))).orderBy(desc(mnemonics.updatedAt)).all() : []), {
    tables: ['mnemonics'],
    deps: [nodeId],
  });
}

export function usePalaces() {
  return useLive((db) => db.select().from(memoryPalaces).where(isNull(memoryPalaces.deletedAt)).orderBy(desc(memoryPalaces.updatedAt)).all(), { tables: ['memory_palaces'] });
}

/** Saves the chosen option. A card keeps one mnemonic per student: the previous one is replaced (MEM-06.4). */
export async function saveMnemonic(db: AppDb, userId: string, target: { cardId?: string; nodeId?: string }, option: MnemonicOption, palaceId: string | null): Promise<string> {
  const now = new Date();
  if (target.cardId) {
    const old = await supabase.from('mnemonics').update({ deleted_at: now.toISOString() }).eq('user_id', userId).eq('card_id', target.cardId).is('deleted_at', null);
    if (old.error) throw old.error;
    db.update(mnemonics).set({ deletedAt: now, updatedAt: now }).where(and(eq(mnemonics.cardId, target.cardId), isNull(mnemonics.deletedAt))).run();
  }
  const id = uuidv7();
  const row = { id, user_id: userId, card_id: target.cardId ?? null, node_id: target.nodeId ?? null, type: option.type, title: option.title, content: option.content, palace_id: option.type === 'palace' ? palaceId : null };
  const { error } = await supabase.from('mnemonics').insert(row);
  if (error) throw error;
  db.insert(mnemonics)
    .values({ id, userId, cardId: row.card_id, nodeId: row.node_id, type: row.type, title: row.title, content: row.content, palaceId: row.palace_id, createdAt: now, updatedAt: now, deletedAt: null, pulledAt: null })
    .onConflictDoNothing()
    .run();
  return id;
}

export async function deleteMnemonic(db: AppDb, id: string) {
  const now = new Date();
  const { error } = await supabase.from('mnemonics').update({ deleted_at: now.toISOString() }).eq('id', id);
  if (error) throw error;
  db.update(mnemonics).set({ deletedAt: now, updatedAt: now }).where(eq(mnemonics.id, id)).run();
}

export async function savePalace(db: AppDb, userId: string, input: { id?: string; name: string; loci: string[] }): Promise<string> {
  const now = new Date();
  const id = input.id ?? uuidv7();
  if (input.id) {
    const { error } = await supabase.from('memory_palaces').update({ name: input.name, loci: input.loci }).eq('id', id);
    if (error) throw error;
    db.update(memoryPalaces).set({ name: input.name, loci: input.loci, updatedAt: now }).where(eq(memoryPalaces.id, id)).run();
  } else {
    const { error } = await supabase.from('memory_palaces').insert({ id, user_id: userId, name: input.name, loci: input.loci });
    if (error) throw error;
    db.insert(memoryPalaces).values({ id, userId, name: input.name, loci: input.loci, createdAt: now, updatedAt: now, deletedAt: null, pulledAt: null }).onConflictDoNothing().run();
  }
  return id;
}

export async function deletePalace(db: AppDb, id: string) {
  const now = new Date();
  const { error } = await supabase.from('memory_palaces').update({ deleted_at: now.toISOString() }).eq('id', id);
  if (error) throw error;
  db.update(memoryPalaces).set({ deletedAt: now, updatedAt: now }).where(eq(memoryPalaces.id, id)).run();
}

/** Card text for the studio header (online read; the studio needs the network anyway). */
export function useCardText(cardId: string | undefined) {
  return useQuery({
    queryKey: ['card-text', cardId],
    enabled: !!cardId,
    queryFn: async () => {
      const { data, error } = await supabase.from('cards').select('front,back,node_id,subject_id').eq('id', cardId!).maybeSingle();
      if (error) throw error;
      return data as { front: string; back: string; node_id: string; subject_id: string } | null;
    },
  });
}
