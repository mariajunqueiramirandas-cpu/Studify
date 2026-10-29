// Note rows and citations (LRN-01, data-model §5.3): one current note per (node, depth), the previous one
// is superseded when a summary is regenerated (R4).
import type { Db } from '@studify/db';

export const REGENERATE_LIMIT_PER_DAY = 3;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

export async function supersedeCurrent(db: Db, nodeId: string, depth: string): Promise<void> {
  const { error } = await db
    .from('notes')
    .update({ status: 'superseded' })
    .eq('node_id', nodeId)
    .eq('depth', depth)
    .eq('status', 'ready');
  if (error) throw error;
}

export async function currentNote(db: Db, nodeId: string, depth: string) {
  const { data, error } = await db
    .from('notes')
    .select('id, status, body, citations')
    .eq('node_id', nodeId)
    .eq('depth', depth)
    .in('status', ['pending', 'generating', 'ready'])
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as { id: string; status: 'pending' | 'generating' | 'ready'; body: string; citations: unknown } | null;
}
