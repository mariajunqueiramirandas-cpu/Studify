import { describe, expect, it } from 'vitest';
import {
  GoogleTtsProvider,
  concatMp3,
  id3v2Length,
  lineSsml,
  mp3DurationMs,
  mp3Frames,
  parseFrameHeader,
  silentFrame,
  ssmlEscape,
  ttsCostMicroUsd,
  ttsFromEnv,
} from '../src/index.ts';

function frames(n: number): Uint8Array {
  const one = silentFrame();
  const out = new Uint8Array(one.length * n);
  for (let i = 0; i < n; i++) out.set(one, i * one.length);
  return out;
}

function withId3(audio: Uint8Array): Uint8Array {
  const tagBody = new Uint8Array(20);
  const header = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, tagBody.length]);
  const out = new Uint8Array(header.length + tagBody.length + audio.length);
  out.set(header, 0);
  out.set(tagBody, header.length);
  out.set(audio, header.length + tagBody.length);
  return out;
}

describe('mp3 frames (INT-01.4 assembly)', () => {
  it('parses an MPEG-2 Layer III header (64 kbps, 24 kHz)', () => {
    expect(parseFrameHeader(silentFrame(), 0)).toEqual({ length: 192, sampleRate: 24000, samples: 576 });
    expect(parseFrameHeader(new Uint8Array([0, 0, 0, 0]), 0)).toBeNull();
  });

  it('measures duration from frame headers, skipping an ID3v2 tag', () => {
    // 50 frames × 576 samples / 24 000 Hz = 1.2 s
    expect(mp3DurationMs(frames(50))).toBe(1200);
    const tagged = withId3(frames(50));
    expect(id3v2Length(tagged)).toBe(30);
    expect(mp3DurationMs(tagged)).toBe(1200);
    expect(mp3Frames(tagged)).toHaveLength(50);
  });

  it('concatenates files, dropping tags', () => {
    const joined = concatMp3([withId3(frames(10)), frames(15)]);
    expect(mp3Frames(joined)).toHaveLength(25);
    expect(mp3DurationMs(joined)).toBe(600);
    expect(id3v2Length(joined)).toBe(0);
  });

  it('stops at trailing junk', () => {
    const audio = frames(3);
    const out = new Uint8Array(audio.length + 5);
    out.set(audio);
    out.set([0x54, 0x41, 0x47, 1, 2], audio.length);
    expect(mp3Frames(out)).toHaveLength(3);
  });
});

describe('ssml and cost', () => {
  it('escapes text and adds the pause as a break', () => {
    expect(ssmlEscape(`a < b & "c"`)).toBe('a &lt; b &amp; &quot;c&quot;');
    expect(lineSsml('Pausa pra pensar…', 5000)).toBe('<speak>Pausa pra pensar…<break time="5000ms"/></speak>');
    expect(lineSsml('Oi', 0)).toBe('<speak>Oi</speak>');
    expect(lineSsml('Oi', 60_000)).toContain('10000ms');
  });

  it('prices characters in micro-USD', () => {
    expect(ttsCostMicroUsd({ microUsdPerChar: 16 }, 9000)).toBe(144_000);
  });
});

describe('GoogleTtsProvider', () => {
  it('sends SSML with the host voice and measures the returned audio', async () => {
    const calls: Array<{ url: string; body: Record<string, any> }> = [];
    const audio = frames(25);
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ audioContent: btoa(String.fromCharCode(...audio)) }), { status: 200 });
    }) as unknown as typeof fetch;
    const tts = new GoogleTtsProvider({ apiKey: 'k', fetchImpl });
    const result = await tts.synthesize({ text: 'Oi, eu sou a Bia.', voice: 'bia', pauseAfterMs: 500 });
    expect(calls[0]!.url).toContain('key=k');
    expect(calls[0]!.body.voice).toEqual({ languageCode: 'pt-BR', name: 'pt-BR-Neural2-A' });
    expect(calls[0]!.body.input.ssml).toBe('<speak>Oi, eu sou a Bia.<break time="500ms"/></speak>');
    expect(result.durationMs).toBe(600);
    expect(result.billedChars).toBe(calls[0]!.body.input.ssml.length);
    expect(tts.id).toBe('google:pt-BR-Neural2-A+pt-BR-Neural2-B');
  });

  it('marks 429 and 5xx failures retryable', async () => {
    const tts = new GoogleTtsProvider({ apiKey: 'k', fetchImpl: (async () => new Response('', { status: 503 })) as unknown as typeof fetch });
    await expect(tts.synthesize({ text: 'x', voice: 'caio' })).rejects.toMatchObject({ status: 503, retryable: true });
  });
});

describe('ttsFromEnv', () => {
  it('defaults to device (no cloud audio) without a key', () => {
    expect(ttsFromEnv({})).toBeNull();
    expect(ttsFromEnv({ TTS_PROVIDER: 'device', GOOGLE_TTS_API_KEY: 'k' })).toBeNull();
  });

  it('builds Google with custom voices and price', () => {
    const tts = ttsFromEnv({ GOOGLE_TTS_API_KEY: 'k', TTS_VOICE_CAIO: 'pt-BR-Neural2-C', TTS_USD_PER_MILLION_CHARS: '30' });
    expect(tts?.voices).toEqual({ bia: 'pt-BR-Neural2-A', caio: 'pt-BR-Neural2-C' });
    expect(tts?.microUsdPerChar).toBe(30);
  });

  it('rejects unknown providers and google without a key', () => {
    expect(() => ttsFromEnv({ TTS_PROVIDER: 'polly' })).toThrow(/unknown TTS_PROVIDER/);
    expect(() => ttsFromEnv({ TTS_PROVIDER: 'google' })).toThrow(/GOOGLE_TTS_API_KEY/);
  });
});
