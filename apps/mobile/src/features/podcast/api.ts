// Podcast Interativo client (INT-01; api §4.8): episodes of a subject, the episode row kept live while the
// worker records it, podcast-create (cached episodes come back instantly), the ✋ stream, the resume position
// and the offline download (INT-01.7).
import type { LineTiming, PodcastAskReq, PodcastCreateReq, PodcastCreateRes, PodcastScriptDoc, PodcastStyle } from '@studify/shared';
import { useQuery } from '@tanstack/react-query';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect } from 'react';
import { uuidv7 } from 'uuidv7';
import { callFunction, streamFunction } from '../../api/functions';
import { queryClient } from '../../api/queryClient';
import { supabase } from '../../api/supabase';
import { realtime, rowTopic } from '../../api/realtime';
import { useSession } from '../auth/session';
import { row, rows } from '../common/query';
import { toEventHandler, type StreamHandlers } from '../learn/api';
import { signedUrl } from '../subjects/api';

export interface EpisodeRow {
  id: string;
  subject_id: string;
  node_ids: string[];
  style: PodcastStyle;
  length_minutes: 5 | 10 | 15;
  owner_user_id: string | null;
  title: string | null;
  script: PodcastScriptDoc | null;
  audio_path: string | null;
  duration_ms: number | null;
  chapters: Array<{ segment_id: string; start_ms: number; title: string }> | null;
  line_timings: LineTiming[] | null;
  status: 'queued' | 'scripting' | 'synthesizing' | 'ready' | 'failed';
  error_code: string | null;
  superseded_by: string | null;
  created_at: string;
}

export interface InteractionRow {
  id: string;
  episode_id: string;
  position_ms: number;
  segment_id: string | null;
  question_text: string;
  answer_lines: Array<{ speaker: 'bia' | 'caio'; text: string }>;
  citations: Array<{ document_id: string; page_start: number; page_end: number }>;
  out_of_material: boolean;
  created_at: string;
}

const LIST_COLUMNS = 'id, subject_id, node_ids, style, length_minutes, owner_user_id, title, duration_ms, status, error_code, superseded_by, created_at, audio_path';

export function useSubjectEpisodes(subjectId: string | undefined) {
  return useQuery({
    queryKey: ['podcasts', subjectId],
    enabled: !!subjectId,
    queryFn: () => rows<EpisodeRow>(supabase.from('podcast_episodes').select(LIST_COLUMNS).eq('subject_id', subjectId!).neq('status', 'failed').order('created_at', { ascending: false }).limit(30)),
  });
}

/** The episode; Realtime (data-model §8.1) refreshes it while the worker records it. */
export function useEpisode(episodeId: string | undefined) {
  const query = useQuery({
    queryKey: ['podcast', episodeId],
    enabled: !!episodeId,
    queryFn: () => row<EpisodeRow>(supabase.from('podcast_episodes').select('*').eq('id', episodeId!).maybeSingle()),
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'ready' && q.state.data.status !== 'failed' ? 10_000 : false),
  });
  useEffect(() => {
    if (!episodeId) return undefined;
    const channel = realtime
      .channel(rowTopic('podcast_episodes', 'id', episodeId))
      .on('change', () => void queryClient.invalidateQueries({ queryKey: ['podcast', episodeId] }))
      .subscribe();
    return () => void realtime.removeChannel(channel);
  }, [episodeId]);
  return query;
}

export function useInteractions(episodeId: string | undefined) {
  const { userId } = useSession();
  return useQuery({
    queryKey: ['podcastInteractions', episodeId],
    enabled: !!episodeId && !!userId,
    queryFn: () => rows<InteractionRow>(supabase.from('podcast_interactions').select('*').eq('episode_id', episodeId!).eq('user_id', userId!).order('created_at')),
  });
}

/** Where the student stopped last time (podcast_plays), in ms. */
export async function resumePosition(userId: string, episodeId: string): Promise<number> {
  const play = await row<{ position_ms: number; completed_at: string | null }>(supabase.from('podcast_plays').select('position_ms, completed_at').eq('user_id', userId).eq('episode_id', episodeId).maybeSingle());
  return play && !play.completed_at ? play.position_ms : 0;
}

export function createEpisode(req: PodcastCreateReq) {
  return callFunction<PodcastCreateReq, PodcastCreateRes>('podcast-create', req, { idempotencyKey: uuidv7() });
}

export function askHosts(req: PodcastAskReq, handlers: StreamHandlers) {
  return streamFunction('podcast-ask', req, toEventHandler(handlers), { idempotencyKey: uuidv7() });
}

// ---------------------------------------------------------------- offline (INT-01.7 "Baixar")

const dir = () => new Directory(Paths.document, 'podcasts');

export function downloadedFile(episodeId: string): File | null {
  const f = new File(dir(), `${episodeId}.mp3`);
  return f.exists ? f : null;
}

export async function downloadEpisode(episode: Pick<EpisodeRow, 'id' | 'audio_path'>): Promise<File> {
  if (!episode.audio_path) throw new Error('no audio');
  const d = dir();
  if (!d.exists) d.create({ intermediates: true });
  const slash = episode.audio_path.indexOf('/');
  const url = await signedUrl(episode.audio_path.slice(0, slash), episode.audio_path.slice(slash + 1));
  if (!url) throw new Error('no url');
  return File.downloadFileAsync(url, new File(d, `${episode.id}.mp3`));
}

export function removeDownload(episodeId: string) {
  downloadedFile(episodeId)?.delete();
}

/** The URI to play: the downloaded file when present, else a fresh signed URL; null for on-device episodes. */
export async function playableUri(episode: Pick<EpisodeRow, 'id' | 'audio_path'>): Promise<string | null> {
  if (!episode.audio_path) return null;
  const local = downloadedFile(episode.id);
  if (local) return local.uri;
  const slash = episode.audio_path.indexOf('/');
  return signedUrl(episode.audio_path.slice(0, slash), episode.audio_path.slice(slash + 1));
}
