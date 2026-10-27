// Pure helpers for read-aloud (WEL-04) and on-device podcast playback (INT-01.11): Markdown and LaTeX become
// speakable PT-BR text (packages/shared speech.ts), split into utterances under the engine's input limit.
import { speakableText, splitSentences } from '@studify/shared';

/** Android TTS rejects inputs over ~4,000 characters (TextToSpeech.getMaxSpeechInputLength). */
export const SPEECH_CHUNK_MAX = 3_500;

/** Utterances for a text, each at most `max` characters, never splitting a sentence that fits. */
export function speechChunks(markdown: string, max = SPEECH_CHUNK_MAX): string[] {
  // Citation markers ([[cite:3]]) and cloze braces ({{c1::…}}) are for the screen, not the ear.
  const clean = markdown.replace(/\[\[cite:\d+\]\]/g, '').replace(/\{\{c\d+::(.*?)(::[^}]*)?\}\}/g, '$1');
  const spoken = speakableText(clean);
  const out: string[] = [];
  let current = '';
  for (const sentence of splitSentences(spoken)) {
    const parts = sentence.length > max ? sentence.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')) ?? [sentence] : [sentence];
    for (const part of parts) {
      const piece = part.trim();
      if (!piece) continue;
      if (current && current.length + 1 + piece.length > max) {
        out.push(current);
        current = piece;
      } else {
        current = current ? `${current} ${piece}` : piece;
      }
    }
  }
  if (current) out.push(current);
  return out;
}

/** Joins a recognizer's partial transcript onto what the student already typed. */
export function appendTranscript(typed: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return typed;
  const base = typed.trimEnd();
  if (!base) return said.charAt(0).toUpperCase() + said.slice(1);
  return `${base} ${said}`;
}
