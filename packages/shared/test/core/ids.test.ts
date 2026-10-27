import { describe, expect, it } from 'vitest';
import { isUuid, isUuidV7, uuidV7, uuidV7Time } from '../../src/core/ids.ts';

const V4 = '4f6c2a1e-9b3d-4c5e-8f70-1a2b3c4d5e6f';

describe('uuidV7', () => {
  it('produces canonical v7 strings (version nibble 7, RFC variant)', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = uuidV7();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(isUuidV7(id)).toBe(true);
      expect(isUuid(id)).toBe(true);
    }
  });

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    // Ahead of the ids generated above at Date.now(): the generator is monotonic, so a past timestamp
    // would reuse the last millisecond instead of encoding its own.
    const ms = Date.now() + 60_000;
    expect(uuidV7Time(uuidV7(ms))).toBe(ms);
  });

  it('sorts strictly by creation time, including many ids in the same millisecond', () => {
    const ms = 1_800_000_000_000;
    const ids = Array.from({ length: 5000 }, () => uuidV7(ms));
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]! > ids[i - 1]!, `index ${i}`).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps ordering when the clock goes backwards (stays on the last millisecond)', () => {
    const later = uuidV7(2_000_000_000_000);
    const earlier = uuidV7(1_000_000_000_000);
    expect(earlier > later).toBe(true);
    expect(uuidV7Time(earlier)).toBe(2_000_000_000_000);
  });

  it('orders ids across successive milliseconds', () => {
    const a = uuidV7(3_000_000_000_000);
    const b = uuidV7(3_000_000_000_001);
    expect(b > a).toBe(true);
  });

  it('rejects an invalid clock value', () => {
    expect(() => uuidV7(-1)).toThrow(RangeError);
    expect(() => uuidV7(1.5)).toThrow(RangeError);
  });
});

describe('isUuid / isUuidV7', () => {
  it('accepts any canonical UUID but only v7 for isUuidV7', () => {
    expect(isUuid(V4)).toBe(true);
    expect(isUuidV7(V4)).toBe(false);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid('4F6C2A1E9B3D4C5E8F701A2B3C4D5E6F')).toBe(false);
    expect(uuidV7Time(V4)).toBeNull();
  });
});
