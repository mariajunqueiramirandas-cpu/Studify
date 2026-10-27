// App-wide podcast player (INT-01.7, mobile-app.md §10): one episode at a time, kept outside any screen so the
// mini-player and background playback survive navigation. Cloud episodes play their MP3 with expo-audio
// (lock-screen controls, 0.75×–2×); episodes without cloud audio are read line by line with the on-device voice
// (INT-01.11), honoring "Pausa pra pensar" silences. Positions are synced as podcast_play outbox rows.
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import * as Speech from 'expo-speech';
import { create } from 'zustand';
import type { AppDb } from '../../db/client';
import { enqueueOutbox } from '../../db/outbox';
import { speechChunks } from '../voice/speech-text';
import { lineAt, type TimelineLine } from './timeline';

export interface Track {
  episodeId: string;
  title: string;
  artist: string;
  /** Signed URL or local file of the MP3; null → on-device voices. */
  uri: string | null;
  lines: TimelineLine[];
  durationMs: number;
}

interface PlayerState {
  track: Track | null;
  playing: boolean;
  positionMs: number;
  rate: number;
  /** A ✋ answer is playing; the episode waits (INT-01.8). */
  interrupted: boolean;
}

export const usePodcastPlayer = create<PlayerState>(() => ({ track: null, playing: false, positionMs: 0, rate: 1, interrupted: false }));

const RATES = [0.75, 1, 1.25, 1.5, 2] as const;
export { RATES as PODCAST_RATES };

let audio: AudioPlayer | null = null;
let statusSub: { remove: () => void } | null = null;
let deviceSession = 0;
let db: AppDb | null = null;
let lastSync = 0;

function set(patch: Partial<PlayerState>) {
  usePodcastPlayer.setState(patch);
}

/** Queues the resume position (INT-01.7) at most every 15 s, and always on pause and at the end. */
function syncPosition(force = false, completed = false) {
  const { track, positionMs } = usePodcastPlayer.getState();
  if (!track || !db) return;
  const now = Date.now();
  if (!force && now - lastSync < 15_000) return;
  lastSync = now;
  enqueueOutbox(db, {
    kind: 'podcast_play',
    entityId: track.episodeId,
    payload: { episode_id: track.episodeId, position_ms: Math.round(positionMs), updated_at: new Date(now).toISOString(), ...(completed ? { completed_at: new Date(now).toISOString() } : {}) },
  });
}

function onStatus(status: AudioStatus) {
  set({ positionMs: status.currentTime * 1000, playing: status.playing });
  if (status.didJustFinish) {
    set({ playing: false });
    syncPosition(true, true);
  } else if (status.playing) {
    syncPosition();
  }
}

// ---------------------------------------------------------------- on-device voices

function speakFrom(index: number) {
  const mine = ++deviceSession;
  const { track, rate } = usePodcastPlayer.getState();
  if (!track) return;
  const step = (i: number) => {
    if (mine !== deviceSession) return;
    const line = track.lines[i];
    if (!line) {
      set({ playing: false, positionMs: track.durationMs });
      syncPosition(true, true);
      return;
    }
    set({ positionMs: line.startMs });
    syncPosition();
    const text = speechChunks(line.text).join(' ');
    // Bia and Caio are told apart by pitch on the device voice.
    Speech.speak(text, {
      language: 'pt-BR',
      rate,
      pitch: line.speaker === 'bia' ? 1.1 : 0.9,
      onDone: () => {
        if (mine !== deviceSession) return;
        if (line.pauseMs > 0) {
          set({ positionMs: line.endMs - line.pauseMs });
          const started = Date.now();
          const tick = () => {
            if (mine !== deviceSession) return;
            const elapsed = Date.now() - started;
            if (elapsed >= line.pauseMs / rate) step(i + 1);
            else {
              set({ positionMs: line.endMs - line.pauseMs + elapsed * rate });
              setTimeout(tick, 250);
            }
          };
          setTimeout(tick, 250);
        } else {
          step(i + 1);
        }
      },
    });
  };
  step(index);
}

function stopDevice() {
  deviceSession++;
  void Speech.stop();
}

// ---------------------------------------------------------------- controls

export async function loadTrack(track: Track, opts: { startMs?: number; database: AppDb; autoplay?: boolean }) {
  db = opts.database;
  const current = usePodcastPlayer.getState().track;
  if (current?.episodeId === track.episodeId && current.uri === track.uri) {
    if (opts.autoplay && !usePodcastPlayer.getState().playing) play();
    return;
  }
  stop();
  await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix' });
  set({ track, positionMs: opts.startMs ?? 0, playing: false, interrupted: false });
  if (track.uri) {
    audio = createAudioPlayer(track.uri, { updateInterval: 500 });
    statusSub = audio.addListener('playbackStatusUpdate', onStatus);
    audio.setPlaybackRate(usePodcastPlayer.getState().rate);
    audio.setActiveForLockScreen(true, { title: track.title, artist: track.artist, albumTitle: 'Studify' });
    if (opts.startMs) await audio.seekTo(opts.startMs / 1000);
  }
  if (opts.autoplay) play();
}

export function play() {
  const { track, positionMs } = usePodcastPlayer.getState();
  if (!track) return;
  if (audio) audio.play();
  else {
    set({ playing: true });
    speakFrom(lineAt(track.lines, positionMs));
  }
}

export function pause() {
  if (audio) audio.pause();
  else stopDevice();
  set({ playing: false });
  syncPosition(true);
}

export async function seek(ms: number) {
  const { track, playing } = usePodcastPlayer.getState();
  if (!track) return;
  const target = Math.max(0, Math.min(ms, track.durationMs));
  set({ positionMs: target });
  if (audio) await audio.seekTo(target / 1000);
  else if (playing) speakFrom(lineAt(track.lines, target));
}

export function skip(deltaMs: number) {
  void seek(usePodcastPlayer.getState().positionMs + deltaMs);
}

export function setRate(rate: number) {
  set({ rate });
  if (audio) audio.setPlaybackRate(rate);
  else if (usePodcastPlayer.getState().playing) speakFrom(lineAt(usePodcastPlayer.getState().track?.lines ?? [], usePodcastPlayer.getState().positionMs));
}

/** ✋: pause the episode while the answer plays; resume() rewinds as the server says (3 s, INT-01.8). */
export function interrupt() {
  pause();
  set({ interrupted: true });
}

export async function resumeAt(ms: number) {
  set({ interrupted: false });
  await seek(ms);
  play();
}

export function stop() {
  if (usePodcastPlayer.getState().track) syncPosition(true);
  stopDevice();
  statusSub?.remove();
  statusSub = null;
  if (audio) {
    audio.setActiveForLockScreen(false);
    audio.remove();
    audio = null;
  }
  set({ track: null, playing: false, positionMs: 0, interrupted: false });
}

/** Plays a ✋ answer clip, then calls `onEnd` (also when it fails to load). */
export function playClip(uri: string, onEnd: () => void) {
  const clip = createAudioPlayer(uri);
  const sub = clip.addListener('playbackStatusUpdate', (s) => {
    if (s.didJustFinish) {
      sub.remove();
      clip.remove();
      onEnd();
    }
  });
  clip.setPlaybackRate(usePodcastPlayer.getState().rate);
  clip.play();
}

/** Reads ✋ answer lines with the device voice (INT-01.11), then calls `onEnd`. */
export function speakLines(lines: readonly { speaker: 'bia' | 'caio'; text: string }[], onEnd: () => void) {
  const mine = ++deviceSession;
  const step = (i: number) => {
    if (mine !== deviceSession) return;
    const line = lines[i];
    if (!line) return onEnd();
    Speech.speak(speechChunks(line.text).join(' '), { language: 'pt-BR', rate: usePodcastPlayer.getState().rate, pitch: line.speaker === 'bia' ? 1.1 : 0.9, onDone: () => step(i + 1), onError: () => step(i + 1) });
  };
  step(0);
}
