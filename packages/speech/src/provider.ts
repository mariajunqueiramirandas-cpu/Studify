// Cloud text-to-speech for Podcast Interativo (INT-01.4, ✋ answers INT-01.8). The provider is an owner
// decision still open (D-12, spec 12 §12): this interface keeps it swappable, Google Cloud TTS is the first
// implementation, and "device" means no cloud audio — the app reads the script with on-device Android TTS
// (INT-01.11 fallback), so the feature works before a provider is chosen.

export type HostVoice = 'bia' | 'caio';

export interface SynthesisRequest {
  text: string;
  voice: HostVoice;
  /** Silence appended after the line (pause_after_ms, "Pausa pra pensar"). */
  pauseAfterMs?: number;
  /** Speaking rate, 0.75–2 (the player also changes speed; this is the base pace). */
  rate?: number;
}

export interface SynthesisResult {
  audio: Uint8Array;
  mime: 'audio/mpeg';
  durationMs: number;
  /** Characters billed by the provider (for ai_usage and the budget gate). */
  billedChars: number;
}

export interface TtsProvider {
  /** Stable id stored in podcast_episodes.voices and ai_usage.model (e.g. "google:pt-BR-Neural2"). */
  readonly id: string;
  /** Provider voice names, e.g. { bia: "pt-BR-Neural2-A", caio: "pt-BR-Neural2-B" }. */
  readonly voices: Readonly<Record<HostVoice, string>>;
  /** Price in micro-USD per character, used to reserve and log TTS spend (ai-pipeline §12). */
  readonly microUsdPerChar: number;
  synthesize(request: SynthesisRequest, options?: { signal?: AbortSignal }): Promise<SynthesisResult>;
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'TtsError';
  }
}

/** Estimated cost of synthesizing `chars` characters, in micro-USD (rounded up). */
export function ttsCostMicroUsd(provider: Pick<TtsProvider, 'microUsdPerChar'>, chars: number): number {
  return Math.ceil(Math.max(0, chars) * provider.microUsdPerChar);
}

/** Escapes text for SSML. */
export function ssmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** One spoken line as SSML, with the pause as a trailing break (max 10 s per SSML break). */
export function lineSsml(text: string, pauseAfterMs = 0): string {
  const pause = Math.min(10_000, Math.max(0, Math.round(pauseAfterMs)));
  return `<speak>${ssmlEscape(text)}${pause > 0 ? `<break time="${pause}ms"/>` : ''}</speak>`;
}
