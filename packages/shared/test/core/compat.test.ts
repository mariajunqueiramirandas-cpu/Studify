import { describe, expect, it } from 'vitest';
import { CLIENT_COMPAT_LEVEL, isSupportedClient } from '../../src/core/compat.ts';

const headers = (values: Record<string, string>) => new Headers(values);

describe('isSupportedClient', () => {
  it('serves an app at the current level and refuses one below it', () => {
    expect(isSupportedClient(headers({ 'x-studify-version': '150', 'x-studify-compat': String(CLIENT_COMPAT_LEVEL) }))).toBe(true);
    expect(isSupportedClient(headers({ 'x-studify-version': '150', 'x-studify-compat': String(CLIENT_COMPAT_LEVEL + 1) }))).toBe(true);
    expect(isSupportedClient(headers({ 'x-studify-version': '150', 'x-studify-compat': String(CLIENT_COMPAT_LEVEL - 1) }))).toBe(false);
  });

  it('counts an app build without the header as level 1 (built before it existed)', () => {
    expect(isSupportedClient(headers({ 'x-studify-version': '120' }))).toBe(CLIENT_COMPAT_LEVEL <= 1);
    expect(isSupportedClient(headers({ 'x-studify-version': '120', 'x-studify-compat': 'abc' }))).toBe(CLIENT_COMPAT_LEVEL <= 1);
  });

  it('does not gate callers that are not the app (the web dashboard)', () => {
    expect(isSupportedClient(headers({}))).toBe(true);
  });
});
