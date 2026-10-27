// MPEG audio (MP3) frame handling for podcast assembly (INT-01.4): measuring the duration of each synthesized
// line from its frame headers (for chapters and the synced transcript) and joining lines into one file.
// MP3 is a sequence of independent frames, so concatenating the frame data of files with the same encoding
// settings gives a valid stream; ID3 tags are stripped first.

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG-1
  2: [22050, 24000, 16000], // MPEG-2
  0: [11025, 12000, 8000], // MPEG-2.5
};

export interface Mp3Frame {
  offset: number;
  length: number;
  sampleRate: number;
  samples: number;
}

/** Bytes of an ID3v2 tag at the start (0 when absent). Size is a 28-bit syncsafe integer. */
export function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** Parses one Layer III frame header at `offset`, or null when the bytes are not a valid header. */
export function parseFrameHeader(bytes: Uint8Array, offset: number): Omit<Mp3Frame, 'offset'> | null {
  if (offset + 4 > bytes.length) return null;
  const b1 = bytes[offset]!;
  const b2 = bytes[offset + 1]!;
  const b3 = bytes[offset + 2]!;
  if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) return null;
  const version = (b2 >> 3) & 0x03;
  const layer = (b2 >> 1) & 0x03;
  if (version === 1 || layer !== 1) return null; // reserved version, or not Layer III
  const bitrateIndex = (b3 >> 4) & 0x0f;
  const sampleIndex = (b3 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null;
  const padding = (b3 >> 1) & 0x01;
  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex]! * 1000;
  const sampleRate = SAMPLE_RATES[version]![sampleIndex]!;
  const samples = mpeg1 ? 1152 : 576;
  const length = Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  if (length < 4) return null;
  return { length, sampleRate, samples };
}

/** Every audio frame after the ID3v2 tag, stopping at the first byte that is not a frame (ID3v1, junk). */
export function mp3Frames(bytes: Uint8Array): Mp3Frame[] {
  const frames: Mp3Frame[] = [];
  let offset = id3v2Length(bytes);
  // Some encoders pad before the first frame: resync on the first valid header.
  while (offset < bytes.length && !parseFrameHeader(bytes, offset)) offset++;
  while (offset < bytes.length) {
    const header = parseFrameHeader(bytes, offset);
    if (!header || offset + header.length > bytes.length) break;
    frames.push({ offset, ...header });
    offset += header.length;
  }
  return frames;
}

/** Duration in milliseconds from the frame headers. */
export function mp3DurationMs(bytes: Uint8Array): number {
  let seconds = 0;
  for (const frame of mp3Frames(bytes)) seconds += frame.samples / frame.sampleRate;
  return Math.round(seconds * 1000);
}

/** The audio frames only (tags removed). */
export function mp3AudioData(bytes: Uint8Array): Uint8Array {
  const frames = mp3Frames(bytes);
  if (frames.length === 0) return new Uint8Array(0);
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;
  return bytes.subarray(first.offset, last.offset + last.length);
}

/** Joins MP3 files (same encoding settings) into one stream. */
export function concatMp3(parts: readonly Uint8Array[]): Uint8Array {
  const data = parts.map(mp3AudioData);
  const total = data.reduce((sum, d) => sum + d.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const d of data) {
    out.set(d, at);
    at += d.length;
  }
  return out;
}

/**
 * A synthetic frame header for tests and tools: MPEG-2 Layer III, given bitrate/sample-rate indexes, no
 * padding, followed by zero bytes. Real audio comes from the TTS provider.
 */
export function silentFrame(bitrateIndex = 8, sampleIndex = 1): Uint8Array {
  const b3 = (bitrateIndex << 4) | (sampleIndex << 2);
  const header = { length: 0 };
  const bytes = new Uint8Array([0xff, 0xf3, b3, 0xc4]);
  const parsed = parseFrameHeader(bytes, 0);
  header.length = parsed ? parsed.length : 4;
  const frame = new Uint8Array(header.length);
  frame.set(bytes, 0);
  return frame;
}
