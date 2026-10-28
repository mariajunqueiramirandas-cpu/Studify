import { beforeEach, describe, expect, it } from 'vitest';
import { silentFrame, type TtsProvider } from '@studify/speech';
import { handlePodcastGenerate, mapScript } from '../../src/jobs/podcast.ts';
import { handleRoomsSweep } from '../../src/jobs/rooms.ts';
import { purgeCaptures } from '../../src/jobs/account.ts';
import { DOC, GROUP_ID, NOW, SUBJECT, TOPIC, USER, USER_B, fakeEnv, type FakeEnv } from './fakes.ts';
import { seedStudent } from './seed.ts';

const EPISODE = '0190a000-0000-7000-8000-0000000e9150';
let env: FakeEnv;

/** A script of `words` words in alternating 50-word lines (valid for a 5-minute episode at 750 ± 15%). */
function script(words = 750, pages = [{ doc: 'D1', page_start: 1, page_end: 1 }]) {
  const line = (i: number) => ({ speaker: i % 2 === 0 ? 'bia' : 'caio', text: Array.from({ length: 50 }, (_, w) => `palavra${w}`).join(' '), pause_after_ms: null });
  const n = Math.round(words / 50);
  const lines = Array.from({ length: n }, (_, i) => line(i));
  return {
    title: 'Fotossíntese em 5 minutos',
    segments: [
      { id: 'seg1', kind: 'hook', node_keys: [], title: 'Abertura', lines: lines.slice(0, 2), source_pages: [], recall_question: null },
      { id: 'seg2', kind: 'topic', node_keys: ['t1'], title: 'Clorofila', lines: lines.slice(2, n - 2), source_pages: pages, recall_question: { question: 'O que capta luz?', answer: 'A clorofila.' } },
      { id: 'seg3', kind: 'outro', node_keys: [], title: 'Tchau', lines: lines.slice(n - 2), source_pages: [], recall_question: null },
    ],
  };
}

function seedEpisode(extra: Record<string, unknown> = {}) {
  env.db.seed('knowledge_nodes', [{ id: TOPIC, subject_id: SUBJECT, kind: 'topic', title: 'Fotossíntese', summary: 'Luz vira energia.', learning_objectives: [], deleted_at: null }]);
  env.db.seed('node_sources', [{ node_id: TOPIC, document_id: DOC, page_start: 1, page_end: 2, deleted_at: null }]);
  env.db.seed('documents', [{ id: DOC, subject_id: SUBJECT, title: 'Apostila', kind: 'textbook', mime_type: 'application/pdf', storage_path: `${SUBJECT}/${DOC}.pdf`, page_count: 3, deleted_at: null }]);
  env.db.seed('document_slices', [{ document_id: DOC, page_start: 1, page_end: 3, storage_path: `${DOC}/1-3.pdf`, anthropic_file_id: null, anthropic_file_expires_at: null }]);
  env.storage.objects.set(`slices/${DOC}/1-3.pdf`, new TextEncoder().encode('%PDF-1.4 slice'));
  env.db.seed('notes', [{ node_id: TOPIC, depth: 'study', status: 'ready', body: 'A clorofila capta luz.', deleted_at: null }]);
  env.db.seed('podcast_episodes', [
    { id: EPISODE, subject_id: SUBJECT, node_ids: [TOPIC], style: 'overview', length_minutes: 5, owner_user_id: null, class_group_id: null, status: 'queued', created_by: USER, ...extra },
  ]);
}

const fakeTts: TtsProvider = {
  id: 'fake:tts',
  voices: { bia: 'A', caio: 'B' },
  microUsdPerChar: 16,
  synthesize: async (req) => ({ audio: silentFrame(), mime: 'audio/mpeg', durationMs: 1000 + (req.voice === 'bia' ? 0 : 500), billedChars: req.text.length }),
};

beforeEach(() => {
  env = fakeEnv(NOW);
  seedStudent(env.db);
});

describe('podcast.generate (INT-01)', () => {
  it('writes the script, synthesizes the audio and stores the measured timeline', async () => {
    seedEpisode();
    (env.ctx as { tts: TtsProvider | null }).tts = fakeTts;
    env.claude.reply('roteiro de um episódio', script());
    const outcome = await handlePodcastGenerate(env.ctx, { episode_id: EPISODE, user_id: USER });
    expect(outcome).toEqual({ status: 'ready', audio: true });
    const episode = env.db.rows('podcast_episodes')[0]!;
    expect(episode.status).toBe('ready');
    expect(episode.audio_path).toBe(`audio/${SUBJECT}/${EPISODE}.mp3`);
    expect(env.storage.objects.has(`audio/${SUBJECT}/${EPISODE}.mp3`)).toBe(true);
    // Labels became ids; the topic segment keeps its page.
    expect(episode.script.segments[1].node_ids).toEqual([TOPIC]);
    expect(episode.script.segments[1].source_pages).toEqual([{ document_id: DOC, page_start: 1, page_end: 1 }]);
    // 15 lines: 8 by Bia (1 s) and 7 by Caio (1.5 s).
    expect(episode.duration_ms).toBe(8 * 1000 + 7 * 1500);
    expect(episode.chapters.map((c: { segment_id: string }) => c.segment_id)).toEqual(['seg1', 'seg2', 'seg3']);
    expect(episode.voices).toEqual({ provider: 'fake:tts', bia: 'A', caio: 'B' });
    expect(env.claude.usage.some((u) => u.task_id === 'podcast.tts' && u.cost_micro_usd > 0)).toBe(true);
    expect(env.enqueued.find((e) => e.name === 'notify.dispatch')?.data).toEqual({ user_id: USER, type: 'podcast_ready', data: { episode_id: EPISODE } });
  });

  it('is ready with device audio when no TTS provider is configured; personal episodes stay private', async () => {
    seedEpisode({ style: 'exam_review', owner_user_id: USER });
    env.claude.reply('roteiro de um episódio', script());
    const outcome = await handlePodcastGenerate(env.ctx, { episode_id: EPISODE });
    expect(outcome).toEqual({ status: 'ready', audio: false });
    const episode = env.db.rows('podcast_episodes')[0]!;
    expect(episode.audio_path).toBeNull();
    expect(episode.voices).toEqual({ provider: 'device' });
    expect(episode.duration_ms).toBeGreaterThan(0);

    // With a provider, the personal episode is stored under the owner's private folder.
    env.db.rows('podcast_episodes')[0]!.status = 'queued';
    (env.ctx as { tts: TtsProvider | null }).tts = fakeTts;
    await handlePodcastGenerate(env.ctx, { episode_id: EPISODE });
    expect(env.db.rows('podcast_episodes')[0]!.audio_path).toBe(`audio/answers/${USER}/${EPISODE}.mp3`);
  });

  it('fails the episode when the script cites pages that were not sent, after one call (no retry)', async () => {
    seedEpisode();
    env.claude.reply('roteiro de um episódio', script(750, [{ doc: 'D1', page_start: 9, page_end: 9 }]));
    const outcome = await handlePodcastGenerate(env.ctx, { episode_id: EPISODE });
    expect(outcome.status).toBe('failed');
    expect(env.db.rows('podcast_episodes')[0]).toMatchObject({ status: 'failed', error_code: 'script_invalid' });
    expect(env.claude.calls.length).toBe(1);
  });

  it('accepts a script that only misses the word budget, with one call', async () => {
    seedEpisode();
    env.claude.reply('roteiro de um episódio', script(1000));
    const outcome = await handlePodcastGenerate(env.ctx, { episode_id: EPISODE });
    expect(outcome.status).toBe('ready');
    expect(env.claude.calls.length).toBe(1);
  });

  it('mapScript drops references outside the pages sent', () => {
    const mapped = mapScript(script(750, [{ doc: 'D1', page_start: 1, page_end: 1 }, { doc: 'D2', page_start: 1, page_end: 1 }]) as never, new Map([['t1', TOPIC]]), {
      labels: { D1: DOC },
      allowedPages: { D1: [1, 2] },
    });
    expect(mapped.segments[1]!.source_pages).toEqual([{ document_id: DOC, page_start: 1, page_end: 1 }]);
  });
});

describe('rooms.sweep (SOC-05.6)', () => {
  it('closes rooms empty for 10 minutes or open for 4 hours, and tells the channel', async () => {
    env.db.seed('study_rooms', [
      { id: 'empty', class_group_id: GROUP_ID, status: 'open', created_at: '2026-10-27T14:00:00.000Z', last_active_at: '2026-10-27T14:45:00.000Z' },
      { id: 'busy', class_group_id: GROUP_ID, status: 'open', created_at: '2026-10-27T14:00:00.000Z', last_active_at: '2026-10-27T14:45:00.000Z' },
      { id: 'old', class_group_id: GROUP_ID, status: 'open', created_at: '2026-10-27T10:30:00.000Z', last_active_at: '2026-10-27T14:59:00.000Z' },
      { id: 'fresh', class_group_id: GROUP_ID, status: 'open', created_at: '2026-10-27T14:55:00.000Z', last_active_at: '2026-10-27T14:55:00.000Z' },
    ]);
    env.db.seed('study_room_members', [
      { room_id: 'busy', user_id: USER, left_at: null },
      { room_id: 'old', user_id: USER_B, left_at: null },
    ]);
    const result = await handleRoomsSweep(env.ctx);
    expect(result.closed).toBe(2);
    const status = Object.fromEntries(env.db.rows('study_rooms').map((r) => [r.id, r.status]));
    expect(status).toEqual({ empty: 'closed', busy: 'open', old: 'closed', fresh: 'open' });
    expect(env.db.rows('study_room_members').find((m) => m.room_id === 'old')?.left_at).toBe(NOW);
    expect(env.broadcasts.map((b) => [b.topic, b.event, b.private])).toEqual([
      ['room:empty', 'closed', true],
      ['room:old', 'closed', true],
    ]);
  });
});

describe('storage.purge: unsaved captures (spec 11 §8.4)', () => {
  it('deletes photos and rows of unsaved captures past expires_at, keeps saved ones', async () => {
    env.db.seed('camera_captures', [
      { id: 'gone', user_id: USER, saved: false, expires_at: '2026-10-01T00:00:00Z', image_paths: [`photos/${USER}/gone/1.jpg`] },
      { id: 'kept', user_id: USER, saved: true, expires_at: '2026-10-01T00:00:00Z', image_paths: [`photos/${USER}/kept/1.jpg`] },
      { id: 'young', user_id: USER, saved: false, expires_at: '2026-11-20T00:00:00Z', image_paths: [`photos/${USER}/young/1.jpg`] },
    ]);
    for (const id of ['gone', 'kept', 'young']) env.storage.objects.set(`photos/${USER}/${id}/1.jpg`, new Uint8Array([1]));
    expect(await purgeCaptures(env.ctx, new Date(NOW))).toBe(1);
    expect(env.db.rows('camera_captures').map((c) => c.id).sort()).toEqual(['kept', 'young']);
    expect(env.storage.removed).toEqual([`photos/${USER}/gone/1.jpg`]);
  });
});
