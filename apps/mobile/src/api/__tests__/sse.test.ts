/// <reference types="jest" />
import { createSseParser, type SseMessage } from '../sse';

describe('SSE parser', () => {
  it('parses events split across arbitrary chunk boundaries', () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    const stream = 'event: delta\ndata: {"text":"Olá"}\n\n: keep-alive\n\nevent: done\r\ndata: {"stop_reason":"end_turn"}\r\n\r\n';
    for (const ch of stream) parser.feed(ch);
    parser.flush();
    expect(messages).toEqual([
      { event: 'delta', data: '{"text":"Olá"}' },
      { event: 'done', data: '{"stop_reason":"end_turn"}' },
    ]);
  });

  it('joins multi-line data and defaults the event name to message', () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.feed('data: linha 1\ndata: linha 2\n\n');
    expect(messages).toEqual([{ event: 'message', data: 'linha 1\nlinha 2' }]);
  });

  it('discards an unterminated trailing message on EOF for safe reconnect', () => {
    const messages: SseMessage[] = [];
    const parser = createSseParser((m) => messages.push(m));
    parser.feed('event: done\ndata: {}');
    parser.flush();
    expect(messages).toEqual([]);
  });
});
