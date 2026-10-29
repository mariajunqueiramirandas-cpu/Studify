// Central de notificações (api.md §9.1, data-model R34). The worker writes one notification_inbox row per
// push that is not ephemeral, keyed like the notification itself, so a live update or a replacement edits
// the same row. Realtime keeps the list and the unread badge fresh.
import { RICH_CHANNELS, parseRichNotification, type RichNotification } from '@studify/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { data } from '../../api/data';
import { supabase } from '../../api/supabase';
import { realtime, rowTopic, type RealtimeChannel } from '../../api/realtime';
import { logger } from '../../lib/logger';
import { useSession } from '../auth/session';

export type InboxChannel = Exclude<(typeof RICH_CHANNELS)[number], 'live'>;

export interface InboxRow {
  id: string;
  key: string;
  type: string;
  channel: InboxChannel;
  title: string;
  body: string;
  deep_link: string | null;
  rich: unknown;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxItem extends Omit<InboxRow, 'rich'> {
  /** The validated rich payload, or a basic one built from the row when it has none. */
  rich: RichNotification;
}

const GLYPH_BY_CHANNEL: Record<InboxChannel, RichNotification['glyph']> = { reviews: 'cards', plan: 'calendar', class: 'people', processing: 'sparkles' };

/** Rows from before rich payloads, or with one this build does not know, still render as basic cards. */
export function toInboxItem(row: InboxRow): InboxItem {
  const parsed = row.rich ? parseRichNotification(row.rich) : null;
  const rich =
    parsed ??
    parseRichNotification({
      v: 1,
      key: row.key.slice(0, 80) || row.id,
      template: 'basic',
      channel: row.channel,
      title: row.title.slice(0, 80) || 'Studify',
      body: row.body.slice(0, 240),
      glyph: GLYPH_BY_CHANNEL[row.channel] ?? 'sparkles',
      ...(row.deep_link ? { deep_link: row.deep_link } : {}),
    })!;
  return { ...row, rich };
}

const inboxKey = (userId: string | null | undefined) => ['inbox', userId ?? 'none'] as const;
const unreadKey = (userId: string | null | undefined) => ['inboxUnread', userId ?? 'none'] as const;

export function useInbox() {
  const { userId } = useSession();
  useInboxRealtime();
  return useQuery({
    queryKey: inboxKey(userId),
    enabled: !!userId,
    staleTime: 30_000,
    queryFn: async (): Promise<InboxItem[]> => {
      const list = await data<InboxRow[]>('notifications-list');
      return list.map(toInboxItem);
    },
  });
}

export function useUnreadCount(): number {
  const { userId } = useSession();
  useInboxRealtime();
  const q = useQuery({
    queryKey: unreadKey(userId),
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<number> => {
      try {
        const res = await data<{ count: number }>('notifications-unread-count');
        return res?.count ?? 0;
      } catch {
        return 0; // not reachable: no badge
      }
    },
  });
  return q.data ?? 0;
}

// One channel per app, however many screens show the badge or the list.
let channelUsers = 0;
let channelRef: RealtimeChannel | null = null;

function useInboxRealtime() {
  const { userId } = useSession();
  const qc = useQueryClient();
  useEffect(() => {
    if (!userId) return undefined;
    channelUsers++;
    if (!channelRef) {
      channelRef = realtime
        .channel(rowTopic('notification_inbox', 'user_id', userId))
        .on('change', () => {
          void qc.invalidateQueries({ queryKey: ['inbox'] });
          void qc.invalidateQueries({ queryKey: ['inboxUnread'] });
        })
        .subscribe();
    }
    return () => {
      channelUsers--;
      if (channelUsers === 0 && channelRef) {
        void realtime.removeChannel(channelRef);
        channelRef = null;
      }
    };
  }, [userId, qc]);
}

/** The inbox writes never throw (callers fire and forget); a failure is undone by the refresh that follows. */
async function quietly(write: Promise<unknown>): Promise<void> {
  try {
    await write;
  } catch (e) {
    logger.warn('inbox.write_failed', { error: String(e) });
  }
}

function refresh(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['inbox'] });
  void qc.invalidateQueries({ queryKey: ['inboxUnread'] });
}

export function useInboxActions() {
  const { userId } = useSession();
  const qc = useQueryClient();
  const now = () => new Date().toISOString();
  return {
    async markRead(id: string) {
      qc.setQueryData<InboxItem[]>(inboxKey(userId), (prev) => prev?.map((i) => (i.id === id && !i.read_at ? { ...i, read_at: now() } : i)));
      await quietly(data('notifications-mark-read', { id }));
      refresh(qc);
    },
    async markAllRead() {
      if (!userId) return;
      qc.setQueryData<InboxItem[]>(inboxKey(userId), (prev) => prev?.map((i) => (i.read_at ? i : { ...i, read_at: now() })));
      qc.setQueryData<number>(unreadKey(userId), 0);
      await quietly(data('notifications-mark-all-read'));
      refresh(qc);
    },
    async remove(id: string) {
      qc.setQueryData<InboxItem[]>(inboxKey(userId), (prev) => prev?.filter((i) => i.id !== id));
      await quietly(data('notifications-delete', { id }));
      refresh(qc);
    },
  };
}

/** Opening a notification from the shade marks its inbox row read (the key travels as `notif`). */
export async function markReadByKey(key: string): Promise<void> {
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session?.user.id) return;
    await data('notifications-mark-read-key', { key });
  } catch (e) {
    logger.warn('inbox.mark_read_failed', { error: String(e) });
  }
}

// ---------------------------------------------------------------- presentation helpers (pure)

/** "agora", "há 5 min", "há 3 h", "ontem", "seg", "12/03". */
export function relativeTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const s = Math.max(0, (now.getTime() - at.getTime()) / 1000);
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (at.getTime() >= startOfToday) return `há ${Math.floor(s / 3600)} h`;
  if (at.getTime() >= startOfToday - 86_400_000) return 'ontem';
  if (at.getTime() >= startOfToday - 6 * 86_400_000) return ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][at.getDay()]!;
  return `${String(at.getDate()).padStart(2, '0')}/${String(at.getMonth() + 1).padStart(2, '0')}`;
}

export type InboxSection = 'today' | 'yesterday' | 'week' | 'older';

export function sectionOf(iso: string, now = new Date()): InboxSection {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(iso).getTime();
  if (t >= startOfToday) return 'today';
  if (t >= startOfToday - 86_400_000) return 'yesterday';
  if (t >= startOfToday - 6 * 86_400_000) return 'week';
  return 'older';
}

/** Groups items (already newest first) into the sections of the screen, skipping empty ones. */
export function groupInbox<T extends { created_at: string }>(items: T[], now = new Date()): { section: InboxSection; items: T[] }[] {
  const order: InboxSection[] = ['today', 'yesterday', 'week', 'older'];
  const by = new Map<InboxSection, T[]>();
  for (const i of items) {
    const s = sectionOf(i.created_at, now);
    by.set(s, [...(by.get(s) ?? []), i]);
  }
  return order.filter((s) => by.has(s)).map((s) => ({ section: s, items: by.get(s)! }));
}

/** "em 2 d 4 h", "em 3 h 10 min", "em 12 min", "agora". */
export function countdownLabel(targetIso: string, now = new Date()): string {
  const s = Math.floor((new Date(targetIso).getTime() - now.getTime()) / 1000);
  if (s <= 60) return 'agora';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h > 0 ? `em ${d} d ${h} h` : `em ${d} d`;
  if (h > 0) return m > 0 ? `em ${h} h ${m} min` : `em ${h} h`;
  return `em ${m} min`;
}
