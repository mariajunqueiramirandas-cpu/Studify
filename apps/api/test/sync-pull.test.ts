import { expect, test } from 'bun:test';
// The keyset condition of sync-pull (src/data/sync.ts), moved from the app with the pull itself.
import { parseLogic } from '@studify/db';
import { cursorCondition, SYNC_TABLES } from '../src/data/sync.ts';

test('builds a lexicographic (updated_at, ...pk) > cursor condition', () => {
  const f = cursorCondition(['user_id', 'card_id'], '2026-10-27T10:00:00.000100+00:00', ['u1', 'c5']);
  expect(f).toBe(
    'updated_at.gt."2026-10-27T10:00:00.000100+00:00",' +
      'and(updated_at.eq."2026-10-27T10:00:00.000100+00:00",user_id.gt."u1"),' +
      'and(updated_at.eq."2026-10-27T10:00:00.000100+00:00",user_id.eq."u1",card_id.gt."c5")',
  );
});

test('quoted values survive the parser, quotes and backslashes included', () => {
  const tree = parseLogic(cursorCondition(['id'], 'ts', ['a"b\\c']), true);
  const last = tree.items[1];
  expect(last?.kind).toBe('group');
  const cond = last?.kind === 'group' ? last.items[1] : undefined;
  expect(cond).toMatchObject({ column: 'id', op: 'gt', value: 'a"b\\c' });
});

test('only the mirrored tables can be pulled', () => {
  expect(SYNC_TABLES.has('cards')).toBe(true);
  expect(SYNC_TABLES.has('ai_usage')).toBe(false);
});
