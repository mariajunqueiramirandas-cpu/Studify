// Google Cloud Text-to-Speech (REST v1, API key auth) as a TtsProvider. Neural2 pt-BR voices accept SSML, so
// pauses are SSML breaks. Voices, rate and price come from the environment (ttsFromEnv); the API key should be
// restricted to the Text-to-Speech API in the Google Cloud console.
import { mp3DurationMs } from './mp3.ts';
import { lineSsml, TtsError, type HostVoice, type SynthesisRequest, type SynthesisResult, type TtsProvider } from './provider.ts';

export interface GoogleTtsOptions {
  apiKey: string;
  voices?: Partial<Record<HostVoice, string>>;
  /** USD per 1 million characters (Neural2 list price: 16). */
  usdPerMillionChars?: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export const GOOGLE_DEFAULT_VOICES: Readonly<Record<HostVoice, string>> = {
  bia: 'pt-BR-Neural2-A',
  caio: 'pt-BR-Neural2-B',
};

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export class GoogleTtsProvider implements TtsProvider {
  readonly id: string;
  readonly voices: Readonly<Record<HostVoice, string>>;
  readonly microUsdPerChar: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;

  constructor(options: GoogleTtsOptions) {
    this.#apiKey = options.apiKey;
    this.voices = { ...GOOGLE_DEFAULT_VOICES, ...(options.voices ?? {}) };
    this.id = `google:${this.voices.bia}+${this.voices.caio}`;
    this.microUsdPerChar = options.usdPerMillionChars ?? 16;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#endpoint = options.endpoint ?? 'https://texttospeech.googleapis.com/v1/text:synthesize';
  }

  async synthesize(request: SynthesisRequest, options: { signal?: AbortSignal } = {}): Promise<SynthesisResult> {
    const ssml = lineSsml(request.text, request.pauseAfterMs ?? 0);
    const voice = this.voices[request.voice];
    const res = await this.#fetch(`${this.#endpoint}?key=${encodeURIComponent(this.#apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { ssml },
        voice: { languageCode: voice.slice(0, 5), name: voice },
        audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000, speakingRate: request.rate ?? 1 },
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      throw new TtsError(`google tts failed with HTTP ${res.status}`, res.status, retryable);
    }
    const body = (await res.json()) as { audioContent?: string };
    if (!body.audioContent) throw new TtsError('google tts returned no audio', res.status, true);
    const audio = decodeBase64(body.audioContent);
    return { audio, mime: 'audio/mpeg', durationMs: mp3DurationMs(audio), billedChars: ssml.length };
  }
}
