import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from 'uuidv7';
import { streamFunction } from '../../api/functions';
import { supabase } from '../../api/supabase';
import { useSession } from '../auth/session';
import { rows } from '../common/query';
import { toEventHandler, type Citation, type StreamHandlers } from '../learn/api';
import type { TutorScope } from './open';

export type TutorMode = 'answer' | 'socratic' | 'quiz';

export interface TutorThread {
  id: string;
  scope_type: TutorScope['type'] | 'capture';
  subject_id: string | null;
  goal_id: string | null;
  node_id: string | null;
  passage: TutorScope['passage'] | null;
  mode: TutorMode;
  title: string | null;
  last_message_at: string | null;
  archived_at: string | null;
}

export interface TutorMessage {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant' | 'system_note';
  content: string;
  citations: Citation[];
  general_knowledge: boolean;
  status: 'streaming' | 'complete' | 'interrupted' | 'refused' | 'failed';
  safety_flag: 'distress' | 'blocked_content' | null;
  tool_events: { name: string; payload: unknown }[] | null;
  feedback: -1 | 1 | null;
  created_at: string;
}

export function useThreads() {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['tutorThreads', userId],
    enabled: !!userId,
    queryFn: () => rows<TutorThread>(supabase.from('tutor_threads').select('*').eq('user_id', userId!).is('archived_at', null).order('last_message_at', { ascending: false, nullsFirst: false }).limit(100)),
  });
}

export function useThreadMessages(threadId: string | null) {
  return useQuery({
    queryKey: ['tutorThread', threadId, 'messages'],
    enabled: !!threadId,
    queryFn: () => rows<TutorMessage>(supabase.from('tutor_messages').select('*').eq('thread_id', threadId!).order('created_at')),
  });
}

export function sendTutorMessage(
  input: { thread_id?: string; scope?: TutorScope; mode: TutorMode; message: string; allow_general_answer?: boolean },
  handlers: StreamHandlers,
) {
  const client_message_id = uuidv7();
  return {
    clientMessageId: client_message_id,
    handle: streamFunction('tutor-chat', { ...input, client_message_id }, toEventHandler(handlers), { idempotencyKey: client_message_id }),
  };
}

export async function rateMessage(messageId: string, feedback: -1 | 1, reason?: string) {
  await supabase.from('tutor_messages').update({ feedback, feedback_reason: reason ?? null }).eq('id', messageId);
}

export async function archiveThread(threadId: string) {
  await supabase.from('tutor_threads').update({ archived_at: new Date().toISOString() }).eq('id', threadId);
}

/** `[[APOIO]]` marks distress in conversational output (security §8.2) — never shown raw. */
export function stripSafetyMarkers(text: string): { text: string; distress: boolean } {
  const distress = text.includes('[[APOIO]]');
  return { text: text.replace(/\[\[APOIO\]\]/g, '').trim(), distress };
}
