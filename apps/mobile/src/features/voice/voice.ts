// Voice in and out (WEL-04, TUT-06, INT-01.8): on-device speech recognition for spoken questions and
// expo-speech for read-aloud. Recognition prefers the on-device model when Android offers one; the app never
// keeps the audio. Read-aloud speaks one utterance at a time so a long note can be stopped mid-way.
import * as Speech from 'expo-speech';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useUiStore } from '../../stores/ui';
import { speechChunks } from './speech-text';

export const VOICE_LANG = 'pt-BR';

// ---------------------------------------------------------------- read-aloud

interface ReadingState {
  /** Key of the text being read (one reader at a time across the app), or null. */
  readingKey: string | null;
  set: (key: string | null) => void;
}

const useReading = create<ReadingState>((set) => ({ readingKey: null, set: (readingKey) => set({ readingKey }) }));

let session = 0;

/** Reads a Markdown text aloud from the start, replacing whatever was being read. */
export function readAloud(key: string, markdown: string, opts: { rate?: number; onDone?: () => void } = {}): void {
  const mine = ++session;
  void Speech.stop();
  const chunks = speechChunks(markdown);
  useReading.getState().set(chunks.length ? key : null);
  const next = (i: number) => {
    if (mine !== session) return;
    if (i >= chunks.length) {
      useReading.getState().set(null);
      opts.onDone?.();
      return;
    }
    Speech.speak(chunks[i]!, {
      language: VOICE_LANG,
      rate: opts.rate ?? useUiStore.getState().readAloudRate,
      onDone: () => next(i + 1),
      onStopped: () => {
        if (mine === session) useReading.getState().set(null);
      },
      onError: () => {
        if (mine === session) useReading.getState().set(null);
      },
    });
  };
  next(0);
}

export function stopReading(): void {
  session++;
  useReading.getState().set(null);
  void Speech.stop();
}

/** "Ouvir" toggle for one text: speaking state plus a play/stop action. Stops when the screen unmounts. */
export function useReadAloud(key: string) {
  const speaking = useReading((s) => s.readingKey === key);
  useEffect(() => () => {
    if (useReading.getState().readingKey === key) stopReading();
  }, [key]);
  const toggle = useCallback(
    (markdown: string) => {
      if (useReading.getState().readingKey === key) stopReading();
      else readAloud(key, markdown);
    },
    [key],
  );
  return { speaking, toggle };
}

// ---------------------------------------------------------------- voice input

export type VoiceError = 'permission' | 'unavailable' | 'no_speech' | 'network' | 'other';

/**
 * Push-to-talk recognition. `partial` updates while the student speaks; `onFinal` receives the final text.
 * Errors map to a few cases the UI explains (permission denied, no recognizer, nothing heard).
 */
export function useVoiceInput(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<VoiceError | null>(null);
  const finalRef = useRef(onFinal);
  useLayoutEffect(() => {
    finalRef.current = onFinal;
  });
  const active = useRef(false);

  // Recognition events are global: every hook instance hears them, so each acts only on its own session.
  useSpeechRecognitionEvent('start', () => {
    if (active.current) setListening(true);
  });
  useSpeechRecognitionEvent('end', () => {
    if (!active.current) return;
    active.current = false;
    setListening(false);
    setPartial('');
  });
  useSpeechRecognitionEvent('result', (event) => {
    if (!active.current) return;
    const text = event.results[0]?.transcript ?? '';
    if (event.isFinal) {
      setPartial('');
      if (text.trim()) finalRef.current(text.trim());
    } else {
      setPartial(text);
    }
  });
  useSpeechRecognitionEvent('error', (event) => {
    if (!active.current) return;
    active.current = false;
    setListening(false);
    setError(event.error === 'not-allowed' ? 'permission' : event.error === 'no-speech' || event.error === 'speech-timeout' ? 'no_speech' : event.error === 'network' ? 'network' : event.error === 'service-not-allowed' || event.error === 'language-not-supported' ? 'unavailable' : 'other');
  });

  const start = useCallback(async () => {
    setError(null);
    stopReading();
    if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) {
      setError('unavailable');
      return;
    }
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setError('permission');
      return;
    }
    active.current = true;
    ExpoSpeechRecognitionModule.start({
      lang: VOICE_LANG,
      interimResults: true,
      continuous: false,
      addsPunctuation: true,
      requiresOnDeviceRecognition: ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
    });
  }, []);

  const stop = useCallback(() => ExpoSpeechRecognitionModule.stop(), []);

  useEffect(() => () => {
    if (active.current) ExpoSpeechRecognitionModule.abort();
  }, []);

  return { listening, partial, error, start, stop };
}
