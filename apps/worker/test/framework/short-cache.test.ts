import { describe, expect, it } from 'vitest';
import type { TaskCall } from '@studify/ai';
import { withShortCache } from '../../src/lib/ai-adapter.ts';

const call = {
  task: { id: 't', version: 1, features: [], effort: 'medium', maxTokensClass: 'S', output: { mode: 'plain' } },
  ctx: {},
  system: [{ text: 'a' }, { text: 'b', cacheTtl: '1h' }],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'x' }, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'oi', cache_control: { type: 'ephemeral', ttl: '5m' } },
        { type: 'text', text: 'tarefa' },
      ],
    },
    { role: 'assistant', content: 'texto' },
  ],
} as unknown as TaskCall<string>;

describe('withShortCache', () => {
  it('turns every 1h breakpoint into 5m and leaves the rest of the request alone', () => {
    const out = withShortCache(call);
    expect(out.system).toEqual([{ text: 'a' }, { text: 'b', cacheTtl: '5m' }]);
    const blocks = out.messages[0]!.content as Array<{ cache_control?: { ttl: string } }>;
    expect(blocks.map((b) => b.cache_control?.ttl ?? null)).toEqual(['5m', '5m', null]);
    expect(out.messages[1]).toEqual(call.messages[1]);
    expect((call.system[1] as { cacheTtl: string }).cacheTtl).toBe('1h');
  });
});
