// Incremental Server-Sent Events parser (api.md §2.6). Pure, so it is unit-tested in Node.
export interface SseMessage {
  event: string;
  data: string;
}

export interface SseParser {
  feed(chunk: string): void;
  /** Dispatches a trailing message that was not terminated by a blank line. */
  flush(): void;
}

export function createSseParser(onMessage: (message: SseMessage) => void): SseParser {
  let buffer = '';
  let event = 'message';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) {
      onMessage({ event, data: data.join('\n') });
    }
    event = 'message';
    data = [];
  };

  const handleLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    },
    flush() {
      if (buffer.length > 0) {
        handleLine(buffer);
        buffer = '';
      }
      dispatch();
    },
  };
}
