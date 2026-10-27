import { describe, expect, test } from 'vitest';
import { linkKindOf, parseSharedLink } from '../src/links.ts';

describe('shared links', () => {
  test('a Turma code is grouped for display and opens the join screen', () => {
    const link = parseSharedLink('/c/abcdefgh', 'studify');
    expect(link?.label).toBe('Código da Turma');
    expect(link?.shown).toBe('ABCD-EFGH');
    expect(link?.deepLink).toBe('studify://class/join?code=ABCDEFGH');
  });

  test('a pilot invite opens the invite step of sign-up', () => {
    expect(parseSharedLink('/i/STUDYF26', 'studify')?.deepLink).toBe('studify://auth/invite?code=STUDYF26');
  });

  test('a quiz token has no code card and is passed through encoded', () => {
    const link = parseSharedLink('/q/a%20b', 'studify');
    expect(link?.label).toBeNull();
    expect(link?.deepLink).toBe('studify://quiz/shared/a%20b');
  });

  test('a battle PIN is shown as is', () => {
    const link = parseSharedLink('/b/123456', 'studify');
    expect(link?.shown).toBe('123456');
    expect(link?.deepLink).toBe('studify://class/battle/join?pin=123456');
  });

  test('a link route without a value, or with a malformed escape, still renders', () => {
    expect(linkKindOf('/c/')).toBe('c');
    expect(parseSharedLink('/c/', 'studify')).toBeNull();
    expect(parseSharedLink('/b/%E0%A4', 'studify')?.shown).toBe('%E0%A4');
  });

  test('other paths are the landing page', () => {
    for (const path of ['/', '/download', '/constructor/x', '/x/ABCDEFGH']) expect(linkKindOf(path)).toBeNull();
  });
});
