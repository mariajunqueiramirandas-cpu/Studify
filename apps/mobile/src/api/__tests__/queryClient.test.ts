/// <reference types="jest" />
import type { DehydratedState } from '@tanstack/react-query';
import { deserializeCache, serializeCache } from '../queryClient';

jest.mock('../../lib/kv', () => ({ getKv: jest.fn() }));

const stateWith = (data: unknown) =>
  ({ mutations: [], queries: [{ queryKey: ['subject', 's1', 'mastery'], queryHash: 'h', state: { data, status: 'success' } }] }) as unknown as DehydratedState;

describe('query cache persistence', () => {
  it('round-trips Maps and Sets (mastery, outline index)', () => {
    const mastery = new Map([['n1', { node_id: 'n1', mastery: 0.5 }]]);
    const outline = { roots: [{ id: 'n1', children: [] }], byId: new Map([['n1', { id: 'n1' }]]), excluded: new Set(['n2']) };
    const restored = deserializeCache(serializeCache(stateWith({ mastery, outline })));
    const data = restored.queries[0]!.state.data as { mastery: Map<string, unknown>; outline: typeof outline };
    expect(data.mastery).toBeInstanceOf(Map);
    expect([...data.mastery.values()]).toEqual([{ node_id: 'n1', mastery: 0.5 }]);
    expect(data.outline.byId.get('n1')).toEqual({ id: 'n1' });
    expect(data.outline.excluded.has('n2')).toBe(true);
    expect(data.outline.roots).toEqual([{ id: 'n1', children: [] }]);
  });

  it('leaves plain objects untouched', () => {
    const restored = deserializeCache(serializeCache(stateWith({ __type: 'Map', entries: 1, name: 'Biologia' })));
    expect(restored.queries[0]!.state.data).toEqual({ __type: 'Map', entries: 1, name: 'Biologia' });
  });
});
