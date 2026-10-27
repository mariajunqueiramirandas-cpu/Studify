// @studify/speech — cloud text-to-speech for the podcast (INT-01) and MP3 assembly. Server-only (API and
// worker). On-device TTS/STT for read-aloud, the voice tutor and Lucas lives in the app (expo-speech).
import { GoogleTtsProvider } from './google.ts';
import type { HostVoice, TtsProvider } from './provider.ts';

export * from './provider.ts';
export * from './mp3.ts';
export { GoogleTtsProvider, GOOGLE_DEFAULT_VOICES } from './google.ts';
export type { GoogleTtsOptions } from './google.ts';

/**
 * Builds the configured provider, or null for "device" (no cloud audio: episodes play with on-device TTS).
 *   TTS_PROVIDER         google | device   (default: google when GOOGLE_TTS_API_KEY is set, else device)
 *   GOOGLE_TTS_API_KEY   API key restricted to the Text-to-Speech API
 *   TTS_VOICE_BIA, TTS_VOICE_CAIO   provider voice names (defaults pt-BR-Neural2-A / -B)
 *   TTS_USD_PER_MILLION_CHARS       price used for budgets and ai_usage (default 16)
 */
export function ttsFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): TtsProvider | null {
  const value = (key: string) => {
    const v = env[key]?.trim();
    return v && v.length > 0 ? v : undefined;
  };
  const apiKey = value('GOOGLE_TTS_API_KEY');
  const provider = value('TTS_PROVIDER') ?? (apiKey ? 'google' : 'device');
  if (provider === 'device') return null;
  if (provider !== 'google') throw new Error(`unknown TTS_PROVIDER "${provider}" (google or device)`);
  if (!apiKey) throw new Error('TTS_PROVIDER=google needs GOOGLE_TTS_API_KEY');
  const voices: Partial<Record<HostVoice, string>> = {};
  const bia = value('TTS_VOICE_BIA');
  const caio = value('TTS_VOICE_CAIO');
  if (bia) voices.bia = bia;
  if (caio) voices.caio = caio;
  const price = value('TTS_USD_PER_MILLION_CHARS');
  return new GoogleTtsProvider({
    apiKey,
    voices,
    ...(price ? { usdPerMillionChars: Number(price) } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}
